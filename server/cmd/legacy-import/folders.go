package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

func importFolders(ctx context.Context, i *importer) error {
	rows, err := i.source.QueryContext(ctx, `SELECT id,user_id,name,scope,sort_order,collapsed,created_at
 FROM conversation_folders ORDER BY id`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, user int64
		var name, scope string
		var order int
		var collapsed bool
		var created time.Time
		if err = rows.Scan(&id, &user, &name, &scope, &order, &collapsed, &created); err != nil {
			rows.Close()
			return err
		}
		if scope != "direct" && scope != "group" {
			rows.Close()
			return fmt.Errorf("invalid old conversation folder scope")
		}
		_, err = i.target.Exec(ctx, `INSERT INTO pulse.conversation_folders
 (id,user_id,scope,name,sort_order,collapsed,legacy_id)
 VALUES($1,$2,$3,$4,$5,$6,$7)`, legacyUUID("folder", id),
			legacyUUID("user", user), scope, name, order, collapsed, id)
		if err != nil {
			rows.Close()
			return err
		}
		if err = i.addID(ctx, "folder", id); err != nil {
			rows.Close()
			return err
		}
		i.counts["conversation_folders"]++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	items, err := i.source.QueryContext(ctx, `SELECT folder_id,conversation_id,user_id
 FROM conversation_folder_items ORDER BY folder_id,conversation_id,user_id`)
	if err != nil {
		return err
	}
	defer items.Close()
	for items.Next() {
		var folder, conversation, user int64
		if err = items.Scan(&folder, &conversation, &user); err != nil {
			return err
		}
		command, err := i.target.Exec(ctx, `UPDATE pulse.user_states SET folder_id=$3
 WHERE conversation_id=$1 AND user_id=$2`, legacyUUID("conversation", conversation),
			legacyUUID("user", user), legacyUUID("folder", folder))
		if err != nil {
			return err
		}
		if command.RowsAffected() != 1 {
			return fmt.Errorf("old folder item has no imported conversation state")
		}
		i.counts["conversation_folder_items"]++
	}
	return items.Err()
}

func importRegionLocations(ctx context.Context, i *importer) error {
	rows, err := i.source.QueryContext(ctx, `SELECT ip,country_code,province_code,region_name,region_code,
 city_name,location,status,checked_at,next_retry_at
 FROM ip_region_locations ORDER BY ip`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var ip, status string
		var country, province, region, regionCode, city, location sql.NullString
		var checked, retry sql.NullTime
		if err = rows.Scan(&ip, &country, &province, &region, &regionCode,
			&city, &location, &status, &checked, &retry); err != nil {
			return err
		}
		original, err := json.Marshal(map[string]any{
			"country_code": nullOrString(country), "province_code": nullOrString(province),
			"region_name": nullOrString(region), "region_code": nullOrString(regionCode),
			"city_name": nullOrString(city), "location": nullOrString(location),
			"status": status, "checked_at": nullTime(checked), "next_retry_at": nullTime(retry),
		})
		if err != nil {
			return err
		}
		if _, err = i.target.Exec(ctx, `INSERT INTO pulse.ip_locations
 (ip,country,province,city,status,updated_at,legacy_payload)
 VALUES($1,$2,$3,$4,$5,COALESCE($6,now()),$7)`,
			ip, nullString(country), nullString(province), nullString(city), status,
			nullTime(checked), json.RawMessage(original)); err != nil {
			return err
		}
		i.counts["ip_region_locations"]++
	}
	return rows.Err()
}
