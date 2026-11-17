package core

import "testing"

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
