package core

import (
	"encoding/json"
	"testing"
)

func TestProfileLocationChinesePresentationPreservesReportedPlace(t *testing.T) {
	raw := []byte(`{"id":"unchanged","registration_ip":"36.35.54.51","registration_ip_location":"China Anhui Hefei","registration_ip_location_detail":{"country":"China","province":"Anhui","city":"Hefei","district":"原区县","source":"ippure","reported":true},"logins":[{"ip":"183.198.88.116","location":"China Shanghai Shanghai","location_status":"reported","location_detail":{"country":"China","province":"Shanghai","city":"Shanghai","source":"ippure","reported":true}}]}`)
	var result struct {
		ID           string `json:"id"`
		Registration struct {
			Country, Province, City, District, Source string
			Reported                                  bool
		} `json:"registration_ip_location_detail"`
		Logins []struct {
			Detail struct {
				Country, Province, City, Source string
				Reported                        bool
			} `json:"location_detail"`
		} `json:"logins"`
	}
	if err := json.Unmarshal(fillOfflineProfileLocations(t.Context(), raw), &result); err != nil {
		t.Fatal(err)
	}
	if result.ID != "unchanged" || result.Registration.Country != "中国" || result.Registration.Province != "安徽省" || result.Registration.City != "合肥市" || result.Registration.District != "原区县" || result.Registration.Source != "ippure" || !result.Registration.Reported {
		t.Fatalf("reported place was not translated while preserving its provenance: %+v", result)
	}
	// The offline database places this IP in Hebei. Translation must retain the
	// reported Shanghai location, rather than silently selecting another provider.
	if len(result.Logins) != 1 || result.Logins[0].Detail.Country != "中国" || result.Logins[0].Detail.Province != "上海市" || result.Logins[0].Detail.City != "上海市" || result.Logins[0].Detail.Source != "ippure" || !result.Logins[0].Detail.Reported {
		t.Fatalf("translation changed the reported city/source: %+v", result.Logins)
	}
}

func TestProfileLocationChineseOfflineResult(t *testing.T) {
	raw := fillOfflineProfileLocations(t.Context(), []byte(`{"registration_ip":"59.153.251.108","registration_ip_location":"","logins":[]}`))
	var result struct {
		Detail struct{ Country, Province, City, Source string } `json:"registration_ip_location_detail"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if result.Detail.Country != "越南" || result.Detail.Province != "河内" || result.Detail.City != "河内" || result.Detail.Source != "offline" {
		t.Fatalf("offline result is not localized: %s", raw)
	}
}

func TestStaffChineseLocationDoesNotRewriteIPPureStorage(t *testing.T) {
	f := newFixture(t)
	f.service.IPPureEnabled = true
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	f.exec(t, "UPDATE pulse.users SET registration_ip='183.198.88.116' WHERE id=$1", f.bob.UserID)
	f.exec(t, "INSERT INTO pulse.client_reported_ip_locations(user_id,ip,country,province,city) VALUES($1,'183.198.88.116','China','Shanghai','Shanghai')", f.bob.UserID)
	var result struct {
		Detail struct{ Country, Province, City, Source string } `json:"registration_ip_location_detail"`
	}
	f.request(t, "GET", "/api/v2/staff/users/"+f.bob.UserID, f.alice.Token, nil, 200, &result)
	if result.Detail.Country != "中国" || result.Detail.Province != "上海市" || result.Detail.City != "上海市" || result.Detail.Source != "ippure" {
		t.Fatalf("staff profile was not localized: %+v", result)
	}
	var country, province, city string
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT country,province,city FROM pulse.client_reported_ip_locations WHERE user_id=$1 AND ip='183.198.88.116'", f.bob.UserID).Scan(&country, &province, &city); err != nil || country != "China" || province != "Shanghai" || city != "Shanghai" {
		t.Fatalf("presentation rewrote provider data: %q %q %q %v", country, province, city, err)
	}
}
