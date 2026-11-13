package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

func importNotifications(ctx context.Context, i *importer) error {
	// Friend-request insertion has a Go notification trigger. Those generated
	// rows are not part of the old snapshot and must not duplicate history.
	if _, e := i.target.Exec(ctx, "DELETE FROM pulse.notifications"); e != nil {
		return e
	}
	if _, e := i.target.Exec(ctx, "DELETE FROM pulse.user_outbox"); e != nil {
		return e
	}
	rows, e := i.source.QueryContext(ctx, `SELECT id,user_id,type,actor_id,conversation_id,
 body_json,request_id,request_status,pending_request_id,read_at,created_at
 FROM user_notifications ORDER BY id`)
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var id, user int64
		var kind string
		var actor, conversation, pending sql.NullInt64
		var body []byte
		var request sql.NullInt64
		var status sql.NullString
		var read sql.NullTime
		var created time.Time
		if e = rows.Scan(&id, &user, &kind, &actor, &conversation, &body, &request, &status, &pending, &read, &created); e != nil {
			return e
		}
		if !json.Valid(body) {
			return fmt.Errorf("invalid old notification body")
		}
		var actorID, targetID, referenceID any
		if actor.Valid {
			actorID = legacyUUID("user", actor.Int64)
		}
		if conversation.Valid {
			targetID = legacyUUID("conversation", conversation.Int64)
		}
		if pending.Valid {
			referenceID = legacyUUID("friend_request", pending.Int64)
		} else if request.Valid {
			referenceID = legacyUUID("friend_request", request.Int64)
		}
		var oldID int64
		e = i.target.QueryRow(ctx, `INSERT INTO pulse.notifications(
 user_id,kind,actor_id,target_id,reference_id,read_at,handled,created_at,
 legacy_id,legacy_type,legacy_body,legacy_request_status,legacy_pending_request_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
			legacyUUID("user", user), kind, actorID, targetID, referenceID, nullTime(read), nullString(status), created,
			id, kind, json.RawMessage(body), nullOrString(status), nullInt(pending)).Scan(&oldID)
		if e != nil {
			return fmt.Errorf("legacy notification %d: %w", id, e)
		}
		if e = i.addID(ctx, "notification", id); e != nil {
			return e
		}
		i.counts["user_notifications"]++
	}
	e = rows.Err()
	rows.Close()
	return e
}
