package main

import (
	"context"
	"database/sql"
	"time"
)

func importPushDevices(ctx context.Context, i *importer) error {
	rows, e := i.source.QueryContext(ctx, `SELECT id,user_id,platform,device_token,enabled,
 created_at,updated_at,last_used_at FROM notification_devices ORDER BY id`)
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var id, user int64
		var platform, token string
		var enabled bool
		var created, updated time.Time
		var last sql.NullTime
		if e = rows.Scan(&id, &user, &platform, &token, &enabled, &created, &updated, &last); e != nil {
			return e
		}
		if _, e = i.target.Exec(ctx, `INSERT INTO pulse.legacy_push_devices(
 legacy_id,user_id,platform,token,token_hash,enabled,created_at,updated_at,last_used_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, legacyUUID("user", user), platform, token,
			legacyDigest(token), enabled, created, updated, nullTime(last)); e != nil {
			return e
		}
		i.counts["notification_devices"]++
	}
	return rows.Err()
}
