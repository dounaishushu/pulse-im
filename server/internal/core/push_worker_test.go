package core

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPushDrainsLargeGroupAndRetriesOnlyFailedDevice(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "push group", nil)
	if err != nil {
		t.Fatal(err)
	}
	const peers, messages = 500, 6
	f.service.PushWorkers = PushWorkerConfig{Workers: messages, BatchSize: 192, Parallelism: 32}
	// Model users browsing on another device just before the message arrives.
	f.exec(t, `WITH people AS (
 INSERT INTO pulse.users(id,account,password_hash,last_active_at)
 SELECT gen_random_uuid(),'push-peer-'||i,'isolated-fixture',now() FROM generate_series(1,$2::integer) i RETURNING id,account
), members AS (
 INSERT INTO pulse.members(conversation_id,user_id) SELECT $1,id FROM people RETURNING conversation_id,user_id
), states AS (
 INSERT INTO pulse.user_states(conversation_id,user_id) SELECT conversation_id,user_id FROM members
), sessions AS (
 INSERT INTO pulse.login_sessions(id,user_id,device_id,token_hash,expires_at)
 SELECT gen_random_uuid(),id,account,sha256(id::text::bytea),now()+interval '1 hour' FROM people RETURNING id,user_id,device_id
)
INSERT INTO pulse.push_devices(id,user_id,session_id,platform,token,token_hash)
SELECT gen_random_uuid(),user_id,id,'ios',device_id,sha256(device_id::bytea) FROM sessions`, group.ID, peers)

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var received, failOnce, active, peak atomic.Int32
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count := active.Add(1)
		defer active.Add(-1)
		for previous := peak.Load(); count > previous && !peak.CompareAndSwap(previous, count); previous = peak.Load() {
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload["user_id"] == nil || payload["conversation_id"] != group.ID {
			t.Error("invalid Go push payload", err)
		}
		seq, _ := payload["seq"].(string)
		if n, err := strconv.Atoi(seq); err != nil || n < 1 || n > messages {
			t.Error("invalid conversation sequence")
		}
		time.Sleep(12 * time.Millisecond)
		if seq == "1" && strings.HasSuffix(r.URL.Path, "/push-peer-1") && failOnce.Add(1) == 1 {
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		received.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer mock.Close()
	f.service.Push = &PushTransport{config: PushConfig{APNsKeyID: "key", APNsTeam: "team", APNsTopic: "test.topic"}, ecKey: key, client: mock.Client(), apnsURL: mock.URL}
	for i := range messages {
		if _, err := f.service.Send(f.ctx, f.alice.Identity, group.ID, SendInput{RequestID: "push-large-group-" + strconv.Itoa(i), Body: "group message"}); err != nil {
			t.Fatal(err)
		}
	}
	ctx, stop := context.WithCancel(f.ctx)
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); f.service.RunPushWorker(ctx) }()
	defer func() { stop(); <-workerDone }()
	check := func(want int32) {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			var sent int
			if err := f.store.Pool.QueryRow(f.ctx, `SELECT count(*) FROM pulse.push_deliveries WHERE status='sent'`).Scan(&sent); err != nil {
				t.Fatal(err)
			}
			if sent == int(want) && received.Load() == want {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("wanted %d delivered; got %d", want, received.Load())
	}
	started := time.Now()
	check(peers*messages - 1)
	t.Logf("%d accepted by local APNs fixture in %s, peak concurrency %d", peers*messages-1, time.Since(started).Round(time.Millisecond), peak.Load())
	if peak.Load() <= 32 || peak.Load() > 192 || failOnce.Load() != 1 {
		t.Fatalf("expected concurrent delivery and one deferred retry, got peak=%d attempts=%d", peak.Load(), failOnce.Load())
	}
	var scheduled bool
	if err = f.store.Pool.QueryRow(f.ctx, `SELECT retry_at>now()+interval '45 seconds' FROM pulse.push_deliveries WHERE status='failed'`).Scan(&scheduled); err != nil || !scheduled {
		t.Fatalf("Retry-After was not respected: %v %v", scheduled, err)
	}
	f.exec(t, `UPDATE pulse.push_deliveries SET retry_at=now() WHERE status='failed'`)
	f.exec(t, `UPDATE pulse.push_jobs SET available_at=now()`)
	check(peers * messages)
	var pending int
	if err = f.store.Pool.QueryRow(f.ctx, `SELECT count(*) FROM pulse.push_jobs`).Scan(&pending); err != nil || pending != 0 || failOnce.Load() != 2 {
		t.Fatalf("queue was not drained cleanly: %d pending, %d attempts: %v", pending, failOnce.Load(), err)
	}
}
