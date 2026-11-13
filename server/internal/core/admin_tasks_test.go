package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"
)

type adminClient struct {
	f           *fixture
	cookie      *http.Cookie
	csrf, entry string
	who         AdminIdentity
}

func newAdmin(t *testing.T, f *fixture) *adminClient {
	t.Helper()
	_, entry, e := f.service.BootstrapAdmin(f.ctx, "rootreview", testPassword)
	if e != nil {
		t.Fatal(e)
	}
	c := &adminClient{f: f, entry: entry}
	c.login(t, "rootreview", testPassword)
	return c
}
func (c *adminClient) login(t *testing.T, account, password string) {
	t.Helper()
	data, _ := json.Marshal(map[string]string{"account": account, "password": password, "entry_token": c.entry})
	req, _ := http.NewRequest("POST", c.f.http.URL+"/api/v2/admin/auth/login", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	resp, e := c.f.http.Client().Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("admin login failed: %d", resp.StatusCode)
	}
	var out struct {
		User AdminIdentity `json:"user"`
		CSRF string        `json:"csrf_token"`
	}
	if e = json.NewDecoder(resp.Body).Decode(&out); e != nil {
		t.Fatal(e)
	}
	c.who, c.csrf = out.User, out.CSRF
	for _, cookie := range resp.Cookies() {
		if cookie.Name == "pulse_admin" {
			c.cookie = cookie
		}
	}
	if c.cookie == nil || !c.cookie.HttpOnly || c.cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("admin cookie not protected")
	}
	var sid string
	if e = c.f.store.Pool.QueryRow(c.f.ctx, "SELECT id::text FROM pulse.admin_sessions WHERE token_hash=$1", digest(c.cookie.Value)).Scan(&sid); e != nil {
		t.Fatal(e)
	}
	c.who.SessionID = sid
	c.who.RequestID = newID()
}
func (c *adminClient) request(t *testing.T, method, path string, body any, status int, out any) {
	t.Helper()
	var input io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		input = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, c.f.http.URL+path, input)
	req.AddCookie(c.cookie)
	req.Header.Set("X-Admin-Entry", c.entry)
	req.Header.Set("X-CSRF-Token", c.csrf)
	req.Header.Set("Content-Type", "application/json")
	resp, e := c.f.http.Client().Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != status {
		t.Fatalf("%s %s: got %d want %d: %s", method, path, resp.StatusCode, status, raw)
	}
	if out != nil {
		if e = json.Unmarshal(raw, out); e != nil {
			t.Fatal(e)
		}
	}
}
func TestAdminBootstrapIsSingleUse(t *testing.T) {
	f := newFixture(t)
	newAdmin(t, f)
	if _, _, e := f.service.BootstrapAdmin(f.ctx, "another", testPassword); func() bool {
		var fault *Fault
		return errors.As(e, &fault) && fault.Code == "admin_already_bootstrapped"
	}() == false {
		t.Fatalf("second bootstrap allowed: %v", e)
	}
	var count int
	if e := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM information_schema.columns WHERE table_schema='pulse' AND table_name='admin_accounts' AND column_name='entry_token'").Scan(&count); e != nil || count != 0 {
		t.Fatal("recoverable entry token remains in database", e)
	}
}
func TestAdminIsolationCSRFPermissionsAndRevocation(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	root.request(t, "GET", "/api/v2/admin/users", nil, 200, nil)
	prior := root.csrf
	root.csrf = "bad"
	root.request(t, "POST", "/api/v2/admin/users", map[string]string{"account": "admincreated9", "nickname": "测试", "password": testPassword}, 403, nil)
	root.csrf = prior
	var account struct {
		ID    string `json:"id"`
		Entry string `json:"entry_token"`
	}
	root.request(t, "POST", "/api/v2/admin/accounts", AdminAccountInput{Account: "auditor01", Password: testPassword, Role: "auditor", Permissions: []string{"users.view"}, Active: true}, 200, &account)
	auditor := &adminClient{f: f, entry: account.Entry}
	auditor.login(t, "auditor01", testPassword)
	auditor.request(t, "GET", "/api/v2/admin/users", nil, 200, nil)
	auditor.request(t, "GET", "/api/v2/admin/tasks", nil, 403, nil)
	auditor.request(t, "POST", "/api/v2/admin/users", map[string]string{"account": "forbidden9", "nickname": "测试", "password": testPassword}, 403, nil)
	root.request(t, "PUT", "/api/v2/admin/accounts/"+account.ID, AdminAccountInput{Account: "auditor01", Role: "auditor", Permissions: []string{"users.view"}, Active: false, Expected: 1}, 200, nil)
	auditor.request(t, "GET", "/api/v2/admin/users", nil, 401, nil)
	root.request(t, "PUT", "/api/v2/admin/accounts/"+root.who.ID, AdminAccountInput{Account: "rootreview", Role: "auditor", Active: false, Expected: 1}, 403, nil)
	active := false
	root.request(t, "PATCH", "/api/v2/admin/users/"+f.bob.UserID, AdminUserPatch{Active: &active, Expected: 1}, 204, nil)
	f.request(t, "GET", "/api/v2/me", f.bob.Token, nil, 401, nil)
	var setting struct {
		Version string `json:"version"`
	}
	root.request(t, "GET", "/api/v2/admin/config/announcement", nil, 200, &setting)
	root.request(t, "PUT", "/api/v2/admin/config/announcement", map[string]any{"value": map[string]any{"enabled": true, "title": "公告", "body": "内容"}, "expected_version": setting.Version}, 200, nil)
	root.request(t, "PUT", "/api/v2/admin/config/announcement", map[string]any{"value": map[string]any{"enabled": false}, "expected_version": setting.Version}, 409, nil)
}
func TestWorkTaskSnapshotGradingAndProtectedDelete(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	yes, no := true, false
	q1, e := f.service.SaveQuestion(f.ctx, root.who, "", WorkQuestion{ImageURL: "https://example.invalid/a.png", Correct: &yes})
	if e != nil {
		t.Fatal(e)
	}
	q2, e := f.service.SaveQuestion(f.ctx, root.who, "", WorkQuestion{ImageURL: "https://example.invalid/b.png", Correct: &no})
	if e != nil {
		t.Fatal(e)
	}
	task, e := f.service.SaveWorkTask(f.ctx, root.who, "", WorkTaskInput{Key: "daily", Name: "每日任务", OpenTime: "00:00", Estimated: 10, Questions: 2, Intern: "1.005", Formal: "2.015", Enabled: true})
	if e != nil {
		t.Fatal(e)
	}
	code, e := f.service.TaskCode(f.ctx, root.who, task, workDate(), false)
	if e != nil {
		t.Fatal(e)
	}
	var record WorkRecord
	f.request(t, "POST", "/api/v2/tasks/"+task+"/start", f.alice.Token, map[string]string{"code": code}, 200, &record)
	if record.Total != 2 || record.Unit != "1.005" || record.Questions[0].Correct != nil {
		t.Fatal("snapshot leaked or wrong price")
	}
	f.exec(t, "UPDATE pulse.work_questions SET correct=NOT correct")
	f.exec(t, "UPDATE pulse.work_tasks SET intern_millis=9000")
	f.exec(t, "UPDATE pulse.users SET formal_employee=true WHERE id=$1", f.alice.UserID)
	old := record.ID
	f.request(t, "POST", "/api/v2/tasks/"+task+"/start", f.alice.Token, map[string]string{"code": code}, 200, &record)
	if record.ID != old || record.Unit != "1.005" {
		t.Fatal("daily record changed")
	}
	f.request(t, "PUT", "/api/v2/task-records/"+old+"/submit", f.alice.Token, WorkAnswersInput{Answers: map[string]bool{q1: true}, Expected: record.Version}, 400, nil)
	f.request(t, "PUT", "/api/v2/task-records/"+old+"/submit", f.alice.Token, WorkAnswersInput{Answers: map[string]bool{q1: true, q2: false}, Expected: record.Version}, 200, &record)
	if record.Wage != "2.010" || record.CorrectCount != 2 || record.Status != "reviewed" {
		t.Fatalf("grading did not use snapshot: %+v", record)
	}
	f.request(t, "PUT", "/api/v2/task-records/"+old+"/submit", f.alice.Token, WorkAnswersInput{Answers: map[string]bool{}, Expected: 1}, 200, nil)
	f.request(t, "GET", "/api/v2/task-records/"+old, f.bob.Token, nil, 403, nil)
	root.request(t, "DELETE", "/api/v2/admin/tasks/"+task, nil, 409, nil)
	// Fixture-only legacy pending record remains reviewable; submission cannot invent extra questions.
	f.exec(t, "UPDATE pulse.work_records SET status='in_progress' WHERE id=$1", old)
	f.request(t, "PUT", "/api/v2/task-records/"+old+"/answers", f.alice.Token, WorkAnswersInput{Answers: map[string]bool{newID(): true}, Expected: record.Version}, 400, nil)
}
