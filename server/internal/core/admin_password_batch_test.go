package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestBulkPasswordResetAtomicIdempotentAndPrivate(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	input := BulkPasswordInput{RequestID: "reset-two", UserIDs: []string{f.bob.UserID, f.alice.UserID}, Password: "Reset888"}
	var result BulkPasswordResult
	root.request(t, "POST", "/api/v2/admin/users/password-reset-batch", input, 200, &result)
	if result.Count != 2 || len(result.UserIDs) != 2 {
		t.Fatal("incorrect result")
	}
	for _, login := range []Login{f.alice, f.bob} {
		if _, err := f.service.Authenticate(f.ctx, login.Token); !errors.Is(err, ErrUnauthorized) {
			t.Fatal("old session survived")
		}
	}
	if _, err := f.service.Authenticate(f.ctx, f.carol.Token); err != nil {
		t.Fatal("unselected session changed", err)
	}
	var hashes []string
	rows, err := f.store.Pool.Query(f.ctx, "SELECT password_hash FROM pulse.users WHERE id=ANY($1::uuid[]) ORDER BY id", input.UserIDs)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var hash string
		if err = rows.Scan(&hash); err != nil {
			t.Fatal(err)
		}
		hashes = append(hashes, hash)
	}
	rows.Close()
	if len(hashes) != 2 || hashes[0] == hashes[1] {
		t.Fatal("users did not get independent salts")
	}
	login, err := f.service.Login(f.ctx, "alice01", input.Password, "reset-login", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Login(f.ctx, "bob01", input.Password, "reset-login", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	if err = f.service.ChangePassword(f.ctx, login.Identity, input.Password, "AfterReset9"); err != nil {
		t.Fatal(err)
	}
	newer, err := f.service.Login(f.ctx, "alice01", "AfterReset9", "later-login", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	root.request(t, "POST", "/api/v2/admin/users/password-reset-batch", input, 200, &result)
	if _, err = f.service.Authenticate(f.ctx, newer.Token); err != nil {
		t.Fatal("retry revoked a newer session", err)
	}
	if _, err = f.service.Login(f.ctx, "alice01", "AfterReset9", "verify-later", "127.0.0.1"); err != nil {
		t.Fatal("retry overwrote newer password", err)
	}
	input.Password = "Changed999"
	root.request(t, "POST", "/api/v2/admin/users/password-reset-batch", input, 409, nil)
	var audits int
	var details string
	f.store.Pool.QueryRow(f.ctx, "SELECT count(*),COALESCE(string_agg(details::text,','),'') FROM pulse.admin_audit WHERE action='user.password-reset-batch'").Scan(&audits, &details)
	if audits != 1 || strings.Contains(details, "Reset888") || !strings.Contains(details, f.bob.UserID) {
		t.Fatal("audit duplicated or leaked password")
	}
	var raw string
	f.store.Pool.QueryRow(f.ctx, "SELECT result::text FROM pulse.admin_create_requests WHERE request_id='reset-two'").Scan(&raw)
	if strings.Contains(raw, "Reset888") || !strings.Contains(raw, "$argon2id$") {
		t.Fatal("unsafe retry receipt")
	}
	bad := BulkPasswordInput{RequestID: "reset-unavailable", UserIDs: []string{f.carol.UserID, newID()}, Password: "Reset888"}
	root.request(t, "POST", "/api/v2/admin/users/password-reset-batch", bad, 409, nil)
	if _, err = f.service.Authenticate(f.ctx, f.carol.Token); err != nil {
		t.Fatal("invalid selection partially changed users")
	}
	bad.UserIDs = []string{f.carol.UserID, f.carol.UserID}
	root.request(t, "POST", "/api/v2/admin/users/password-reset-batch", bad, 400, nil)
	bad.UserIDs = []string{f.carol.UserID}
	bad.Password = "short"
	root.request(t, "POST", "/api/v2/admin/users/password-reset-batch", bad, 400, nil)
	f.exec(t, "UPDATE pulse.users SET deleted_at=now(),active=false WHERE id=$1", f.carol.UserID)
	bad.Password = "Reset888"
	root.request(t, "POST", "/api/v2/admin/users/password-reset-batch", bad, 409, nil)
	f.exec(t, "UPDATE pulse.users SET active=false WHERE id=$1", f.bob.UserID)
	frozen := BulkPasswordInput{RequestID: "reset-frozen", UserIDs: []string{f.bob.UserID}, Password: "Frozen88"}
	root.request(t, "POST", "/api/v2/admin/users/password-reset-batch", frozen, 200, nil)
	var active bool
	f.store.Pool.QueryRow(f.ctx, "SELECT active FROM pulse.users WHERE id=$1", f.bob.UserID).Scan(&active)
	if active {
		t.Fatal("reset unfroze user")
	}
}

func TestBulkPasswordResetPermissionCSRFAndConcurrentRetry(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	created, err := f.service.SaveAdmin(f.ctx, root.who, "", AdminAccountInput{Account: "resetreader", Password: testPassword, Role: "auditor", Permissions: []string{"users.view"}, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	reader := &adminClient{f: f, entry: created["entry_token"].(string)}
	reader.login(t, "resetreader", testPassword)
	input := BulkPasswordInput{RequestID: "reset-parallel", UserIDs: []string{f.alice.UserID, f.bob.UserID}, Password: "Reset888"}
	reader.request(t, "POST", "/api/v2/admin/users/password-reset-batch", input, 403, nil)
	csrf := root.csrf
	root.csrf = "invalid"
	root.request(t, "POST", "/api/v2/admin/users/password-reset-batch", input, 403, nil)
	root.csrf = csrf
	start := make(chan struct{})
	errs := make(chan error, 2)
	var workers sync.WaitGroup
	for i := 0; i < 2; i++ {
		workers.Go(func() {
			<-start
			result, err := f.service.BulkResetPasswords(f.ctx, root.who, input)
			if err == nil && result.Count != 2 {
				err = errors.New("bad result")
			}
			errs <- err
		})
	}
	close(start)
	workers.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var count int
	f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.admin_audit WHERE action='user.password-reset-batch'").Scan(&count)
	if count != 1 {
		t.Fatal("duplicate audit")
	}
	f.exec(t, "UPDATE pulse.admin_accounts SET active=false WHERE id=$1", root.who.ID)
	if _, err = f.service.BulkResetPasswords(f.ctx, root.who, input); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("revoked admin replayed operation", err)
	}
}

func TestBulkPasswordResetRollsBackWhenAuditFails(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	f.exec(t, `CREATE FUNCTION pulse.reject_reset_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='user.password-reset-batch' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`)
	f.exec(t, `CREATE TRIGGER reject_reset_audit BEFORE INSERT ON pulse.admin_audit FOR EACH ROW EXECUTE FUNCTION pulse.reject_reset_audit()`)
	defer f.exec(t, "DROP TRIGGER reject_reset_audit ON pulse.admin_audit; DROP FUNCTION pulse.reject_reset_audit()")
	input := BulkPasswordInput{RequestID: "reset-audit-failure", UserIDs: []string{f.alice.UserID, f.bob.UserID}, Password: "Reset888"}
	if _, err := f.service.BulkResetPasswords(f.ctx, root.who, input); err == nil {
		t.Fatal("reset committed without audit")
	}
	if _, err := f.service.Authenticate(f.ctx, f.alice.Token); err != nil {
		t.Fatal("audit failure invalidated session")
	}
	if _, err := f.service.Login(f.ctx, "alice01", testPassword, "audit-failure", "127.0.0.1"); err != nil {
		t.Fatal("audit failure changed password")
	}
}

func TestBulkPasswordResetDisconnectsExistingRealtime(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	connection := f.ws(t, f.alice)
	defer connection.Close()
	input := BulkPasswordInput{RequestID: "reset-live", UserIDs: []string{f.alice.UserID}, Password: "Reset888"}
	raw, _ := json.Marshal(input)
	req, _ := http.NewRequest("POST", f.http.URL+"/api/v2/admin/users/password-reset-batch", bytes.NewReader(raw))
	req.AddCookie(root.cookie)
	req.Header.Set("X-Admin-Entry", root.entry)
	req.Header.Set("X-CSRF-Token", root.csrf)
	req.Header.Set("Content-Type", "application/json")
	response, err := f.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("reset failed")
	}
	connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = connection.ReadMessage()
	if err == nil {
		t.Fatal("existing realtime remained open")
	}
}
