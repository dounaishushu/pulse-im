package core

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAuthenticatedMessagingDoesNotUsePerUserQuotas(t *testing.T) {
	f := newFixture(t)
	// Exhaust the old Redis counters. Authenticated delivery must continue.
	for _, scope := range []string{"api", "api-media", "send"} {
		for i := 0; i < 3; i++ {
			_ = f.cache.Allow(f.ctx, scope, f.alice.UserID, 1, time.Minute)
		}
	}
	_ = f.cache.Client.Close()
	for i := 0; i < 40; i++ {
		f.request(t, "POST", "/api/v2/conversations/"+f.cid+"/messages", f.alice.Token,
			SendInput{RequestID: fmt.Sprintf("unlimited-%d", i), Body: "queued message"}, 201, nil)
	}
	var count int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.messages WHERE conversation_id=$1", f.cid).Scan(&count); err != nil || count != 40 {
		t.Fatalf("count=%d error=%v", count, err)
	}
}

func TestRequestAdmissionWaitsForCapacity(t *testing.T) {
	api := &API{slots: make(chan struct{}, 1)}
	api.slots <- struct{}{}
	entered := make(chan struct{}, 1)
	handler := api.wrapTimed(false, time.Second, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
		entered <- struct{}{}
		w.WriteHeader(204)
		return nil
	})
	output := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { handler(output, httptest.NewRequest("POST", "/test", strings.NewReader("{}"))); close(done) }()
	select {
	case <-done:
		t.Fatal("busy admission rejected instead of waiting")
	case <-time.After(30 * time.Millisecond):
	}
	<-api.slots
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("waiting request never admitted")
	}
	if output.Code != 204 || len(entered) != 1 {
		t.Fatalf("status=%d", output.Code)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	api.slots <- struct{}{}
	canceled := httptest.NewRecorder()
	handler(canceled, httptest.NewRequest("POST", "/test", nil).WithContext(ctx))
	if canceled.Code != 503 {
		t.Fatalf("canceled request status=%d", canceled.Code)
	}
}

func TestImportedExcessSessionsNeverPreventNewLogin(t *testing.T) {
	f := newFixture(t)
	for i := 0; i < 19; i++ {
		f.exec(t, "INSERT INTO pulse.login_sessions(id,user_id,device_id,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')", newID(), f.alice.UserID, fmt.Sprintf("legacy-device-%d", i), digest(newID()))
	}
	login, err := f.service.Login(f.ctx, "alice01", testPassword, "new-client", "new-login")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Authenticate(f.ctx, login.Token); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.login_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()", f.alice.UserID).Scan(&count); err != nil || count != 8 {
		t.Fatalf("count=%d error=%v", count, err)
	}
}
