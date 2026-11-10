package core

import (
	"context"
	"errors"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCommitOrderAndOutboxHaveNoGlobalWatermarkGap(t *testing.T) {
	f := newFixture(t)
	tx, err := f.store.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	if err = lockConversations(f.ctx, tx, []string{f.cid}); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(f.ctx, "UPDATE pulse.conversations SET message_seq=1,event_seq=1 WHERE id=$1", f.cid); err != nil {
		t.Fatal(err)
	}
	mid := newID()
	if _, err = tx.Exec(f.ctx, `INSERT INTO pulse.messages(id,conversation_id,seq,event_seq,sender_id,request_id,request_hash,body)
        VALUES($1,$2,1,1,$3,'held',$4,'held transaction')`, mid, f.cid, f.alice.UserID, digest("held")); err != nil {
		t.Fatal(err)
	}
	if err = recordEvent(f.ctx, tx, f.cid, 1, "message.created", mid); err != nil {
		t.Fatal(err)
	}
	type answer struct {
		result SendResult
		err    error
	}
	finished := make(chan answer, 1)
	go func() {
		result, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "following", Body: "second"})
		finished <- answer{result, err}
	}()
	select {
	case result := <-finished:
		t.Fatalf("writer passed uncommitted predecessor: %v", result.err)
	case <-time.After(50 * time.Millisecond):
	}
	before, err := f.service.Sync(f.ctx, f.bob.Identity, f.cid, 0, nil, 100)
	if err != nil || before.SnapshotMaxSeq != 0 || len(before.Events) != 0 {
		t.Fatal("uncommitted message was visible")
	}
	if err = tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-finished:
		if result.err != nil || result.result.Message.Seq != 2 {
			t.Fatalf("following write: %v", result.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("writer did not resume")
	}
	after, err := f.service.Sync(f.ctx, f.bob.Identity, f.cid, 0, nil, 100)
	if err != nil || len(after.Events) != 2 || after.Events[0].Message.ID != mid {
		t.Fatal("committed predecessor was skipped")
	}
	f.exec(t, "DELETE FROM pulse.outbox")
	late, err := f.store.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer late.Rollback(f.ctx)
	low := "00000000-0000-4000-8000-000000000001"
	high := "ffffffff-ffff-4fff-bfff-ffffffffffff"
	if _, err = late.Exec(f.ctx, "INSERT INTO pulse.outbox(id,conversation_id,event_seq,kind) VALUES($1,$2,1,'conversation.changed')", low, f.cid); err != nil {
		t.Fatal(err)
	}
	f.exec(t, "INSERT INTO pulse.outbox(id,conversation_id,event_seq,kind) VALUES($1,$2,2,'conversation.changed')", high, f.cid)
	first, err := f.store.Claim(f.ctx, 1)
	if err != nil || len(first) != 1 || first[0].ID != high {
		t.Fatal("expected first committed outbox row")
	}
	if err = f.store.Finish(f.ctx, first[0]); err != nil {
		t.Fatal(err)
	}
	if err = late.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	second, err := f.store.Claim(f.ctx, 1)
	if err != nil || len(second) != 1 || second[0].ID != low {
		t.Fatal("lower-ID late commit was lost")
	}
}
func TestGroupPermissionsAndConstantMessageWrites(t *testing.T) {
	f := newFixture(t)
	group := newID()
	f.exec(t, "INSERT INTO pulse.conversations(id,kind,title,mute_all) VALUES($1,'group','test group',true)", group)
	for _, u := range []Login{f.alice, f.bob, f.carol} {
		role := "member"
		if u.UserID == f.bob.UserID {
			role = "owner"
		}
		f.exec(t, "INSERT INTO pulse.members(conversation_id,user_id,role) VALUES($1,$2,$3)", group, u.UserID, role)
		f.exec(t, "INSERT INTO pulse.user_states(conversation_id,user_id) VALUES($1,$2)", group, u.UserID)
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	in := SendInput{RequestID: "group", Body: "group message"}
	if _, err := f.service.Send(f.ctx, f.alice.Identity, group, in); !errors.Is(err, ErrForbidden) {
		t.Fatal("internal staff bypassed group mute-all")
	}
	f.exec(t, "UPDATE pulse.members SET muted=true WHERE conversation_id=$1 AND user_id=$2", group, f.bob.UserID)
	if _, err := f.service.Send(f.ctx, f.bob.Identity, group, in); !errors.Is(err, ErrForbidden) {
		t.Fatal("owner bypassed individual mute")
	}
	f.exec(t, "UPDATE pulse.members SET muted=false WHERE conversation_id=$1", group)
	f.exec(t, "UPDATE pulse.users SET can_send=false WHERE id=$1", f.bob.UserID)
	if _, err := f.service.Send(f.ctx, f.bob.Identity, group, in); !errors.Is(err, ErrForbidden) {
		t.Fatal("owner bypassed account speech restriction")
	}
	f.exec(t, "UPDATE pulse.users SET can_send=true WHERE id=$1", f.bob.UserID)
	sent, err := f.service.Send(f.ctx, f.bob.Identity, group, in)
	if err != nil {
		t.Fatal(err)
	}
	var changed int
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.user_states WHERE conversation_id=$1 AND (version<>0 OR read_seq<>0 OR delivered_seq<>0)", group).Scan(&changed); err != nil || changed != 0 {
		t.Fatal("group send rewrote member read states")
	}
	if _, err = f.service.MutateMessage(f.ctx, f.carol.Identity, group, sent.Message.ID, "other text", 1, false); !errors.Is(err, ErrForbidden) {
		t.Fatal("ordinary member edited another user's text")
	}
	if _, err = f.service.MutateMessage(f.ctx, f.bob.Identity, group, sent.Message.ID, "", 0, true); !errors.Is(err, ErrForbidden) {
		t.Fatal("group role granted internal-only recall")
	}
	f.exec(t, "UPDATE pulse.conversations SET mute_all=false WHERE id=$1", group)
	edited, err := f.service.MutateMessage(f.ctx, f.alice.Identity, group, sent.Message.ID, "edited by authorized staff", 1, false)
	if err != nil || edited.Version != 2 {
		t.Fatalf("authorized edit failed: %v", err)
	}
	if _, err = f.service.MutateMessage(f.ctx, f.bob.Identity, group, sent.Message.ID, "stale edit", 1, false); !errors.Is(err, ErrConflict) {
		t.Fatal("stale edit overwrote a newer version")
	}
	f.exec(t, "UPDATE pulse.conversations SET kind='channel' WHERE id=$1", group)
	if _, err = f.service.Send(f.ctx, f.alice.Identity, group, SendInput{RequestID: "channel", Body: "attempt"}); !errors.Is(err, ErrForbidden) {
		t.Fatal("channel publish role bypass")
	}
}
func TestSessionsSurviveServiceRestartAndRevocationStopsWork(t *testing.T) {
	f := newFixture(t)
	restarted, err := NewService(f.store, f.cache)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = restarted.Authenticate(f.ctx, f.alice.Token); err != nil {
		t.Fatal("restart lost a durable login")
	}
	ws := f.ws(t, f.alice)
	f.exec(t, "UPDATE pulse.users SET active=false WHERE id=$1", f.alice.UserID)
	if _, err = f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "stale", Body: "stale identity"}); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("stale authenticated identity bypassed freeze")
	}
	if err = f.service.Sweep(f.ctx, f.hub); err != nil {
		t.Fatal(err)
	}
	_ = ws.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err = ws.ReadMessage(); err == nil {
		t.Fatal("frozen account retained socket")
	}
	f.exec(t, "UPDATE pulse.users SET active=true WHERE id=$1", f.alice.UserID)
	// Re-login on the same device invalidates the old token across service instances.
	var latest Login
	f.request(t, "POST", "/api/v2/auth/login", "", map[string]string{"account": "alice01", "password": testPassword, "device_id": "desktop-a"}, 200, &latest)
	if _, err = restarted.Authenticate(f.ctx, f.alice.Token); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("old device token remained valid")
	}
	if _, err = restarted.Authenticate(f.ctx, latest.Token); err != nil {
		t.Fatal("new credential was not durable")
	}
}
func TestRedisLimitsTicketsExpiryAndPresence(t *testing.T) {
	f := newFixture(t)
	for range 3 {
		if err := f.cache.Allow(f.ctx, "unit", "id", 3, time.Minute); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.cache.Allow(f.ctx, "unit", "id", 3, time.Minute); !errors.Is(err, ErrLimited) {
		t.Fatal("limit not enforced")
	}
	ticket, err := f.cache.Ticket(f.ctx, f.alice.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	sid, err := f.cache.TakeTicket(f.ctx, ticket)
	if err != nil || sid != f.alice.SessionID {
		t.Fatal("ticket did not resolve")
	}
	if _, err = f.cache.TakeTicket(f.ctx, ticket); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("ticket replay accepted")
	}
	ticket, err = f.cache.Ticket(f.ctx, f.alice.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	// Force only this test's ticket expiry, then exercise the normal consume path.
	keys, _, err := f.cache.Client.Scan(f.ctx, 0, f.cache.Prefix+"ticket:*", 100).Result()
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range keys {
		if err = f.cache.Client.PExpire(f.ctx, key, 0).Err(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = f.cache.TakeTicket(f.ctx, ticket); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("expired ticket accepted")
	}
	_ = f.ws(t, f.bob)
	if err = f.service.Sweep(f.ctx, f.hub); err != nil {
		t.Fatal(err)
	}
	keys, _, err = f.cache.Client.Scan(f.ctx, 0, f.cache.Prefix+"online:*", 100).Result()
	if err != nil || len(keys) != 1 {
		t.Fatal("online status not written to Redis")
	}
	ttl, err := f.cache.Client.TTL(f.ctx, keys[0]).Result()
	if err != nil || ttl <= 0 || ttl > 75*time.Second {
		t.Fatal("presence must expire")
	}
}
func TestRedisFailureKeepsBoundedReadRecoveryButRejectsWrites(t *testing.T) {
	f := newFixture(t)
	f.send(t, "before-redis-down", "durable")
	_ = f.cache.Client.Close() // Isolate this client's outage, leave shared Redis running.
	var page SyncPage
	path := "/api/v2/conversations/" + f.cid
	f.request(t, "GET", path+"/sync", f.bob.Token, nil, 200, &page)
	if len(page.Events) != 1 {
		t.Fatal("database recovery failed during cache outage")
	}
	f.request(t, "POST", path+"/messages", f.alice.Token, SendInput{RequestID: "outage", Body: "must not write"}, 503, nil)
	f.request(t, "POST", "/api/v2/realtime/tickets", f.alice.Token, nil, 503, nil)
	f.request(t, "GET", "/readyz", "", nil, 503, nil)
}
func TestWebSocketReplacementOriginAndFrameLimits(t *testing.T) {
	f := newFixture(t)
	old := f.ws(t, f.bob)
	fresh := f.ws(t, f.bob)
	_ = old.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := old.ReadMessage(); err == nil {
		t.Fatal("superseded socket still open")
	}
	f.send(t, "replacement", "for new socket")
	if _, err := f.service.DispatchOnce(f.ctx, f.hub); err != nil {
		t.Fatal(err)
	}
	if h := readHint(t, fresh); h.Type != "conversation.changed" {
		t.Fatal("old cleanup removed replacement")
	}
	var ticket struct {
		Ticket string `json:"ticket"`
	}
	f.request(t, "POST", "/api/v2/realtime/tickets", f.bob.Token, nil, 201, &ticket)
	headers := http.Header{"Origin": []string{"https://untrusted.invalid"}}
	conn, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(f.http.URL, "http")+"/api/v2/realtime?ticket="+ticket.Ticket, headers)
	if conn != nil {
		conn.Close()
	}
	if err == nil || resp == nil || resp.StatusCode != 403 {
		t.Fatal("untrusted WebSocket origin accepted")
	}
	if err = fresh.WriteMessage(websocket.TextMessage, []byte(strings.Repeat("x", 8192))); err != nil {
		t.Fatal(err)
	}
	_ = fresh.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err = fresh.ReadMessage(); err == nil {
		t.Fatal("oversized frame accepted")
	}
}
func TestRequestValidationAndHTTPGuards(t *testing.T) {
	f := newFixture(t)
	path := "/api/v2/conversations/" + f.cid
	f.request(t, "POST", path+"/messages", f.alice.Token, map[string]string{"request_id": "bad", "body": "ok", "sender_id": f.bob.UserID}, 400, nil)
	f.request(t, "POST", path+"/messages", f.alice.Token, SendInput{RequestID: "huge", Body: strings.Repeat("文", 5001)}, 400, nil)
	f.request(t, "PUT", path+"/read", f.alice.Token, map[string]int{"seq": 1}, 400, nil)
	f.request(t, "GET", path+"/sync?limit=101", f.alice.Token, nil, 400, nil)
	f.request(t, "GET", path+"/sync?after=-1", f.alice.Token, nil, 400, nil)
	f.request(t, "GET", path+"/sync?snapshot_max_seq=999", f.alice.Token, nil, 400, nil)
	f.request(t, "GET", path+"/sync", f.carol.Token, nil, 403, nil)
	f.request(t, "GET", "/local-storage/anything", "", nil, 404, nil)
	f.request(t, "GET", "/api/v2/me?Authorization="+f.alice.Token, "", nil, 401, nil)
}
func TestBoundedSocketQueuesAndReplacementIdentity(t *testing.T) {
	h := NewHub(2, 1<<20)
	identity := Identity{UserID: newID(), SessionID: newID(), DeviceID: "test", ExpiresAt: time.Now().Add(time.Hour)}
	makeSocket := func() *socket {
		return &socket{identity: identity, id: newID(), hub: h, send: make(chan []byte, 64), done: make(chan struct{})}
	}
	old, fresh := makeSocket(), makeSocket()
	if !h.add(old) || !h.add(fresh) {
		t.Fatal("failed to register")
	}
	old.close()
	if h.sessions[identity.SessionID] != fresh {
		t.Fatal("old cleanup removed new connection")
	}
	for range 64 {
		if !fresh.enqueue([]byte("hint")) {
			t.Fatal("queue full before configured bound")
		}
	}
	if fresh.enqueue([]byte("overflow")) {
		t.Fatal("queue not bounded")
	}
	if h.queuedBytes.Load() != 0 {
		t.Fatal("close leaked queue memory accounting")
	}
	h = NewHub(1, 16)
	a := &socket{identity: identity, hub: h, send: make(chan []byte, 64), done: make(chan struct{})}
	if a.enqueue(make([]byte, 17)) {
		t.Fatal("global bytes bound ignored")
	}
	if h.queuedBytes.Load() != 0 {
		t.Fatal("budget not released on rejection")
	}
	if !h.reserve() || h.reserve() {
		t.Fatal("connection capacity not bounded")
	}
	<-h.slots
	h.Close()
	if h.reserve() {
		t.Fatal("new connection reserved during shutdown")
	}
}
func TestPasswordParametersAreBounded(t *testing.T) {
	hash, err := hashPassword("RealisticPassword10")
	if err != nil {
		t.Fatal(err)
	}
	if !verifyPassword("RealisticPassword10", hash) || verifyPassword("incorrect", hash) {
		t.Fatal("password verification mismatch")
	}
	for _, bad := range []string{
		strings.Replace(hash, "m=65536", "m=4294967295", 1),
		strings.Replace(hash, "p=2", "p=0", 1),
		strings.Replace(hash, "t=3", "t=0", 1),
		strings.Replace(hash, "v=19", "v=18", 1),
		hash + "extraneous",
	} {
		if verifyPassword("RealisticPassword10", bad) {
			t.Fatal("unsafe encoded hash was accepted")
		}
	}
	if _, err = hashPassword("short"); !errors.Is(err, ErrInvalid) {
		t.Fatal("short password accepted")
	}
}
func TestBackgroundDispatcherDeliversCommittedHint(t *testing.T) {
	f := newFixture(t)
	conn := f.ws(t, f.bob)
	f.workers.Go(func() { f.service.RunDispatcher(f.ctx, f.hub) })
	f.send(t, "automatic", "automatically dispatched")
	if h := readHint(t, conn); h.EventSeq != 1 {
		t.Fatal("background worker failed")
	}
	// Nothing depends on Redis Pub/Sub or an in-memory retry surviving restart.
	ctx, cancel := context.WithTimeout(f.ctx, time.Second)
	defer cancel()
	page, err := f.service.Sync(ctx, f.bob.Identity, f.cid, 0, nil, 100)
	if err != nil || len(page.Events) != 1 {
		t.Fatal("durable event missing")
	}
}

func TestReadDetailsStayPrivateAndSenderOnlyAggregate(t *testing.T) {
	f := newFixture(t)
	aliceWS := f.ws(t, f.alice)
	m := f.send(t, "receipt-privacy", "sender-owned")
	if _, err := f.service.DispatchOnce(f.ctx, f.hub); err != nil {
		t.Fatal(err)
	}
	_ = readHint(t, aliceWS)
	if _, err := f.service.Advance(f.ctx, f.bob.Identity, f.cid, 1, true); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.DispatchOnce(f.ctx, f.hub); err != nil {
		t.Fatal(err)
	}
	hint := readHint(t, aliceWS)
	if hint.Type != "receipts.changed" || hint.UserID != "" || hint.StateVersion != 0 {
		t.Fatal("reader identity leaked in notification")
	}
	states, err := f.service.States(f.ctx, f.alice.Identity, f.cid, "")
	if err != nil || len(states) != 1 || states[0].UserID != f.alice.UserID {
		t.Fatal("other member's cursor exposed")
	}
	result, err := f.service.Receipts(f.ctx, f.alice.Identity, f.cid, m.ID)
	if err != nil || result.ReadCount != 1 || result.DeliveredCount != 1 || result.RecipientCount != 1 {
		t.Fatalf("receipt aggregation: %+v, %v", result, err)
	}
	if _, err = f.service.Receipts(f.ctx, f.bob.Identity, f.cid, m.ID); !errors.Is(err, ErrForbidden) {
		t.Fatal("non-sender queried aggregate")
	}
	f.request(t, "GET", "/api/v2/conversations/"+f.cid+"/messages/"+m.ID+"/receipts", f.alice.Token, nil, 200, &result)
	f.request(t, "GET", "/api/v2/conversations/"+f.cid+"/messages/"+m.ID+"/receipts", f.bob.Token, nil, 403, nil)
	f.exec(t, "UPDATE pulse.user_states SET clear_seq=1 WHERE conversation_id=$1 AND user_id=$2", f.cid, f.alice.UserID)
	if _, err = f.service.Receipts(f.ctx, f.alice.Identity, f.cid, m.ID); !errors.Is(err, ErrForbidden) {
		t.Fatal("invisible message receipt exposed")
	}
}
func TestDeviceSessionCapAndLogoutWithoutRedis(t *testing.T) {
	f := newFixture(t)
	for i := 0; i < 7; i++ {
		f.exec(t, "INSERT INTO pulse.login_sessions(id,user_id,device_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",
			newID(), f.alice.UserID, newID(), digest(newID()))
	}
	_, err := f.service.Login(f.ctx, "alice01", testPassword, "ninth-device", "session-cap-test")
	var fault *Fault
	if !errors.As(err, &fault) || fault.Code != "device_session_limit" {
		t.Fatalf("session cap missing: %v", err)
	}
	_ = f.cache.Client.Close()
	f.request(t, "POST", "/api/v2/auth/logout", f.alice.Token, nil, 204, nil)
	if _, err = f.service.Authenticate(f.ctx, f.alice.Token); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("Redis outage blocked credential revocation")
	}
}

func TestReadyCannotBeOvertakenByConcurrentDispatch(t *testing.T) {
	f := newFixture(t)
	f.send(t, "during-upgrade", "event before ready")
	errc := make(chan error, 1)
	raw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hub.Serve(w, r, f.bob.Identity, nil, func(ctx context.Context, sid string) (Identity, error) {
			_, err := f.service.DispatchOnce(ctx, f.hub)
			errc <- err
			return f.service.Session(ctx, sid)
		})
	}))
	defer raw.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(raw.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if hint := readHint(t, conn); hint.Type != "ready" {
		t.Fatal("concurrent hint overtook initial ready")
	}
	if hint := readHint(t, conn); hint.Type != "conversation.changed" {
		t.Fatal("event queued during upgrade was lost")
	}
	if err = <-errc; err != nil {
		t.Fatal(err)
	}
}
