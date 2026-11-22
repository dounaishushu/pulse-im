package core

import (
	"strings"
	"testing"
)

func TestStaffIPPureLocationsStayBoundToUserAndActualIP(t *testing.T) {
	f := newFixture(t)
	f.service.IPPureEnabled = true
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	f.exec(t, "UPDATE pulse.users SET registration_ip='8.8.8.8' WHERE id=$1", f.bob.UserID)
	f.exec(t, "INSERT INTO pulse.login_events(user_id,account,ip,platform,device_name,success,reason) VALUES($1,'bob01','7.7.7.7','android','测试手机',true,'ok')", f.bob.UserID)
	input := clientNetworkInput{ExitIP: "7.7.7.7", ExitLocation: &clientIPLocation{Country: " China ", Province: "广东省", City: "深圳市"}}
	if err := f.service.recordClientNetwork(f.ctx, f.bob.Identity, "7.7.7.7", input); err != nil {
		t.Fatal(err)
	}
	// A second account at the same IP cannot replace the first account's data.
	input.ExitLocation = &clientIPLocation{Province: "别的省", City: "别的市", District: "别的区"}
	if err := f.service.recordClientNetwork(f.ctx, f.carol.Identity, "7.7.7.7", input); err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.client_network_observations SET checked_at=now()-interval '2 minutes' WHERE user_id=$1", f.bob.UserID)
	if err := f.service.recordClientNetwork(f.ctx, f.bob.Identity, "::ffff:8.8.8.8", clientNetworkInput{ExitIP: "8.8.8.8", ExitLocation: &clientIPLocation{Country: "中国", Province: "浙江省", City: "杭州市", District: "西湖区"}}); err != nil {
		t.Fatal(err)
	}
	var result struct {
		RegistrationIP     string            `json:"registration_ip"`
		RegistrationDetail *clientIPLocation `json:"registration_ip_location_detail"`
		RegistrationStatus string            `json:"registration_ip_location_status"`
		Logins             []struct {
			IP     string `json:"ip"`
			Detail struct {
				Province string `json:"province"`
				City     string `json:"city"`
				District string `json:"district"`
				Source   string `json:"source"`
				Reported bool   `json:"reported"`
			} `json:"location_detail"`
			Status string `json:"location_status"`
		} `json:"logins"`
	}
	path := "/api/v2/staff/users/" + f.bob.UserID
	f.request(t, "GET", path, f.alice.Token, nil, 200, &result)
	if result.RegistrationIP != "8.8.8.8" || result.RegistrationStatus != "reported" || result.RegistrationDetail == nil || result.RegistrationDetail.District != "西湖区" {
		t.Fatalf("registration location was not matched by IP: %+v", result)
	}
	if len(result.Logins) == 0 || result.Logins[0].IP != "7.7.7.7" || result.Logins[0].Status != "reported" || result.Logins[0].Detail.Province != "广东省" || result.Logins[0].Detail.City != "深圳市" || result.Logins[0].Detail.District != "" || result.Logins[0].Detail.Source != "ippure" || !result.Logins[0].Detail.Reported {
		t.Fatalf("login location mixed users, IPs or fabricated a district: %+v", result)
	}
	var authoritative int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.ip_locations WHERE ip IN('7.7.7.7','8.8.8.8')").Scan(&authoritative); err != nil || authoritative != 0 {
		t.Fatalf("client metadata contaminated the server cache: %d %v", authoritative, err)
	}
	f.request(t, "GET", path, f.carol.Token, nil, 403, nil)
	f.exec(t, "UPDATE pulse.users SET internal_staff=false WHERE id=$1", f.alice.UserID)
	f.request(t, "GET", path, f.alice.Token, nil, 403, nil)
}

func TestIPPureLocationRejectsMismatchesAndLimitsWrites(t *testing.T) {
	f := newFixture(t)
	f.service.IPPureEnabled = true
	input := clientNetworkInput{ExitIP: "8.8.8.8", ExitLocation: &clientIPLocation{Country: "中国", Province: "广东省", City: "深圳市"}}
	if err := f.service.recordClientNetwork(f.ctx, f.bob.Identity, "9.9.9.9", input); err != nil {
		t.Fatal(err)
	}
	assertRows := func(wanted int) {
		t.Helper()
		var rows int
		if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.client_reported_ip_locations WHERE user_id=$1", f.bob.UserID).Scan(&rows); err != nil || rows != wanted {
			t.Fatalf("unexpected stored locations: %d %v", rows, err)
		}
	}
	assertRows(0)
	if err := f.service.recordClientNetwork(f.ctx, f.bob.Identity, "8.8.8.8", input); err != nil {
		t.Fatal(err)
	}
	assertRows(0) // The existing one-minute session write limit also covers locations.
	f.exec(t, "UPDATE pulse.client_network_observations SET checked_at=now()-interval '2 minutes' WHERE user_id=$1", f.bob.UserID)
	if err := f.service.recordClientNetwork(f.ctx, f.bob.Identity, "8.8.8.8", input); err != nil {
		t.Fatal(err)
	}
	assertRows(1)
	f.service.IPPureEnabled = false
	f.exec(t, "UPDATE pulse.client_network_observations SET checked_at=now()-interval '2 minutes' WHERE user_id=$1", f.bob.UserID)
	if err := f.service.recordClientNetwork(f.ctx, f.bob.Identity, "9.9.9.9", clientNetworkInput{ExitIP: "9.9.9.9", ExitLocation: &clientIPLocation{City: "不能保存"}}); err != nil {
		t.Fatal(err)
	}
	assertRows(1)
}

func TestIPPureLocationValidationAndOldClientCompatibility(t *testing.T) {
	for _, value := range []string{strings.Repeat("中", 129), "bad\ncity", "bad\x00city", "bad\x1bcity"} {
		input := clientNetworkInput{ExitIP: "8.8.8.8", ExitLocation: &clientIPLocation{City: value}}
		if err := input.normalize(true); err != ErrInvalid {
			t.Fatalf("accepted invalid location: %q %v", value, err)
		}
	}
	input := clientNetworkInput{ExitIP: "8.8.8.8", ExitLocation: &clientIPLocation{City: "  深圳市  "}}
	if err := input.normalize(true); err != nil || input.ExitLocation.City != "深圳市" || input.ExitLocation.District != "" {
		t.Fatalf("location normalization failed: %+v %v", input, err)
	}
	old := clientNetworkInput{ExitIP: "8.8.8.8"}
	if err := old.normalize(true); err != nil || old.ExitLocation != nil {
		t.Fatalf("old clients must not fabricate locations: %+v %v", old, err)
	}
}

func TestIPPureLocationCleanupFollowsConfiguredRetention(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "INSERT INTO pulse.client_reported_ip_locations(user_id,ip,city,checked_at) VALUES($1,'8.8.8.8','旧归属地',now()-interval '91 days'),($1,'9.9.9.9','新归属地',now())", f.bob.UserID)
	if _, err := f.service.CleanupData(f.ctx, 90); err != nil {
		t.Fatal(err)
	}
	var old, fresh int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FILTER(WHERE ip='8.8.8.8'),count(*) FILTER(WHERE ip='9.9.9.9') FROM pulse.client_reported_ip_locations WHERE user_id=$1", f.bob.UserID).Scan(&old, &fresh); err != nil || old != 0 || fresh != 1 {
		t.Fatalf("location retention mismatch: old=%d fresh=%d %v", old, fresh, err)
	}
}
