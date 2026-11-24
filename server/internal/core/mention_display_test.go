package core

import (
	"encoding/json"
	"strings"
	"testing"
)

func requireMentionDisplay(t *testing.T, message Message, target, label string) {
	t.Helper()
	var content MessageContent
	if err := json.Unmarshal(message.Content, &content); err != nil {
		t.Fatal(err)
	}
	if len(content.Mentions) != 1 || content.Mentions[0] != target || len(content.MentionUsers) != 1 {
		t.Fatalf("missing mention identity: %+v", content)
	}
	user := content.MentionUsers[0]
	if user.UserID != target || user.Nickname != "被艾特者的昵称" || len(user.Labels) != 1 || user.Labels[0] != label {
		t.Fatalf("incorrect mention display context: %+v", user)
	}
}

func TestMentionDisplayCapturesLabelsWithoutChangingSharedBody(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "per-viewer mentions", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET nickname='被艾特者的昵称' WHERE id=$1", f.carol.UserID)
	f.exec(t, "INSERT INTO pulse.contact_metadata(user_id,peer_id,remark) VALUES($1,$2,'备注一下'),($3,$2,'第三人的未使用备注')", f.bob.UserID, f.carol.UserID, f.alice.UserID)
	path := "/api/v2/conversations/" + group.ID
	input := map[string]any{"request_id": "viewer-label", "body": "@备注一下 请查看", "mentions": []string{f.carol.UserID}}
	var sent, duplicate SendResult
	f.request(t, "POST", path+"/messages", f.bob.Token, input, 201, &sent)
	requireMentionDisplay(t, sent.Message, f.carol.UserID, "备注一下")
	f.request(t, "POST", path+"/messages", f.bob.Token, input, 200, &duplicate)
	if !duplicate.Duplicate || duplicate.Message.ID != sent.Message.ID {
		t.Fatal("display metadata changed send idempotency")
	}
	for _, login := range []Login{f.alice, f.bob, f.carol} {
		var history HistoryPage
		f.request(t, "GET", path+"/history?order=asc&limit=100", login.Token, nil, 200, &history)
		if len(history.Items) != 1 || history.Items[0].Body != "@备注一下 请查看" {
			t.Fatal("shared source text was personalized or lost")
		}
		requireMentionDisplay(t, history.Items[0], f.carol.UserID, "备注一下")
		if strings.Contains(string(history.Items[0].Content), "第三人的未使用备注") {
			t.Fatal("an unrelated account's private remark leaked")
		}
	}
	// Captured labels survive subsequent private remark changes and edits.
	f.exec(t, "UPDATE pulse.contact_metadata SET remark='发送后改过的备注' WHERE user_id=$1 AND peer_id=$2", f.bob.UserID, f.carol.UserID)
	edited, err := f.service.MutateMessage(f.ctx, f.bob.Identity, group.ID, sent.Message.ID, "@备注一下 修改正文", 1, false)
	if err != nil {
		t.Fatal(err)
	}
	requireMentionDisplay(t, edited, f.carol.UserID, "备注一下")
	removed, err := f.service.MutateMessage(f.ctx, f.bob.Identity, group.ID, sent.Message.ID, "移除了艾特", 2, false)
	if err != nil {
		t.Fatal(err)
	}
	var content MessageContent
	if err = json.Unmarshal(removed.Content, &content); err != nil || len(content.Mentions) != 0 || len(content.MentionUsers) != 0 {
		t.Fatalf("removed mentions left stale display names: %+v %v", content, err)
	}
}

func TestMentionDisplayBackfillsLegacyReadPathsWithoutWrites(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "legacy mentions", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET nickname='被艾特者的昵称' WHERE id=$1", f.carol.UserID)
	f.exec(t, "INSERT INTO pulse.contact_metadata(user_id,peer_id,remark) VALUES($1,$2,'工作 张姐[VIP]'),($3,$2,'不能泄露的其他备注')", f.bob.UserID, f.carol.UserID, f.alice.UserID)
	sent, err := f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "legacy-viewer-label", Body: "@工作 张姐[VIP] 请查看", Mentions: []string{f.carol.UserID}})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.messages SET content=content-'mention_users' WHERE id=$1", sent.Message.ID)
	f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=true WHERE id=$1", group.ID)
	path := "/api/v2/conversations/" + group.ID
	var history HistoryPage
	f.request(t, "GET", path+"/history?order=asc&limit=100", f.carol.Token, nil, 200, &history)
	if len(history.Items) != 1 {
		t.Fatal("legacy history missing")
	}
	requireMentionDisplay(t, history.Items[0], f.carol.UserID, "工作 张姐[VIP]")
	var sync SyncPage
	f.request(t, "GET", path+"/sync?after_seq=0&limit=100", f.carol.Token, nil, 200, &sync)
	if len(sync.Events) != 1 {
		t.Fatal("legacy sync missing")
	}
	requireMentionDisplay(t, sync.Events[0].Message, f.carol.UserID, "工作 张姐[VIP]")
	var single Message
	f.request(t, "GET", path+"/messages/"+sent.Message.ID, f.carol.Token, nil, 200, &single)
	requireMentionDisplay(t, single, f.carol.UserID, "工作 张姐[VIP]")
	items, err := f.service.SearchMessages(f.ctx, f.carol.Identity, SearchInput{ConversationID: group.ID, Query: "请查看", Limit: 10})
	if err != nil || len(items) != 1 {
		t.Fatalf("legacy search: %v", err)
	}
	requireMentionDisplay(t, items[0], f.carol.UserID, "工作 张姐[VIP]")
	conversations, err := f.service.ClientConversations(f.ctx, f.carol.Identity, "", group.ID)
	if err != nil || len(conversations) != 1 || conversations[0].LastMessage == nil {
		t.Fatalf("legacy conversation preview: %v", err)
	}
	requireMentionDisplay(t, *conversations[0].LastMessage, f.carol.UserID, "工作 张姐[VIP]")
	var reply SendResult
	f.request(t, "POST", path+"/messages", f.carol.Token, map[string]any{"request_id": "quote-legacy-mention", "body": "引用含艾特的消息", "reply_to_id": sent.Message.ID}, 201, &reply)
	var contexts struct {
		Items []struct {
			Message *Message `json:"message"`
		} `json:"items"`
	}
	f.request(t, "POST", path+"/reply-contexts", f.carol.Token, map[string]any{"message_ids": []string{reply.Message.ID}}, 200, &contexts)
	if len(contexts.Items) != 1 || contexts.Items[0].Message == nil {
		t.Fatal("legacy quoted mention missing")
	}
	requireMentionDisplay(t, *contexts.Items[0].Message, f.carol.UserID, "工作 张姐[VIP]")
	var rawContexts struct {
		Items []struct {
			Message map[string]json.RawMessage `json:"message"`
		} `json:"items"`
	}
	f.request(t, "POST", path+"/reply-contexts", f.carol.Token, map[string]any{"message_ids": []string{reply.Message.ID}}, 200, &rawContexts)
	for _, field := range []string{"manager_only", "imported_legacy", "sender", "content"} {
		if len(rawContexts.Items[0].Message[field]) == 0 {
			t.Fatal("mention enrichment removed an existing reply field", field)
		}
	}
	var persisted bool
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT content ? 'mention_users' FROM pulse.messages WHERE id=$1", sent.Message.ID).Scan(&persisted); err != nil || persisted {
		t.Fatal("legacy reads modified shared storage", err)
	}
}

func TestMentionDisplayDoesNotExposeUnusedRemarkOrForwardReferences(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	names := map[string]mentionLabels{id: {nickname: "公开昵称", remark: "未使用的私有备注"}}
	users := captureMentionUsers("@公开昵称 正文", []string{id}, names, nil)
	if len(users) != 1 || len(users[0].Labels) != 1 || users[0].Labels[0] != "公开昵称" {
		t.Fatalf("unused labels were disclosed: %+v", users)
	}
	raw, _ := json.Marshal(MessageContent{Mentions: []string{id}, MentionUsers: users})
	forwarded, err := forwardContent(raw, "text")
	if err != nil || strings.Contains(string(forwarded), "mention") {
		t.Fatalf("forwarding retained original mention references: %s %v", forwarded, err)
	}
}
