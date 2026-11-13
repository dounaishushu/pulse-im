package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type IdleCandidate struct {
	ID         string    `json:"id"`
	Account    string    `json:"account"`
	LastActive time.Time `json:"last_active_at"`
	Protected  bool      `json:"protected"`
	Version    int64     `json:"version,string"`
}

const idleProtection = `(u.internal_staff OR EXISTS(SELECT 1 FROM pulse.members m WHERE m.user_id=u.id AND m.active AND m.role IN('owner','admin')) OR EXISTS(SELECT 1 FROM pulse.work_records r WHERE r.user_id=u.id AND r.status<>'reviewed'))`

func (s *Service) IdleCandidates(ctx context.Context, days int, after string) ([]IdleCandidate, error) {
	if days < 1 || days > 3650 {
		return nil, ErrInvalid
	}
	if after == "" {
		after = "00000000-0000-0000-0000-000000000000"
	}
	if !validID(after) {
		return nil, ErrInvalid
	}
	rows, e := s.Store.Pool.Query(ctx, "SELECT u.id::text,u.account,u.last_active_at,"+idleProtection+",u.profile_version FROM pulse.users u WHERE u.deleted_at IS NULL AND u.last_active_at<now()-make_interval(days=>$1) AND u.id>$2 ORDER BY u.id LIMIT 200", days, after)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []IdleCandidate{}
	for rows.Next() {
		var v IdleCandidate
		if e = rows.Scan(&v.ID, &v.Account, &v.LastActive, &v.Protected, &v.Version); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Service) IdleCandidatesPage(ctx context.Context, days int, after string, limit int) ([]IdleCandidate, string, bool, error) {
	if days < 1 || days > 3650 || limit < 1 || limit > 200 {
		return nil, "", false, ErrInvalid
	}
	if after == "" {
		after = "00000000-0000-0000-0000-000000000000"
	}
	if !validID(after) {
		return nil, "", false, ErrInvalid
	}
	rows, err := s.Store.Pool.Query(ctx, "SELECT u.id::text,u.account,u.last_active_at,false,u.profile_version FROM pulse.users u WHERE u.deleted_at IS NULL AND u.active AND u.last_active_at<now()-make_interval(days=>$1) AND u.id>$2 AND NOT "+idleProtection+" ORDER BY u.id LIMIT $3", days, after, limit+1)
	if err != nil {
		return nil, "", false, err
	}
	items := make([]IdleCandidate, 0, limit+1)
	for rows.Next() {
		var item IdleCandidate
		if err = rows.Scan(&item.ID, &item.Account, &item.LastActive, &item.Protected, &item.Version); err != nil {
			rows.Close()
			return nil, "", false, err
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, "", false, err
	}
	hasMore := len(items) > limit
	next := ""
	if hasMore {
		items = items[:limit]
		next = items[len(items)-1].ID
	}
	return items, next, hasMore, nil
}

type IdleDeleteInput struct {
	Users []struct {
		ID      string `json:"id"`
		Version int64  `json:"version,string"`
	} `json:"users"`
	Days         int    `json:"days"`
	Confirmation string `json:"confirmation"`
}

func (s *Service) DeleteIdle(ctx context.Context, admin *AdminIdentity, in IdleDeleteInput) (int, error) {
	return s.deleteIdle(ctx, admin, in, admin == nil)
}

func (s *Service) DeleteIdleByScheduledPolicy(ctx context.Context, in IdleDeleteInput) (int, error) {
	return s.deleteIdle(ctx, nil, in, false)
}

func (s *Service) deleteIdle(ctx context.Context, admin *AdminIdentity, in IdleDeleteInput, enforceAccountPolicy bool) (int, error) {
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return 0, e
	}
	defer tx.Rollback(ctx)
	deleted, e := s.deleteIdleTx(ctx, tx, admin, in, enforceAccountPolicy)
	if e != nil {
		return 0, e
	}
	return deleted, tx.Commit(ctx)
}

func (s *Service) deleteIdleTx(ctx context.Context, tx pgx.Tx, admin *AdminIdentity, in IdleDeleteInput, enforceAccountPolicy bool) (int, error) {
	if len(in.Users) < 1 || len(in.Users) > 200 || in.Days < 1 || in.Days > 3650 || in.Confirmation != "DELETE_IDLE_USERS" {
		return 0, ErrInvalid
	}
	deleted := 0
	var e error
	if admin != nil {
		if e = lockAdmin(ctx, tx, *admin, "maintenance", true); e != nil {
			return 0, e
		}
	}
	// Sort IDs to keep user locks consistent with account and membership mutations.
	ids := make([]string, 0, len(in.Users))
	versions := map[string]int64{}
	for _, u := range in.Users {
		if !validID(u.ID) || versions[u.ID] != 0 || u.Version < 1 {
			return 0, ErrInvalid
		}
		ids = append(ids, u.ID)
		versions[u.ID] = u.Version
	}
	sort.Strings(ids)
	for _, id := range ids {
		var version int64
		var last time.Time
		var inactive, protected bool
		e = tx.QueryRow(ctx, "SELECT profile_version,last_active_at,NOT active OR deleted_at IS NOT NULL FROM pulse.users WHERE id=$1 FOR UPDATE", id).Scan(&version, &last, &inactive)
		if e != nil {
			return 0, e
		}
		if inactive || version != versions[id] || last.After(time.Now().Add(-time.Duration(in.Days)*24*time.Hour)) {
			return 0, &Fault{409, "idle_preview_stale"}
		}
		if e = tx.QueryRow(ctx, "SELECT "+idleProtection+" FROM pulse.users u WHERE id=$1", id).Scan(&protected); e != nil {
			return 0, e
		}
		if protected {
			return 0, &Fault{409, "idle_user_protected"}
		}
		if enforceAccountPolicy {
			var policy int
			if e = tx.QueryRow(ctx, "SELECT inactivity_days FROM pulse.users WHERE id=$1", id).Scan(&policy); e != nil {
				return 0, e
			}
			if policy == 0 || last.After(time.Now().Add(-time.Duration(policy)*24*time.Hour)) {
				return 0, ErrConflict
			}
		}
		if _, e = tx.Exec(ctx, "UPDATE pulse.users SET active=false,deleted_at=now(),profile_version=profile_version+1 WHERE id=$1", id); e != nil {
			return 0, e
		}
		if _, e = tx.Exec(ctx, "UPDATE pulse.login_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", id); e != nil {
			return 0, e
		}
		if _, e = tx.Exec(ctx, "UPDATE pulse.push_devices SET enabled=false WHERE user_id=$1", id); e != nil {
			return 0, e
		}
		if _, e = tx.Exec(ctx, "DELETE FROM pulse.mobile_bindings WHERE user_id=$1", id); e != nil {
			return 0, e
		}
		if _, e = tx.Exec(ctx, "UPDATE pulse.members SET active=false,membership_version=membership_version+1 WHERE user_id=$1 AND active", id); e != nil {
			return 0, e
		}
		deleted++
	}
	if admin != nil {
		if e = auditTx(ctx, tx, *admin, "idle.delete", "users", "", map[string]any{"ids": ids, "count": deleted}); e != nil {
			return 0, e
		}
	}
	return deleted, nil
}
func (s *Service) CleanupData(ctx context.Context, retention int) (int64, error) {
	if retention < 7 || retention > 3650 {
		return 0, ErrInvalid
	}
	var total int64
	statements := []string{
		`DELETE FROM pulse.admin_ops_nonces WHERE created_at<now()-interval '10 minutes' AND $1>=7`,
		`DELETE FROM pulse.admin_sessions WHERE id IN(SELECT id FROM pulse.admin_sessions WHERE (expires_at<now() OR revoked_at IS NOT NULL) AND created_at<now()-make_interval(days=>$1) LIMIT 500)`,
		// User sessions remain referenced by durable sends and push registration; preserve those references.
		`DELETE FROM pulse.login_sessions WHERE id IN(SELECT s.id FROM pulse.login_sessions s WHERE (s.expires_at<now() OR s.revoked_at IS NOT NULL) AND s.created_at<now()-make_interval(days=>$1) AND NOT EXISTS(SELECT 1 FROM pulse.push_devices d WHERE d.session_id=s.id) AND NOT EXISTS(SELECT 1 FROM pulse.send_batches b WHERE b.session_id=s.id) LIMIT 500)`,
		`DELETE FROM pulse.login_events WHERE id IN(SELECT id FROM pulse.login_events WHERE created_at<now()-make_interval(days=>$1) LIMIT 500)`,
		`DELETE FROM pulse.login_audit WHERE id IN(SELECT id FROM pulse.login_audit WHERE created_at<now()-make_interval(days=>$1) LIMIT 500)`,
		`DELETE FROM pulse.client_diagnostics WHERE id IN(SELECT id FROM pulse.client_diagnostics WHERE created_at<now()-make_interval(days=>$1) LIMIT 500)`,
		`DELETE FROM pulse.notifications WHERE id IN(SELECT id FROM pulse.notifications WHERE read_at IS NOT NULL AND created_at<now()-make_interval(days=>$1) LIMIT 500)`}
	for _, sql := range statements {
		cmd, e := s.Store.Pool.Exec(ctx, sql, retention)
		if e != nil {
			return total, e
		}
		total += cmd.RowsAffected()
	}
	if _, e := s.Store.Pool.Exec(ctx, "UPDATE pulse.media SET status='pending',lease_token=NULL,lease_until=NULL,error_code='upload_interrupted' WHERE status='receiving' AND lease_until<now()"); e != nil {
		return total, e
	}
	// Expire incomplete uploads; only generated names inside the configured private media root are removed.
	if s.Media != nil {
		rows, e := s.Store.Pool.Query(ctx, `UPDATE pulse.media SET status='cancelled',error_code='upload_expired' WHERE id IN(SELECT id FROM pulse.media WHERE status IN('pending','failed','cancelled') AND updated_at<now()-interval '1 day' AND source_path<>'' LIMIT 100) RETURNING id::text,source_path`)
		if e != nil {
			return total, e
		}
		type stale struct{ id, name string }
		files := []stale{}
		for rows.Next() {
			var f stale
			if e = rows.Scan(&f.id, &f.name); e != nil {
				rows.Close()
				return total, e
			}
			files = append(files, f)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return total, e
		}
		for _, f := range files {
			s.Media.remove(f.name)
			_, _ = s.Store.Pool.Exec(ctx, "UPDATE pulse.media SET source_path='' WHERE id=$1 AND status='cancelled'", f.id)
			total++
		}
	}
	if s.RuntimeDir != "" {
		for _, dir := range []string{"cache", "logs"} {
			n, e := cleanupRuntime(filepath.Join(s.RuntimeDir, dir), time.Now().Add(-time.Duration(retention)*24*time.Hour))
			if e != nil {
				return total, e
			}
			total += int64(n)
		}
	}
	return total, nil
}

func previewRuntime(root string, before time.Time, maximum int) (files int, bytes int64, limited bool, err error) {
	if root == "" {
		return 0, 0, false, nil
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return
	}
	base := filepath.Base(root)
	if base != "cache" && base != "logs" {
		err = ErrInvalid
		return
	}
	info, statErr := os.Lstat(root)
	if os.IsNotExist(statErr) {
		return
	}
	if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		err = ErrForbidden
		return
	}
	scanned := 0
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil || strings.HasPrefix(rel, "..") {
			return ErrForbidden
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		scanned++
		if scanned > maximum {
			limited = true
			return filepath.SkipAll
		}
		fileInfo, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		if fileInfo.Mode().IsRegular() && fileInfo.ModTime().Before(before) {
			files++
			bytes += fileInfo.Size()
		}
		return nil
	})
	return
}

func (s *Service) PreviewCleanupData(ctx context.Context, retention int) (map[string]any, error) {
	if retention < 7 || retention > 3650 {
		return nil, ErrInvalid
	}
	counts := map[string]int64{}
	queries := []struct {
		key string
		sql string
	}{
		{"admin_ops_nonces", "SELECT count(*) FROM(SELECT nonce FROM pulse.admin_ops_nonces WHERE created_at<now()-interval '10 minutes' AND $1>=7 LIMIT 500)n"},
		{"admin_sessions", "SELECT count(*) FROM(SELECT id FROM pulse.admin_sessions WHERE (expires_at<now() OR revoked_at IS NOT NULL) AND created_at<now()-make_interval(days=>$1) LIMIT 500)n"},
		{"login_sessions", `SELECT count(*) FROM(SELECT s.id FROM pulse.login_sessions s WHERE (s.expires_at<now() OR s.revoked_at IS NOT NULL) AND s.created_at<now()-make_interval(days=>$1)
			AND NOT EXISTS(SELECT 1 FROM pulse.push_devices d WHERE d.session_id=s.id) AND NOT EXISTS(SELECT 1 FROM pulse.send_batches b WHERE b.session_id=s.id) LIMIT 500)n`},
		{"login_events", "SELECT count(*) FROM(SELECT id FROM pulse.login_events WHERE created_at<now()-make_interval(days=>$1) LIMIT 500)n"},
		{"login_audit", "SELECT count(*) FROM(SELECT id FROM pulse.login_audit WHERE created_at<now()-make_interval(days=>$1) LIMIT 500)n"},
		{"client_diagnostics", "SELECT count(*) FROM(SELECT id FROM pulse.client_diagnostics WHERE created_at<now()-make_interval(days=>$1) LIMIT 500)n"},
		{"notifications", "SELECT count(*) FROM(SELECT id FROM pulse.notifications WHERE read_at IS NOT NULL AND created_at<now()-make_interval(days=>$1) LIMIT 500)n"},
		{"incomplete_uploads", "SELECT count(*) FROM(SELECT id FROM pulse.media WHERE status IN('pending','failed','cancelled') AND updated_at<now()-interval '1 day' AND source_path<>'' AND $1>=7 LIMIT 100)n"},
	}
	databaseLimited := false
	for _, query := range queries {
		if query.key == "incomplete_uploads" && s.Media == nil {
			counts[query.key] = 0
			continue
		}
		var count int64
		if err := s.Store.Pool.QueryRow(ctx, query.sql, retention).Scan(&count); err != nil {
			return nil, err
		}
		counts[query.key] = count
		maximum := int64(500)
		if query.key == "incomplete_uploads" {
			maximum = 100
		}
		databaseLimited = databaseLimited || count == maximum
	}
	fileCount, totalBytes, scanLimited := 0, int64(0), false
	if s.RuntimeDir != "" {
		for _, dir := range []string{"cache", "logs"} {
			n, size, limited, err := previewRuntime(filepath.Join(s.RuntimeDir, dir), time.Now().Add(-time.Duration(retention)*24*time.Hour), 10000)
			if err != nil {
				return nil, err
			}
			fileCount += n
			totalBytes += size
			scanLimited = scanLimited || limited
		}
	}
	return map[string]any{"cache_days": retention, "database_rows": counts,
		"files":            map[string]any{"files": fileCount, "bytes": totalBytes, "scan_limited": scanLimited},
		"database_limited": databaseLimited, "redis": map[string]any{"captcha_entries": "ephemeral TTL; not enumerated"}}, nil
}
func (s *Service) ProcessMaintenanceOnce(ctx context.Context) (bool, error) {
	lease := newID()
	var id, kind, adminID string
	var raw, previousResult []byte
	e := s.Store.Pool.QueryRow(ctx, `WITH candidate AS(SELECT id FROM pulse.maintenance_runs WHERE status='pending' OR(status='running' AND lease_until<now()) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE pulse.maintenance_runs r SET status='running',started_at=COALESCE(started_at,now()),lease_token=$1,lease_until=now()+interval '60 seconds' FROM candidate c WHERE r.id=c.id RETURNING r.id::text,r.kind,COALESCE(r.admin_id::text,''),r.parameters,r.result`, lease).Scan(&id, &kind, &adminID, &raw, &previousResult)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	var in struct {
		Retention     int  `json:"retention_days"`
		InactiveDays  int  `json:"inactive_days"`
		CleanAccounts bool `json:"clean_accounts"`
		CleanCache    bool `json:"clean_cache"`
		Users         []struct {
			ID      string `json:"id"`
			Version int64  `json:"version,string"`
		} `json:"users"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return s.finishMaintenance(ctx, id, lease, "invalid_parameters", 0)
	}
	if adminID != "" {
		var active bool
		var role string
		var permissions []string
		if e = s.Store.Pool.QueryRow(ctx, "SELECT active,role,permissions FROM pulse.admin_accounts WHERE id=$1", adminID).Scan(&active, &role, &permissions); e != nil {
			return s.finishMaintenance(ctx, id, lease, "admin_unavailable", 0)
		}
		if !active || !adminPermission(role, permissions, "maintenance", true) {
			return s.finishMaintenance(ctx, id, lease, "permission_revoked", 0)
		}
	}
	if !in.CleanAccounts && !in.CleanCache {
		if kind == "accounts" {
			in.CleanAccounts = true
		} else {
			in.CleanCache = true
		}
	}
	var count int64
	more := false
	result := map[string]any{}
	if json.Unmarshal(previousResult, &result) != nil || result == nil {
		return s.finishMaintenance(ctx, id, lease, "invalid_result", 0)
	}
	if in.CleanAccounts && result["accounts_completed"] != true {
		days := in.InactiveDays
		if days == 0 {
			days = 180
		}
		if len(in.Users) > 0 && adminID != "" {
			admin := &AdminIdentity{ID: adminID, RequestID: newID()}
			// Persist account progress in the deletion transaction. A later cache pass
			// or a worker restart must not attempt to delete the same accounts again.
			tx, beginErr := s.Store.Pool.Begin(ctx)
			if beginErr != nil {
				e = beginErr
			} else {
				var currentLease string
				e = tx.QueryRow(ctx, "SELECT lease_token::text FROM pulse.maintenance_runs WHERE id=$1 FOR UPDATE", id).Scan(&currentLease)
				if e == nil && currentLease != lease {
					e = ErrConflict
				}
				var deleted, skipped int
				var outcomes []map[string]any
				if e == nil {
					sort.Slice(in.Users, func(i, j int) bool { return in.Users[i].ID < in.Users[j].ID })
					seen := map[string]bool{}
					for _, user := range in.Users {
						if !validID(user.ID) || user.Version < 1 || seen[user.ID] {
							e = ErrInvalid
							break
						}
						seen[user.ID] = true
						part, beginErr := tx.Begin(ctx)
						if beginErr != nil {
							e = beginErr
							break
						}
						one := IdleDeleteInput{Days: days, Confirmation: "DELETE_IDLE_USERS"}
						one.Users = append(one.Users, user)
						n, deleteErr := s.deleteIdleTx(ctx, part, admin, one, false)
						if deleteErr == nil {
							e = part.Commit(ctx)
							if e != nil {
								break
							}
							deleted += n
							outcomes = append(outcomes, map[string]any{"user_id": user.ID, "outcome": "deleted", "reason": "INACTIVE"})
							continue
						}
						_ = part.Rollback(ctx)
						var fault *Fault
						if errors.Is(deleteErr, pgx.ErrNoRows) || (errors.As(deleteErr, &fault) && (fault.Code == "idle_preview_stale" || fault.Code == "idle_user_protected")) {
							reason := "NOT_ACTIVE"
							if fault != nil {
								reason = fault.Code
							}
							skipped++
							outcomes = append(outcomes, map[string]any{"user_id": user.ID, "outcome": "skipped", "reason": reason})
						} else {
							e = deleteErr
							break
						}
					}
				}
				if e == nil {
					result["users"], result["skipped_count"] = outcomes, skipped
					result["accounts_completed"], result["account_count"] = true, deleted
					progress, _ := json.Marshal(result)
					_, e = tx.Exec(ctx, "UPDATE pulse.maintenance_runs SET result=$3,deleted_count=deleted_count+$4 WHERE id=$1 AND lease_token=$2", id, lease, progress, deleted)
				}
				if e == nil {
					e = tx.Commit(ctx)
				}
				_ = tx.Rollback(ctx)
			}
		} else {
			deleted, pending, deleteErr := s.deleteScheduledIdle(ctx, days)
			e = deleteErr
			count += int64(deleted)
			more = more || pending
			previous, _ := result["account_count"].(float64)
			result["account_count"] = int64(previous) + int64(deleted)
		}
	}
	if e == nil && in.CleanCache {
		if in.Retention == 0 {
			in.Retention = 90
		}
		before, previewErr := s.PreviewCleanupData(ctx, in.Retention)
		if previewErr != nil {
			e = previewErr
		} else {
			cleaned, cleanErr := s.CleanupData(ctx, in.Retention)
			e = cleanErr
			count += cleaned
			previous, _ := result["cleanup_items"].(float64)
			result["cleanup_items"] = int64(previous) + cleaned
			if e == nil {
				after, afterErr := s.PreviewCleanupData(ctx, in.Retention)
				if afterErr != nil {
					e = afterErr
				} else {
					result["cache_preview"] = before
					rows, _ := after["database_rows"].(map[string]int64)
					for _, remaining := range rows {
						more = more || remaining > 0
					}
					files, _ := after["files"].(map[string]any)
					if remaining, ok := files["files"].(int); ok {
						more = more || remaining > 0
					}
				}
			}
		}
	}
	code, status := "", "completed"
	if more {
		status = "pending"
	}
	if e != nil {
		code, status = "cleanup_failed", "failed"
	}
	finish, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	resultRaw, _ := json.Marshal(result)
	_, saveErr := s.Store.Pool.Exec(finish, "UPDATE pulse.maintenance_runs SET status=$3,deleted_count=deleted_count+$4,error_code=$5,progress=CASE WHEN $3='completed' THEN 100 ELSE LEAST(90,progress+1) END,finished_at=CASE WHEN $3 IN('completed','failed') THEN now() ELSE NULL END,result=$6,lease_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2", id, lease, status, count, code, resultRaw)
	if saveErr != nil {
		return true, saveErr
	}
	return true, e
}

func (s *Service) finishMaintenance(ctx context.Context, id, lease, code string, count int64) (bool, error) {
	finish, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	status := "failed"
	if code == "permission_revoked" {
		status = "cancelled"
	}
	_, err := s.Store.Pool.Exec(finish, "UPDATE pulse.maintenance_runs SET status=$5,error_code=$3,deleted_count=deleted_count+$4,progress=LEAST(90,progress+1),finished_at=now(),lease_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2", id, lease, code, count, status)
	return true, err
}

func (s *Service) deleteScheduledIdle(ctx context.Context, days int) (int, bool, error) {
	if days < 1 || days > 3650 {
		return 0, false, ErrInvalid
	}
	after := ""
	users := make([]IdleCandidate, 0, 200)
	more := false
	for page := 0; page < 10 && len(users) < 200; page++ {
		items, next, hasMore, err := s.IdleCandidatesPage(ctx, days, after, 200)
		if err != nil {
			return 0, false, err
		}
		users = append(users, items...)
		if !hasMore {
			break
		}
		more = true
		after = next
	}
	if len(users) == 0 {
		return 0, false, nil
	}
	in := IdleDeleteInput{Days: days, Confirmation: "DELETE_IDLE_USERS"}
	for _, item := range users {
		in.Users = append(in.Users, struct {
			ID      string `json:"id"`
			Version int64  `json:"version,string"`
		}{item.ID, item.Version})
	}
	deleted, err := s.DeleteIdleByScheduledPolicy(ctx, in)
	if err != nil {
		return deleted, false, err
	}
	return deleted, more, nil
}

type MaintenancePolicy struct {
	Enabled       bool `json:"enabled"`
	Retention     int  `json:"retention_days"`
	Hour          int  `json:"hour"`
	Minute        int  `json:"minute"`
	IntervalDays  int  `json:"interval_days"`
	InactiveDays  int  `json:"inactive_days"`
	CleanAccounts bool `json:"clean_accounts"`
	CleanCache    bool `json:"clean_cache"`
}

func (s *Service) maintenancePolicy(ctx context.Context) (MaintenancePolicy, error) {
	policy := MaintenancePolicy{Retention: 90, Hour: 3, IntervalDays: 1, InactiveDays: 180, CleanAccounts: true, CleanCache: true}
	if err := readSetting(ctx, s.Store.Pool, "maintenance", &policy); err != nil {
		return policy, err
	}
	if policy.Retention == 0 {
		policy.Retention = 90
	}
	if policy.IntervalDays == 0 {
		policy.IntervalDays = 1
	}
	if policy.InactiveDays == 0 {
		policy.InactiveDays = 180
	}
	if !policy.CleanAccounts && !policy.CleanCache {
		policy.CleanAccounts, policy.CleanCache = true, true
	}
	return policy, nil
}

func nextMaintenanceRun(now time.Time, policy MaintenancePolicy, last *time.Time) time.Time {
	local := now.In(workTimezone)
	interval := policy.IntervalDays
	if interval < 1 {
		interval = 1
	}
	var candidate time.Time
	if last != nil {
		base := last.In(workTimezone).AddDate(0, 0, interval)
		candidate = time.Date(base.Year(), base.Month(), base.Day(), policy.Hour, policy.Minute, 0, 0, workTimezone)
	} else {
		candidate = time.Date(local.Year(), local.Month(), local.Day(), policy.Hour, policy.Minute, 0, 0, workTimezone)
	}
	for !candidate.After(local) {
		candidate = candidate.AddDate(0, 0, interval)
	}
	return candidate
}

func maintenanceDueAt(now time.Time, policy MaintenancePolicy, last *time.Time) time.Time {
	local := now.In(workTimezone)
	base := local
	interval := policy.IntervalDays
	if interval < 1 {
		interval = 1
	}
	if last != nil {
		base = last.In(workTimezone).AddDate(0, 0, interval)
	}
	return time.Date(base.Year(), base.Month(), base.Day(), policy.Hour, policy.Minute, 0, 0, workTimezone)
}

func (s *Service) MaintenanceStatus(ctx context.Context) (map[string]any, error) {
	policy, err := s.maintenancePolicy(ctx)
	if err != nil {
		return nil, err
	}
	var lastFinished *time.Time
	var workerError string
	var finished, lastStarted *time.Time
	err = s.Store.Pool.QueryRow(ctx, "SELECT last_finished,last_started,error_code FROM pulse.worker_heartbeats WHERE name='maintenance'").Scan(&finished, &lastStarted, &workerError)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	workerFound := err == nil
	lastFinished = finished
	var lastScheduled sql.NullTime
	var last *time.Time
	err = s.Store.Pool.QueryRow(ctx, "SELECT max(schedule_key::timestamptz) FROM pulse.maintenance_runs WHERE kind='scheduled'").Scan(&lastScheduled)
	if err != nil {
		return nil, err
	}
	if lastScheduled.Valid {
		last = &lastScheduled.Time
	}
	var next any
	if policy.Enabled {
		next = nextMaintenanceRun(time.Now(), policy, last).Format(time.RFC3339)
	}
	online := workerFound && lastStarted != nil && time.Since(*lastStarted) <= 2*time.Minute && workerError == ""
	return map[string]any{"worker_online": online, "last_run_at": lastFinished, "next_run_at": next}, nil
}
func (s *Service) RunMaintenance(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		pass, cancel := context.WithTimeout(ctx, 40*time.Second)
		_ = s.ObserveWorker(pass, "maintenance", func(c context.Context) error { _, e := s.ProcessMaintenanceOnce(c); return e })
		if policy, policyErr := s.maintenancePolicy(pass); policyErr == nil {
			var latest sql.NullTime
			lastErr := s.Store.Pool.QueryRow(pass, "SELECT max(schedule_key::timestamptz) FROM pulse.maintenance_runs WHERE kind='scheduled'").Scan(&latest)
			var last *time.Time
			if latest.Valid {
				last = &latest.Time
			}
			if policy.Enabled && lastErr == nil && !maintenanceDueAt(time.Now(), policy, last).After(time.Now().In(workTimezone)) {
				parameters, _ := json.Marshal(policy)
				due := maintenanceDueAt(time.Now(), policy, last)
				_, _ = s.Store.Pool.Exec(pass, `INSERT INTO pulse.maintenance_runs(id,kind,parameters,schedule_key)
					VALUES($1,'scheduled',$2,$3) ON CONFLICT(schedule_key) WHERE schedule_key IS NOT NULL DO NOTHING`, newID(), parameters, due.Format(time.RFC3339))
			}
		}
		rows, e := s.Store.Pool.Query(pass, "SELECT u.id::text,u.profile_version,u.inactivity_days FROM pulse.users u WHERE active AND deleted_at IS NULL AND inactivity_days>0 AND last_active_at<now()-make_interval(days=>inactivity_days) AND NOT "+idleProtection+" ORDER BY id LIMIT 20")
		if e == nil {
			type idle struct {
				id      string
				version int64
				days    int
			}
			items := []idle{}
			for rows.Next() {
				var x idle
				if rows.Scan(&x.id, &x.version, &x.days) == nil {
					items = append(items, x)
				}
			}
			rows.Close()
			for _, x := range items {
				in := IdleDeleteInput{Days: x.days, Confirmation: "DELETE_IDLE_USERS"}
				in.Users = append(in.Users, struct {
					ID      string `json:"id"`
					Version int64  `json:"version,string"`
				}{x.id, x.version})
				_, _ = s.DeleteIdle(pass, nil, in)
			}
		}
		cancel()
	}
}

func (a *API) registerMaintenance(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/admin/maintenance/status", a.adminWrap("maintenance", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		status, err := s.MaintenanceStatus(r.Context())
		if err == nil {
			writeJSON(w, http.StatusOK, status)
		}
		return err
	}))
	mux.HandleFunc("GET /api/v2/admin/maintenance/cache-preview", a.adminWrap("maintenance", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		days, err := parseSeq(r.URL.Query().Get("days"), 90)
		if err != nil {
			return err
		}
		preview, err := s.PreviewCleanupData(r.Context(), int(days))
		if err == nil {
			writeJSON(w, 200, preview)
		}
		return err
	}))
	mux.HandleFunc("GET /api/v2/admin/maintenance/idle", a.adminWrap("maintenance", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		days, e := parseSeq(r.URL.Query().Get("days"), 180)
		if e != nil {
			return e
		}
		items, next, hasMore, e := s.IdleCandidatesPage(r.Context(), int(days), r.URL.Query().Get("after"), 200)
		if e != nil {
			return e
		}
		writeJSON(w, 200, map[string]any{"items": items, "next_after": next, "has_more": hasMore})
		return nil
	}))
	mux.HandleFunc("POST /api/v2/admin/maintenance/idle-delete", a.adminWrap("maintenance", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in IdleDeleteInput
		if e := decode(w, r, &in); e != nil {
			return e
		}
		n, e := s.DeleteIdle(r.Context(), &who, in)
		if e == nil {
			for _, u := range in.Users {
				a.Hub.CloseUser(u.ID)
			}
			writeJSON(w, 200, map[string]int{"deleted": n})
		}
		return e
	}))
	mux.HandleFunc("POST /api/v2/admin/maintenance/runs", a.adminWrap("maintenance", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in struct {
			Retention     int  `json:"retention_days"`
			InactiveDays  int  `json:"inactive_days"`
			CleanAccounts bool `json:"clean_accounts"`
			CleanCache    bool `json:"clean_cache"`
			Users         []struct {
				ID      string `json:"id"`
				Version int64  `json:"version,string"`
			} `json:"users"`
			Kind string `json:"kind"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if in.Kind != "" && in.Kind != "accounts" && in.Kind != "cache" {
			return ErrInvalid
		}
		if !in.CleanAccounts && !in.CleanCache {
			in.CleanAccounts = in.Kind == "accounts"
			in.CleanCache = !in.CleanAccounts
		}
		if in.CleanCache && in.Retention == 0 {
			in.Retention = 90
		}
		if in.CleanCache && (in.Retention < 7 || in.Retention > 3650) {
			return ErrInvalid
		}
		if in.CleanAccounts && (in.InactiveDays < 1 || in.InactiveDays > 3650) {
			return ErrInvalid
		}
		if (in.CleanAccounts && len(in.Users) == 0) || len(in.Users) > 200 {
			return ErrInvalid
		}
		parameters, _ := json.Marshal(in)
		id := newID()
		e := s.adminWrite(r.Context(), who, "maintenance", "cleanup.schedule", "maintenance", id, func(tx pgx.Tx) error {
			_, e := tx.Exec(r.Context(), "INSERT INTO pulse.maintenance_runs(id,kind,admin_id,parameters) VALUES($1,'manual',$2,$3)", id, who.ID, parameters)
			return e
		})
		if e == nil {
			writeJSON(w, http.StatusAccepted, map[string]string{"id": id, "status": "queued"})
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/admin/maintenance/runs", a.adminWrap("maintenance", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		return adminRows(w, r, s, "SELECT to_jsonb(r)-'lease_token' FROM pulse.maintenance_runs r ORDER BY created_at DESC,id LIMIT $1 OFFSET $2")
	}))
}
func cleanupRuntime(root string, before time.Time) (int, error) {
	root, e := filepath.Abs(root)
	if e != nil {
		return 0, e
	}
	base := filepath.Base(root)
	if base != "cache" && base != "logs" {
		return 0, ErrInvalid
	}
	info, e := os.Lstat(root)
	if os.IsNotExist(e) {
		return 0, nil
	}
	if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return 0, ErrForbidden
	}
	count := 0
	e = filepath.WalkDir(root, func(path string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		rel, e := filepath.Rel(root, path)
		if e != nil || strings.HasPrefix(rel, "..") {
			return ErrForbidden
		}
		if d.Type()&os.ModeSymlink != 0 {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		if info.Mode().IsRegular() && info.ModTime().Before(before) {
			if e = os.Remove(path); e != nil {
				return e
			}
			count++
		}
		return nil
	})
	return count, e
}
