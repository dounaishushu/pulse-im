package core

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
)

func mediaAdminID(who Identity) any {
	if who.administrator != nil {
		return who.administrator.ID
	}
	return nil
}

type MessageContent struct {
	Media        *Media         `json:"media,omitempty"`
	Contact      *PublicContact `json:"contact,omitempty"`
	Mentions     []string       `json:"mentions,omitempty"`
	MentionAll   bool           `json:"mention_all,omitempty"`
	MentionUsers []MentionUser  `json:"mention_users,omitempty"`
}
type PublicContact struct {
	ID       string `json:"id"`
	PublicID string `json:"public_id"`
	Account  string `json:"account"`
	Nickname string `json:"nickname"`
	AvatarID string `json:"avatar_id"`
}

func validateSend(in SendInput) error {
	if !requestPattern.MatchString(in.RequestID) || !validText(in.Body, 0, 5000) {
		return ErrInvalid
	}
	if in.SourceMessageID != "" {
		if !validID(in.SourceMessageID) || in.Body != "" || in.Kind != "" || in.MediaID != "" || in.CardUserID != "" || in.ReplyToID != "" || len(in.Mentions) > 0 || in.MentionAll {
			return ErrInvalid
		}
		return nil
	}
	kind := in.Kind
	if kind == "" {
		kind = "text"
	}
	switch kind {
	case "text":
		if !validBody(in.Body) || in.MediaID != "" || in.CardUserID != "" {
			return ErrInvalid
		}
	case "image", "video", "audio", "file":
		if !validID(in.MediaID) || in.CardUserID != "" {
			return ErrInvalid
		}
	case "contact":
		if !validID(in.CardUserID) || in.MediaID != "" {
			return ErrInvalid
		}
	case "shake":
		if !validText(in.Body, 0, 30) {
			return ErrInvalid
		}
		if in.MediaID != "" || in.CardUserID != "" {
			return ErrInvalid
		}
	default:
		return ErrInvalid
	}
	if in.ReplyToID != "" && !validID(in.ReplyToID) {
		return ErrInvalid
	}
	if len(in.Mentions) > 100 {
		return ErrInvalid
	}
	seen := map[string]bool{}
	for _, id := range in.Mentions {
		if !validID(id) || seen[id] {
			return ErrInvalid
		}
		seen[id] = true
	}
	return nil
}
func visibleMessage(ctx context.Context, tx pgx.Tx, who Identity, cid, mid string) (Message, error) {
	var m Message
	a, e := authorize(ctx, tx, who, cid, false)
	if e != nil {
		return m, e
	}
	e = scanMessage(tx.QueryRow(ctx, `SELECT `+messageColumns+` FROM pulse.messages msg WHERE id=$1 AND conversation_id=$2 AND NOT revoked AND seq>GREATEST($3::bigint,$4::bigint-1) AND (NOT msg.manager_only OR $6) AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.message_id=msg.id AND d.user_id=$5)`, mid, cid, a.ClearSeq, a.VisibleFrom, who.UserID, a.managesGroup()), &m)
	if errors.Is(e, pgx.ErrNoRows) {
		return m, ErrForbidden
	}
	if e == nil {
		e = hydrateMentionUsers(ctx, tx, &m)
	}
	return m, e
}
func (s *Service) resolveContent(ctx context.Context, tx pgx.Tx, who Identity, cid, kind string, in SendInput) ([]byte, error) {
	out := MessageContent{}
	a, e := authorize(ctx, tx, who, cid, true)
	if e != nil {
		return nil, e
	}
	if kind == "shake" {
		var internal bool
		if e = tx.QueryRow(ctx, "SELECT internal_staff FROM pulse.users WHERE id=$1", who.UserID).Scan(&internal); e != nil {
			return nil, e
		}
		if !internal || a.Kind != "direct" {
			return nil, ErrForbidden
		}
	}
	if kind == "file" && (a.Kind == "group" || a.Kind == "channel") {
		return nil, ErrForbidden
	}
	if in.MediaID != "" {
		var media Media
		e = scanMedia(tx.QueryRow(ctx, "SELECT "+mediaColumns+" FROM pulse.media WHERE id=$1 AND(owner_id=$2 OR admin_owner_id=$4) AND status='ready' AND kind=$3", in.MediaID, optionalUUID(who.UserID), kind, mediaAdminID(who)), &media)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, ErrForbidden
		}
		if e != nil {
			return nil, e
		}
		out.Media = &media
	}
	if kind == "contact" {
		var contact PublicContact
		e = tx.QueryRow(ctx, `SELECT u.id::text,COALESCE(u.legacy_public_id,u.public_id),CASE WHEN u.account_is_internal THEN '' ELSE u.account END,COALESCE(NULLIF(u.nickname,''),CASE WHEN u.account_is_internal THEN '' ELSE u.account END),COALESCE(u.avatar_id::text,'') FROM pulse.users u WHERE u.id=$1 AND u.active AND NOT EXISTS(SELECT 1 FROM pulse.blocks b WHERE(b.user_id=$1 AND b.peer_id=$2)OR(b.user_id=$2 AND b.peer_id=$1))`, in.CardUserID, who.UserID).Scan(&contact.ID, &contact.PublicID, &contact.Account, &contact.Nickname, &contact.AvatarID)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, ErrForbidden
		}
		if e != nil {
			return nil, e
		}
		out.Contact = &contact
	}
	if in.ReplyToID != "" {
		if _, e = visibleMessage(ctx, tx, who, cid, in.ReplyToID); e != nil {
			return nil, e
		}
	}
	if len(in.Mentions) > 0 || in.MentionAll {
		if a.Kind != "group" {
			return nil, ErrForbidden
		}
		manager := a.Role == "owner" || a.Role == "admin"
		if in.MentionAll && !manager {
			return nil, ErrForbidden
		}
		// Membership authorizes an individual mention. Friendships and visible
		// past messages are unrelated, including after clearing chat history.
		names := make(map[string]mentionLabels, len(in.Mentions))
		if len(in.Mentions) > 0 {
			rows, err := tx.Query(ctx, `SELECT u.id::text,COALESCE(NULLIF(u.nickname,''),CASE WHEN u.account_is_internal THEN '' ELSE u.account END),COALESCE(cm.remark,'')
			 FROM pulse.members m JOIN pulse.users u ON u.id=m.user_id AND u.active
			 LEFT JOIN pulse.contact_metadata cm ON cm.user_id=$3 AND cm.peer_id=u.id
			 WHERE m.conversation_id=$1 AND m.active AND m.user_id=ANY($2::uuid[])`, cid, in.Mentions, who.UserID)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var id string
				var labels mentionLabels
				if err = rows.Scan(&id, &labels.nickname, &labels.remark); err != nil {
					rows.Close()
					return nil, err
				}
				names[id] = labels
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return nil, err
			}
		}
		if in.MentionAll && !containsMention(in.Body, "所有人") {
			return nil, ErrInvalid
		}
		for _, id := range in.Mentions {
			if id == who.UserID {
				return nil, ErrInvalid
			}
			labels, allowed := names[id]
			if !allowed {
				return nil, ErrForbidden
			}
			if !labels.matches(in.Body) {
				return nil, ErrInvalid
			}
		}
		out.Mentions, out.MentionAll = in.Mentions, in.MentionAll
		out.MentionUsers = captureMentionUsers(in.Body, in.Mentions, names, nil)
	}
	return json.Marshal(out)
}
func forwardContent(raw []byte, kind string) ([]byte, error) {
	if kind == "shake" || kind == "system" {
		return nil, ErrForbidden
	}
	var data MessageContent
	if e := json.Unmarshal(raw, &data); e != nil {
		return nil, e
	}
	data.Mentions = nil
	data.MentionAll = false
	data.MentionUsers = nil
	return json.Marshal(data)
}
func storeMessageReferences(ctx context.Context, tx pgx.Tx, m Message, in SendInput) error {
	var content MessageContent
	if err := json.Unmarshal(m.Content, &content); err != nil {
		return err
	}
	if content.Media != nil {
		if _, e := tx.Exec(ctx, "INSERT INTO pulse.message_media(message_id,media_id) VALUES($1,$2)", m.ID, content.Media.ID); e != nil {
			return e
		}
	}
	if len(content.Mentions) > 0 {
		if _, e := tx.Exec(ctx, "INSERT INTO pulse.message_mentions(message_id,user_id) SELECT $1,unnest($2::uuid[])", m.ID, content.Mentions); e != nil {
			return e
		}
	}
	return nil
}

type SearchInput struct {
	ConversationID, Query, Kind, SenderID string
	From, To                              *time.Time
	AfterSeq                              int64
	Limit                                 int
}

func (s *Service) SearchMessages(ctx context.Context, who Identity, in SearchInput) ([]Message, error) {
	if !validID(in.ConversationID) || !validText(in.Query, 0, 200) || (in.SenderID != "" && !validID(in.SenderID)) || in.Limit < 1 || in.Limit > 100 || in.AfterSeq < 0 {
		return nil, ErrInvalid
	}
	switch in.Kind {
	case "", "text", "image", "video", "audio", "file", "contact", "shake":
	default:
		return nil, ErrInvalid
	}
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	if _, e = lockIdentity(ctx, tx, who); e != nil {
		return nil, e
	}
	a, e := authorize(ctx, tx, who, in.ConversationID, false)
	if e != nil {
		return nil, e
	}
	pattern := "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(in.Query) + "%"
	rows, e := tx.Query(ctx, `SELECT `+messageColumns+` FROM pulse.messages msg WHERE conversation_id=$1 AND seq>GREATEST($2::bigint,$3::bigint-1,$4::bigint) AND NOT revoked AND (NOT msg.manager_only OR $12) AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.user_id=$5 AND d.message_id=msg.id) AND($6='' OR kind=$6) AND($7::uuid IS NULL OR sender_id=$7) AND($8::timestamptz IS NULL OR created_at>=$8) AND($9::timestamptz IS NULL OR created_at<$9) AND search_text ILIKE $10 ORDER BY seq LIMIT $11`, in.ConversationID, a.ClearSeq, a.VisibleFrom, in.AfterSeq, who.UserID, in.Kind, optionalUUID(in.SenderID), in.From, in.To, pattern, in.Limit, a.managesGroup())
	if e != nil {
		return nil, e
	}
	items := []Message{}
	for rows.Next() {
		var m Message
		if e = scanMessage(rows, &m); e != nil {
			rows.Close()
			return nil, e
		}
		items = append(items, m)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	if e = hydrateMessagePage(ctx, tx, items); e != nil {
		return nil, e
	}
	return items, tx.Commit(ctx)
}
func (s *Service) PinMessage(ctx context.Context, who Identity, cid, mid string, pin bool) error {
	if !validID(cid) || !validID(mid) {
		return ErrInvalid
	}
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = lockIdentity(ctx, tx, who); e != nil {
		return e
	}
	if e = lockConversations(ctx, tx, []string{cid}); e != nil {
		return e
	}
	a, e := authorize(ctx, tx, who, cid, false)
	if e != nil {
		return e
	}
	if (a.Kind == "group" || a.Kind == "channel") && a.Role == "member" {
		return ErrForbidden
	}
	if _, e = visibleMessage(ctx, tx, who, cid, mid); e != nil {
		return e
	}
	if pin {
		var count int
		var exists bool
		e = tx.QueryRow(ctx, "SELECT count(*),COALESCE(bool_or(message_id=$2),false) FROM pulse.message_pins WHERE conversation_id=$1", cid, mid).Scan(&count, &exists)
		if e != nil {
			return e
		}
		if !exists && count >= 20 {
			return &Fault{409, "pin_limit"}
		}
		_, e = tx.Exec(ctx, "INSERT INTO pulse.message_pins(conversation_id,message_id,actor_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", cid, mid, who.UserID)
	} else {
		_, e = tx.Exec(ctx, "DELETE FROM pulse.message_pins WHERE conversation_id=$1 AND message_id=$2", cid, mid)
	}
	if e != nil {
		return e
	}
	if e = membershipHint(ctx, tx, cid, ""); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e == nil {
		s.notify()
	}
	return e
}
func (a *API) registerMessageContent(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/conversations/{id}/search", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		q := r.URL.Query()
		n, e := parseSeq(q.Get("after_seq"), 0)
		if e != nil {
			return e
		}
		limit, e := parseSeq(q.Get("limit"), 50)
		if e != nil {
			return e
		}
		in := SearchInput{ConversationID: r.PathValue("id"), Query: q.Get("q"), Kind: q.Get("kind"), SenderID: q.Get("sender_id"), AfterSeq: n, Limit: int(limit)}
		for _, f := range []struct {
			name string
			ptr  **time.Time
		}{{"from", &in.From}, {"to", &in.To}} {
			if q.Get(f.name) != "" {
				t, e := time.Parse(time.RFC3339, q.Get(f.name))
				if e != nil {
					return ErrInvalid
				}
				*f.ptr = &t
			}
		}
		v, e := s.SearchMessages(r.Context(), who, in)
		if e == nil {
			writeJSON(w, 200, map[string]any{"items": v})
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/conversations/{id}/messages/{message}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid, mid := r.PathValue("id"), r.PathValue("message")
		if !validID(cid) || !validID(mid) {
			return ErrInvalid
		}
		tx, e := s.Store.Pool.Begin(r.Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(r.Context())
		if _, e = lockIdentity(r.Context(), tx, who); e != nil {
			return e
		}
		v, e := visibleMessage(r.Context(), tx, who, cid, mid)
		if e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
	for _, method := range []string{"PUT", "DELETE"} {
		pin := method == "PUT"
		mux.HandleFunc(method+" /api/v2/conversations/{id}/pins/{message}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
			e := s.PinMessage(r.Context(), who, r.PathValue("id"), r.PathValue("message"), pin)
			if e == nil {
				w.WriteHeader(204)
			}
			return e
		}))
	}
	mux.HandleFunc("GET /api/v2/conversations/{id}/pins", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid := r.PathValue("id")
		if !validID(cid) {
			return ErrInvalid
		}
		tx, e := s.Store.Pool.Begin(r.Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(r.Context())
		if _, e = lockIdentity(r.Context(), tx, who); e != nil {
			return e
		}
		if _, e = authorize(r.Context(), tx, who, cid, false); e != nil {
			return e
		}
		rows, e := tx.Query(r.Context(), "SELECT message_id::text,actor_id::text,created_at FROM pulse.message_pins WHERE conversation_id=$1 ORDER BY created_at LIMIT 20", cid)
		if e != nil {
			return e
		}
		type pinned struct {
			ID, Actor string
			At        time.Time
		}
		ids := []pinned{}
		for rows.Next() {
			var item pinned
			if e = rows.Scan(&item.ID, &item.Actor, &item.At); e != nil {
				rows.Close()
				return e
			}
			ids = append(ids, item)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		type pinInfo struct {
			PinnedBy string    `json:"pinned_by"`
			PinnedAt time.Time `json:"pinned_at"`
		}
		type pinView struct {
			Message
			Pin pinInfo `json:"pin"`
		}
		items := []pinView{}
		for _, id := range ids {
			m, e := visibleMessage(r.Context(), tx, who, cid, id.ID)
			if errors.Is(e, ErrForbidden) {
				continue
			}
			if e != nil {
				return e
			}
			items = append(items, pinView{Message: m, Pin: pinInfo{PinnedBy: id.Actor, PinnedAt: id.At}})
		}
		if e = tx.Commit(r.Context()); e != nil {
			return e
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return nil
	}))
}

type mentionLabels struct{ nickname, remark string }

func (labels mentionLabels) matches(body string) bool {
	return containsMention(body, labels.nickname) || containsMention(body, labels.remark)
}

func containsMention(body, name string) bool {
	for _, label := range mentionLabelForms(name) {
		if regexp.MustCompile(`(?:^|\s)@` + regexp.QuoteMeta(label) + `(?:\s|$)`).MatchString(body) {
			return true
		}
	}
	return false
}

func mentionLabelForms(name string) []string {
	// Match the viewer-visible label produced by web/contact-names.js as well
	// as full labels from retained clients. Never accept arbitrary client aliases.
	visible := strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return ' '
		}
		return r
	}, name)), " ")
	if visible == "" {
		return nil
	}
	full := strings.Join(strings.Fields(name), " ")
	runes := []rune(visible)
	if len(runes) > 64 {
		visible = string(runes[:64])
	}
	if visible == full {
		return []string{full}
	}
	return []string{full, visible}
}
func pruneMentions(ctx context.Context, tx pgx.Tx, viewer, body string, raw []byte) ([]byte, []string, error) {
	var content MessageContent
	if e := json.Unmarshal(raw, &content); e != nil {
		return nil, nil, e
	}
	kept := []string{}
	if len(content.Mentions) > 0 {
		// Resolve the author's own labels once for the whole edit, rather than
		// looking up every target separately or dropping valid remark mentions.
		rows, err := tx.Query(ctx, `SELECT u.id::text,COALESCE(NULLIF(u.nickname,''),CASE WHEN u.account_is_internal THEN '' ELSE u.account END),COALESCE(cm.remark,'')
		 FROM pulse.users u LEFT JOIN pulse.contact_metadata cm ON cm.user_id=$1 AND cm.peer_id=u.id
		 WHERE u.id=ANY($2::uuid[])`, viewer, content.Mentions)
		if err != nil {
			return nil, nil, err
		}
		names := make(map[string]mentionLabels, len(content.Mentions))
		for rows.Next() {
			var id string
			var labels mentionLabels
			if err = rows.Scan(&id, &labels.nickname, &labels.remark); err != nil {
				rows.Close()
				return nil, nil, err
			}
			names[id] = labels
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, nil, err
		}
		for _, id := range content.Mentions {
			if names[id].matches(body) || storedMentionMatches(body, id, content.MentionUsers) {
				kept = append(kept, id)
			}
		}
		content.MentionUsers = captureMentionUsers(body, kept, names, content.MentionUsers)
	}
	content.Mentions = kept
	if content.MentionAll && !containsMention(body, "所有人") {
		content.MentionAll = false
	}
	encoded, e := json.Marshal(content)
	return encoded, kept, e
}
