// legacy-audit inventories a read-only MySQL source and an isolated PostgreSQL target.
// It never copies user data, credentials, media, or password hashes into its report.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgxpool"
)

type tableSpec struct {
	Name     string   `json:"name"`
	Columns  []string `json:"required_columns"`
	Target   string   `json:"go_target"`
	Optional bool     `json:"optional"`
}

var legacyTables = []tableSpec{
	{"users", []string{"id", "public_id", "nickname", "phone", "username", "password_hash", "status", "created_at"}, "pulse.users + pulse.legacy_ids", false},
	{"user_permissions", []string{"user_id", "muted", "allow_add_friend", "allow_create_group", "internal_staff", "formal_employee"}, "pulse.users", false},
	{"user_security", []string{"user_id", "two_step_hash", "recovery_hashes"}, "pulse.security", true},
	{"user_settings", []string{"user_id", "settings_json"}, "pulse.privacy_settings + pulse.notification_preferences", true},
	{"contacts", []string{"user_id", "contact_user_id", "remark", "group_name"}, "pulse.friendships + pulse.contact_metadata", false},
	{"contact_requests", []string{"id", "from_user_id", "to_user_id", "status"}, "pulse.friend_requests", true},
	{"user_blocks", []string{"blocker_id", "blocked_id"}, "pulse.blocks", false},
	{"conversations", []string{"id", "type", "owner_id", "status"}, "pulse.conversations + pulse.legacy_ids", false},
	{"conversation_members", []string{"conversation_id", "user_id", "role", "cleared_before_message_id"}, "pulse.members + pulse.user_states", false},
	{"conversation_read_progress", []string{"conversation_id", "user_id", "through_message_id"}, "pulse.user_states", true},
	{"conversation_folders", []string{"id", "user_id", "scope", "name"}, "pulse.conversation_folders + pulse.legacy_ids", true},
	{"conversation_folder_items", []string{"folder_id", "conversation_id", "user_id"}, "pulse.user_states.folder_id", true},
	{"messages", []string{"id", "conversation_id", "sender_id", "type", "request_id", "body_json", "recalled_at", "created_at"}, "pulse.messages + pulse.events + pulse.legacy_ids", false},
	{"message_receipts", []string{"message_id", "user_id", "status"}, "pulse.receipt_facts + later pulse.user_states overrides", true},
	{"message_deletions", []string{"message_id", "user_id"}, "pulse.message_deletions", true},
	{"message_mentions", []string{"message_id", "user_id"}, "pulse.message_mentions", true},
	{"message_pins", []string{"conversation_id", "message_id", "pinned_by"}, "pulse.message_pins", true},
	{"media_uploads", []string{"path", "user_id", "kind"}, "pulse.media + private file migration", true},
	{"media_references", []string{"path", "message_id"}, "pulse.message_media", true},
	{"user_notifications", []string{"id", "user_id", "type", "created_at"}, "pulse.notifications", true},
	{"notification_devices", []string{"user_id", "platform", "device_token"}, "pulse.push_devices", true},
	{"mobile_device_policy", []string{"enabled"}, "pulse.system_settings", true},
	{"mobile_device_bindings", []string{"user_id", "device_hash", "platform"}, "pulse.mobile_bindings", true},
	{"work_tasks", []string{"id", "task_key", "name", "status"}, "pulse.work_tasks + pulse.legacy_ids", true},
	{"work_questions", []string{"id", "question_uuid", "image_url", "correct_answer"}, "pulse.work_questions + pulse.legacy_ids", true},
	{"work_task_records", []string{"id", "user_id", "task_id", "question_snapshot_json", "answers_json", "wage"}, "pulse.work_records + pulse.legacy_ids", true},
	{"work_task_codes", []string{"task_id", "task_date", "code"}, "pulse.work_codes", true},
	{"work_task_daily_questions", []string{"task_id", "task_date", "question_ids_json"}, "pulse.work_daily", true},
	{"dispatch_tasks", []string{"id"}, "pulse.dispatch_plans + pulse.legacy_ids", true},
	{"admin_accounts", []string{"id", "username", "password_hash"}, "pulse.admin_accounts + pulse.legacy_ids", true},
	{"admin_audit_logs", []string{"id", "created_at"}, "pulse.admin_audit", true},
	{"client_announcements", []string{"id"}, "pulse.system_settings", true},
	{"client_navigation_config", []string{"id"}, "pulse.system_settings", true},
	{"client_routes", []string{"id"}, "pulse.system_settings", true},
	{"login_logs", []string{"id", "user_id", "created_at"}, "pulse.login_events", true},
	{"sensitive_words", []string{"id", "word"}, "pulse.sensitive_words", true},
	{"ip_region_locations", []string{"ip"}, "pulse.ip_locations", true},
}

type tableResult struct {
	tableSpec
	Exists  bool     `json:"exists"`
	Rows    int64    `json:"rows"`
	Missing []string `json:"missing_columns,omitempty"`
	Error   string   `json:"error,omitempty"`
}
type report struct {
	SourceSchema string           `json:"source_schema"`
	TargetSchema string           `json:"target_schema"`
	CheckedAt    time.Time        `json:"checked_at"`
	Tables       []tableResult    `json:"tables"`
	SourceCounts map[string]int64 `json:"source_counts"`
	TargetCounts map[string]int64 `json:"target_counts"`
	CanRunImport bool             `json:"can_run_import"`
	Reason       string           `json:"reason"`
}

func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func run() error {
	output := flag.String("output", "", "fresh output report path")
	flag.Parse()
	if *output == "" {
		return errors.New("-output is required")
	}
	if _, e := os.Stat(*output); !os.IsNotExist(e) {
		return errors.New("report already exists")
	}
	sourceDSN, targetDSN := os.Getenv("PULSE_LEGACY_MYSQL_DSN"), os.Getenv("PULSE_POSTGRES_DSN")
	if sourceDSN == "" || targetDSN == "" {
		return errors.New("PULSE_LEGACY_MYSQL_DSN and PULSE_POSTGRES_DSN are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	source, e := sql.Open("mysql", sourceDSN)
	if e != nil {
		return errors.New("invalid MySQL configuration")
	}
	defer source.Close()
	source.SetMaxOpenConns(2)
	source.SetConnMaxLifetime(time.Minute)
	if e = source.PingContext(ctx); e != nil {
		return errors.New("MySQL connection failed")
	}
	target, e := pgxpool.New(ctx, targetDSN)
	if e != nil {
		return errors.New("invalid PostgreSQL configuration")
	}
	defer target.Close()
	if e = target.Ping(ctx); e != nil {
		return errors.New("PostgreSQL connection failed")
	}
	var sourceSchema, targetSchema string
	if e = source.QueryRowContext(ctx, "SELECT DATABASE()").Scan(&sourceSchema); e != nil {
		return e
	}
	if e = target.QueryRow(ctx, "SELECT current_database()").Scan(&targetSchema); e != nil {
		return e
	}
	if sourceSchema != "pulse_im" || targetSchema != "pulse_core_test" {
		return errors.New("audit requires pulse_im source and disposable pulse_core_test target; no data was copied")
	}
	result := report{SourceSchema: sourceSchema, TargetSchema: targetSchema, CheckedAt: time.Now().UTC(), SourceCounts: map[string]int64{}, TargetCounts: map[string]int64{}, CanRunImport: false, Reason: "read-only inventory only; full transactional importer and reconciliation are not yet implemented"}
	columns := map[string]map[string]bool{}
	rows, e := source.QueryContext(ctx, "SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()")
	if e != nil {
		return e
	}
	for rows.Next() {
		var table, column string
		if e = rows.Scan(&table, &column); e != nil {
			rows.Close()
			return e
		}
		if columns[table] == nil {
			columns[table] = map[string]bool{}
		}
		columns[table][column] = true
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, spec := range legacyTables {
		item := tableResult{tableSpec: spec, Exists: columns[spec.Name] != nil}
		if !item.Exists {
			item.Error = "table_missing"
		} else {
			for _, column := range spec.Columns {
				if !columns[spec.Name][column] {
					item.Missing = append(item.Missing, column)
				}
			}
			sort.Strings(item.Missing)
			if len(item.Missing) > 0 {
				item.Error = "schema_mismatch"
			}
			query := "SELECT count(*) FROM `" + spec.Name + "`"
			if e = source.QueryRowContext(ctx, query).Scan(&item.Rows); e != nil {
				return e
			}
			result.SourceCounts[spec.Name] = item.Rows
		}
		result.Tables = append(result.Tables, item)
	}
	targetTables := []string{"users", "friendships", "blocks", "conversations", "members", "user_states", "messages", "receipt_facts", "message_deletions", "media", "work_tasks", "work_questions", "work_records", "admin_accounts", "legacy_ids"}
	for _, table := range targetTables {
		if strings.ContainsAny(table, "`./ ") {
			return errors.New("invalid table name")
		}
		var count int64
		if e = target.QueryRow(ctx, "SELECT count(*) FROM pulse."+table).Scan(&count); e != nil {
			return e
		}
		result.TargetCounts[table] = count
	}
	encoded, e := json.MarshalIndent(result, "", "  ")
	if e != nil {
		return e
	}
	path, e := filepath.Abs(*output)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	return os.WriteFile(path, encoded, 0600)
}
