package core

import (
	"encoding/json"
	"testing"
)

func TestAdminUserOfflineLocationCompletesOnlyTheCurrentUserAndIP(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	f.service.IPPureEnabled = true
	f.exec(t, "UPDATE pulse.users SET registration_ip='106.34.114.34' WHERE id=$1", f.bob.UserID)
	f.exec(t, "DELETE FROM pulse.login_events WHERE user_id=$1", f.bob.UserID)
	f.exec(t, "INSERT INTO pulse.login_events(user_id,account,ip,platform,device_name,success,reason) VALUES($1,'bob01','120.219.99.2','web','test',true,'ok')", f.bob.UserID)
	f.exec(t, "INSERT INTO pulse.client_reported_ip_locations(user_id,ip,country,province,city) VALUES($1,'106.34.114.34','中国','别人的省','别人的城市')", f.carol.UserID)
	check := func(row adminLocationUser) {
		t.Helper()
		if row.ID != f.bob.UserID || row.Registration == nil || row.Registration.Country != "中国" || row.Registration.Province != "河南省" || row.Registration.City != "郑州市" || row.Registration.Source != "offline" || row.Registration.Reported {
			t.Fatalf("registration fallback missing or borrowed another user's metadata: %+v", row)
		}
		if row.Login == nil || row.Login.Province != "河南省" || row.Login.City != "许昌市" || row.Login.Source != "offline" || row.Login.Reported {
			t.Fatalf("latest login fallback used a different IP: %+v", row.Login)
		}
	}
	var page struct {
		Items []adminLocationUser `json:"items"`
	}
	root.request(t, "GET", "/api/v2/admin/users?size=1&q=bob01", nil, 200, &page)
	if len(page.Items) != 1 {
		t.Fatalf("pagination/filter changed: %+v", page)
	}
	check(page.Items[0])
	var detail adminLocationUser
	root.request(t, "GET", "/api/v2/admin/users/"+f.bob.UserID, nil, 200, &detail)
	check(detail)
	var cache, reports int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT (SELECT count(*) FROM pulse.ip_locations),(SELECT count(*) FROM pulse.client_reported_ip_locations)").Scan(&cache, &reports); err != nil || cache != 0 || reports != 1 {
		t.Fatalf("read-only fallback wrote provider data: cache=%d reports=%d err=%v", cache, reports, err)
	}
	f.request(t, "GET", "/api/v2/admin/users", f.bob.Token, nil, 401, nil)
}

func TestAdminUserChinesePresentationKeepsProviderDecision(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	f.service.IPPureEnabled = true
	f.exec(t, "UPDATE pulse.users SET registration_ip='183.198.88.116' WHERE id=$1", f.bob.UserID)
	f.exec(t, "INSERT INTO pulse.client_reported_ip_locations(user_id,ip,country,province,city) VALUES($1,'183.198.88.116','China','Shanghai','Shanghai')", f.bob.UserID)
	var row adminLocationUser
	root.request(t, "GET", "/api/v2/admin/users/"+f.bob.UserID, nil, 200, &row)
	if row.Registration == nil || row.Registration.Country != "中国" || row.Registration.Province != "上海市" || row.Registration.City != "上海市" || row.Registration.Source != "ippure" || !row.Registration.Reported {
		t.Fatalf("English labels remained, or the IP lookup replaced the provider's city: %+v", row)
	}
}

func TestAdminUserOfflineLocationDoesNotInventMissingParts(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	f.exec(t, "UPDATE pulse.users SET registration_ip='39.144.89.121' WHERE id=$1", f.bob.UserID)
	f.exec(t, "UPDATE pulse.login_events SET ip=NULL WHERE user_id=$1", f.bob.UserID)
	var row map[string]json.RawMessage
	root.request(t, "GET", "/api/v2/admin/users/"+f.bob.UserID, nil, 200, &row)
	var detail struct{ Country, Province, City, Source string }
	if err := json.Unmarshal(row["registration_ip_location_detail"], &detail); err != nil || detail.Country != "中国" || detail.Province != "" || detail.City != "" || detail.Source != "offline" {
		t.Fatalf("country-only offline data was expanded or lost: %s %v", row["registration_ip_location_detail"], err)
	}
	if string(row["last_login_ip_location_detail"]) != "null" {
		t.Fatalf("missing login IP inherited a location: %s", row["last_login_ip_location_detail"])
	}
}
