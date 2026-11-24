package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func privacyMention(t *testing.T, f *fixture) (string, Message) {
	t.Helper()
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "mention privacy", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET nickname='公开昵称' WHERE id=$1", f.carol.UserID)
	f.exec(t, "INSERT INTO pulse.contact_metadata(user_id,peer_id,remark) VALUES($1,$2,'工作 张姐[VIP]')", f.bob.UserID, f.carol.UserID)
	sent, err := f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "privacy-source", Body: "正文 @工作 张姐[VIP] 请查看 @工作 张姐[VIP]", Mentions: []string{f.carol.UserID}})
	if err != nil {
		t.Fatal(err)
	}
	return group.ID, sent.Message
}

func TestMentionPrivacyForwardUsesPublicNamesWithoutMentionNotifications(t *testing.T) {
	f := newFixture(t)
	_, source := privacyMention(t, f)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "forward destination", []string{f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	sent, err := f.service.Send(f.ctx, f.alice.Identity, group.ID, SendInput{RequestID: "privacy-forward", SourceMessageID: source.ID})
	if err != nil {
		t.Fatal(err)
	}
	want := "正文 @公开昵称 请查看 @公开昵称"
	var page HistoryPage
	f.request(t, "GET", "/api/v2/conversations/"+group.ID+"/history", f.carol.Token, nil, 200, &page)
	if len(page.Items) != 1 || page.Items[0].Body != want || sent.Message.Body != want {
		t.Fatalf("forward exposes private label: %+v", page.Items)
	}
	if strings.Contains(string(sent.Message.Content), "mention") || strings.Contains(string(sent.Message.Content), "工作") {
		t.Fatal("forward retained source mention identity")
	}
	var references int
	f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.message_mentions WHERE message_id=$1", sent.Message.ID).Scan(&references)
	if references != 0 {
		t.Fatal("forward created fresh mention notifications")
	}
	var original string
	f.store.Pool.QueryRow(f.ctx, "SELECT body FROM pulse.messages WHERE id=$1", source.ID).Scan(&original)
	if original != source.Body {
		t.Fatal("forward mutated the source body")
	}
}

func TestMentionPrivacyLegacyRenameReadPathsAndForward(t *testing.T) {
	f := newFixture(t)
	cid, source := privacyMention(t, f)
	f.exec(t, "UPDATE pulse.messages SET content=content-'mention_users' WHERE id=$1", source.ID)
	f.exec(t, "UPDATE pulse.contact_metadata SET remark='发送者的新私密备注' WHERE user_id=$1 AND peer_id=$2", f.bob.UserID, f.carol.UserID)
	f.exec(t, "UPDATE pulse.users SET nickname='当前公开昵称' WHERE id=$1", f.carol.UserID)
	check := func(message Message) {
		t.Helper()
		if strings.Contains(message.Body, "工作") || strings.Contains(message.Body, "VIP") || !strings.Contains(message.Body, "@当前公开昵称") || !strings.Contains(message.Body, "历史提及名称已变更") {
			t.Fatalf("unsafe legacy fallback: %+v", message)
		}
		var content MessageContent
		if err := json.Unmarshal(message.Content, &content); err != nil {
			t.Fatal(err)
		}
		if !completeMentionUsers(message.Body, content.Mentions, content.MentionUsers) {
			t.Fatal("fallback has no usable per-viewer name metadata")
		}
		if strings.Contains(string(message.Content), "私密备注") || strings.Contains(string(message.Content), "工作") {
			t.Fatal("fallback retained private aliases")
		}
	}
	for _, viewer := range []Login{f.alice, f.bob, f.carol} {
		page, err := f.service.History(f.ctx, viewer.Identity, cid, 0, 0, 0, nil, 100, false, nil)
		if err != nil || len(page.Items) != 1 {
			t.Fatal(page, err)
		}
		check(page.Items[0])
	}
	sync, err := f.service.Sync(f.ctx, f.carol.Identity, cid, 0, nil, 100)
	if err != nil || len(sync.Events) != 1 {
		t.Fatal(sync, err)
	}
	check(sync.Events[0].Message)
	rows, err := f.service.SearchMessages(f.ctx, f.carol.Identity, SearchInput{ConversationID: cid, Query: "请查看", Limit: 10})
	if err != nil || len(rows) != 1 {
		t.Fatal(rows, err)
	}
	check(rows[0])
	var single Message
	path := "/api/v2/conversations/" + cid
	f.request(t, "GET", path+"/messages/"+source.ID, f.carol.Token, nil, 200, &single)
	check(single)
	summary, err := f.service.ClientConversations(f.ctx, f.carol.Identity, "", cid)
	if err != nil || len(summary) != 1 || summary[0].LastMessage == nil {
		t.Fatal(summary, err)
	}
	check(*summary[0].LastMessage)
	var reply SendResult
	f.request(t, "POST", path+"/messages", f.carol.Token, map[string]any{"request_id": "privacy-reply", "body": "回复", "reply_to_id": source.ID}, 201, &reply)
	var context struct {
		Items []struct {
			Message Message `json:"message"`
		} `json:"items"`
	}
	f.request(t, "POST", path+"/reply-contexts", f.carol.Token, map[string]any{"message_ids": []string{reply.Message.ID}}, 200, &context)
	if len(context.Items) != 1 {
		t.Fatal(context)
	}
	check(context.Items[0].Message)
	var rawContext struct {
		Items []struct {
			Message map[string]json.RawMessage `json:"message"`
		} `json:"items"`
	}
	f.request(t, "POST", path+"/reply-contexts", f.carol.Token, map[string]any{"message_ids": []string{reply.Message.ID}}, 200, &rawContext)
	encoded, err := json.Marshal(rawContext)
	if err != nil || len(rawContext.Items) != 1 || strings.Contains(string(encoded), "工作") || strings.Contains(string(encoded), "VIP") {
		t.Fatal("raw reply context exposes an old private alias", string(encoded), err)
	}
	if _, exposed := rawContext.Items[0].Message["search_text"]; exposed {
		t.Fatal("reply context exposes an internal search projection")
	}
	forwarded, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "privacy-legacy-forward", SourceMessageID: source.ID})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(forwarded.Message.Body, "工作") || !strings.Contains(forwarded.Message.Body, "当前公开昵称") || strings.Contains(string(forwarded.Message.Content), "mention") {
		t.Fatal("unsafe legacy forward", forwarded)
	}
	var raw string
	var enriched bool
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT body,content ? 'mention_users' FROM pulse.messages WHERE id=$1", source.ID).Scan(&raw, &enriched); err != nil || raw != source.Body || enriched {
		t.Fatal("legacy compatibility altered stored source", raw, enriched, err)
	}
}

func TestMentionPrivacyPublicTokenBoundariesAndNoCascadingReplacement(t *testing.T) {
	users := []MentionUser{{UserID: "one", Nickname: "公开甲", Labels: []string{"私人备注", "私人备注 长名字"}}, {UserID: "two", Nickname: "公开乙", Labels: []string{"公开甲"}}}
	content := MessageContent{Mentions: []string{"one", "two"}, MentionUsers: users}
	body := "@私人备注 长名字 @私人备注\n@公开甲 邮箱@私人备注 @私人备注后缀\u3000@私人备注"
	want := "@公开甲 @公开甲\n@公开乙 邮箱@私人备注 @私人备注后缀\u3000@公开甲"
	if got := publicMentionText(body, content); got != want {
		t.Fatalf("unexpected token replacement: %q", got)
	}
}

func TestMentionPrivacyLegacyFallbackIsBoundedAndHasStableNames(t *testing.T) {
	users := make([]MentionUser, 100)
	for i := range users {
		users[i] = MentionUser{UserID: fmt.Sprint(i), Nickname: fmt.Sprintf("%02d%s", i, strings.Repeat("名", 64))}
	}
	body, users := legacyMentionFallback(users)
	if !validBody(body) {
		t.Fatal("legacy summary exceeds message limit")
	}
	for _, user := range users {
		if len(user.Labels) != 1 || !containsMention(body, user.Labels[0]) {
			t.Fatal("unusable fallback mention", user)
		}
	}
}

func TestMentionPrivacyForwardExpansionReturnsValidationError(t *testing.T) {
	f := newFixture(t)
	cid, _ := privacyMention(t, f)
	f.exec(t, "UPDATE pulse.users SET nickname=$2 WHERE id=$1", f.carol.UserID, strings.Repeat("名", 64))
	f.exec(t, "UPDATE pulse.contact_metadata SET remark='x' WHERE user_id=$1 AND peer_id=$2", f.bob.UserID, f.carol.UserID)
	source, err := f.service.Send(f.ctx, f.bob.Identity, cid, SendInput{RequestID: "privacy-large", Body: strings.Repeat("@x ", 1200), Mentions: []string{f.carol.UserID}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "privacy-large-forward", SourceMessageID: source.Message.ID})
	if !errors.Is(err, ErrInvalid) {
		t.Fatal("expanded forward should fail validation rather than a database constraint", err)
	}
}

func TestMentionPrivacyOfflinePushOmitsSharedAliases(t *testing.T) {
	for _, test := range []struct {
		name    string
		message pushMessage
		want    string
	}{
		{"mentioned-text", pushMessage{Kind: "text", Body: "@发送者私密备注", HasMentions: true}, genericPushPreview},
		{"ordinary-text", pushMessage{Kind: "text", Body: "普通文字"}, "普通文字"},
		{"image", pushMessage{Kind: "image", Body: "图片说明"}, genericPushPreview},
		{"unicode-limit", pushMessage{Kind: "text", Body: strings.Repeat("文", 130)}, strings.Repeat("文", 120)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := pushPreview(test.message); got != test.want {
				t.Fatal(got)
			}
		})
	}
}
