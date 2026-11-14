package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestAdminRedesignFiltersAndScopedSelectors(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	var accountProfile map[string]any
	root.request(t, "GET", "/api/v2/admin/users/"+f.alice.UserID, nil, 200, &accountProfile)
	if accountProfile["last_login_ip"] != "127.0.0.1" || accountProfile["last_login_at"] == nil || accountProfile["password_hash"] != nil {
		t.Fatalf("missing login context or leaked credentials: %#v", accountProfile)
	}
	created, err := f.service.SaveAdmin(f.ctx, root.who, "", AdminAccountInput{Account: "grouponly", Password: testPassword, Role: "operator", Permissions: []string{"groups.manage"}, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	operator := &adminClient{f: f, entry: created["entry_token"].(string)}
	operator.login(t, "grouponly", testPassword)
	operator.request(t, "GET", "/api/v2/admin/users", nil, 403, nil)
	var selector struct {
		Items []map[string]any `json:"items"`
	}
	operator.request(t, "GET", "/api/v2/admin/select-options?scope=groups&kind=sender&q=alice", nil, 200, &selector)
	if len(selector.Items) != 1 || selector.Items[0]["username"] != "alice01" {
		t.Fatalf("wrong selector: %#v", selector.Items)
	}
	if len(selector.Items[0]) != 3 {
		t.Fatal("selector exposed more than id/name/username")
	}
	operator.request(t, "GET", "/api/v2/admin/select-options?scope=dispatch&kind=sender", nil, 403, nil)
	operator.request(t, "GET", "/api/v2/admin/select-options?scope=users&kind=sender", nil, 400, nil)
	operator.request(t, "GET", "/api/v2/admin/ip-locations?ip=127.0.0.1", nil, 403, nil)
	readerAccount, err := f.service.SaveAdmin(f.ctx, root.who, "", AdminAccountInput{Account: "userreader", Password: testPassword, Role: "auditor", Permissions: []string{"users.view"}, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	reader := &adminClient{f: f, entry: readerAccount["entry_token"].(string)}
	reader.login(t, "userreader", testPassword)
	reader.request(t, "GET", "/api/v2/admin/ip-locations?ip=127.0.0.1", nil, 200, nil)
	reader.request(t, "POST", "/api/v2/admin/ip-locations/refresh", map[string]any{"ips": []string{"127.0.0.1"}}, 403, nil)
	f.exec(t, "UPDATE pulse.users SET legacy_public_id='AbCdEf1234567890' WHERE id=$1", f.alice.UserID)
	f.exec(t, "INSERT INTO pulse.legacy_ids(entity,legacy_id,new_id) VALUES('user',987654321,$1)", f.alice.UserID)
	var oldIDs struct {
		Items []map[string]any `json:"items"`
	}
	for _, value := range []string{"AbCdEf1234567890", "987654321", f.alice.UserID} {
		root.request(t, "GET", "/api/v2/admin/users?q="+value, nil, 200, &oldIDs)
		if len(oldIDs.Items) != 1 || oldIDs.Items[0]["id"] != f.alice.UserID {
			t.Fatal("migrated user identifier no longer resolves", value)
		}
	}

	for i, owner := range []string{f.alice.UserID, f.bob.UserID} {
		_, err := f.service.AdminSaveGroup(f.ctx, root.who, "", AdminGroupInput{Title: fmt.Sprintf("review-group-%d", i), OwnerID: owner, Kind: "group", Policy: "invite", Limit: 100, Active: true})
		if err != nil {
			t.Fatal(err)
		}
	}
	var groups struct {
		Items []map[string]any `json:"items"`
	}
	root.request(t, "GET", "/api/v2/admin/groups?name=review-group&owner=alice", nil, 200, &groups)
	if len(groups.Items) != 1 || groups.Items[0]["owner_username"] != "alice01" {
		t.Fatalf("group filter not applied: %#v", groups.Items)
	}
	root.request(t, "GET", "/api/v2/admin/groups?group_id="+groups.Items[0]["id"].(string), nil, 200, &groups)
	if len(groups.Items) != 1 {
		t.Fatal("exact group filter not applied")
	}

	for i := 0; i < 2; i++ {
		answer := i == 0
		if _, err := f.service.SaveQuestion(f.ctx, root.who, "", WorkQuestion{ImageURL: "https://example.invalid/question.png", Correct: &answer}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		_, err := f.service.SaveWorkTask(f.ctx, root.who, "", WorkTaskInput{Key: fmt.Sprintf("filter%d", i), Name: fmt.Sprintf("task name %d", i), OpenTime: "09:00", Estimated: 10, Questions: 2, Intern: "0.100", Formal: "0.200", Enabled: i == 0})
		if err != nil {
			t.Fatal(err)
		}
	}
	var tasks struct {
		Items []map[string]any `json:"items"`
	}
	root.request(t, "GET", "/api/v2/admin/tasks?key=filter&name=name&status=disabled&size=1", nil, 200, &tasks)
	if len(tasks.Items) != 1 || tasks.Items[0]["task_key"] != "filter1" {
		t.Fatalf("task filter applied after pagination: %#v", tasks.Items)
	}
	root.request(t, "GET", "/api/v2/admin/tasks?status=unrecognized", nil, 400, nil)

	var accounts struct {
		Items []map[string]any `json:"items"`
	}
	root.request(t, "GET", "/api/v2/admin/accounts?q=group&status=active&size=1", nil, 200, &accounts)
	if len(accounts.Items) != 1 || accounts.Items[0]["account"] != "grouponly" {
		t.Fatal("account filtering failed")
	}
	f.exec(t, "INSERT INTO pulse.sensitive_words(id,word,replacement) SELECT gen_random_uuid(),'filler-'||lpad(i::text,3,'0'),'*' FROM generate_series(1,101)i")
	f.exec(t, "INSERT INTO pulse.sensitive_words(id,word,replacement) VALUES($1,'zz-target','*')", newID())
	var words struct {
		Items []map[string]any `json:"items"`
	}
	root.request(t, "GET", "/api/v2/admin/sensitive-words?q=zz-target&size=1", nil, 200, &words)
	if len(words.Items) != 1 || words.Items[0]["word"] != "zz-target" {
		t.Fatal("word search did not run before pagination")
	}
}

func TestAdminDispatchUserTargetsPreservePrivacyAndExecution(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	future := time.Now().Add(time.Hour)
	input := DispatchInput{Name: "direct-user-plan", SenderID: f.alice.UserID, Users: []string{f.carol.UserID}, Steps: []SendInput{{Body: "user dispatch"}}, Delays: []int{0}, RunAt: &future, Enabled: true}
	plan, err := f.service.SaveDispatch(f.ctx, root.who, "", input)
	if err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT payload FROM pulse.dispatch_plans WHERE id=$1", plan).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var stored DispatchInput
	if err = json.Unmarshal(raw, &stored); err != nil || len(stored.Users) != 1 || len(stored.Targets) != 1 {
		t.Fatal("user targets were not durably resolved", err)
	}
	f.exec(t, "UPDATE pulse.dispatch_plans SET next_run=now()-interval '1 second' WHERE id=$1", plan)
	if done, e := f.service.ScheduleDispatchOnce(f.ctx); !done || e != nil {
		t.Fatalf("schedule: %v %v", done, e)
	}
	if done, e := f.service.ProcessSendOnce(f.ctx); !done || e != nil {
		t.Fatalf("delivery: %v %v", done, e)
	}
	var count int
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.messages WHERE conversation_id=$1 AND body='user dispatch'", stored.Targets[0]).Scan(&count); err != nil || count != 1 {
		t.Fatal("direct message not delivered", err)
	}
	var plans struct {
		Items []map[string]any `json:"items"`
	}
	root.request(t, "GET", "/api/v2/admin/dispatch-plans?q=direct-user&status=completed&trigger_type=once", nil, 200, &plans)
	if len(plans.Items) != 1 || plans.Items[0]["ui_status"] != "completed" {
		t.Fatalf("wrong dispatch status: %#v", plans.Items)
	}

	// A new block must be enforced at actual delivery, even after a plan was saved.
	input.Name = "blocked-after-admission"
	plan, err = f.service.SaveDispatch(f.ctx, root.who, "", input)
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", f.carol.UserID, f.alice.UserID)
	f.exec(t, "UPDATE pulse.dispatch_plans SET next_run=now()-interval '1 second' WHERE id=$1", plan)
	if _, err = f.service.ScheduleDispatchOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.ProcessSendOnce(f.ctx); err != nil {
		t.Fatal(err)
	}
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.messages WHERE conversation_id=$1", stored.Targets[0]).Scan(&count); err != nil || count != 1 {
		t.Fatal("blocked target received a dispatch", err)
	}

	input.Name = "blocked-before-admission"
	if _, err = f.service.SaveDispatch(f.ctx, root.who, "", input); !errors.Is(err, ErrForbidden) {
		t.Fatal("block bypassed at plan admission", err)
	}
	f.exec(t, "DELETE FROM pulse.blocks")
	f.exec(t, "INSERT INTO pulse.privacy_settings(user_id,temporary_chat) VALUES($1,'nobody') ON CONFLICT(user_id) DO UPDATE SET temporary_chat='nobody'", f.carol.UserID)
	if _, err = f.service.SaveDispatch(f.ctx, root.who, "", input); !errors.Is(err, ErrForbidden) {
		t.Fatal("temporary-chat privacy bypassed", err)
	}
	input.Users = []string{f.alice.UserID}
	if _, err = f.service.SaveDispatch(f.ctx, root.who, "", input); !errors.Is(err, ErrInvalid) {
		t.Fatal("self-target accepted", err)
	}
	input.Users, input.Targets = []string{f.bob.UserID}, []string{f.cid}
	if _, err = f.service.SaveDispatch(f.ctx, root.who, "", input); !errors.Is(err, ErrInvalid) {
		t.Fatal("mixed target sets accepted", err)
	}
	input.Users, input.Targets = []string{f.bob.UserID, f.bob.UserID}, nil
	if _, err = f.service.SaveDispatch(f.ctx, root.who, "", input); !errors.Is(err, ErrInvalid) {
		t.Fatal("duplicate user accepted", err)
	}
	if strings.Contains(string(raw), "password") {
		t.Fatal("credentials stored with dispatch")
	}
}
