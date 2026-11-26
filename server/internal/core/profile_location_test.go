package core

import (
	"bytes"
	"encoding/json"
	"testing"
)

type offlineProfile struct {
	ID                 string `json:"id"`
	RegistrationIP     string `json:"registration_ip"`
	RegistrationStatus string `json:"registration_ip_location_status"`
	RegistrationDetail struct {
		Country string `json:"country"`
		Source  string `json:"source"`
	} `json:"registration_ip_location_detail"`
	Logins []struct {
		IP       string `json:"ip"`
		Platform string `json:"platform"`
		Status   string `json:"location_status"`
		Detail   struct {
			Country, Province, City, District, Source string
			DatabaseVersion                           string `json:"database_version"`
		} `json:"location_detail"`
	} `json:"logins"`
}

func TestStaffOfflineLocationFillsLegacyWebAndRegistration(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	f.exec(t, "UPDATE pulse.users SET registration_ip='117.5.147.45' WHERE id=$1", f.bob.UserID)
	f.exec(t, `INSERT INTO pulse.login_events(user_id,account,ip,platform,device_name,success,reason)
 VALUES($1,'bob01','223.67.221.190','web','Web',true,'ok')`, f.bob.UserID)
	var profile offlineProfile
	f.request(t, "GET", "/api/v2/staff/users/"+f.bob.UserID, f.alice.Token, nil, 200, &profile)
	if profile.ID != f.bob.UserID || profile.RegistrationIP != "117.5.147.45" || profile.RegistrationStatus != "offline" || profile.RegistrationDetail.Country != "越南" || profile.RegistrationDetail.Source != "offline" {
		t.Fatalf("registration fallback missing or attributed to the wrong IP: %+v", profile)
	}
	if len(profile.Logins) == 0 || profile.Logins[0].IP != "223.67.221.190" || profile.Logins[0].Platform != "web" || profile.Logins[0].Status != "offline" || profile.Logins[0].Detail.Source != "offline" || profile.Logins[0].Detail.Country != "中国" || profile.Logins[0].Detail.Province == "" || profile.Logins[0].Detail.City == "" || profile.Logins[0].Detail.District != "" || profile.Logins[0].Detail.DatabaseVersion != "ip2region v3.19.0" {
		t.Fatalf("legacy Web login was not filled from the actual address: %+v", profile)
	}
	var cached, reported int
	if err := f.store.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM pulse.ip_locations WHERE ip IN('117.5.147.45','223.67.221.190')),
 (SELECT count(*) FROM pulse.client_reported_ip_locations WHERE user_id=$1)`, f.bob.UserID).Scan(&cached, &reported); err != nil || cached != 0 || reported != 0 {
		t.Fatalf("offline lookup contaminated existing location tables: cache=%d reported=%d err=%v", cached, reported, err)
	}
	f.request(t, "GET", "/api/v2/staff/users/"+f.bob.UserID, f.carol.Token, nil, 403, nil)
}

func TestStaffOfflineLocationYieldsToLaterIPPureReport(t *testing.T) {
	f := newFixture(t)
	f.service.IPPureEnabled = true
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	f.exec(t, `INSERT INTO pulse.login_events(user_id,account,ip,platform,device_name,success,reason)
 VALUES($1,'bob01','223.67.221.190','pc','PC',true,'ok')`, f.bob.UserID)
	path := "/api/v2/staff/users/" + f.bob.UserID
	var profile offlineProfile
	f.request(t, "GET", path, f.alice.Token, nil, 200, &profile)
	if len(profile.Logins) == 0 || profile.Logins[0].Detail.Source != "offline" {
		t.Fatalf("missing initial fallback: %+v", profile)
	}
	input := clientNetworkInput{ExitIP: "223.67.221.190", ExitLocation: &clientIPLocation{Country: "中国", Province: "IPPure省", City: "IPPure市", District: "IPPure区"}}
	if err := f.service.recordClientNetwork(f.ctx, f.bob.Identity, "223.67.221.190", input); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", path, f.alice.Token, nil, 200, &profile)
	if profile.Logins[0].Status != "reported" || profile.Logins[0].Detail.Source != "ippure" || profile.Logins[0].Detail.Province != "IPPure省" || profile.Logins[0].Detail.City != "IPPure市" || profile.Logins[0].Detail.District != "IPPure区" {
		t.Fatalf("offline data replaced a later authoritative IPPure report: %+v", profile)
	}
}

func TestProfileOfflineLocationPreservesExistingDataAndMissingIPs(t *testing.T) {
	for _, raw := range []string{
		`{"registration_ip":"","registration_ip_location":"","logins":[{"ip":"","location":""}]}`,
		`{"registration_ip":"192.0.2.1","registration_ip_location_status":"unknown","logins":[{"ip":"10.0.0.1","location_status":"unknown"}]}`,
		`{"registration_ip":"223.67.221.190","registration_ip_location":"缓存的归属地","logins":[{"ip":"223.67.221.190","location":"IPPure 归属地","location_detail":{"source":"ippure"}}]}`,
		`{"registration_ip":"223.67.221.190","registration_ip_location_detail":{"country":"中国","province":"缓存省份","source":"cache"},"logins":[]}`,
	} {
		if got := fillOfflineProfileLocations(t.Context(), []byte(raw)); !bytes.Equal(got, []byte(raw)) {
			t.Fatalf("overwrote existing data or invented a missing address: %s", got)
		}
	}
	var profile offlineProfile
	raw := fillOfflineProfileLocations(t.Context(), []byte(`{"id":"unchanged","registration_ip":"223.67.221.190","registration_ip_location":"","logins":[]}`))
	if err := json.Unmarshal(raw, &profile); err != nil || profile.ID != "unchanged" || profile.RegistrationDetail.Source != "offline" {
		t.Fatalf("unrelated profile fields were lost: %s %v", raw, err)
	}
	raw = fillOfflineProfileLocations(t.Context(), []byte(`{"registration_ip":"223.67.221.190","registration_ip_location_detail":{"country":"","province":"","city":"","district":"","source":"cache"},"logins":[]}`))
	if err := json.Unmarshal(raw, &profile); err != nil || profile.RegistrationDetail.Source != "offline" {
		t.Fatalf("an empty structured cache entry blocked fallback: %s %v", raw, err)
	}
}
