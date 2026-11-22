package core

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func enablePasswordCopies(t *testing.T, f *fixture) {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	vault, err := newUserPasswordVault(base64.StdEncoding.EncodeToString(key))
	if err != nil {
		t.Fatal(err)
	}
	f.service.passwordVault = vault
}

func checkPasswordCopy(t *testing.T, f *fixture, uid, expected string) {
	t.Helper()
	var hash, verifier, keyID string
	var sealed []byte
	if err := f.store.Pool.QueryRow(f.ctx, `SELECT u.password_hash,v.verifier,v.key_id,v.ciphertext FROM pulse.users u JOIN pulse.user_password_copies v ON v.user_id=u.id WHERE u.id=$1`, uid).Scan(&hash, &verifier, &keyID, &sealed); err != nil {
		t.Fatal(err)
	}
	vault := f.service.passwordVault
	if hash != verifier || keyID != vault.keyID || bytes.Contains(sealed, []byte(expected)) {
		t.Fatal("copy was not encrypted and bound to the current verifier")
	}
	plain, err := vault.aead.Open(nil, sealed[:vault.aead.NonceSize()], sealed[vault.aead.NonceSize():], passwordCopyAAD(uid, verifier))
	if err != nil || string(plain) != expected || !verifyPassword(expected, hash) {
		t.Fatal("copy differs from the password accepted by login")
	}
	clear(plain)
}

func TestUserPasswordCopiesRequireValidIndependentKey(t *testing.T) {
	if vault, err := newUserPasswordVault(" "); err != nil || vault != nil {
		t.Fatal("optional feature enabled without a key")
	}
	for _, invalid := range []string{"not-base64!", base64.StdEncoding.EncodeToString(make([]byte, 31)), strings.Repeat("!", 10000)} {
		if _, err := newUserPasswordVault(invalid); err == nil || strings.Contains(err.Error(), invalid) {
			t.Fatal("invalid key was accepted or exposed in diagnostics")
		}
	}
	t.Setenv("PULSE_USER_PASSWORD_ENCRYPTION_KEY", "bad-config")
	if _, err := NewService(nil, nil); err == nil {
		t.Fatal("bad key silently disabled password encryption")
	}
}

func TestUserPasswordCopiesPermissionsReauthenticationAndNoLeaks(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	enablePasswordCopies(t, f)
	uid := f.alice.UserID
	statusPath := "/api/v2/admin/users/" + uid + "/password-status"
	revealPath := "/api/v2/admin/users/" + uid + "/password-reveal"
	var state userPasswordStatus
	root.request(t, "GET", statusPath, nil, 200, &state)
	if state.Available || state.Reason != "not_recorded" {
		t.Fatal("historical hash became a recoverable password")
	}
	// Successful login must not secretly capture an existing user's password.
	if _, err := f.service.Login(f.ctx, "alice01", testPassword, "no-capture", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	root.request(t, "POST", revealPath, map[string]string{"admin_password": testPassword}, 409, nil)
	root.request(t, "PATCH", "/api/v2/admin/users/"+uid, AdminUserPatch{Password: "NewUser888", Expected: 1}, 204, nil)
	checkPasswordCopy(t, f, uid, "NewUser888")
	root.request(t, "GET", statusPath, nil, 200, &state)
	if !state.Available {
		t.Fatal("new password was not available")
	}
	if _, err := f.service.Authenticate(f.ctx, f.alice.Token); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("reset did not revoke the old user session")
	}
	root.request(t, "POST", revealPath, map[string]string{"admin_password": "wrong-admin-password"}, 422, nil)
	var revealed userPasswordReveal
	root.request(t, "POST", revealPath, map[string]string{"admin_password": testPassword}, 200, &revealed)
	if revealed.Password != "NewUser888" || revealed.VisibleForSeconds != 30 || revealed.UpdatedAt.IsZero() {
		t.Fatal("incorrect reveal response")
	}
	var profile, list json.RawMessage
	root.request(t, "GET", "/api/v2/admin/users/"+uid, nil, 200, &profile)
	root.request(t, "GET", "/api/v2/admin/users", nil, 200, &list)
	for _, raw := range []json.RawMessage{profile, list} {
		for _, forbidden := range []string{"NewUser888", "password_hash", "ciphertext", "verifier", "key_id"} {
			if bytes.Contains(raw, []byte(forbidden)) {
				t.Fatal("credential data leaked through a normal user endpoint")
			}
		}
	}
	var successes, denied int
	var details string
	if err := f.store.Pool.QueryRow(f.ctx, `SELECT count(*) FILTER(WHERE action='user.password-reveal'),count(*) FILTER(WHERE action='user.password-reveal-denied'),string_agg(details::text,' ') FROM pulse.admin_audit`).Scan(&successes, &denied, &details); err != nil {
		t.Fatal(err)
	}
	if successes != 1 || denied != 1 || strings.Contains(details, "NewUser888") || strings.Contains(details, testPassword) || strings.Contains(details, "wrong-admin-password") {
		t.Fatal("reveal audit missing or contained credentials")
	}
	csrf := root.csrf
	root.csrf = "invalid"
	root.request(t, "POST", revealPath, map[string]string{"admin_password": testPassword}, 403, nil)
	root.csrf = csrf
	f.request(t, "POST", revealPath, f.bob.Token, map[string]string{"admin_password": testPassword}, 401, nil)
	created, err := f.service.SaveAdmin(f.ctx, root.who, "", AdminAccountInput{Account: "pwoperator", Password: testPassword, Role: "operator", Permissions: []string{"users.manage"}, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	operator := &adminClient{f: f, entry: created["entry_token"].(string)}
	operator.login(t, "pwoperator", testPassword)
	operator.request(t, "GET", statusPath, nil, 403, nil)
	operator.request(t, "POST", revealPath, map[string]string{"admin_password": testPassword}, 403, nil)
	// A stale or forged identity must not bypass the current role check.
	forged := operator.who
	forged.Role = "superadmin"
	if _, err = f.service.adminRevealUserPassword(f.ctx, forged, uid, testPassword); !errors.Is(err, ErrForbidden) {
		t.Fatal("database role was not revalidated")
	}
	f.exec(t, "UPDATE pulse.admin_sessions SET revoked_at=now() WHERE id=$1", root.who.SessionID)
	if _, err = f.service.adminRevealUserPassword(f.ctx, root.who, uid, testPassword); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("revoked admin session retained reveal access")
	}
}

func TestUserPasswordCopiesAllPasswordWritersStaySynchronized(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	enablePasswordCopies(t, f)
	uid, err := f.service.CreateUser(f.ctx, "clipassword01", "CLIpass888")
	if err != nil {
		t.Fatal(err)
	}
	checkPasswordCopy(t, f, uid, "CLIpass888")
	var created struct {
		ID string `json:"id"`
	}
	root.request(t, "POST", "/api/v2/admin/users", map[string]string{"account": "passwordnew01", "nickname": "密码测试", "password": "Created888"}, 201, &created)
	checkPasswordCopy(t, f, created.ID, "Created888")
	batch, err := f.service.BulkCreateUsers(f.ctx, root.who, BulkUsersInput{RequestID: "password-copy-batch", Users: []BulkUser{{"pwbatch1", "批量一", "BatchOne888"}, {"pwbatch2", "批量二", "BatchTwo888"}}})
	if err != nil {
		t.Fatal(err)
	}
	for i, row := range batch {
		checkPasswordCopy(t, f, row["id"], []string{"BatchOne888", "BatchTwo888"}[i])
	}
	input := BulkPasswordInput{RequestID: "password-copy-reset", UserIDs: []string{created.ID, uid}, Password: "BulkReset888"}
	if _, err = f.service.BulkResetPasswords(f.ctx, root.who, input); err != nil {
		t.Fatal(err)
	}
	for _, id := range input.UserIDs {
		checkPasswordCopy(t, f, id, input.Password)
	}
	login, err := f.service.Login(f.ctx, "clipassword01", input.Password, "copy-change", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.ChangePassword(f.ctx, login.Identity, input.Password, "Changed888"); err != nil {
		t.Fatal(err)
	}
	checkPasswordCopy(t, f, uid, "Changed888")
	if result, err := f.service.BulkResetPasswords(f.ctx, root.who, input); err != nil || !result.Replayed {
		t.Fatal("reset retry was not idempotent")
	}
	checkPasswordCopy(t, f, uid, "Changed888")
	// API-created passwords can contain CR/LF: both encryption and JSON must preserve them.
	controlPassword := "Line\r\nBreak\t888"
	login, err = f.service.Login(f.ctx, "clipassword01", "Changed888", "copy-controls", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.ChangePassword(f.ctx, login.Identity, "Changed888", controlPassword); err != nil {
		t.Fatal(err)
	}
	checkPasswordCopy(t, f, uid, controlPassword)
	var revealed userPasswordReveal
	root.request(t, "POST", "/api/v2/admin/users/"+uid+"/password-reveal", map[string]string{"admin_password": testPassword}, 200, &revealed)
	if revealed.Password != controlPassword {
		t.Fatal("reveal JSON changed control characters")
	}
	var captcha Captcha
	f.request(t, "GET", "/api/v2/auth/captcha", "", nil, 200, &captcha)
	f.cache.Client.Set(f.ctx, f.cache.Prefix+"captcha:"+hex.EncodeToString(digest(captcha.ID)), hex.EncodeToString(digest("127.0.0.1:ABCDE")), time.Minute)
	f.request(t, "POST", "/api/v2/auth/register", "", RegisterInput{Account: "pwregister1", Nickname: "注册测试", Password: "Register888", CaptchaID: captcha.ID, CaptchaCode: "ABCDE"}, 201, &created)
	checkPasswordCopy(t, f, created.ID, "Register888")
}

func TestUserPasswordCopiesFailClosedOnKeyTamperingAndExternalChanges(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	// Hash-only installations keep working and cannot reveal a plaintext value.
	root.request(t, "POST", "/api/v2/admin/users/"+f.alice.UserID+"/password-reveal", map[string]string{"admin_password": testPassword}, 409, nil)
	enablePasswordCopies(t, f)
	uid, err := f.service.CreateUser(f.ctx, "pwfailure1", "Failure888")
	if err != nil {
		t.Fatal(err)
	}
	revealPath := "/api/v2/admin/users/" + uid + "/password-reveal"
	var original []byte
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT ciphertext FROM pulse.user_password_copies WHERE user_id=$1", uid).Scan(&original); err != nil {
		t.Fatal(err)
	}
	corrupt := append([]byte(nil), original...)
	corrupt[len(corrupt)-1] ^= 1
	f.exec(t, "UPDATE pulse.user_password_copies SET ciphertext=$2 WHERE user_id=$1", uid, corrupt)
	root.request(t, "POST", revealPath, map[string]string{"admin_password": testPassword}, 409, nil)
	f.exec(t, "UPDATE pulse.user_password_copies SET ciphertext=$2 WHERE user_id=$1", uid, original)
	vault := f.service.passwordVault
	enablePasswordCopies(t, f)
	var state userPasswordStatus
	root.request(t, "GET", "/api/v2/admin/users/"+uid+"/password-status", nil, 200, &state)
	if state.Available || state.Reason != "key_unavailable" {
		t.Fatal("wrong key was reported as usable")
	}
	root.request(t, "POST", revealPath, map[string]string{"admin_password": testPassword}, 409, nil)
	f.service.passwordVault = vault
	// Changing a verifier through any SQL writer invalidates the old ciphertext.
	f.exec(t, "UPDATE pulse.users SET password_hash=$2 WHERE id=$1", uid, testPasswordHash)
	var count int
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.user_password_copies WHERE user_id=$1", uid).Scan(&count); err != nil || count != 0 {
		t.Fatal("external password update retained old encrypted password")
	}
	root.request(t, "POST", revealPath, map[string]string{"admin_password": testPassword}, 409, nil)
	root.request(t, "PATCH", "/api/v2/admin/users/"+uid, AdminUserPatch{Password: "Restored888", Expected: 1}, 204, nil)
	checkPasswordCopy(t, f, uid, "Restored888")
	f.service.passwordVault = nil
	root.request(t, "PATCH", "/api/v2/admin/users/"+uid, AdminUserPatch{Password: "Disabled888", Expected: 2}, 204, nil)
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.user_password_copies WHERE user_id=$1", uid).Scan(&count); err != nil || count != 0 {
		t.Fatal("disabled encryption retained a stale password")
	}
	f.service.passwordVault = vault
	root.request(t, "PATCH", "/api/v2/admin/users/"+uid, AdminUserPatch{Password: "DeleteCopy888", Expected: 3}, 204, nil)
	root.request(t, "PATCH", "/api/v2/admin/users/"+uid, AdminUserPatch{Delete: true, Expected: 4}, 204, nil)
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.user_password_copies WHERE user_id=$1", uid).Scan(&count); err != nil || count != 0 {
		t.Fatal("deleted user retained a recoverable password")
	}
}

func TestUserPasswordCopiesRevealRequiresAuditAndIsRateLimited(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	enablePasswordCopies(t, f)
	uid, err := f.service.CreateUser(f.ctx, "pwaudit01", "AuditTest888")
	if err != nil {
		t.Fatal(err)
	}
	// A reveal may not succeed if its audit record cannot be committed.
	f.exec(t, `CREATE FUNCTION pulse.test_reject_password_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='user.password-reveal' THEN RAISE EXCEPTION 'isolated audit failure'; END IF; RETURN NEW; END $$`)
	f.exec(t, `CREATE TRIGGER test_password_audit BEFORE INSERT ON pulse.admin_audit FOR EACH ROW EXECUTE FUNCTION pulse.test_reject_password_audit()`)
	t.Cleanup(func() {
		f.exec(t, "DROP TRIGGER IF EXISTS test_password_audit ON pulse.admin_audit; DROP FUNCTION IF EXISTS pulse.test_reject_password_audit()")
	})
	path := "/api/v2/admin/users/" + uid + "/password-reveal"
	root.request(t, "POST", path, map[string]string{"admin_password": testPassword}, http.StatusServiceUnavailable, nil)
	f.exec(t, "DROP TRIGGER test_password_audit ON pulse.admin_audit")
	for i := 0; i < 9; i++ {
		root.request(t, "POST", path, map[string]string{"admin_password": "wrong-password"}, 422, nil)
	}
	root.request(t, "POST", path, map[string]string{"admin_password": testPassword}, http.StatusTooManyRequests, nil)
}
