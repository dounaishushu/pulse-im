package core

import (
	"context"
	"testing"
	"time"
)

func TestUnreadCacheTracksSparseReceiptsAndPersonalVisibility(t *testing.T) {
	f := newFixture(t)
	first := f.send(t, "cache-first", "first")
	second := f.send(t, "cache-second", "second")
	f.exec(t, "UPDATE pulse.messages SET imported_legacy=true WHERE id=$1", first.ID)
	check := func(want int) {
		t.Helper()
		for range 2 {
			rows, err := f.service.ClientConversations(f.ctx, f.bob.Identity, "", f.cid)
			if err != nil || len(rows) != 1 || rows[0].Unread != want {
				t.Fatalf("未读计数不一致: %+v %v, want %d", rows, err, want)
			}
			truth, err := f.service.Unread(f.ctx, f.bob.Identity, f.cid, 999)
			if err != nil || truth.Count != want {
				t.Fatalf("原始未读结果不一致: %+v %v", truth, err)
			}
		}
	}
	check(2)
	if _, err := f.service.ReceiptOne(f.ctx, f.bob.Identity, f.cid, first.ID, "delivered"); err != nil {
		t.Fatal(err)
	}
	check(1)
	if _, err := f.service.Advance(f.ctx, f.bob.Identity, f.cid, second.Seq, true); err != nil {
		t.Fatal(err)
	}
	check(0)
	third := f.send(t, "cache-third", "third")
	check(1)
	if _, err := f.service.ClearHistory(f.ctx, f.bob.Identity, f.cid, third.Seq); err != nil {
		t.Fatal(err)
	}
	check(0)
	f.service.unreadMu.Lock()
	entries := len(f.service.unreadCache)
	f.service.unreadMu.Unlock()
	if entries != 1 {
		t.Fatalf("意外的缓存范围: %d", entries)
	}
	f.exec(t, "UPDATE pulse.members SET active=false,membership_version=membership_version+1 WHERE conversation_id=$1 AND user_id=$2", f.cid, f.bob.UserID)
	if _, err := f.service.ClientConversations(f.ctx, f.bob.Identity, "", f.cid); err == nil {
		t.Fatal("旧缓存绕过退群权限")
	}
}

func TestWorkerHeartbeatsCoalesceAndFlushErrorRecovery(t *testing.T) {
	f := newFixture(t)
	for range 20 {
		if err := f.service.ObserveWorker(f.ctx, "coalesce-test", func(context.Context) error { return nil }); err != nil {
			t.Fatal(err)
		}
	}
	var runs int64
	var code string
	read := func() {
		t.Helper()
		if err := f.store.Pool.QueryRow(f.ctx, "SELECT runs,error_code FROM pulse.worker_heartbeats WHERE name='coalesce-test'").Scan(&runs, &code); err != nil {
			t.Fatal(err)
		}
	}
	read()
	if runs != 1 {
		t.Fatalf("空闲心跳没有合并: %d", runs)
	}
	_ = f.service.ObserveWorker(f.ctx, "coalesce-test", func(context.Context) error { return &Fault{503, "fixture_error"} })
	read()
	if runs != 21 || code != "fixture_error" {
		t.Fatalf("错误没有立即记录: %d %s", runs, code)
	}
	_ = f.service.ObserveWorker(f.ctx, "coalesce-test", func(context.Context) error { return nil })
	read()
	if runs != 22 || code != "" {
		t.Fatalf("恢复没有立即记录: %d %s", runs, code)
	}
	_ = f.service.ObserveWorker(f.ctx, "coalesce-test", func(context.Context) error { return nil })
	f.service.FlushWorkerHeartbeats()
	read()
	if runs != 23 {
		t.Fatalf("停机丢失计数: %d", runs)
	}
}

func TestDeliveryWakeAfterIdleStartsWithoutPollingDelay(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(f.ctx)
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); f.service.RunDeliveryJobs(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	time.Sleep(1600 * time.Millisecond)
	started := time.Now()
	id, err := f.service.CreateSendBatch(f.ctx, f.alice.Identity, "latency-batch", "forward", []SendOperation{{ConversationID: f.cid, Input: SendInput{Body: "wake"}}}, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	for time.Since(started) < 900*time.Millisecond {
		var status string
		if err = f.store.Pool.QueryRow(f.ctx, "SELECT status FROM pulse.send_batches WHERE id=$1", id).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status == "completed" || status == "done" {
			return
		}
		if status == "failed" {
			t.Fatal("发送任务失败")
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("空闲后新任务没有及时唤醒")
}
