package core

import "testing"

func TestWorkTaskCodeRejectionKeepsSession(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	for _, answer := range []bool{true, false} {
		if _, err := f.service.SaveQuestion(f.ctx, root.who, "", WorkQuestion{ImageURL: "https://example.invalid/task.png", Correct: &answer}); err != nil {
			t.Fatal(err)
		}
	}
	task, err := f.service.SaveWorkTask(f.ctx, root.who, "", WorkTaskInput{Key: "verification", Name: "验证码测试", OpenTime: "00:00", Estimated: 1, Questions: 2, Intern: "0.402", Formal: "1.000", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	code, err := f.service.TaskCode(f.ctx, root.who, task, workDate(), false)
	if err != nil {
		t.Fatal(err)
	}
	var failure struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	wrong := "000000"
	if code == wrong {
		wrong = "000001"
	}
	f.request(t, "POST", "/api/v2/tasks/"+task+"/start", f.alice.Token, map[string]string{"code": wrong}, 403, &failure)
	if failure.Error.Code != "task_code_invalid" {
		t.Fatalf("wrong code was misclassified: %+v", failure)
	}
	f.request(t, "GET", "/api/v2/me/profile", f.alice.Token, nil, 200, nil)
	var records int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.work_records WHERE task_id=$1", task).Scan(&records); err != nil || records != 0 {
		t.Fatalf("incorrect code created a task record: count=%d err=%v", records, err)
	}
	current, err := f.service.TaskCode(f.ctx, root.who, task, workDate(), true)
	if err != nil {
		t.Fatal(err)
	}
	f.request(t, "POST", "/api/v2/tasks/"+task+"/start", f.alice.Token, map[string]string{"code": code}, 403, &failure)
	if failure.Error.Code != "task_code_invalid" {
		t.Fatalf("replaced code was misclassified: %+v", failure)
	}
	var record WorkRecord
	f.request(t, "POST", "/api/v2/tasks/"+task+"/start", f.alice.Token, map[string]string{"code": current}, 200, &record)
	if record.UserID != f.alice.UserID || record.Employee != "intern" || record.Status != "in_progress" {
		t.Fatalf("correct code did not start the authenticated intern task: %+v", record)
	}
	f.request(t, "POST", "/api/v2/tasks/"+task+"/start", "", map[string]string{"code": current}, 401, &failure)
	if failure.Error.Code != "unauthorized" {
		t.Fatalf("missing login was not kept distinct: %+v", failure)
	}
}
