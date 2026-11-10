package core

import (
	"errors"
	"testing"
	"time"
)

func TestDeviceSessionsAndPasswordChangeRevokeAll(t *testing.T) {
	f := newFixture(t)
	other, err := f.service.Login(f.ctx, "alice01", testPassword, "phone-2", "login-test")
	if err != nil {
		t.Fatal(err)
	}
	items, err := f.service.Sessions(f.ctx, f.alice.Identity)
	if err != nil || len(items) != 2 {
		t.Fatalf("session list: %+v %v", items, err)
	}
	var currentCount int
	for _, item := range items {
		if item.Current {
			currentCount++
		}
		if item.ID == other.SessionID && item.DeviceID != "phone-2" {
			t.Fatal("wrong device")
		}
	}
	if currentCount != 1 {
		t.Fatal("current session not marked once")
	}
	if err = f.service.RevokeSession(f.ctx, f.bob.Identity, other.SessionID); !errors.Is(err, ErrMissing) {
		t.Fatal("other user revoked session")
	}
	if err = f.service.RevokeSession(f.ctx, f.alice.Identity, other.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Authenticate(f.ctx, other.Token); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("revoked session accepted")
	}
	other, err = f.service.Login(f.ctx, "alice01", testPassword, "phone-2", "login-test")
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.ChangePassword(f.ctx, f.alice.Identity, "wrong password", "NewStrongPassword2026"); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("wrong current password accepted")
	}
	if err = f.service.ChangePassword(f.ctx, f.alice.Identity, testPassword, "NewStrongPassword2026"); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Authenticate(f.ctx, f.alice.Token); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("current session survived password change")
	}
	if _, err = f.service.Authenticate(f.ctx, other.Token); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("other device survived password change")
	}
	if _, err = f.service.Login(f.ctx, "alice01", testPassword, "desktop-a", "login-test"); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("old password accepted")
	}
	if _, err = f.service.Login(f.ctx, "alice01", "NewStrongPassword2026", "desktop-a", "login-test"); err != nil {
		t.Fatal("new password rejected: ", err)
	}
}

func TestHTTPDeviceSessionsAndPasswordChangeCloseSocket(t *testing.T) {
	f := newFixture(t)
	ws := f.ws(t, f.alice)
	var response struct {
		Items []DeviceSession `json:"items"`
	}
	f.request(t, "GET", "/api/v2/auth/sessions", f.alice.Token, nil, 200, &response)
	if len(response.Items) != 1 || !response.Items[0].Current {
		t.Fatal("HTTP session list invalid")
	}
	f.request(t, "DELETE", "/api/v2/auth/sessions/"+f.bob.SessionID, f.alice.Token, nil, 404, nil)
	f.request(t, "PUT", "/api/v2/auth/password", f.alice.Token, map[string]string{
		"current_password": testPassword, "new_password": "AnotherSecurePass2026"}, 204, nil)
	_ = ws.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("old socket survived password change")
	}
	f.request(t, "GET", "/api/v2/me", f.alice.Token, nil, 401, nil)
	f.request(t, "POST", "/api/v2/auth/login", "", map[string]string{
		"account": "alice01", "password": "AnotherSecurePass2026", "device_id": "desktop-a"}, 200, nil)
}
