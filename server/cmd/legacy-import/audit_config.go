package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"time"
)

func importAuditConfig(ctx context.Context, i *importer) error {
	logs, e := i.source.QueryContext(ctx, `SELECT id,user_id,phone,device_type,ip,success,created_at
 FROM login_logs ORDER BY id`)
	if e != nil {
		return e
	}
	for logs.Next() {
		var id int64
		var uid sql.NullInt64
		var phone, device, ip sql.NullString
		var success bool
		var created time.Time
		if e = logs.Scan(&id, &uid, &phone, &device, &ip, &success, &created); e != nil {
			logs.Close()
			return e
		}
		var userID, ipValue any
		if uid.Valid {
			userID = legacyUUID("user", uid.Int64)
		}
		if raw := nullString(ip); raw != "" && net.ParseIP(raw) != nil {
			ipValue = raw
		}
		platform := nullString(device)
		if platform != "pc" && platform != "web" && platform != "android" && platform != "ios" {
			platform = "unknown"
		}
		if _, e = i.target.Exec(ctx, `INSERT INTO pulse.login_events(id,user_id,account,ip,platform,device_name,success,reason,created_at)
 OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, userID, nullString(phone), ipValue, platform, nullString(device), success, "legacy_import", created); e != nil {
			logs.Close()
			return e
		}
		i.counts["login_logs"]++
	}
	e = logs.Err()
	logs.Close()
	if e != nil {
		return e
	}
	if _, e = i.target.Exec(ctx, "SELECT setval(pg_get_serial_sequence('pulse.login_events','id'),GREATEST(COALESCE((SELECT max(id) FROM pulse.login_events),0),1),true)"); e != nil {
		return e
	}
	audit, e := i.source.QueryContext(ctx, `SELECT id,admin_id,action,target_type,target_id,request_id,ip,detail_json,created_at FROM admin_audit_logs ORDER BY id`)
	if e != nil {
		return e
	}
	for audit.Next() {
		var id int64
		var admin sql.NullInt64
		var action, kind, request string
		var target sql.NullString
		var ip sql.NullString
		var details []byte
		var created time.Time
		if e = audit.Scan(&id, &admin, &action, &kind, &target, &request, &ip, &details, &created); e != nil {
			audit.Close()
			return e
		}
		if details == nil {
			details = []byte("null")
		}
		if !json.Valid(details) {
			audit.Close()
			return fmt.Errorf("invalid admin audit details")
		}
		var adminID, ipValue any
		// The legacy system records system actions with admin_id=0. They have
		// no administrator principal in the new schema.
		if admin.Valid && admin.Int64 > 0 {
			adminID = legacyUUID("admin", admin.Int64)
		}
		if raw := nullString(ip); raw != "" && net.ParseIP(raw) != nil {
			ipValue = raw
		}
		_, e = i.target.Exec(ctx, `INSERT INTO pulse.admin_audit(id,admin_id,action,target_type,target_id,request_id,ip,details,created_at)
		 OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, adminID, action, kind, nullString(target), request, ipValue, json.RawMessage(details), created)
		if e != nil {
			audit.Close()
			return e
		}
		original, e := json.Marshal(map[string]any{
			"admin_id": nullInt(admin), "target_id": nullOrString(target), "detail_json": json.RawMessage(details),
		})
		if e != nil {
			audit.Close()
			return e
		}
		if _, e = i.target.Exec(ctx, `INSERT INTO pulse.legacy_audit_events(source,legacy_id,payload)
 VALUES('admin_audit_logs',$1,$2)`, id, json.RawMessage(original)); e != nil {
			audit.Close()
			return e
		}
		i.counts["admin_audit_logs"]++
	}
	e = audit.Err()
	audit.Close()
	if e != nil {
		return e
	}
	if _, e = i.target.Exec(ctx, "SELECT setval(pg_get_serial_sequence('pulse.admin_audit','id'),GREATEST(COALESCE((SELECT max(id) FROM pulse.admin_audit),0),1),true)"); e != nil {
		return e
	}
	return i.importSmallConfig(ctx)
}

func (i *importer) importSmallConfig(ctx context.Context) error {
	for _, name := range []string{"client_app_config", "client_announcements", "client_navigation_config", "client_routes"} {
		if _, ok := map[string]bool{"client_app_config": true, "client_announcements": true, "client_navigation_config": true, "client_routes": true}[name]; !ok {
			return fmt.Errorf("invalid config table")
		}
		rows, e := i.source.QueryContext(ctx, "SELECT * FROM `"+name+"`")
		if e != nil {
			return e
		}
		columns, e := rows.Columns()
		if e != nil {
			rows.Close()
			return e
		}
		for rows.Next() {
			values := make([]any, len(columns))
			holders := make([]any, len(columns))
			for n := range values {
				holders[n] = &values[n]
			}
			if e = rows.Scan(holders...); e != nil {
				rows.Close()
				return e
			}
			object := map[string]any{}
			var id int64
			for n, column := range columns {
				if column == "id" {
					switch v := values[n].(type) {
					case int64:
						id = v
					case []byte:
						id, _ = strconv.ParseInt(string(v), 10, 64)
					}
				}
				switch v := values[n].(type) {
				case []byte:
					object[column] = string(v)
				default:
					object[column] = v
				}
			}
			if id <= 0 {
				rows.Close()
				return fmt.Errorf("invalid old config id")
			}
			payload, e := json.Marshal(object)
			if e != nil {
				rows.Close()
				return e
			}
			if _, e = i.target.Exec(ctx, "INSERT INTO pulse.legacy_client_config(source,legacy_id,payload) VALUES($1,$2,$3)", name, id, json.RawMessage(payload)); e != nil {
				rows.Close()
				return e
			}
			i.counts[name]++
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
	}
	words, e := i.source.QueryContext(ctx, "SELECT id,word,replacement,status FROM sensitive_words ORDER BY id")
	if e != nil {
		return e
	}
	for words.Next() {
		var id int64
		var word, replacement string
		var status bool
		if e = words.Scan(&id, &word, &replacement, &status); e != nil {
			words.Close()
			return e
		}
		if _, e = i.target.Exec(ctx, `INSERT INTO pulse.sensitive_words(id,word,replacement,enabled)
 VALUES($1,$2,$3,$4)`, legacyUUID("sensitive_word", id), word, replacement, status); e != nil {
			words.Close()
			return e
		}
		i.counts["sensitive_words"]++
	}
	e = words.Err()
	words.Close()
	if e != nil {
		return e
	}
	return i.importActiveSettings(ctx)
}
