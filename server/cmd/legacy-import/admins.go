package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

var oldAdminModule = map[string]string{
	"dashboard": "stats", "users": "users", "devices": "devices", "groups": "groups",
	"messages": "messages", "moderation": "messages", "sensitive-words": "sensitive_words",
	"login-logs": "audit", "announcement": "announcements", "client-config": "config",
	"routes": "config", "task-config": "tasks", "question-bank": "questions",
	"task-records": "records", "dispatch-tasks": "dispatch", "maintenance": "maintenance",
}

func mapAdminPermissions(raw []byte, role string) ([]string, error) {
	if role == "superadmin" {
		return []string{}, nil
	}
	var old []string
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &old); err != nil {
			return nil, err
		}
	} else {
		// PHP's null permissions_json used the legacy role defaults.
		for page := range oldAdminModule {
			if page == "maintenance" || page == "dispatch-tasks" {
				continue
			}
			old = append(old, page+".view")
			if role == "operator" && page != "dashboard" && page != "login-logs" && page != "client-config" && page != "routes" && page != "devices" {
				old = append(old, page+".manage")
			}
		}
	}
	permissions := map[string]bool{}
	for _, permission := range old {
		parts := strings.Split(permission, ".")
		if len(parts) != 2 || (parts[1] != "view" && parts[1] != "manage") {
			return nil, fmt.Errorf("unknown old admin permission")
		}
		module, ok := oldAdminModule[parts[0]]
		if !ok {
			return nil, fmt.Errorf("unknown old admin permission module")
		}
		if role == "auditor" && parts[1] == "manage" {
			return nil, fmt.Errorf("auditor has write permission in source")
		}
		permissions[module+"."+parts[1]] = true
		if parts[1] == "manage" {
			permissions[module+".view"] = true
		}
	}
	result := make([]string, 0, len(permissions))
	for value := range permissions {
		result = append(result, value)
	}
	sort.Strings(result)
	return result, nil
}

func newEntryToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func importAdmins(ctx context.Context, i *importer) error {
	rows, err := i.source.QueryContext(ctx, `SELECT id,username,password_hash,role,status,
 permissions_json,created_at,updated_at FROM admin_accounts ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var account, hash, role, status string
		var raw []byte
		var created, updated time.Time
		if err = rows.Scan(&id, &account, &hash, &role, &status, &raw, &created, &updated); err != nil {
			return err
		}
		if id <= 0 || hash == "" || account == "" {
			return fmt.Errorf("invalid old administrator")
		}
		switch role {
		case "admin":
			role = "superadmin"
		case "operator", "auditor":
		default:
			return fmt.Errorf("unknown old administrator role")
		}
		if status != "active" && status != "disabled" {
			return fmt.Errorf("unknown old administrator status")
		}
		permissions, e := mapAdminPermissions(raw, role)
		if e != nil {
			return e
		}
		token, e := newEntryToken()
		if e != nil {
			return e
		}
		var oldPermissions any
		if len(raw) > 0 {
			oldPermissions = json.RawMessage(raw)
		}
		_, err = i.target.Exec(ctx, `INSERT INTO pulse.admin_accounts(
 id,account,password_hash,role,permissions,active,entry_hash,created_at,updated_at,legacy_permissions)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, legacyUUID("admin", id), strings.ToLower(account), hash, role, permissions, status == "active", legacyDigest(token), created, updated, oldPermissions)
		if err != nil {
			return fmt.Errorf("legacy admin %d: %w", id, err)
		}
		if err = i.addID(ctx, "admin", id); err != nil {
			return err
		}
		i.adminEntries[account] = token
		i.counts["admin_accounts"]++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	entries, err := i.source.QueryContext(ctx, `SELECT id,admin_id,token_hash,token_salt,
 creation_request_key,telegram_user_id,created_at,revoked_at FROM admin_account_entries ORDER BY id`)
	if err != nil {
		return err
	}
	defer entries.Close()
	for entries.Next() {
		var id, adminID int64
		var hash, salt string
		var request sql.NullString
		var telegram sql.NullInt64
		var created time.Time
		var revoked sql.NullTime
		if err = entries.Scan(&id, &adminID, &hash, &salt, &request, &telegram, &created, &revoked); err != nil {
			return err
		}
		if _, err = i.target.Exec(ctx, `INSERT INTO pulse.legacy_admin_entries(
 legacy_id,admin_id,token_hash,token_salt,creation_request_key,telegram_user_id,created_at,revoked_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, legacyUUID("admin", adminID), hash, salt, nullOrString(request), nullInt(telegram), created, nullTime(revoked)); err != nil {
			return err
		}
		if telegram.Valid && !revoked.Valid {
			if _, err = i.target.Exec(ctx, `INSERT INTO pulse.legacy_telegram_owners(telegram_user_id,admin_id,legacy_entry_id)
 VALUES($1,$2,$3) ON CONFLICT(telegram_user_id,admin_id) DO UPDATE SET legacy_entry_id=LEAST(pulse.legacy_telegram_owners.legacy_entry_id,$3)`, telegram.Int64, legacyUUID("admin", adminID), id); err != nil {
				return err
			}
		}
		if !revoked.Valid {
			if _, err = i.target.Exec(ctx, `UPDATE pulse.admin_accounts SET
 legacy_numeric_id=$2,legacy_entry_salt=$3,legacy_entry_hash=$4 WHERE id=$1`,
				legacyUUID("admin", adminID), adminID, salt, hash); err != nil {
				return err
			}
		}
		i.counts["admin_account_entries"]++
	}
	if err = entries.Err(); err != nil {
		return err
	}
	_, err = i.target.Exec(ctx, `INSERT INTO pulse.telegram_grants(telegram_user_id,admin_id,admin_ids,permissions)
 SELECT telegram_user_id,min(admin_id::text)::uuid,array_agg(admin_id ORDER BY legacy_entry_id),ARRAY['entry.self']::text[]
 FROM pulse.legacy_telegram_owners GROUP BY telegram_user_id`)
	if err != nil {
		return err
	}
	return i.importTelegramAdminPolicy(ctx)
}

func (i *importer) importTelegramAdminPolicy(ctx context.Context) error {
	raw := os.Getenv("PULSE_LEGACY_TELEGRAM_ADMIN_IDS")
	ids := strings.Fields(strings.ReplaceAll(raw, ",", " "))
	if len(ids) > 1000 {
		return fmt.Errorf("too many legacy Telegram administrators")
	}
	if len(ids) == 0 {
		return nil
	}
	var actor string
	if err := i.target.QueryRow(ctx, `SELECT id::text FROM pulse.admin_accounts
 WHERE active AND role='superadmin' ORDER BY created_at,id LIMIT 1`).Scan(&actor); err != nil {
		return fmt.Errorf("legacy Telegram administrator has no active superadmin principal: %w", err)
	}
	permissions := []string{"tasks.codes"}
	if enabled := strings.ToLower(os.Getenv("PULSE_LEGACY_TELEGRAM_ACCOUNTS_ENABLED")); enabled == "true" || enabled == "1" {
		permissions = append(permissions, "accounts.create", "entry.self")
	}
	seen := map[int64]bool{}
	for _, value := range ids {
		uid, err := strconv.ParseInt(value, 10, 64)
		if err != nil || uid <= 0 {
			return fmt.Errorf("invalid legacy Telegram administrator ID")
		}
		if seen[uid] {
			continue
		}
		seen[uid] = true
		_, err = i.target.Exec(ctx, `INSERT INTO pulse.telegram_grants(telegram_user_id,admin_id,admin_ids,permissions)
 VALUES($1,$2,'{}'::uuid[],$3)
 ON CONFLICT(telegram_user_id) DO UPDATE SET
 admin_id=$2,permissions=ARRAY(SELECT DISTINCT p FROM unnest(pulse.telegram_grants.permissions||$3::text[]) p ORDER BY p),active=true`,
			uid, actor, permissions)
		if err != nil {
			return err
		}
		i.counts["telegram_authorized"]++
	}
	return nil
}
