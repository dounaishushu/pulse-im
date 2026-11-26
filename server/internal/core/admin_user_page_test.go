package core

import (
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func TestAdminUserPagePreservesFiltersAndLatestRows(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	id := func(n int) string { return fmt.Sprintf("10000000-0000-4000-8000-%012d", n) }
	for n := 1; n <= 8; n++ {
		f.exec(t, `INSERT INTO pulse.users(id,account,password_hash,nickname,active,deleted_at,created_at)
		 VALUES($1,$2,$3,$2,$4,CASE WHEN $5 THEN '2026-11-05'::timestamptz END,
		 CASE WHEN $6 THEN '2026-11-02'::timestamptz ELSE '2026-11-01'::timestamptz END)`,
			id(n), fmt.Sprintf("pageuser%02d", n), testPasswordHash, n != 3 && n != 4 && n != 7 && n != 8, n == 4 || n == 8, n >= 6)
	}
	f.exec(t, "UPDATE pulse.users SET nickname='page%_needle' WHERE id=$1", id(2))
	f.exec(t, "UPDATE pulse.users SET registration_ip='8.8.8.8',phone='+86123000005',legacy_public_id='legacyPageFive' WHERE id=$1", id(5))
	f.exec(t, "INSERT INTO pulse.legacy_ids(entity,legacy_id,new_id) VALUES('user',987654321,$1)", id(5))
	// The successful timestamp is authoritative, with id breaking equal-time ties.
	for _, row := range []struct {
		ip, at  string
		success bool
	}{
		{"7.7.7.5", "2026-11-03T12:00:00Z", true},
		{"7.7.7.6", "2026-11-03T12:00:00Z", true},
		{"9.9.9.5", "2026-11-04T12:00:00Z", false},
		{"1.1.1.5", "2026-11-02T12:00:00Z", true},
	} {
		f.exec(t, `INSERT INTO pulse.login_events(user_id,account,ip,platform,device_name,success,reason,created_at,client_version)
		 VALUES($1,'pageuser05',$2,'web','page test',$3,'test',$4,'2.4.234')`, id(5), row.ip, row.success, row.at)
	}
	for n := 1; n <= 2; n++ {
		sid := fmt.Sprintf("20000000-0000-4000-8000-%012d", n)
		f.exec(t, `INSERT INTO pulse.login_sessions(id,user_id,device_id,token_hash,expires_at,platform)
		 VALUES($1,$2,$3,$4,now()+interval '1 day','android')`, sid, id(5), fmt.Sprint(n), digest(sid))
		f.exec(t, `INSERT INTO pulse.client_network_observations(session_id,user_id,observed_ip,exit_ip,client_version,checked_at)
		 VALUES($1,$2,$3::inet,$3::inet,'0.2.124','2026-11-04T12:00:00Z')`, sid, id(5), fmt.Sprintf("8.8.4.%d", n))
	}
	type pageResult struct {
		Items   []map[string]any `json:"items"`
		Page    int              `json:"page"`
		Size    int              `json:"size"`
		HasMore bool             `json:"has_more"`
	}
	for _, tc := range []struct {
		name, query, status string
		page, size          int
		want                []int
	}{
		{"first", "pageuser", "", 1, 3, []int{6, 7, 8}},
		{"second", "pageuser", "", 2, 3, []int{1, 2, 3}},
		{"last", "pageuser", "", 3, 3, []int{4, 5}},
		{"empty", "pageuser", "", 4, 3, nil},
		{"active", "pageuser", "active", 2, 2, []int{2, 5}},
		{"frozen", "pageuser", "frozen", 2, 1, []int{3}},
		{"deleted", "pageuser", "deleted", 2, 1, []int{4}},
		{"phone", "+86123000005", "", 1, 50, []int{5}},
		{"public id", strings.ToUpper(strings.ReplaceAll(id(5), "-", "")), "", 1, 50, []int{5}},
		{"uuid", id(5), "", 1, 50, []int{5}},
		{"legacy public id", "legacyPageFive", "", 1, 50, []int{5}},
		{"legacy numeric id", "987654321", "", 1, 50, []int{5}},
		{"registration ip", "8.8.8.8", "", 1, 50, []int{5}},
		{"historical successful ip", "1.1.1.5", "", 1, 50, []int{5}},
		{"failed ip excluded", "9.9.9.5", "", 1, 50, nil},
		{"literal search wildcards", "%_", "", 1, 50, []int{2}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			query := url.Values{"q": {tc.query}, "status": {tc.status}, "page": {fmt.Sprint(tc.page)}, "size": {fmt.Sprint(tc.size)}}
			var result pageResult
			root.request(t, "GET", "/api/v2/admin/users?"+query.Encode(), nil, 200, &result)
			if len(result.Items) != len(tc.want) || result.Page != tc.page || result.Size != tc.size || result.HasMore != (len(tc.want) == tc.size) {
				t.Fatalf("page metadata or count changed: %+v, want %v", result, tc.want)
			}
			for i, n := range tc.want {
				if result.Items[i]["id"] != id(n) {
					t.Fatalf("page order/filter changed at %d: %v, want %s", i, result.Items[i]["id"], id(n))
				}
				if _, exposed := result.Items[i]["password_hash"]; exposed {
					t.Fatal("page projection exposed password_hash")
				}
			}
		})
	}
	var listed pageResult
	root.request(t, "GET", "/api/v2/admin/users?q=pageuser05", nil, 200, &listed)
	var detail map[string]any
	root.request(t, "GET", "/api/v2/admin/users/"+id(5), nil, 200, &detail)
	if len(listed.Items) != 1 || !reflect.DeepEqual(listed.Items[0], detail) {
		t.Fatalf("page projection differs from user detail: %+v vs %+v", listed.Items, detail)
	}
	network, ok := detail["client_network"].(map[string]any)
	if detail["last_login_ip"] != "7.7.7.6" || detail["last_login_client_version"] != "2.4.234" || !ok || network["observed_ip"] != "8.8.4.2" || network["platform"] != "android" {
		t.Fatalf("latest records selected incorrectly: %+v", detail)
	}
	for _, query := range []string{"status=unknown", "page=0", "size=101"} {
		root.request(t, "GET", "/api/v2/admin/users?"+query, nil, 400, nil)
	}
}

func TestAdminUserPageBoundsLatestLookups(t *testing.T) {
	f := newFixture(t)
	f.exec(t, `INSERT INTO pulse.users(id,account,password_hash,created_at)
	 SELECT md5('page-plan-user-'||g)::uuid,'planuser'||g,$1,now()+make_interval(secs=>g)
	 FROM generate_series(1,512) g`, testPasswordHash)
	f.exec(t, `INSERT INTO pulse.login_events(user_id,account,ip,platform,device_name,success,reason,created_at)
	 SELECT md5('page-plan-user-'||g)::uuid,'planuser'||g,'8.8.8.8','web','plan test',true,'ok',now()-make_interval(secs=>e)
	 FROM generate_series(1,512) g CROSS JOIN generate_series(1,8) e`)
	f.exec(t, `INSERT INTO pulse.login_sessions(id,user_id,device_id,token_hash,expires_at,platform)
	 SELECT md5('page-plan-session-'||g)::uuid,md5('page-plan-user-'||g)::uuid,'plan test',
	 decode(repeat(md5('page-plan-token-'||g),2),'hex'),now()+interval '1 day','web' FROM generate_series(1,512) g`)
	f.exec(t, `INSERT INTO pulse.client_network_observations(session_id,user_id,observed_ip)
	 SELECT md5('page-plan-session-'||g)::uuid,md5('page-plan-user-'||g)::uuid,'8.8.8.8' FROM generate_series(1,512) g`)
	f.exec(t, "ANALYZE pulse.users; ANALYZE pulse.login_events; ANALYZE pulse.client_network_observations")
	const size = 7
	var raw []byte
	if err := f.store.Pool.QueryRow(f.ctx, "EXPLAIN (ANALYZE, FORMAT JSON) "+adminUsersQuery(true), size, 14, "%%", "").Scan(&raw); err != nil {
		t.Fatal(err)
	}
	type planNode struct {
		Relation string     `json:"Relation Name"`
		Loops    float64    `json:"Actual Loops"`
		Rows     float64    `json:"Actual Rows"`
		Plans    []planNode `json:"Plans"`
	}
	var plan []struct{ Plan planNode }
	if err := json.Unmarshal(raw, &plan); err != nil || len(plan) != 1 || plan[0].Plan.Rows != size {
		t.Fatalf("invalid plan or page size: %s / %v", raw, err)
	}
	lookups := map[string]float64{}
	var walk func(planNode)
	walk = func(node planNode) {
		if node.Relation == "login_events" || node.Relation == "client_network_observations" {
			lookups[node.Relation] += node.Loops
		}
		for _, child := range node.Plans {
			walk(child)
		}
	}
	walk(plan[0].Plan)
	for _, relation := range []string{"login_events", "client_network_observations"} {
		if lookups[relation] != size {
			t.Errorf("%s enrichment must run only for the %d page users, got %.0f lookups", relation, size, lookups[relation])
		}
	}
	t.Logf("actual page size %d; latest-record lookups: %v", size, lookups)
}

func TestAdminLatestSuccessfulLoginIndexMatchesOrder(t *testing.T) {
	f := newFixture(t)
	var valid, ready bool
	var definition, predicate string
	err := f.store.Pool.QueryRow(f.ctx, `SELECT i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid),pg_get_expr(i.indpred,i.indrelid)
	 FROM pg_index i WHERE i.indexrelid=to_regclass('pulse.login_events_user_latest_success')`).Scan(&valid, &ready, &definition, &predicate)
	if err != nil || !valid || !ready || predicate != "success" || !strings.Contains(definition, "(user_id, created_at DESC, id DESC)") {
		t.Fatalf("latest successful-login index missing or mismatched: %s, predicate=%q, valid=%v, ready=%v, error=%v", definition, predicate, valid, ready, err)
	}
}
