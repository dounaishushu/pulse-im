package core

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestGroupMentionRemarkLabelsAcrossRoles(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "remark mentions", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=true WHERE id=$1", group.ID)
	f.exec(t, "INSERT INTO pulse.contact_metadata(user_id,peer_id,remark) VALUES($1,$2,'客户张姐'),($3,$2,'管理员的私有备注')", f.bob.UserID, f.carol.UserID, f.alice.UserID)
	for _, tc := range []struct {
		role, token, label string
	}{
		{"member", f.bob.Token, "客户张姐"},
		{"admin", f.bob.Token, "客户张姐"},
		{"owner", f.alice.Token, "管理员的私有备注"},
	} {
		t.Run(tc.role, func(t *testing.T) {
			if tc.role != "owner" {
				f.exec(t, "UPDATE pulse.members SET role=$3 WHERE conversation_id=$1 AND user_id=$2", group.ID, f.bob.UserID, tc.role)
			}
			input := map[string]any{"request_id": "remark-" + tc.role, "kind": "text", "body": "@" + tc.label + " 请查看", "mentions": []string{f.carol.UserID}}
			var sent, duplicate SendResult
			f.request(t, "POST", "/api/v2/conversations/"+group.ID+"/messages", tc.token, input, 201, &sent)
			f.request(t, "POST", "/api/v2/conversations/"+group.ID+"/messages", tc.token, input, 200, &duplicate)
			if duplicate.Message.ID != sent.Message.ID || !duplicate.Duplicate {
				t.Fatal("mention retry did not preserve idempotency")
			}
			var content MessageContent
			if err := json.Unmarshal(sent.Message.Content, &content); err != nil || len(content.Mentions) != 1 || content.Mentions[0] != f.carol.UserID {
				t.Fatalf("remark mention lost the target identity: %+v %v", content, err)
			}
			var count int
			if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.message_mentions WHERE message_id=$1 AND user_id=$2", sent.Message.ID, f.carol.UserID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("mention reference missing or repeated: %d %v", count, err)
			}
			f.request(t, "POST", "/api/v2/conversations/"+group.ID+"/messages", tc.token, map[string]any{"request_id": "plain-after-" + tc.role, "body": "艾特之后继续发消息"}, 201, nil)
		})
	}
	// A member's own remark is usable without granting access to private profiles.
	f.exec(t, "UPDATE pulse.members SET role='member' WHERE conversation_id=$1 AND user_id=$2", group.ID, f.bob.UserID)
	f.request(t, "GET", "/api/v2/profiles/"+f.carol.UserID+"?conversation_id="+group.ID, f.bob.Token, nil, 403, nil)
}

func TestGroupMentionRemarkValidationIsViewerScoped(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "private remark labels", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "INSERT INTO pulse.contact_metadata(user_id,peer_id,remark) VALUES($1,$2,'我的备注'),($3,$2,'其他人的备注')", f.bob.UserID, f.carol.UserID, f.alice.UserID)
	for i, body := range []string{"@其他人的备注 hello", "@随意的名称 hello", "没有艾特", "@我的备注后缀 hello"} {
		_, err := f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "wrong-label-" + string(rune('a'+i)), Body: body, Mentions: []string{f.carol.UserID}})
		if !errors.Is(err, ErrInvalid) {
			t.Fatalf("unrelated or invisible label %q accepted: %v", body, err)
		}
	}
	for i, remark := range []string{"工作 张姐[VIP]", "  工作\u200b  张姐\n VIP  ", strings.Repeat("长", 64)} {
		f.exec(t, "UPDATE pulse.contact_metadata SET remark=$3 WHERE user_id=$1 AND peer_id=$2", f.bob.UserID, f.carol.UserID, remark)
		label := []string{"工作 张姐[VIP]", "工作 张姐 VIP", strings.Repeat("长", 64)}[i]
		if _, err := f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "normalized-label-" + string(rune('a'+i)), Body: "@" + label + " hello", Mentions: []string{f.carol.UserID}}); err != nil {
			t.Fatalf("the displayed remark %q could not be sent: %v", label, err)
		}
	}
	f.exec(t, "UPDATE pulse.contact_metadata SET remark=$3 WHERE user_id=$1 AND peer_id=$2", f.bob.UserID, f.carol.UserID, "\u200b")
	if _, err := f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "invisible-remark-denied", Body: "@\u200b hello", Mentions: []string{f.carol.UserID}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an invisible remark produced a hidden mention: %v", err)
	}
	f.exec(t, "UPDATE pulse.contact_metadata SET remark='' WHERE user_id=$1 AND peer_id=$2", f.bob.UserID, f.carol.UserID)
	if _, err := f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "cleared-remark", Body: "@carol01 hello", Mentions: []string{f.carol.UserID}}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "ordinary-mention-all", Body: "@所有人 hello", MentionAll: true}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("ordinary member acquired mention-all permission: %v", err)
	}
	if err := f.service.SetGroupMuteMinutes(f.ctx, f.alice.Identity, group.ID, f.bob.UserID, -1); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "muted-remark-actor", Body: "@carol01 hello", Mentions: []string{f.carol.UserID}}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("remark support bypassed a mute: %v", err)
	}
}

func TestMentionLabelMatchesContactDisplay(t *testing.T) {
	for _, tc := range []struct {
		body, name string
		want       bool
	}{
		{"@工作 张姐[VIP] hello", "工作 张姐[VIP]", true},
		{"@工作 张姐 VIP hello", "  工作\u200b  张姐\n VIP  ", true},
		{"@" + strings.Repeat("长", 64) + " hello", strings.Repeat("长", 70), true},
		{"@ hello", "", false},
		{"@ hello", "\u200b\n", false},
		{"@\u200b hello", "\u200b", false},
		{"@客户张姐后缀 hello", "客户张姐", false},
		{"文字@客户张姐 hello", "客户张姐", false},
		{"@任意名字 hello", "客户张姐", false},
	} {
		if got := containsMention(tc.body, tc.name); got != tc.want {
			t.Errorf("mention %q with label %q: got %v want %v", tc.body, tc.name, got, tc.want)
		}
	}
}

func TestReplyAndPlainTextAfterRejectedRemarkMention(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "reply after rejected mention", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	parent, err := f.service.Send(f.ctx, f.alice.Identity, group.ID, SendInput{RequestID: "reply-parent", Body: "被引用的消息"})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "INSERT INTO pulse.contact_metadata(user_id,peer_id,remark) VALUES($1,$2,'我自己的备注')", f.bob.UserID, f.alice.UserID)
	path := "/api/v2/conversations/" + group.ID
	f.request(t, "POST", path+"/messages", f.bob.Token, map[string]any{"request_id": "invalid-mention-before-reply", "body": "@其他用户的别名 hello", "mentions": []string{f.alice.UserID}}, 400, nil)
	var reply SendResult
	f.request(t, "POST", path+"/messages", f.bob.Token, map[string]any{"request_id": "reply-after-invalid-mention", "body": "继续引用回复", "reply_to_id": parent.Message.ID}, 201, &reply)
	var contexts struct {
		Items []struct {
			Message *Message `json:"message"`
		} `json:"items"`
	}
	f.request(t, "POST", path+"/reply-contexts", f.bob.Token, map[string]any{"message_ids": []string{reply.Message.ID}}, 200, &contexts)
	if len(contexts.Items) != 1 || contexts.Items[0].Message == nil || contexts.Items[0].Message.SenderID != f.alice.UserID || contexts.Items[0].Message.Body != parent.Message.Body {
		t.Fatalf("reply context lost its author identity or body: %+v", contexts)
	}
	raw, _ := json.Marshal(contexts)
	if strings.Contains(string(raw), "我自己的备注") {
		t.Fatal("viewer remark was written into shared reply data")
	}
	f.request(t, "POST", path+"/messages", f.bob.Token, map[string]any{"request_id": "plain-after-reply", "body": "继续发普通消息"}, 201, nil)
}

func TestEditingGroupRemarkMentionKeepsAndRemovesReferences(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "edit remark mention", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "INSERT INTO pulse.contact_metadata(user_id,peer_id,remark) VALUES($1,$2,'客户张姐')", f.bob.UserID, f.carol.UserID)
	sent, err := f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "editable-remark", Body: "@客户张姐 初始消息", Mentions: []string{f.carol.UserID}})
	if err != nil {
		t.Fatal(err)
	}
	for i, body := range []string{"@客户张姐 修改正文", "已删除艾特", "@客户张姐 仅为普通文本"} {
		edited, err := f.service.MutateMessage(f.ctx, f.bob.Identity, group.ID, sent.Message.ID, body, int64(i+1), false)
		if err != nil {
			t.Fatal(err)
		}
		var content MessageContent
		if err := json.Unmarshal(edited.Content, &content); err != nil {
			t.Fatal(err)
		}
		want := 0
		if i == 0 {
			want = 1
		}
		var references int
		if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.message_mentions WHERE message_id=$1", sent.Message.ID).Scan(&references); err != nil || len(content.Mentions) != want || references != want {
			t.Fatalf("edited mention references are inconsistent: content=%+v count=%d want=%d err=%v", content, references, want, err)
		}
	}
}
