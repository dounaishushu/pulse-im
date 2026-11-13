package main

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"time"
)

func importMessageRelations(ctx context.Context, i *importer) error {
	replies, err := i.source.QueryContext(ctx, `SELECT id,JSON_UNQUOTE(JSON_EXTRACT(body_json,'$.reply_to_id'))
 FROM messages WHERE JSON_EXTRACT(body_json,'$.reply_to_id') IS NOT NULL`)
	if err != nil {
		return err
	}
	for replies.Next() {
		var id int64
		var oldTarget sql.NullString
		if err = replies.Scan(&id, &oldTarget); err != nil {
			replies.Close()
			return err
		}
		target, e := strconv.ParseInt(nullString(oldTarget), 10, 64)
		if e != nil || target <= 0 {
			replies.Close()
			return fmt.Errorf("legacy message %d has invalid reply", id)
		}
		from, ok1 := i.messageIDs[id]
		to, ok2 := i.messageIDs[target]
		if !ok1 || !ok2 || from.Conversation != to.Conversation {
			replies.Close()
			return fmt.Errorf("legacy message %d has missing or cross-conversation reply", id)
		}
		if _, err = i.target.Exec(ctx, `UPDATE pulse.messages SET reply_to=$2::uuid,
			content=jsonb_set(content,'{reply_to_id}',to_jsonb($3::text),true) WHERE id=$1`,
			legacyUUID("message", id), legacyUUID("message", target), legacyUUID("message", target)); err != nil {
			replies.Close()
			return err
		}
		i.counts["message_replies"]++
	}
	err = replies.Err()
	replies.Close()
	if err != nil {
		return err
	}

	deletions, err := i.source.QueryContext(ctx, "SELECT conversation_id,message_id,user_id FROM message_deletions")
	if err != nil {
		return err
	}
	for deletions.Next() {
		var cid, mid, uid int64
		if err = deletions.Scan(&cid, &mid, &uid); err != nil {
			deletions.Close()
			return err
		}
		if key, ok := i.messageIDs[mid]; !ok || key.Conversation != cid {
			deletions.Close()
			return fmt.Errorf("invalid legacy personal deletion")
		}
		if _, err = i.target.Exec(ctx, "INSERT INTO pulse.message_deletions(user_id,message_id) VALUES($1,$2)", legacyUUID("user", uid), legacyUUID("message", mid)); err != nil {
			deletions.Close()
			return err
		}
		i.counts["message_deletions"]++
	}
	err = deletions.Err()
	deletions.Close()
	if err != nil {
		return err
	}

	mentions, err := i.source.QueryContext(ctx, "SELECT conversation_id,message_id,user_id FROM message_mentions")
	if err != nil {
		return err
	}
	for mentions.Next() {
		var cid, mid, uid int64
		if err = mentions.Scan(&cid, &mid, &uid); err != nil {
			mentions.Close()
			return err
		}
		if key, ok := i.messageIDs[mid]; !ok || key.Conversation != cid {
			mentions.Close()
			return fmt.Errorf("invalid legacy message mention")
		}
		if uid == 0 {
			_, err = i.target.Exec(ctx, `UPDATE pulse.messages SET content=jsonb_set(content,'{mention_all}','true'::jsonb,true) WHERE id=$1`, legacyUUID("message", mid))
		} else {
			_, err = i.target.Exec(ctx, "INSERT INTO pulse.message_mentions(message_id,user_id) VALUES($1,$2)", legacyUUID("message", mid), legacyUUID("user", uid))
		}
		if err != nil {
			mentions.Close()
			return err
		}
		i.counts["message_mentions"]++
	}
	err = mentions.Err()
	mentions.Close()
	if err != nil {
		return err
	}

	pins, err := i.source.QueryContext(ctx, "SELECT conversation_id,message_id,pinned_by,pinned_at FROM message_pins")
	if err != nil {
		return err
	}
	for pins.Next() {
		var cid, mid, actor int64
		var when time.Time
		if err = pins.Scan(&cid, &mid, &actor, &when); err != nil {
			pins.Close()
			return err
		}
		if key, ok := i.messageIDs[mid]; !ok || key.Conversation != cid {
			pins.Close()
			return fmt.Errorf("invalid legacy message pin")
		}
		if _, err = i.target.Exec(ctx, `INSERT INTO pulse.message_pins(conversation_id,message_id,actor_id,created_at)
 VALUES($1,$2,$3,$4)`, legacyUUID("conversation", cid), legacyUUID("message", mid), legacyUUID("user", actor), when); err != nil {
			pins.Close()
			return err
		}
		i.counts["message_pins"]++
	}
	err = pins.Err()
	pins.Close()
	return err
}
