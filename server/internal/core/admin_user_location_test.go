package core

import (
	"encoding/json"
	"testing"
)

type adminLocationUser struct {
	ID           string `json:"id"`
	Registration *struct {
		Country, Province, City, Source string
		Reported                        bool
	} `json:"registration_ip_location_detail"`
	Login *struct {
		Country, Province, City, Source string
		Reported                        bool
	} `json:"last_login_ip_location_detail"`
}

func TestAdminUserIPPureLocationsStayBoundToUserAndAddress(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	f.service.IPPureEnabled = true
	f.exec(t, "UPDATE pulse.users SET registration_ip='8.8.8.8' WHERE id IN($1,$2)", f.bob.UserID, f.carol.UserID)
	f.exec(t, `INSERT INTO pulse.login_events(user_id,account,ip,platform,device_name,success,reason) VALUES
	 ($1,'bob01','7.7.7.7','android','test',true,'ok'),($2,'carol01','7.7.7.7','web','test',true,'ok'),
	 ($1,'bob01','9.9.9.9','android','test',false,'denied')`, f.bob.UserID, f.carol.UserID)
	f.exec(t, `INSERT INTO pulse.client_reported_ip_locations(user_id,ip,country,province,city) VALUES
	 ($1,'8.8.8.8','中国','浙江省','杭州市'),($1,'7.7.7.7','中国','广东省','深圳市'),
	 ($1,'9.9.9.9','错误 IP','错误省','错误市'),($2,'7.7.7.7','United States','California','Los Angeles')`, f.bob.UserID, f.carol.UserID)
	f.exec(t, `INSERT INTO pulse.ip_locations(ip,country,province,city,status) VALUES
	 ('8.8.8.8','中国','江苏省','南京市','resolved'),('7.7.7.7','中国','山东省','济南市','resolved')`)
	var page struct {
		Items []adminLocationUser `json:"items"`
	}
	root.request(t, "GET", "/api/v2/admin/users?size=2&q=bob01", nil, 200, &page)
	if len(page.Items) != 1 || page.Items[0].ID != f.bob.UserID {
		t.Fatalf("filtered user pagination changed: %+v", page)
	}
	checkBob := func(row adminLocationUser) {
		t.Helper()
		if row.Registration == nil || row.Registration.Country != "中国" || row.Registration.Province != "浙江省" || row.Registration.City != "杭州市" || row.Registration.Source != "ippure" || !row.Registration.Reported {
			t.Fatalf("registration IPPure result missing or mixed: %+v", row.Registration)
		}
		if row.Login == nil || row.Login.Province != "广东省" || row.Login.City != "深圳市" || row.Login.Source != "ippure" || !row.Login.Reported {
			t.Fatalf("latest successful login location mixed IPs or users: %+v", row.Login)
		}
	}
	checkBob(page.Items[0])
	var detail adminLocationUser
	root.request(t, "GET", "/api/v2/admin/users/"+f.bob.UserID, nil, 200, &detail)
	checkBob(detail)
	root.request(t, "GET", "/api/v2/admin/users/"+f.carol.UserID, nil, 200, &detail)
	if detail.Login == nil || detail.Login.Country != "United States" || detail.Login.City != "Los Angeles" || detail.Registration == nil || detail.Registration.Source != "cache" || detail.Registration.Province != "江苏省" {
		t.Fatalf("same-IP users borrowed each other's reported locations: %+v", detail)
	}
	f.service.IPPureEnabled = false
	root.request(t, "GET", "/api/v2/admin/users/"+f.bob.UserID, nil, 200, &detail)
	if detail.Registration == nil || detail.Registration.Source != "cache" || detail.Registration.Reported || detail.Login == nil || detail.Login.City != "济南市" || detail.Login.Source != "cache" {
		t.Fatalf("disabled IPPure did not retain authoritative cache fallback: %+v", detail)
	}
	var sourceCount int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.ip_locations").Scan(&sourceCount); err != nil || sourceCount != 2 {
		t.Fatalf("read-only user management wrote location data: %d %v", sourceCount, err)
	}
}

func TestAdminUserLocationsDoNotBorrowMissingOrFailedData(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	f.service.IPPureEnabled = true
	f.exec(t, "UPDATE pulse.users SET registration_ip='8.8.8.8' WHERE id=$1", f.bob.UserID)
	f.exec(t, "UPDATE pulse.login_events SET ip=NULL WHERE user_id=$1", f.bob.UserID)
	f.exec(t, "INSERT INTO pulse.client_reported_ip_locations(user_id,ip,city) VALUES($1,'8.8.8.8','别人的城市'),($2,'9.9.9.9','别的 IP')", f.carol.UserID, f.bob.UserID)
	f.exec(t, "INSERT INTO pulse.ip_locations(ip,country,province,city,status) VALUES('8.8.8.8','旧国家','旧省','旧城市','failed')")
	var row map[string]json.RawMessage
	path := "/api/v2/admin/users/" + f.bob.UserID
	root.request(t, "GET", path, nil, 200, &row)
	for _, field := range []string{"registration_ip_location_detail", "last_login_ip_location_detail"} {
		if string(row[field]) != "null" {
			t.Fatalf("missing location fabricated %s: %s", field, row[field])
		}
	}
	if _, exposed := row["password_hash"]; exposed {
		t.Fatal("user projection exposed a password hash")
	}
	f.request(t, "GET", path, f.bob.Token, nil, 401, nil)
	f.request(t, "GET", "/api/v2/admin/users", f.bob.Token, nil, 401, nil)
}
