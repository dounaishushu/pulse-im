package core

import (
	"net/http"
	"strings"
	"testing"
)

func TestDiagnosticAcknowledgementAndRetry(t *testing.T) {
	f := newFixture(t)
	id := newID()
	report := map[string]any{"schema_version": 2, "diagnostic_id": id, "incidents": []map[string]any{{"code": "ANDROID_SOCKET_TIMEOUT", "at": 1794906600000}}}
	body := map[string]any{"platform": "android", "version": "0.2.104", "report": report}
	var response map[string]any
	for i := 0; i < 12; i++ {
		f.request(t, "POST", "/api/v2/client/diagnostics", f.alice.Token, body, 201, &response)
		if response["schema_version"] != float64(2) || response["diagnostic_id"] != id || response["report_id"] != id || response["id"] != id {
			t.Fatal("missing diagnostic acknowledgement")
		}
	}
	var count int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.client_diagnostics WHERE user_id=$1", f.alice.UserID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate report persisted: %d %v", count, err)
	}
	for i := 0; i < 4; i++ {
		report["diagnostic_id"] = newID()
		f.request(t, "POST", "/api/v2/client/diagnostics", f.alice.Token, body, 201, nil)
	}
	report["diagnostic_id"] = newID()
	f.request(t, "POST", "/api/v2/client/diagnostics", f.alice.Token, body, 429, nil)
	report["diagnostic_id"] = id
	f.request(t, "POST", "/api/v2/client/diagnostics", f.alice.Token, body, 201, nil)
}

func TestDiagnosticIdentityIsolation(t *testing.T) {
	f := newFixture(t)
	id := newID()
	report := map[string]any{"schema_version": 2, "diagnostic_id": id, "incidents": []any{}}
	body := map[string]any{"platform": "android", "version": "0.2.104", "report": report}
	f.request(t, "POST", "/api/v2/client/diagnostics", f.alice.Token, body, 201, nil)
	f.request(t, "POST", "/api/v2/client/diagnostics", f.bob.Token, body, 409, nil)
	report["incidents"] = []any{"changed"}
	f.request(t, "POST", "/api/v2/client/diagnostics", f.alice.Token, body, 409, nil)
	report["diagnostic_id"] = "not-a-uuid"
	f.request(t, "POST", "/api/v2/client/diagnostics", f.alice.Token, body, 400, nil)
	f.request(t, "POST", "/api/v2/client/diagnostics", "", body, 401, nil)
	body["report"] = map[string]any{"manual": true}
	f.request(t, "POST", "/api/v2/client/diagnostics", f.bob.Token, body, 201, nil)
}

func TestDiagnosticQuotaPreservesOtherDeviceSamplesAndBackoff(t *testing.T) {
	f := newFixture(t)
	other, err := f.service.Login(f.ctx, "alice01", testPassword, "diagnostic-second-device", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	body := `{"platform":"android","version":"0.2.104","report":{"manual":true}}`
	for range 5 {
		f.request(t, "POST", "/api/v2/client/diagnostics", f.alice.Token,
			map[string]any{"platform": "android", "version": "0.2.104", "report": map[string]bool{"manual": true}}, 201, nil)
	}
	req, _ := http.NewRequest("POST", f.http.URL+"/api/v2/client/diagnostics", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+f.alice.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 429 || res.Header.Get("Retry-After") != "3600" {
		t.Fatal("diagnostic quota did not advertise an hourly backoff")
	}
	f.request(t, "POST", "/api/v2/client/diagnostics", other.Token,
		map[string]any{"platform": "pc", "version": "2.4.199", "report": map[string]bool{"manual": true}}, 201, nil)
}
