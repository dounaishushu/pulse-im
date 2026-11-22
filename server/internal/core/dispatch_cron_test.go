package core

import (
	"errors"
	"testing"
	"time"
)

func TestDispatchCronPreviewFieldCompatibility(t *testing.T) {
	now := time.Date(2026, 11, 22, 1, 0, 10, 0, time.UTC)
	for _, tc := range []struct {
		name, expression string
		want             time.Time
	}{
		{"seconds", "30 0 9 * * *", time.Date(2026, 11, 22, 1, 0, 30, 0, time.UTC)},
		{"legacy_minutes", "0 9 * * *", time.Date(2026, 11, 23, 1, 0, 0, 0, time.UTC)},
		{"second_steps", "*/15 * * * * *", now.Add(5 * time.Second)},
		{"six_field_daily", "0 0 9 * * *", time.Date(2026, 11, 23, 1, 0, 0, 0, time.UTC)},
		{"whitespace", "  30\t0 9 * * *  ", time.Date(2026, 11, 22, 1, 0, 30, 0, time.UTC)},
		{"retained_descriptor", "@daily", time.Date(2026, 11, 22, 16, 0, 0, 0, time.UTC)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := previewDispatchSchedule(dispatchScheduleInput{Cron: tc.expression, Delays: []int{0, 5, 10}}, now)
			if err != nil {
				t.Fatal(err)
			}
			if !out.BaseAt.Equal(tc.want) || out.Timezone != "Asia/Shanghai" || len(out.Steps) != 3 || !out.Steps[2].Equal(tc.want.Add(15*time.Second)) {
				t.Fatalf("incorrect Beijing schedule: got %+v want base %s", out, tc.want)
			}
		})
	}
}

func TestDispatchCronRejectsInvalidSchedules(t *testing.T) {
	for _, expression := range []string{"0 9 * *", "0 0 9 * * * *", "60 0 9 * * *", "0 60 9 * * *", "0 0 24 * * *", "0 0 9 31 2 *", "*/0 * * * * *", "TZ=UTC", "CRON_TZ=Asia/Shanghai"} {
		t.Run(expression, func(t *testing.T) {
			_, err := previewDispatchSchedule(dispatchScheduleInput{Cron: expression, Delays: []int{0}}, time.Now())
			var fault *Fault
			if !errors.As(err, &fault) || fault.Status != 400 || fault.Code != "dispatch_cron_invalid" {
				t.Fatalf("invalid cron was not rejected consistently: %v", err)
			}
		})
	}
}

func TestDispatchCronPersistsExecutesAndReschedules(t *testing.T) {
	for _, expression := range []string{"30 0 9 * * *", "0 9 * * *"} {
		t.Run(expression, func(t *testing.T) {
			f := newFixture(t)
			admin := newAdmin(t, f)
			in := DispatchInput{Name: "cron compatibility", SenderID: f.alice.UserID, Targets: []string{f.cid}, Steps: []SendInput{{Body: "cron notification"}}, Delays: []int{0}, Cron: expression, Enabled: true}
			var saved map[string]string
			admin.request(t, "POST", "/api/v2/admin/dispatch-plans", in, 200, &saved)
			id := saved["id"]
			var storedExpression string
			var next time.Time
			if err := f.store.Pool.QueryRow(f.ctx, "SELECT cron,next_run FROM pulse.dispatch_plans WHERE id=$1", id).Scan(&storedExpression, &next); err != nil || storedExpression != expression || !next.After(time.Now()) {
				t.Fatalf("cron plan was not persisted with a future run: %s %s %v", storedExpression, next, err)
			}
			f.exec(t, "UPDATE pulse.dispatch_plans SET next_run=now()-interval '1 second' WHERE id=$1", id)
			restarted, err := NewService(f.store, f.cache)
			if err != nil {
				t.Fatal(err)
			}
			if done, err := restarted.ScheduleDispatchOnce(f.ctx); err != nil || !done {
				t.Fatalf("saved cron failed after scheduler restart: %v %v", done, err)
			}
			if err := f.store.Pool.QueryRow(f.ctx, "SELECT next_run FROM pulse.dispatch_plans WHERE id=$1", id).Scan(&next); err != nil || !next.After(time.Now()) {
				t.Fatalf("cron did not advance after durable admission: %s %v", next, err)
			}
			wantSecond := 0
			if expression == "30 0 9 * * *" {
				wantSecond = 30
			}
			if beijing := next.In(workTimezone); beijing.Hour() != 9 || beijing.Minute() != 0 || beijing.Second() != wantSecond {
				t.Fatalf("scheduler disagrees with preview: %s", beijing)
			}
			if done, err := restarted.ScheduleDispatchOnce(f.ctx); err != nil || done {
				t.Fatalf("future cron was admitted twice: %v %v", done, err)
			}
			if done, err := restarted.ProcessSendOnce(f.ctx); err != nil || !done {
				t.Fatalf("cron batch was not delivered: %v %v", done, err)
			}
			var count int
			if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.messages WHERE conversation_id=$1 AND body='cron notification'", f.cid).Scan(&count); err != nil || count != 1 {
				t.Fatalf("expected exactly one scheduled message, got %d %v", count, err)
			}
			in.Expected = 1
			in.Cron = "0 9 * * *"
			if expression == in.Cron {
				in.Cron = "30 0 9 * * *"
			}
			admin.request(t, "PUT", "/api/v2/admin/dispatch-plans/"+id, in, 200, &saved)
			if err := f.store.Pool.QueryRow(f.ctx, "SELECT cron FROM pulse.dispatch_plans WHERE id=$1", id).Scan(&storedExpression); err != nil || storedExpression != in.Cron {
				t.Fatalf("could not edit between five and six fields: %s %v", storedExpression, err)
			}
		})
	}
}

func TestDispatchCronInvalidPlanDoesNotWrite(t *testing.T) {
	f := newFixture(t)
	admin := newAdmin(t, f)
	in := DispatchInput{Name: "invalid cron", SenderID: f.alice.UserID, Targets: []string{f.cid}, Steps: []SendInput{{Body: "must not send"}}, Delays: []int{0}, Cron: "0 0 9 31 2 *", Enabled: true}
	var response struct {
		Error struct{ Code string } `json:"error"`
	}
	admin.request(t, "POST", "/api/v2/admin/dispatch-plans", in, 400, &response)
	if response.Error.Code != "dispatch_cron_invalid" {
		t.Fatalf("unhelpful invalid cron error: %+v", response)
	}
	var count int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.dispatch_plans").Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid cron persisted: %d %v", count, err)
	}
}
