package core

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestStaffProfileLocationUsesAuthorizedCachedLoginAndRegistrationData(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	f.exec(t, "UPDATE pulse.users SET registration_ip='192.0.2.10' WHERE id=$1", f.bob.UserID)
	f.exec(t, `INSERT INTO pulse.ip_locations(ip,country,province,city,status) VALUES
 ('192.0.2.10','中国','北京','北京','resolved'),('192.0.2.20','中国','广东','深圳','resolved')`)
	f.exec(t, `INSERT INTO pulse.login_events(user_id,account,ip,platform,device_name,success,reason)
 VALUES($1,'bob01','192.0.2.20','android','测试手机',true,'ok'),($1,'bob01','192.0.2.30','pc','失败登录',false,'denied')`, f.bob.UserID)
	var result struct {
		RegistrationIP       string `json:"registration_ip"`
		RegistrationLocation string `json:"registration_ip_location"`
		Logins               []struct {
			IP       string `json:"ip"`
			Location string `json:"location"`
			Status   string `json:"location_status"`
		} `json:"logins"`
	}
	path := "/api/v2/staff/users/" + f.bob.UserID
	f.request(t, "GET", path, f.alice.Token, nil, 200, &result)
	if result.RegistrationIP != "192.0.2.10" || result.RegistrationLocation != "中国 北京 北京" || len(result.Logins) < 1 || result.Logins[0].IP != "192.0.2.20" || result.Logins[0].Location != "中国 广东 深圳" || result.Logins[0].Status != "resolved" {
		t.Fatalf("cached staff locations missing or wrong login selected: %+v", result)
	}
	f.request(t, "GET", path, f.carol.Token, nil, 403, nil)
	f.exec(t, "UPDATE pulse.users SET internal_staff=false WHERE id=$1", f.alice.UserID)
	f.request(t, "GET", path, f.alice.Token, nil, 403, nil)
}

func TestStaffProfileLocationDoesNotStartExternalLookups(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	f.exec(t, "UPDATE pulse.users SET registration_ip='192.0.2.40' WHERE id=$1", f.bob.UserID)
	var calls atomic.Int32
	lookup := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(503) }))
	defer lookup.Close()
	var err error
	f.service.Locations, err = NewLocationClient(lookup.URL)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Location string `json:"registration_ip_location"`
		Status   string `json:"registration_ip_location_status"`
	}
	path := "/api/v2/staff/users/" + f.bob.UserID
	f.request(t, "GET", path, f.alice.Token, nil, 200, &result)
	if result.Location != "" || result.Status != "unknown" || calls.Load() != 0 {
		t.Fatalf("uncached data must not block on external lookup: %+v calls=%d", result, calls.Load())
	}
	f.service.Locations = nil
	f.request(t, "GET", path, f.alice.Token, nil, 200, &result)
	if result.Location != "" || result.Status != "unconfigured" {
		t.Fatalf("unconfigured provider must be distinguished from resolved data: %+v", result)
	}
}
