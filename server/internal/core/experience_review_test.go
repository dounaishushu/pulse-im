package core

import (
	"testing"
)

func TestReplyContextConcurrentRemovalDoesNotDenyConversation(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	parent, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "context-parent", Body: "引用正文"})
	if err != nil {
		t.Fatal(err)
	}
	children := []Message{}
	for _, request := range []string{"visible", "revoked", "deleted"} {
		child, sendErr := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: request, Body: request, ReplyToID: parent.Message.ID})
		if sendErr != nil {
			t.Fatal(sendErr)
		}
		children = append(children, child.Message)
	}
	if _, err = f.service.MutateMessage(f.ctx, f.alice.Identity, f.cid, children[1].ID, "", 1, true); err != nil {
		t.Fatal(err)
	}
	if _, err = f.deleteMessagesAsStaff(t, f.ctx, f.bob.Identity, f.cid, []string{children[2].ID}); err != nil {
		t.Fatal(err)
	}
	ids := []string{children[0].ID, children[1].ID, children[2].ID, newID(), parent.Message.ID}
	path := "/api/v2/conversations/" + f.cid + "/reply-contexts"
	var result struct {
		Items []struct {
			ID      string   `json:"message_id"`
			Seq     string   `json:"reply_seq"`
			Message *Message `json:"message"`
		} `json:"items"`
	}
	f.request(t, "POST", path, f.bob.Token, map[string]any{"message_ids": ids}, 200, &result)
	if len(result.Items) != len(ids) {
		t.Fatal("引用结果不完整")
	}
	for i, row := range result.Items {
		if row.ID != ids[i] {
			t.Fatal("引用结果顺序错误")
		}
		if i == 0 {
			if row.Seq != "1" || row.Message == nil || row.Message.Body != "引用正文" {
				t.Fatal("可见引用丢失")
			}
		} else if row.Seq != "0" || row.Message != nil {
			t.Fatal("不可用来源泄露了引用内容或位置")
		}
	}
	f.request(t, "POST", path, f.carol.Token, map[string]any{"message_ids": ids}, 403, nil)
	f.request(t, "POST", path, "", map[string]any{"message_ids": ids}, 401, nil)
	f.request(t, "POST", path, f.bob.Token, map[string]any{"message_ids": []string{ids[0], ids[0]}}, 400, nil)
	if _, err = f.clearHistoryAsStaff(t, f.ctx, f.bob.Identity, f.cid, children[2].Seq); err != nil {
		t.Fatal(err)
	}
	f.request(t, "POST", path, f.bob.Token, map[string]any{"message_ids": ids}, 200, &result)
	for _, row := range result.Items {
		if row.Seq != "0" || row.Message != nil {
			t.Fatal("清空后仍暴露引用")
		}
	}
}
