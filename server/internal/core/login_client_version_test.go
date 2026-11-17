package core

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestLoginClientVersionValidation(t *testing.T) {
	for _, version := range []string{"", "2.4.179", " 0.2.103 ", "1.2.3-beta.1+105", strings.Repeat("1", 64)} {
		t.Run("accept/"+version, func(t *testing.T) {
			got, err := normalizeLoginOptions(LoginOptions{Platform: "pc", ClientVersion: version})
			if err != nil || got.ClientVersion != strings.TrimSpace(version) {
				t.Fatalf("version was not preserved: %q, %v", got.ClientVersion, err)
			}
		})
	}
	for _, version := range []string{strings.Repeat("1", 65), "2.4\n179", "2.4 179", "<script>", "版本2"} {
		t.Run("reject/"+version, func(t *testing.T) {
			if _, err := normalizeLoginOptions(LoginOptions{ClientVersion: version}); err == nil {
				t.Fatal("invalid version accepted")
			}
		})
	}
}

func TestLoginClientVersionAuditAndLatestSuccessfulLogin(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	login := func(version, platform string, headers bool, password string, want int) {
		t.Helper()
		input := map[string]string{"account": "alice01", "password": password, "device_id": "version-audit-device"}
		if !headers {
			input["client_version"], input["platform"] = version, platform
		}
		raw, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest("POST", f.http.URL+"/api/v2/auth/login", strings.NewReader(string(raw)))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "https://test.invalid")
		if headers {
			req.Header.Set("X-Client-Version", version)
			req.Header.Set("X-Client-Platform", platform)
		} else {
			req.Header.Set("X-Client-Version", "99.99.99")
			req.Header.Set("X-Client-Platform", "web")
		}
		resp, err := f.http.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != want {
			t.Fatalf("login status: got %d want %d", resp.StatusCode, want)
		}
	}
	checkUser := func(platform, version string) {
		t.Helper()
		var user map[string]any
		root.request(t, "GET", "/api/v2/admin/users/"+f.alice.UserID, nil, 200, &user)
		var users struct{ Items []map[string]any }
		root.request(t, "GET", "/api/v2/admin/users?q=alice01", nil, 200, &users)
		if len(users.Items) != 1 {
			t.Fatalf("unexpected users: %d", len(users.Items))
		}
		for _, row := range []map[string]any{user, users.Items[0]} {
			if row["last_login_platform"] != platform || row["last_login_client_version"] != version || row["last_login_at"] == nil || row["password_hash"] != nil {
				t.Fatalf("incorrect latest login: platform=%v version=%v", row["last_login_platform"], row["last_login_client_version"])
			}
		}
	}
	for _, scenario := range []struct {
		platform, version string
		headers           bool
	}{{"pc", "2.4.179", false}, {"android", "0.2.103", true}, {"ios", "0.2.82", true}, {"web", "2.4.179", false}} {
		t.Run(scenario.platform, func(t *testing.T) {
			login(scenario.version, scenario.platform, scenario.headers, testPassword, 200)
			checkUser(scenario.platform, scenario.version)
		})
	}
	login("9.9.9", "android", true, "WrongPassword2026", 401)
	checkUser("web", "2.4.179")
	f.exec(t, `INSERT INTO pulse.login_events(user_id,account,platform,device_name,success,reason,client_version,created_at)
	 VALUES($1,'alice01','pc','old-device',true,'ok','0.0.1',now()-interval '1 day')`, f.alice.UserID)
	checkUser("web", "2.4.179")
	var events struct{ Items []map[string]any }
	root.request(t, "GET", "/api/v2/admin/login-events?account=alice01", nil, 200, &events)
	found := false
	for _, event := range events.Items {
		if event["client_version"] == "9.9.9" && event["success"] == false {
			found = true
		}
	}
	if !found {
		t.Fatal("failed login version missing from audit")
	}
	f.request(t, "POST", "/api/v2/auth/login", "", map[string]string{"account": "alice01", "password": testPassword, "device_id": "legacy-version-device"}, 200, nil)
	checkUser("unknown", "")
	uid := newID()
	f.exec(t, "INSERT INTO pulse.users(id,account,password_hash) SELECT $1,'neverlogin01',password_hash FROM pulse.users WHERE id=$2", uid, f.alice.UserID)
	var neverLoggedIn map[string]any
	root.request(t, "GET", "/api/v2/admin/users/"+uid, nil, 200, &neverLoggedIn)
	if neverLoggedIn["last_login_at"] != nil || neverLoggedIn["last_login_client_version"] != nil {
		t.Fatal("invented login metadata for an account that never logged in")
	}
	f.request(t, "POST", "/api/v2/auth/login", "", map[string]string{"account": "alice01", "password": testPassword, "device_id": "invalid-version-device", "client_version": strings.Repeat("1", 65)}, 400, nil)
	checkUser("unknown", "")
	req, _ := http.NewRequest("OPTIONS", f.http.URL+"/api/v2/auth/login", nil)
	req.Header.Set("Origin", "https://test.invalid")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type,x-client-platform,x-client-version")
	resp, err := f.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	allow := strings.ToLower(resp.Header.Get("Access-Control-Allow-Headers"))
	if resp.StatusCode != 204 || !strings.Contains(allow, "x-client-version") || !strings.Contains(allow, "x-client-platform") {
		t.Fatal("client metadata headers rejected by CORS preflight")
	}
}
