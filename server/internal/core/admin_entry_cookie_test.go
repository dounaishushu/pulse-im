package core

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAdminEntranceCookieRejectsCrossOriginRequests(t *testing.T) {
	for _, tc := range []struct {
		origin, site string
		allowed      bool
	}{
		{"", "", true},
		{"https://admin.example.invalid", "same-origin", true},
		{"https://web.example.invalid", "same-site", false},
		{"https://untrusted.invalid", "cross-site", false},
		{"null", "", false},
		{"https://web.example.invalid", "", false},
	} {
		req := httptest.NewRequest("GET", "https://admin.example.invalid/api/v2/admin/me", nil)
		req.Header.Set("Origin", tc.origin)
		req.Header.Set("Sec-Fetch-Site", tc.site)
		req.AddCookie(&http.Cookie{Name: "__Host-pulse_admin_entry", Value: strings.Repeat("a", 64)})
		if allowed := adminRequestEntry(req, "") != ""; allowed != tc.allowed {
			t.Fatalf("origin=%q site=%q: allowed=%t", tc.origin, tc.site, allowed)
		}
	}
}

func TestAdminEntranceCookieLoginAndRevocation(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	server := httptest.NewTLSServer(f.http.Config.Handler)
	defer server.Close()
	client := server.Client()
	login := func(password, header string, entries []string, want int) *http.Response {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"account": "rootreview", "password": password})
		req, _ := http.NewRequest("POST", server.URL+"/api/v2/admin/auth/login", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if header != "" {
			req.Header.Set("X-Admin-Entry", header)
		}
		for _, entry := range entries {
			req.AddCookie(&http.Cookie{Name: "__Host-pulse_admin_entry", Value: entry})
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != want {
			response.Body.Close()
			t.Fatalf("cookie login returned %d, want %d", response.StatusCode, want)
		}
		return response
	}
	for _, tc := range []struct {
		password, header string
		entries          []string
	}{
		{testPassword, "", nil},
		{"incorrect-password", "", []string{root.entry}},
		{testPassword, "", []string{strings.Repeat("0", 64)}},
		{testPassword, "", []string{root.entry, root.entry}},
		{testPassword, strings.Repeat("0", 64), []string{root.entry}},
	} {
		login(tc.password, tc.header, tc.entries, 401).Body.Close()
	}
	response := login(testPassword, "", []string{root.entry}, 200)
	defer response.Body.Close()
	var out struct {
		CSRF string `json:"csrf_token"`
	}
	if err := json.NewDecoder(response.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	var session, entry *http.Cookie
	for _, cookie := range response.Cookies() {
		switch cookie.Name {
		case "pulse_admin":
			session = cookie
		case "__Host-pulse_admin_entry":
			entry = cookie
		}
	}
	if session == nil || entry == nil || !entry.Secure || !entry.HttpOnly || entry.Path != "/" || entry.Domain != "" || entry.SameSite != http.SameSiteStrictMode {
		t.Fatal("missing protected entrance cookie")
	}
	request := func(method, path string, want int) {
		t.Helper()
		req, _ := http.NewRequest(method, server.URL+path, nil)
		req.AddCookie(session)
		req.AddCookie(entry)
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != want {
			t.Fatalf("cookie-only %s returned %d, want %d", path, response.StatusCode, want)
		}
	}
	request("GET", "/api/v2/admin/me", 200)
	request("POST", "/api/v2/admin/auth/logout", 403)
	f.exec(t, "UPDATE pulse.admin_accounts SET entry_hash=$2,version=version+1 WHERE id=$1", root.who.ID, digest(opaqueToken()))
	request("GET", "/api/v2/admin/me", 401)
}

func TestLegacyAdminEntranceCookieRemainsAccountBound(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	secret, salt := "isolated-legacy-admin-secret-for-cookie-test", strings.Repeat("a", 64)
	t.Setenv("PULSE_LEGACY_ADMIN_ENTRY_SECRET", secret)
	key := hmac.New(sha256.New, []byte(secret))
	key.Write([]byte("pulse-admin-entry-key-v1"))
	mac := hmac.New(sha256.New, key.Sum(nil))
	mac.Write([]byte("account:42:salt:" + salt))
	entry := hex.EncodeToString(mac.Sum(nil))
	hash := sha256.Sum256([]byte(entry))
	f.exec(t, "UPDATE pulse.admin_accounts SET legacy_numeric_id=42,legacy_entry_salt=$2,legacy_entry_hash=$3 WHERE id=$1", root.who.ID, salt, hex.EncodeToString(hash[:]))
	if _, err := f.service.SaveAdmin(f.ctx, root.who, "", AdminAccountInput{Account: "otheradmin", Password: testPassword, Role: "auditor", Permissions: []string{"stats.view"}, Active: true}); err != nil {
		t.Fatal(err)
	}
	for _, account := range []string{"rootreview", "otheradmin"} {
		body, _ := json.Marshal(map[string]string{"account": account, "password": testPassword})
		req, _ := http.NewRequest("POST", f.http.URL+"/api/v2/admin/auth/login", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "pulse_admin_entry_local", Value: entry})
		response, err := f.http.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		want := 200
		if account == "otheradmin" {
			want = 401
		}
		if response.StatusCode != want {
			t.Fatalf("legacy cookie account %s returned %d, want %d", account, response.StatusCode, want)
		}
	}
}
