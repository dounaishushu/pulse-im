package core

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

var testPasswordHash string
var testPasswordOnce sync.Once

const testPassword = "IsolatedTest_2026"

type fixture struct {
	ctx               context.Context
	store             *Store
	cache             *Cache
	service           *Service
	hub               *Hub
	http              *httptest.Server
	alice, bob, carol Login
	cid               string
	cancel            context.CancelFunc
	workers           sync.WaitGroup
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dsn, redisURL := os.Getenv("PULSE_CORE_TEST_DSN"), os.Getenv("PULSE_CORE_TEST_REDIS_URL")
	if dsn == "" || redisURL == "" {
		t.Skip("requires isolated PostgreSQL and Redis integration configuration")
	}
	ctx, cancel := context.WithCancel(context.Background())
	store, err := OpenStore(ctx, dsn)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	var name string
	err = store.Pool.QueryRow(ctx, "SELECT current_database()").Scan(&name)
	host := store.Pool.Config().ConnConfig.Host
	if err != nil || name != "pulse_core_test" || (host != "127.0.0.1" && host != "localhost") {
		store.Pool.Close()
		cancel()
		t.Fatal("refusing to mutate anything except localhost/pulse_core_test")
	}
	if err = store.Migrate(ctx); err != nil {
		store.Pool.Close()
		cancel()
		t.Fatal(err)
	}
	if err = store.Migrate(ctx); err != nil {
		store.Pool.Close()
		cancel()
		t.Fatal(err)
	}
	if _, err = store.Pool.Exec(ctx, "TRUNCATE pulse.users CASCADE"); err != nil {
		store.Pool.Close()
		cancel()
		t.Fatal(err)
	}
	cache, err := OpenCache(ctx, redisURL, "pulse:test:"+newID()+":")
	if err != nil {
		store.Pool.Close()
		cancel()
		t.Fatal(err)
	}
	service, err := NewService(store, cache)
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{ctx: ctx, store: store, cache: cache, service: service, hub: NewHub(128, 1<<20), cancel: cancel}
	f.http = httptest.NewServer(NewHandler(service, f.hub, HTTPOptions{Origins: map[string]bool{"https://test.invalid": true}}))
	t.Cleanup(func() {
		cancel()
		f.hub.Close()
		f.http.Close()
		f.workers.Wait()
		// Delete only this fixture's Redis namespace; never FLUSHDB/FLUSHALL.
		cleanCtx, cleanCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cleanCancel()
		var cursor uint64
		for {
			keys, next, err := cache.Client.Scan(cleanCtx, cursor, cache.Prefix+"*", 100).Result()
			if err != nil {
				break
			}
			if len(keys) > 0 {
				_ = cache.Client.Del(cleanCtx, keys...).Err()
			}
			cursor = next
			if cursor == 0 {
				break
			}
		}
		cache.Client.Close()
		store.Pool.Close()
	})
	testPasswordOnce.Do(func() { testPasswordHash, err = hashPassword(testPassword) })
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{newID(), newID(), newID()}
	for i, account := range []string{"alice01", "bob01", "carol01"} {
		if _, err = store.Pool.Exec(ctx, "INSERT INTO pulse.users(id,account,password_hash) VALUES($1,$2,$3)", ids[i], account, testPasswordHash); err != nil {
			t.Fatal(err)
		}
	}
	pair := []string{ids[0], ids[1]}
	sort.Strings(pair)
	if _, err = store.Pool.Exec(ctx, "INSERT INTO pulse.friendships(user_low,user_high) VALUES($1,$2)", pair[0], pair[1]); err != nil {
		t.Fatal(err)
	}
	// These are real HTTP password logins with the production handler.
	f.request(t, "POST", "/api/v2/auth/login", "", map[string]string{"account": "alice01", "password": testPassword, "device_id": "desktop-a"}, 200, &f.alice)
	f.request(t, "POST", "/api/v2/auth/login", "", map[string]string{"account": "bob01", "password": testPassword, "device_id": "desktop-b"}, 200, &f.bob)
	f.request(t, "POST", "/api/v2/auth/login", "", map[string]string{"account": "carol01", "password": testPassword, "device_id": "desktop-c"}, 200, &f.carol)
	var direct struct {
		ID string `json:"id"`
	}
	f.request(t, "POST", "/api/v2/conversations/direct", f.alice.Token, map[string]string{"peer_id": f.bob.UserID}, 200, &direct)
	f.cid = direct.ID
	// Fixture construction may emit directory invalidations. Each test begins
	// after that setup event has already been consumed by its fake clients.
	f.exec(t, "DELETE FROM pulse.outbox")
	return f
}
func (f *fixture) request(t *testing.T, method, path, token string, value any, want int, out any) {
	t.Helper()
	var input io.Reader
	if value != nil {
		b, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		input = strings.NewReader(string(b))
	}
	req, err := http.NewRequest(method, f.http.URL+path, input)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := f.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != want {
		t.Fatalf("%s %s: status %d, want %d; %s", method, path, resp.StatusCode, want, body)
	}
	if out != nil {
		if err = json.Unmarshal(body, out); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
	}
}
func (f *fixture) ws(t *testing.T, login Login) *websocket.Conn {
	t.Helper()
	var ticket struct {
		Ticket string `json:"ticket"`
	}
	f.request(t, "POST", "/api/v2/realtime/tickets", login.Token, nil, 201, &ticket)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(f.http.URL, "http")+"/api/v2/realtime?ticket="+ticket.Ticket, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if hint := readHint(t, conn); hint.Type != "ready" {
		t.Fatal("socket was not ready before snapshot synchronization")
	}
	return conn
}
func (f *fixture) send(t *testing.T, key, body string) Message {
	t.Helper()
	out, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: key, Body: body})
	if err != nil {
		t.Fatal(err)
	}
	return out.Message
}
func (f *fixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := f.store.Pool.Exec(f.ctx, sql, args...); err != nil {
		t.Fatal(err)
	}
}
func readHint(t *testing.T, c *websocket.Conn) Hint {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	var h Hint
	if err := c.ReadJSON(&h); err != nil {
		t.Fatal(err)
	}
	return h
}
func TestEndToEndLoginSendReconnectRead(t *testing.T) {
	f := newFixture(t)
	bobWS := f.ws(t, f.bob)
	path := "/api/v2/conversations/" + f.cid
	var sent SendResult
	f.request(t, "POST", path+"/messages", f.alice.Token, SendInput{RequestID: "http-1", Body: "你好，消息🙂"}, 201, &sent)
	if sent.Message.Seq != 1 {
		t.Fatal("unexpected first sequence")
	}
	if _, err := f.service.DispatchOnce(f.ctx, f.hub); err != nil {
		t.Fatal(err)
	}
	hint := readHint(t, bobWS)
	if hint.Type != "conversation.changed" || hint.EventSeq != 1 || hint.ConversationID != f.cid {
		t.Fatalf("unexpected hint: %+v", hint)
	}
	var duplicate SendResult
	f.request(t, "POST", path+"/messages", f.alice.Token, SendInput{RequestID: "http-1", Body: "你好，消息🙂"}, 200, &duplicate)
	if !duplicate.Duplicate || duplicate.Message.ID != sent.Message.ID {
		t.Fatal("duplicate send produced a new message")
	}
	bobWS.Close()
	second := f.send(t, "offline-2", "离线时发送")
	// Simulate no realtime subscriber at dispatch time.
	f.hub.CloseSession(f.bob.SessionID)
	if _, err := f.service.DispatchOnce(f.ctx, f.hub); err != nil {
		t.Fatal(err)
	}
	reconnected := f.ws(t, f.bob)
	var page SyncPage
	f.request(t, "GET", path+"/sync?after=0&limit=1", f.bob.Token, nil, 200, &page)
	if page.SnapshotMaxSeq != 2 || page.NextAfterSeq != 1 || !page.HasMore || len(page.Events) != 1 {
		t.Fatalf("bad first page: %+v", page)
	}
	f.request(t, "GET", path+"/sync?after=1&snapshot_max_seq=2&limit=1", f.bob.Token, nil, 200, &page)
	if page.NextAfterSeq != 2 || page.HasMore || page.Events[0].Message.ID != second.ID {
		t.Fatal("offline message not recovered")
	}
	var state State
	f.request(t, "PUT", path+"/read", f.bob.Token, map[string]string{"seq": "2"}, 200, &state)
	if state.ReadSeq != 2 || state.DeliveredSeq != 2 || state.Version != 1 {
		t.Fatalf("read state: %+v", state)
	}
	if _, err := f.service.DispatchOnce(f.ctx, f.hub); err != nil {
		t.Fatal(err)
	}
	if hint = readHint(t, reconnected); hint.Type != "state.changed" || hint.UserID != f.bob.UserID {
		t.Fatal("read state was not synchronized")
	}
	f.request(t, "PUT", path+"/read", f.bob.Token, map[string]string{"seq": "1"}, 200, &state)
	if state.ReadSeq != 2 || state.Version != 1 {
		t.Fatal("older receipt regressed state or generated a write")
	}
	f.request(t, "PUT", path+"/read", f.bob.Token, map[string]string{"seq": "999"}, 400, nil)
	f.request(t, "POST", "/api/v2/auth/logout", f.bob.Token, nil, 204, nil)
	f.request(t, "GET", "/api/v2/me", f.bob.Token, nil, 401, nil)
	_ = reconnected.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := reconnected.ReadMessage(); err == nil {
		t.Fatal("logout kept its socket alive")
	}
}
func TestConcurrentSendIsIdempotentAndConflictChecked(t *testing.T) {
	f := newFixture(t)
	const count = 12
	results := make(chan SendResult, count)
	errs := make(chan error, count)
	var wg sync.WaitGroup
	for range count {
		wg.Go(func() {
			out, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "same", Body: "same content"})
			results <- out
			errs <- err
		})
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	id := ""
	for result := range results {
		if id == "" {
			id = result.Message.ID
		}
		if id != result.Message.ID {
			t.Fatal("concurrent request duplicated a message")
		}
	}
	if _, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "same", Body: "changed"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected request conflict, got %v", err)
	}
	for _, table := range []string{"messages", "events", "outbox"} {
		var n int
		if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse."+table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("%s has %d rows", table, n)
		}
	}
}
func TestRollbackAndOutboxLeaseRecovery(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "ALTER TABLE pulse.outbox ADD CONSTRAINT test_fail CHECK (kind <> 'conversation.changed')")
	_, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "rollback", Body: "must rollback"})
	if err == nil {
		t.Fatal("fault injection did not fail")
	}
	f.exec(t, "ALTER TABLE pulse.outbox DROP CONSTRAINT test_fail")
	var count, seq int64
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT message_seq FROM pulse.conversations WHERE id=$1", f.cid).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.messages").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if seq != 0 || count != 0 {
		t.Fatal("failed outbox insert left a partial message")
	}
	m := f.send(t, "retry-after-rollback", "now committed")
	if m.Seq != 1 {
		t.Fatal("rollback leaked sequence")
	}
	first, err := f.store.Claim(f.ctx, 1)
	if err != nil || len(first) != 1 {
		t.Fatalf("claim: %v", err)
	}
	next, err := f.store.Claim(f.ctx, 1)
	if err != nil || len(next) != 0 {
		t.Fatal("live lease was claimed twice")
	}
	f.exec(t, "UPDATE pulse.outbox SET lease_until=now()-interval '1 second'")
	recovered, err := f.store.Claim(f.ctx, 1)
	if err != nil || len(recovered) != 1 {
		t.Fatal("expired lease was not recovered")
	}
	if recovered[0].Lease == first[0].Lease {
		t.Fatal("recovery reused old lease")
	}
	if err = f.store.Finish(f.ctx, first[0]); err != nil {
		t.Fatal(err)
	}
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.outbox").Scan(&count); err != nil || count != 1 {
		t.Fatal("stale worker acknowledged a new lease")
	}
	if err = f.store.Finish(f.ctx, recovered[0]); err != nil {
		t.Fatal(err)
	}
	page, err := f.service.Sync(f.ctx, f.bob.Identity, f.cid, 0, nil, 100)
	if err != nil || len(page.Events) != 1 {
		t.Fatal("message not recoverable after outbox completion")
	}
}
func TestSnapshotFilteringAndRevocationDoNotReplayBodies(t *testing.T) {
	f := newFixture(t)
	first := f.send(t, "a", "private-original")
	f.send(t, "b", "second")
	page, err := f.service.Sync(f.ctx, f.bob.Identity, f.cid, 0, nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	upper := page.SnapshotMaxSeq
	f.send(t, "c", "outside original snapshot")
	next, err := f.service.Sync(f.ctx, f.bob.Identity, f.cid, page.NextAfterSeq, &upper, 1)
	if err != nil || next.HasMore || next.SnapshotMaxSeq != 2 || next.NextAfterSeq != 2 {
		t.Fatal("snapshot upper bound moved")
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	if _, err = f.service.MutateMessage(f.ctx, f.alice.Identity, f.cid, first.ID, "", 0, true); err != nil {
		t.Fatal(err)
	}
	page, err = f.service.Sync(f.ctx, f.bob.Identity, f.cid, 0, nil, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range page.Events {
		if event.Message.ID == first.ID && (!event.Message.Revoked || event.Message.Body != "") {
			t.Fatal("revoked original body leaked through old event")
		}
	}
	f.exec(t, "UPDATE pulse.user_states SET clear_seq=3 WHERE conversation_id=$1 AND user_id=$2", f.cid, f.bob.UserID)
	page, err = f.service.Sync(f.ctx, f.bob.Identity, f.cid, 0, nil, 2)
	if err != nil || len(page.Events) != 0 || page.NextAfterSeq != 2 || !page.HasMore {
		t.Fatal("filtered page did not advance")
	}
	page, err = f.service.Sync(f.ctx, f.bob.Identity, f.cid, page.NextAfterSeq, &page.SnapshotMaxSeq, 2)
	if err != nil || page.HasMore || len(page.Events) != 0 {
		t.Fatal("clear visibility failed")
	}
	f.exec(t, "UPDATE pulse.members SET active=false WHERE conversation_id=$1 AND user_id=$2", f.cid, f.bob.UserID)
	if _, err = f.service.Sync(f.ctx, f.bob.Identity, f.cid, 0, nil, 10); !errors.Is(err, ErrForbidden) {
		t.Fatal("departed member can sync")
	}
}
func TestForwardUsesCurrentSourceAndTargetAuthorization(t *testing.T) {
	f := newFixture(t)
	source := f.send(t, "source", "server-side source")
	f.request(t, "POST", "/api/v2/conversations/direct", f.alice.Token, map[string]string{"peer_id": f.carol.UserID}, 200, nil)
	if _, err := f.service.Send(f.ctx, f.carol.Identity, f.cid, SendInput{RequestID: "steal", SourceMessageID: source.ID}); !errors.Is(err, ErrForbidden) {
		t.Fatal("nonmember forwarded a private message")
	}
	f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", f.bob.UserID, f.alice.UserID)
	if _, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "blocked", SourceMessageID: source.ID}); !errors.Is(err, ErrForbidden) {
		t.Fatal("forward bypassed target block")
	}
	f.exec(t, "DELETE FROM pulse.blocks WHERE user_id=$1", f.bob.UserID)
	f.exec(t, "INSERT INTO pulse.message_deletions(user_id,message_id) VALUES($1,$2)", f.alice.UserID, source.ID)
	if _, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "deleted", SourceMessageID: source.ID}); !errors.Is(err, ErrForbidden) {
		t.Fatal("forward bypassed source visibility")
	}
	f.exec(t, "DELETE FROM pulse.message_deletions")
	out, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "forward-ok", SourceMessageID: source.ID})
	if err != nil || out.Message.Body != "server-side source" {
		t.Fatalf("legitimate forward failed: %v", err)
	}
	if _, err = f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "forged", SourceMessageID: source.ID, Body: "forged"}); !errors.Is(err, ErrInvalid) {
		t.Fatal("accepted forged forward body")
	}
}
