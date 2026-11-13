package core

import (
	"encoding/json"
	"testing"
	"time"
)

func TestMaintenanceCacheCleanupReschedulesOnlyWhileMoreRemains(t *testing.T) {
	f := newFixture(t)
	if _, err := f.store.Pool.Exec(f.ctx, `INSERT INTO pulse.notifications(user_id,kind,read_at,created_at)
		SELECT $1,'test.cleanup',now()-interval '120 days',now()-interval '120 days' FROM generate_series(1,501)`, f.alice.UserID); err != nil {
		t.Fatal(err)
	}
	parameters, _ := json.Marshal(map[string]any{"retention_days": 90, "clean_cache": true})
	var runID string
	if err := f.store.Pool.QueryRow(f.ctx, `INSERT INTO pulse.maintenance_runs(id,kind,parameters) VALUES($1,'manual',$2) RETURNING id::text`, newID(), parameters).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	done, err := f.service.ProcessMaintenanceOnce(f.ctx)
	if err != nil || !done {
		t.Fatalf("first cleanup pass failed: done=%v err=%v", done, err)
	}
	var status string
	err = f.store.Pool.QueryRow(f.ctx, "SELECT status FROM pulse.maintenance_runs WHERE id=$1", runID).Scan(&status)
	if err != nil || status != "pending" {
		t.Fatalf("remaining rows should requeue the job: status=%q err=%v", status, err)
	}
	done, err = f.service.ProcessMaintenanceOnce(f.ctx)
	if err != nil || !done {
		t.Fatalf("final cleanup pass failed: done=%v err=%v", done, err)
	}
	err = f.store.Pool.QueryRow(f.ctx, "SELECT status FROM pulse.maintenance_runs WHERE id=$1", runID).Scan(&status)
	if err != nil || status != "completed" {
		t.Fatalf("cleanup without remaining rows must complete: status=%q err=%v", status, err)
	}
}

func TestMaintenanceMixedJobKeepsAccountProgressAndSkipsChangedUsers(t *testing.T) {
	f := newFixture(t)
	admin := newAdmin(t, f)
	f.exec(t, "UPDATE pulse.users SET last_active_at=now()-interval '200 days' WHERE id=$1", f.carol.UserID)
	f.exec(t, `INSERT INTO pulse.notifications(user_id,kind,read_at,created_at) SELECT $1,'cleanup',now()-interval '120 days',now()-interval '120 days' FROM generate_series(1,501)`, f.alice.UserID)
	var run map[string]string
	admin.request(t, "POST", "/api/v2/admin/maintenance/runs", map[string]any{"clean_accounts": true, "clean_cache": true, "retention_days": 90, "inactive_days": 180,
		"users": []map[string]string{{"id": f.bob.UserID, "version": "1"}, {"id": f.carol.UserID, "version": "1"}}}, 202, &run)
	for pass := 0; pass < 2; pass++ {
		if done, err := f.service.ProcessMaintenanceOnce(f.ctx); err != nil || !done {
			t.Fatalf("pass %d: %v %v", pass, done, err)
		}
	}
	var status string
	var result struct {
		Accounts int `json:"account_count"`
		Skipped  int `json:"skipped_count"`
		Cleanup  int `json:"cleanup_items"`
	}
	var raw []byte
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT status,result FROM pulse.maintenance_runs WHERE id=$1", run["id"]).Scan(&status, &raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if status != "completed" || result.Accounts != 1 || result.Skipped != 1 || result.Cleanup != 501 {
		t.Fatalf("unexpected persisted progress: %s %+v", status, result)
	}
	var active bool
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT active FROM pulse.users WHERE id=$1", f.bob.UserID).Scan(&active); err != nil || !active {
		t.Fatal("changed user was deleted", err)
	}
}

func TestMaintenanceScheduleUsesLocalCalendarAndReportsMissingWorker(t *testing.T) {
	last := time.Date(2026, 11, 12, 2, 0, 0, 0, workTimezone)
	now := time.Date(2026, 11, 12, 23, 0, 0, 0, workTimezone)
	want := time.Date(2026, 11, 13, 3, 15, 0, 0, workTimezone)
	policy := MaintenancePolicy{Hour: 3, Minute: 15, IntervalDays: 1}
	if next := nextMaintenanceRun(now, policy, &last); !next.Equal(want) {
		t.Fatalf("next = %v want %v", next, want)
	}
	if due := maintenanceDueAt(now, policy, &last); !due.Equal(want) {
		t.Fatalf("due = %v want %v", due, want)
	}
	f := newFixture(t)
	status, err := f.service.MaintenanceStatus(f.ctx)
	if err != nil || status["worker_online"] != false || status["last_run_at"] != (*time.Time)(nil) {
		t.Fatalf("missing worker: %v %v", status, err)
	}
}

func TestMaintenanceInvalidParametersFinishWithoutHoldingLease(t *testing.T) {
	f := newFixture(t)
	id := newID()
	f.exec(t, `INSERT INTO pulse.maintenance_runs(id,kind,parameters) VALUES($1,'manual','{"clean_cache":"invalid"}')`, id)
	if done, err := f.service.ProcessMaintenanceOnce(f.ctx); err != nil || !done {
		t.Fatal(done, err)
	}
	var status, code string
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT status,error_code FROM pulse.maintenance_runs WHERE id=$1 AND lease_token IS NULL", id).Scan(&status, &code); err != nil || status != "failed" || code != "invalid_parameters" {
		t.Fatal(status, code, err)
	}
}
