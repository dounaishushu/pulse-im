package core

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Labels identify the verified @ tokens in the unchanged message body. They
// contain only text already present in that body, never another unused remark.
// Clients resolve UserID against the viewing account's own contact names.
type MentionUser struct {
	UserID   string   `json:"user_id"`
	Nickname string   `json:"nickname"`
	Labels   []string `json:"labels"`
}

func mentionSpace(r rune) bool { return unicode.IsSpace(r) || r == '\uFEFF' }

// Stored labels are already normalized and verified. Avoid compiling one
// regular expression per target each time a history page is read.
func hasMentionToken(body, label string) bool {
	if label == "" {
		return false
	}
	needle := "@" + label
	for offset := 0; offset < len(body); {
		found := strings.Index(body[offset:], needle)
		if found < 0 {
			return false
		}
		start := offset + found
		end := start + len(needle)
		offset = end
		before, _ := utf8.DecodeLastRuneInString(body[:start])
		after, _ := utf8.DecodeRuneInString(body[end:])
		if (start == 0 || mentionSpace(before)) && (end == len(body) || mentionSpace(after)) {
			return true
		}
	}
	return false
}

func storedMentionMatches(body, id string, users []MentionUser) bool {
	for _, user := range users {
		if user.UserID == id {
			for _, label := range user.Labels {
				if hasMentionToken(body, label) {
					return true
				}
			}
		}
	}
	return false
}

func captureMentionUsers(body string, ids []string, names map[string]mentionLabels, prior []MentionUser) []MentionUser {
	users := make([]MentionUser, 0, len(ids))
	for _, id := range ids {
		name := names[id]
		candidates := []string{name.nickname, name.remark}
		for _, old := range prior {
			if old.UserID == id {
				candidates = append(candidates, old.Labels...)
				if name.nickname == "" {
					name.nickname = old.Nickname
				}
			}
		}
		user := MentionUser{UserID: id, Nickname: name.nickname, Labels: []string{}}
		seen := map[string]bool{}
		for _, candidate := range candidates {
			for _, label := range mentionLabelForms(candidate) {
				if !seen[label] && hasMentionToken(body, label) {
					seen[label] = true
					user.Labels = append(user.Labels, label)
				}
			}
		}
		users = append(users, user)
	}
	return users
}

// A legacy row may outlive the only copy of its author's old remark. Never
// guess the boundary of a label containing spaces, or expose it as plain text.
// Keep the stored message untouched and return a clear, public-name summary.
func legacyMentionFallback(users []MentionUser) (string, []MentionUser) {
	tokens, seen := []string{}, map[string]bool{}
	for i := range users {
		label := publicMentionName(users[i].Nickname)
		if runes := []rune(label); len(runes) > 32 {
			label = string(runes[:32])
		}
		users[i].Labels = []string{label}
		if !seen[label] {
			tokens = append(tokens, "@"+label)
			seen[label] = true
		}
	}
	return strings.Join(tokens, " ") + " （历史提及名称已变更）", users
}

func publicMentionName(name string) string {
	forms := mentionLabelForms(name)
	if len(forms) == 0 {
		return "会话成员"
	}
	return forms[len(forms)-1]
}

func completeMentionUsers(body string, ids []string, users []MentionUser) bool {
	for _, id := range ids {
		if !storedMentionMatches(body, id, users) {
			return false
		}
	}
	return true
}

// Forwarding carries public names, never the original author's private labels.
// Match complete, verified tokens against the original text in one pass so a
// replacement containing another @ label cannot itself be replaced again.
func publicMentionText(body string, content MessageContent) string {
	if len(content.Mentions) == 0 {
		return body
	}
	if !completeMentionUsers(body, content.Mentions, content.MentionUsers) {
		body, content.MentionUsers = legacyMentionFallback(content.MentionUsers)
	}
	targets, labels := map[string]bool{}, map[string][]string{}
	for _, id := range content.Mentions {
		targets[id] = true
	}
	for _, user := range content.MentionUsers {
		if !targets[user.UserID] {
			continue
		}
		for _, label := range user.Labels {
			if label != "" {
				labels[label] = append(labels[label], "@"+publicMentionName(user.Nickname))
			}
		}
	}
	type replacement struct {
		start, end int
		text       string
	}
	matches := []replacement{}
	for label, names := range labels {
		needle := "@" + label
		for offset := 0; offset < len(body); {
			found := strings.Index(body[offset:], needle)
			if found < 0 {
				break
			}
			start := offset + found
			end := start + len(needle)
			offset = end
			before, _ := utf8.DecodeLastRuneInString(body[:start])
			after, _ := utf8.DecodeRuneInString(body[end:])
			if (start == 0 || mentionSpace(before)) && (end == len(body) || mentionSpace(after)) {
				matches = append(matches, replacement{start, end, strings.Join(names, " ")})
			}
		}
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].start == matches[j].start {
			return matches[i].end > matches[j].end
		}
		return matches[i].start < matches[j].start
	})
	var result strings.Builder
	offset := 0
	for _, match := range matches {
		if match.start < offset {
			continue
		}
		result.WriteString(body[offset:match.start])
		result.WriteString(match.text)
		offset = match.end
	}
	result.WriteString(body[offset:])
	return result.String()
}

func hydrateMessagePage(ctx context.Context, tx pgx.Tx, messages []Message) error {
	refs := make([]*Message, len(messages))
	for i := range messages {
		refs[i] = &messages[i]
	}
	return hydrateMentionUsers(ctx, tx, refs...)
}

// New messages persist their verified labels. Older messages are enriched with
// one batched, read-only lookup per page; no profile access or per-mention HTTP
// request is needed, including in groups with a restricted member directory.
func hydrateMentionUsers(ctx context.Context, tx pgx.Tx, messages ...*Message) error {
	type pendingMessage struct {
		message *Message
		content MessageContent
	}
	pending := []pendingMessage{}
	pairs := map[[2]string]bool{}
	senders, targets := []string{}, []string{}
	for _, message := range messages {
		if message == nil || message.Revoked {
			continue
		}
		var content MessageContent
		if err := json.Unmarshal(message.Content, &content); err != nil {
			return err
		}
		if len(content.Mentions) == 0 || completeMentionUsers(message.Body, content.Mentions, content.MentionUsers) {
			continue
		}
		pending = append(pending, pendingMessage{message, content})
		for _, id := range content.Mentions {
			key := [2]string{message.SenderID, id}
			if !pairs[key] {
				pairs[key] = true
				senders = append(senders, message.SenderID)
				targets = append(targets, id)
			}
		}
	}
	if len(pending) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT p.sender_id::text,u.id::text,
	 COALESCE(NULLIF(u.nickname,''),CASE WHEN u.account_is_internal THEN '' ELSE u.account END),COALESCE(cm.remark,'')
	 FROM unnest($1::uuid[],$2::uuid[]) p(sender_id,target_id)
	 JOIN pulse.users u ON u.id=p.target_id
	 LEFT JOIN pulse.contact_metadata cm ON cm.user_id=p.sender_id AND cm.peer_id=u.id`, senders, targets)
	if err != nil {
		return err
	}
	names := map[string]map[string]mentionLabels{}
	for rows.Next() {
		var sender, target string
		var labels mentionLabels
		if err = rows.Scan(&sender, &target, &labels.nickname, &labels.remark); err != nil {
			rows.Close()
			return err
		}
		if names[sender] == nil {
			names[sender] = map[string]mentionLabels{}
		}
		names[sender][target] = labels
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, item := range pending {
		users := captureMentionUsers(item.message.Body, item.content.Mentions, names[item.message.SenderID], item.content.MentionUsers)
		if !completeMentionUsers(item.message.Body, item.content.Mentions, users) {
			item.message.Body, users = legacyMentionFallback(users)
		}
		var content map[string]json.RawMessage
		if err = json.Unmarshal(item.message.Content, &content); err != nil {
			return err
		}
		if content["mention_users"], err = json.Marshal(users); err != nil {
			return err
		}
		if item.message.Content, err = json.Marshal(content); err != nil {
			return err
		}
	}
	return nil
}
