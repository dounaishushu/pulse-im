package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

var oldHashPattern = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

func importOperationalState(ctx context.Context, i *importer) error {
	if err := i.importMobileBindings(ctx); err != nil {
		return err
	}
	if err := i.importActiveTokens(ctx); err != nil {
		return err
	}
	if err := importRealtimeEvents(ctx, i); err != nil {
		return err
	}
	_, err := i.target.Exec(ctx, `UPDATE pulse.users u SET last_active_at=GREATEST(
 u.last_active_at,
 COALESCE((SELECT max(s.last_used_at) FROM pulse.login_sessions s WHERE s.user_id=u.id AND s.expires_at>now()),u.last_active_at),
 COALESCE((SELECT max(l.created_at) FROM pulse.login_events l WHERE l.user_id=u.id AND l.success),u.last_active_at))`)
	if err != nil {
		return err
	}
	for _, name := range []string{
		"mobile_device_policy", "maintenance_config", "maintenance_state", "admin_account_guard", "client_route_state",
		"admin_login_attempts", "admin_security_rates", "work_record_reviews",
		"user_presence", "realtime_sequence", "push_cursor", "dispatch_worker_health", "websocket_worker_health",
	} {
		if err := i.archiveOperationalTable(ctx, name); err != nil {
			return err
		}
	}
	var mobileEnabled bool
	if err := i.source.QueryRowContext(ctx, "SELECT enabled FROM mobile_device_policy WHERE id=1").Scan(&mobileEnabled); err != nil {
		return err
	}
	return i.saveSetting(ctx, "mobile_binding", map[string]bool{"enabled": mobileEnabled})
}

func (i *importer) importMobileBindings(ctx context.Context) error {
	rows, err := i.source.QueryContext(ctx, `SELECT id,user_id,device_hash,platform,device_name,bound_at,last_login_at
 FROM mobile_device_bindings ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, user int64
		var hash, platform, name string
		var bound, last time.Time
		if err = rows.Scan(&id, &user, &hash, &platform, &name, &bound, &last); err != nil {
			return err
		}
		if !oldHashPattern.MatchString(hash) || (platform != "android" && platform != "ios") {
			return fmt.Errorf("invalid old mobile binding %d", id)
		}
		decoded, err := hex.DecodeString(hash)
		if err != nil {
			return err
		}
		_, err = i.target.Exec(ctx, `INSERT INTO pulse.mobile_bindings(user_id,device_hash,platform,device_name,bound_at,last_login_at)
 VALUES($1,$2,$3,$4,$5,$6)`, legacyUUID("user", user), decoded, platform, name, bound, last)
		if err != nil {
			return fmt.Errorf("mobile binding %d: %w", id, err)
		}
		_, err = i.target.Exec(ctx, `INSERT INTO pulse.legacy_mobile_bindings
 (legacy_id,user_id,device_hash,platform,device_name,bound_at,last_login_at)
 VALUES($1,$2,$3,$4,$5,$6,$7)`, id, legacyUUID("user", user), hash, platform, name, bound, last)
		if err != nil {
			return err
		}
		i.counts["mobile_device_bindings"]++
	}
	return rows.Err()
}

func (i *importer) importActiveTokens(ctx context.Context) error {
	rows, err := i.source.QueryContext(ctx, `SELECT id,user_id,token_hash,device_type,expires_at,created_at,last_used_at
 FROM auth_tokens ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, user int64
		var tokenHash, platform string
		var expires, created time.Time
		var last sql.NullTime
		if err = rows.Scan(&id, &user, &tokenHash, &platform, &expires, &created, &last); err != nil {
			return err
		}
		if !oldHashPattern.MatchString(tokenHash) {
			return fmt.Errorf("invalid old auth token hash %d", id)
		}
		decoded, err := hex.DecodeString(tokenHash)
		if err != nil {
			return err
		}
		switch platform {
		case "pc", "web", "android", "ios":
		default:
			platform = "unknown"
		}
		if !expires.After(created) {
			return fmt.Errorf("invalid old auth token dates %d", id)
		}
		sessionID := legacyUUID("session", id)
		lastUsed := created
		if last.Valid {
			lastUsed = last.Time
		}
		_, err = i.target.Exec(ctx, `INSERT INTO pulse.login_sessions
 (id,user_id,device_id,token_hash,platform,created_at,expires_at,last_used_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
			sessionID, legacyUUID("user", user), fmt.Sprintf("legacy-%d", id), decoded,
			platform, created, expires, lastUsed)
		if err != nil {
			return fmt.Errorf("auth token %d: %w", id, err)
		}
		_, err = i.target.Exec(ctx, `INSERT INTO pulse.legacy_session_tokens(legacy_id,session_id,token_hash_hex)
 VALUES($1,$2,$3)`, id, sessionID, strings.ToLower(tokenHash))
		if err != nil {
			return err
		}
		i.counts["auth_tokens"]++
	}
	return rows.Err()
}

func (i *importer) archiveOperationalTable(ctx context.Context, name string) error {
	allowed := map[string]bool{
		"mobile_device_policy": true, "maintenance_config": true, "maintenance_state": true, "admin_account_guard": true, "client_route_state": true,
		"admin_login_attempts": true, "admin_security_rates": true, "work_record_reviews": true,
		"user_presence": true, "realtime_sequence": true, "push_cursor": true,
		"dispatch_worker_health": true, "websocket_worker_health": true,
	}
	if !allowed[name] {
		return fmt.Errorf("unsupported operational archive table")
	}
	// Several legacy operational tables use string or user IDs as their
	// primary key. Keep that key in the archived payload and assign a stable
	// numeric archive key from primary-key order.
	primaryKey := map[string]string{
		"admin_security_rates":    "bucket_key",
		"work_record_reviews":     "request_id",
		"user_presence":           "user_id",
		"dispatch_worker_health":  "worker_id",
		"websocket_worker_health": "node_id",
	}[name]
	hasNumericID := primaryKey == ""
	if hasNumericID {
		primaryKey = "id"
	}
	rows, err := i.source.QueryContext(ctx, "SELECT * FROM `"+name+"` ORDER BY `"+primaryKey+"`")
	if err != nil {
		return err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return err
	}
	var ordinal int64
	for rows.Next() {
		ordinal++
		values := make([]any, len(columns))
		holders := make([]any, len(columns))
		for index := range values {
			holders[index] = &values[index]
		}
		if err = rows.Scan(holders...); err != nil {
			return err
		}
		object := map[string]any{}
		id := ordinal
		for index, column := range columns {
			if column == "id" {
				id, err = legacyPositiveIDCell(values[index])
				if err != nil {
					return err
				}
			}
			switch raw := values[index].(type) {
			case []byte:
				object[column] = string(raw)
			case time.Time:
				object[column] = raw.Format(time.RFC3339Nano)
			default:
				object[column] = raw
			}
		}
		if id <= 0 {
			return fmt.Errorf("invalid operational row id in %s", name)
		}
		payload, err := json.Marshal(object)
		if err != nil {
			return err
		}
		_, err = i.target.Exec(ctx, `INSERT INTO pulse.legacy_runtime_state(source,legacy_id,payload)
 VALUES($1,$2,$3)`, name, id, json.RawMessage(payload))
		if err != nil {
			return err
		}
		i.counts[name]++
	}
	return rows.Err()
}
