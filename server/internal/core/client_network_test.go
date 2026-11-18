package core

import (
	"testing"
)

func TestClientNetworkObservationIsSessionScopedAndAdvisory(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	f.service.IPPureEnabled = true
	path := "/api/v2/client/network-observation"
	f.request(t, "GET", path, "", nil, 401, nil)
	var capability map[string]string
	f.request(t, "GET", path, f.alice.Token, nil, 200, &capability)
	if capability["ippure_url"] == "" {
		t.Fatal("provider not advertised")
	}
	payload := map[string]any{"exit_ip": "2001:4860:4860::8888", "risk_score": 98, "is_residential": false, "client_version": "2.4.191"}
	f.request(t, "POST", path, "", payload, 401, nil)
	f.request(t, "POST", path, f.alice.Token, payload, 200, nil)
	f.request(t, "POST", path, f.alice.Token, map[string]any{"exit_ip": "10.0.0.3"}, 400, nil)
	if _, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "observational-only", Body: "message"}); err != nil {
		t.Fatalf("score cannot restrict messaging: %v", err)
	}
	var item struct {
		ClientNetwork *struct {
			Observed string   `json:"observed_ip"`
			Exit     *string  `json:"exit_ip"`
			Score    *float64 `json:"risk_score"`
			Version  string   `json:"client_version"`
		} `json:"client_network"`
	}
	root.request(t, "GET", "/api/v2/admin/users/"+f.alice.UserID, nil, 200, &item)
	if n := item.ClientNetwork; n == nil || n.Observed != "127.0.0.1" || n.Exit == nil || *n.Exit != "2001:4860:4860::8888" || n.Score == nil || *n.Score != 98 || n.Version != "2.4.191" {
		t.Fatalf("expected separate observed and reported IPs, got %+v", n)
	}
	root.request(t, "GET", "/api/v2/admin/users/"+f.bob.UserID, nil, 200, &item)
	if item.ClientNetwork != nil {
		t.Fatal("an observation appeared on another account")
	}
	f.service.IPPureEnabled = false
	f.request(t, "POST", path, f.bob.Token, payload, 200, nil)
	root.request(t, "GET", "/api/v2/admin/users/"+f.bob.UserID, nil, 200, &item)
	if n := item.ClientNetwork; n == nil || n.Observed != "127.0.0.1" || n.Exit != nil || n.Score != nil {
		t.Fatalf("disabled provider must only retain the observed address: %+v", n)
	}
}

func TestClientNetworkMeasurementPreservesZeroAndNormalizesIP(t *testing.T) {
	zero := 0.0
	in := clientNetworkInput{ExitIP: "::ffff:8.8.8.8", RiskScore: &zero}
	if err := in.normalize(true); err != nil || in.ExitIP != "8.8.8.8" || in.RiskScore == nil || *in.RiskScore != 0 {
		t.Fatalf("valid zero score was lost: %+v / %v", in, err)
	}
}
