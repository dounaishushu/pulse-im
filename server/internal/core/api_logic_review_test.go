package core

import (
	"errors"
	"testing"
)

func TestAPILogicRejectDuplicateBatchSelections(t *testing.T) {
	f := newFixture(t)
	first := f.send(t, "batch-source", "source")
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	t.Run("forward-target", func(t *testing.T) {
		f.request(t, "POST", "/api/v2/forward-batches", f.alice.Token, map[string]any{"request_id": "repeated-target", "message_ids": []string{first.ID}, "conversation_ids": []string{f.cid, f.cid}}, 400, nil)
	})
	t.Run("forward-source", func(t *testing.T) {
		f.request(t, "POST", "/api/v2/forward-batches", f.alice.Token, map[string]any{"request_id": "repeated-source", "message_ids": []string{first.ID, first.ID}, "conversation_ids": []string{f.cid}}, 400, nil)
	})
	t.Run("broadcast-target", func(t *testing.T) {
		f.request(t, "POST", "/api/v2/broadcasts", f.alice.Token, map[string]any{"request_id": "repeated-broadcast", "body": "once", "conversation_ids": []string{f.cid, f.cid}}, 400, nil)
	})
	var count int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.send_batches").Scan(&count); err != nil || count != 0 {
		t.Fatalf("重复选择产生了发送任务: %d %v", count, err)
	}
}

func TestAPILogicCancelBatchRetryAndOwnership(t *testing.T) {
	f := newFixture(t)
	first := f.send(t, "cancel-source", "source")
	id, err := f.service.CreateSendBatch(f.ctx, f.alice.Identity, "cancel-retry", "forward", []SendOperation{{ConversationID: f.cid, Input: SendInput{SourceMessageID: first.ID}}}, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v2/send-batches/" + id
	f.request(t, "DELETE", path, f.alice.Token, nil, 204, nil)
	f.request(t, "DELETE", path, f.alice.Token, nil, 204, nil)
	f.request(t, "DELETE", path, f.bob.Token, nil, 404, nil)
	f.request(t, "DELETE", "/api/v2/send-batches/"+newID(), f.alice.Token, nil, 404, nil)
	if processed, err := f.service.ProcessSendOnce(f.ctx); err != nil || processed {
		t.Fatalf("取消后继续发送: %v %v", processed, err)
	}
	f.exec(t, "UPDATE pulse.send_batches SET status='completed' WHERE id=$1", id)
	f.request(t, "DELETE", path, f.alice.Token, nil, 409, nil)
	f.exec(t, "UPDATE pulse.send_batches SET status='pending' WHERE id=$1", id)
	if err := f.service.Logout(f.ctx, f.alice.Identity); err != nil {
		t.Fatal(err)
	}
	if err := f.service.CancelSendBatch(f.ctx, f.alice.Identity, id); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("失效身份取消了任务: %v", err)
	}
}

func TestAPILogicMissingDispatchIsNotTemporaryOutage(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	root.request(t, "POST", "/api/v2/admin/dispatch-plans/"+newID()+"/disable", map[string]any{}, 404, nil)
}
