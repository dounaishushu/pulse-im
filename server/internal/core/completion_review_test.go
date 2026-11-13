package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"golang.org/x/crypto/bcrypt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestAdminBatchGroupsDeviceViewAndConfigurationBounds(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	in := BulkUsersInput{RequestID: "batch-create", Prefix: "reviewuser", Start: 1, Count: 3, Password: testPassword}
	var result struct {
		Items []map[string]string `json:"items"`
	}
	root.request(t, "POST", "/api/v2/admin/users/batch", in, 201, &result)
	if len(result.Items) != 3 {
		t.Fatal("bulk count")
	}
	root.request(t, "POST", "/api/v2/admin/users/batch", in, 201, nil)
	var count, hashes int
	f.store.Pool.QueryRow(f.ctx, "SELECT count(*),count(DISTINCT password_hash) FROM pulse.users WHERE account LIKE 'reviewuser%'").Scan(&count, &hashes)
	if count != 3 || hashes != 3 {
		t.Fatal("bulk idempotency or unique salts", count, hashes)
	}
	var devices struct {
		Hidden bool  `json:"hidden"`
		Items  []any `json:"items"`
	}
	root.request(t, "GET", "/api/v2/admin/users/"+f.bob.UserID+"/devices", nil, 200, &devices)
	if !devices.Hidden || len(devices.Items) != 0 {
		t.Fatal("hidden device details leaked")
	}
	visible := true
	root.request(t, "PATCH", "/api/v2/admin/users/"+f.bob.UserID, AdminUserPatch{Expected: 1, CanViewDevices: &visible}, 204, nil)
	root.request(t, "GET", "/api/v2/admin/users/"+f.bob.UserID+"/devices", nil, 200, &devices)
	if len(devices.Items) != 1 {
		t.Fatal("devices missing")
	}
	group := AdminGroupInput{Title: "后台群", OwnerID: f.alice.UserID, Kind: "group", Policy: "open", Limit: 20, Active: true}
	var created GroupCreated
	root.request(t, "POST", "/api/v2/admin/groups", group, 200, &created)
	if e := f.service.JoinGroup(f.ctx, f.bob.Identity, created.ID, ""); e != nil {
		t.Fatal(e)
	}
	group.OwnerID = f.bob.UserID
	root.request(t, "PUT", "/api/v2/admin/groups/"+created.ID, group, 200, nil)
	info, e := f.service.GroupDetails(f.ctx, f.bob.Identity, created.ID)
	if e != nil || info.MyRole != "owner" {
		t.Fatal("owner not transferred", e)
	}
	group.Delete = true
	group.Active = false
	root.request(t, "PUT", "/api/v2/admin/groups/"+created.ID, group, 200, nil)
	f.request(t, "GET", "/api/v2/conversations/"+created.ID+"/history", f.bob.Token, nil, 403, nil)
	root.request(t, "PUT", "/api/v2/admin/config/releases", map[string]any{"expected_version": "1", "value": map[string]any{"android": ClientRelease{Latest: "1.2.0", Minimum: "2.0.0", Force: true}}}, 400, nil)
	root.request(t, "PUT", "/api/v2/admin/config/routes", map[string]any{"expected_version": "1", "value": []ClientRoute{{ID: "one", Name: "主线路", API: "https://example.invalid/api", WS: "wss://example.invalid/ws", Media: "https://example.invalid/media", Enabled: false}}}, 409, nil)
	root.request(t, "PUT", "/api/v2/admin/config/navigation", map[string]any{"expected_version": "1", "value": []NavigationItem{{ID: "one", Title: "网址", URL: "javascript:alert(1)"}}}, 400, nil)
}
func TestGlobalSearchClearAndContactMetadataVersion(t *testing.T) {
	f := newFixture(t)
	m, e := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "globalsearch", Body: "全局查询文字"})
	if e != nil {
		t.Fatal(e)
	}
	var found struct {
		Items []Message `json:"items"`
	}
	f.request(t, "GET", "/api/v2/messages/search?q="+"%E5%85%A8%E5%B1%80", f.bob.Token, nil, 200, &found)
	if len(found.Items) != 1 {
		t.Fatal("global search missing")
	}
	f.request(t, "GET", "/api/v2/messages/search?q="+"%E5%85%A8%E5%B1%80", f.carol.Token, nil, 200, &found)
	if len(found.Items) != 0 {
		t.Fatal("global search leaked")
	}
	if _, e = f.service.ClearHistory(f.ctx, f.bob.Identity, f.cid, m.Message.Seq); e != nil {
		t.Fatal(e)
	}
	f.request(t, "GET", "/api/v2/messages/search", f.bob.Token, nil, 200, &found)
	if len(found.Items) != 0 {
		t.Fatal("global search ignored clear")
	}
	if e = f.service.ContactMetadata(f.ctx, f.alice.Identity, f.bob.UserID, "备注", "同事", 0); e != nil {
		t.Fatal(e)
	}
	profile, e := f.service.Profile(f.ctx, f.alice.Identity, f.bob.UserID, "")
	if e != nil || profile.ContactVersion != 1 || profile.Remark != "备注" {
		t.Fatal("contact version missing", e)
	}
	if e = f.service.ContactMetadata(f.ctx, f.alice.Identity, f.bob.UserID, "新备注", "同事", 0); !errors.Is(e, ErrConflict) {
		t.Fatal("stale contact edit")
	}
}
func TestLocationRefreshAndBackgroundAuditRead(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("ip") != "192.0.2.1" {
			t.Error("unexpected lookup")
		}
		_, _ = w.Write([]byte(`{"country":"Test","province":"Example","city":"Fixture"}`))
	}))
	defer mock.Close()
	var e error
	f.service.Locations, e = NewLocationClient(mock.URL)
	if e != nil {
		t.Fatal(e)
	}
	root.request(t, "POST", "/api/v2/admin/ip-locations/refresh", map[string]any{"ips": []string{"192.0.2.1"}}, 200, nil)
	f.exec(t, "UPDATE pulse.users SET registration_ip='192.0.2.1' WHERE id=$1", f.alice.UserID)
	for _, path := range []string{"stats", "regions", "unusual-logins", "login-events", "audit", "diagnostics", "maintenance/runs", "health"} {
		root.request(t, "GET", "/api/v2/admin/"+path, nil, 200, nil)
	}
	report := json.RawMessage(`{"error":"offline","screen":"conversation"}`)
	f.request(t, "POST", "/api/v2/client/diagnostics", f.alice.Token, map[string]any{"platform": "android", "version": "1.0.0", "report": report}, 201, nil)
	root.request(t, "GET", "/api/v2/admin/diagnostics", nil, 200, nil)
}
func TestRegistrationIPQuota(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	f.exec(t, `UPDATE pulse.system_settings SET value='{"enabled":true,"avatar_required":false,"per_ip_limit":1}' WHERE key='registration'`)
	for i, account := range []string{"quota123", "quota124"} {
		id := opaqueToken()
		f.cache.Client.Set(f.ctx, f.cache.Prefix+"captcha:"+fmtDigest(id), fmtDigest("127.0.0.1:ABCDE"), 120000000000)
		status := 201
		if i == 1 {
			status = 429
		}
		f.request(t, "POST", "/api/v2/auth/register", "", RegisterInput{Account: account, Nickname: "注册测试", Password: testPassword, CaptchaID: id, CaptchaCode: "ABCDE"}, status, nil)
	}
}

func TestPushQueueRequiresARegisteredRecipient(t *testing.T) {
	f := newFixture(t)
	if _, e := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "no-push-device", Body: "text"}); e != nil {
		t.Fatal(e)
	}
	var count int
	if e := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.push_jobs").Scan(&count); e != nil || count != 0 {
		t.Fatalf("unconfigured push queue grows without recipients: %d %v", count, e)
	}
}

func TestRevokedPinReleasesCapacity(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	m, e := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "pin-revoke", Body: "pinned"})
	if e != nil {
		t.Fatal(e)
	}
	if e = f.service.PinMessage(f.ctx, f.alice.Identity, f.cid, m.Message.ID, true); e != nil {
		t.Fatal(e)
	}
	if _, e = f.service.MutateMessage(f.ctx, f.alice.Identity, f.cid, m.Message.ID, "", 0, true); e != nil {
		t.Fatal(e)
	}
	var n int
	f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.message_pins WHERE conversation_id=$1", f.cid).Scan(&n)
	if n != 0 {
		t.Fatal("revoked pin occupied capacity")
	}
}

func TestAdminAccessSignedRulesAndReplay(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	f.http.Close()
	prefix, _ := netip.ParsePrefix("127.0.0.1/32")
	secret := "review-test-ops-secret-1234567890123456789"
	f.http = httptest.NewServer(NewHandler(f.service, f.hub, HTTPOptions{AdminOpsSecret: secret, TrustedProxies: []netip.Prefix{prefix}}))
	raw, _ := json.Marshal(AdminAccess{Enabled: true, Version: 1, Rules: []AdminIPRule{{CIDR: "192.0.2.0/24"}}})
	request := func(ip, proto, nonce string, sign bool) int {
		req, _ := http.NewRequest("PUT", f.http.URL+"/api/v2/admin/security/ip-rules", bytes.NewReader(raw))
		req.AddCookie(root.cookie)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Admin-Entry", root.entry)
		req.Header.Set("X-CSRF-Token", root.csrf)
		req.Header.Set("X-Real-IP", ip)
		req.Header.Set("X-Forwarded-Proto", proto)
		stamp := strconv.FormatInt(time.Now().Unix(), 10)
		req.Header.Set("X-Ops-Time", stamp)
		req.Header.Set("X-Ops-Nonce", nonce)
		if sign {
			req.Header.Set("X-Ops-Signature", opsSignature(secret, "PUT", "/api/v2/admin/security/ip-rules", stamp, nonce, raw))
		}
		resp, e := f.http.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := request("192.0.2.10", "https", "nonce0000000000000001", false); got != 403 {
		t.Fatal("missing signature accepted", got)
	}
	if got := request("192.0.2.10", "http", "nonce0000000000000002", true); got != 403 {
		t.Fatal("insecure proxy accepted", got)
	}
	if got := request("192.0.2.10", "https", "nonce0000000000000003", true); got != 200 {
		t.Fatal("signed access change failed", got)
	}
	if got := request("192.0.2.10", "https", "nonce0000000000000003", true); got != 409 {
		t.Fatal("replayed control accepted", got)
	}
	req, _ := http.NewRequest("GET", f.http.URL+"/api/v2/admin/me", nil)
	req.AddCookie(root.cookie)
	req.Header.Set("X-Admin-Entry", root.entry)
	req.Header.Set("X-Real-IP", "198.51.100.7")
	req.Header.Set("X-Forwarded-Proto", "https")
	resp, e := f.http.Client().Do(req)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("unlisted IP accepted", resp.StatusCode)
	}
	req2, _ := http.NewRequest("GET", f.http.URL+"/api/v2/admin/me", nil)
	req2.AddCookie(root.cookie)
	req2.Header.Set("X-Admin-Entry", root.entry)
	resp2, e := f.http.Client().Do(req2)
	if e != nil {
		t.Fatal(e)
	}
	resp2.Body.Close()
	if resp2.StatusCode != 403 {
		t.Fatal("missing proxy real-IP accepted", resp2.StatusCode)
	}
}

func TestTelegramEntryRotatesWithoutRecoverableSecret(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"ok":true}`)) }))
	defer mock.Close()
	f.service.Telegram = &TelegramTransport{config: TelegramConfig{Token: "fixture", WebhookSecret: strings.Repeat("s", 32), AdminBaseURL: "https://example.invalid/admin"}, client: mock.Client(), base: mock.URL}
	root.request(t, "PUT", "/api/v2/admin/telegram/grants", map[string]any{"telegram_user_id": "123", "admin_id": root.who.ID, "permissions": []string{"entry.self"}, "active": true}, 204, nil)
	var update telegramUpdate
	_ = json.Unmarshal([]byte(`{"update_id":12,"message":{"text":"/entry","from":{"id":123},"chat":{"id":123,"type":"private"}}}`), &update)
	old := root.entry
	if _, e := f.service.telegramCommand(f.ctx, update); e != nil {
		t.Fatal(e)
	}
	req, _ := http.NewRequest("POST", f.http.URL+"/api/v2/admin/auth/login", bytes.NewReader([]byte(`{"account":"rootreview","password":"`+testPassword+`","entry_token":"`+old+`"}`)))
	resp, e := f.http.Client().Do(req)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("old admin entry remained usable", resp.StatusCode)
	}
	var count int
	if e = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM information_schema.columns WHERE table_schema='pulse' AND table_name='admin_accounts' AND column_name='entry_token'").Scan(&count); e != nil || count != 0 {
		t.Fatal("entry token was retained", e)
	}
}

func TestLegacyPasswordAndPublicIDRemainUsable(t *testing.T) {
	f := newFixture(t)
	hash, e := bcrypt.GenerateFromPassword([]byte(testPassword), bcrypt.DefaultCost)
	if e != nil {
		t.Fatal(e)
	}
	f.exec(t, "UPDATE pulse.users SET password_hash=$2,legacy_public_id='AbCDef1234567890' WHERE id=$1", f.alice.UserID, string(hash))
	var logged Login
	f.request(t, "POST", "/api/v2/auth/login", "", map[string]string{"account": "alice01", "password": testPassword, "device_id": "legacy-login"}, 200, &logged)
	var profile Profile
	f.request(t, "GET", "/api/v2/me/profile", logged.Token, nil, 200, &profile)
	if profile.PublicID != "AbCDef1234567890" {
		t.Fatal("legacy QR identity changed")
	}
	f.request(t, "GET", "/api/v2/public-users/AbCDef1234567890", f.bob.Token, nil, 200, nil)
}
