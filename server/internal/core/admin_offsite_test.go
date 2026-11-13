package core

import (
	"net"
	"testing"
)

func TestAdminLocationQueueReturnsAddressesAndPreservesUnconfiguredLookups(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	f.exec(t, "UPDATE pulse.users SET registration_ip='192.0.2.10' WHERE id=$1", f.alice.UserID)
	var pending struct {
		Items     []string `json:"items"`
		Available bool     `json:"lookup_available"`
	}
	root.request(t, "GET", "/api/v2/admin/ip-locations/pending", nil, 200, &pending)
	if pending.Available || len(pending.Items) == 0 {
		t.Fatal("unconfigured location queue was not reported")
	}
	for _, ip := range pending.Items {
		if net.ParseIP(ip) == nil {
			t.Fatalf("queue returned a network instead of an address: %q", ip)
		}
	}
	root.request(t, "POST", "/api/v2/admin/ip-locations/refresh", map[string]any{"ips": pending.Items}, 503, nil)
	var failures int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.ip_locations WHERE status='failed'").Scan(&failures); err != nil || failures != 0 {
		t.Fatal("missing provider incorrectly marked addresses as failed", err)
	}
	var offsite struct {
		IPs []string `json:"next_ips"`
	}
	root.request(t, "GET", "/api/v2/admin/offsite-logins", nil, 200, &offsite)
	for _, ip := range offsite.IPs {
		if net.ParseIP(ip) == nil {
			t.Fatalf("offsite queue returned an invalid address: %q", ip)
		}
	}
}

func TestAdminOffsiteComparesLatestLoginWithRegistrationLocation(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	f.exec(t, "UPDATE pulse.users SET registration_ip='192.0.2.10' WHERE id=$1", f.alice.UserID)
	f.exec(t, "INSERT INTO pulse.ip_locations(ip,country,province,city,status) VALUES('192.0.2.10','中国','北京','北京','resolved'),('192.0.2.20','中国','广东','深圳','resolved')")
	f.exec(t, `INSERT INTO pulse.login_events(user_id,account,ip,platform,device_name,success,reason,created_at)
        VALUES($1,'alice01','192.0.2.20','android','phone',true,'ok',now()+interval '1 minute')`, f.alice.UserID)
	var result struct {
		Items []struct {
			Account         string `json:"account"`
			DifferenceLevel string `json:"difference_level"`
		} `json:"items"`
		Total int `json:"total"`
	}
	root.request(t, "GET", "/api/v2/admin/offsite-logins", nil, 200, &result)
	if result.Total != 1 || len(result.Items) != 1 || result.Items[0].Account != "alice01" || result.Items[0].DifferenceLevel != "province" {
		t.Fatalf("registration-relative offsite result incorrect: %+v", result)
	}
}
