package main

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

func importRelationships(ctx context.Context, i *importer) error {
	contacts, err := i.source.QueryContext(ctx, `SELECT user_id,contact_user_id,remark,group_name,
 source_type,source_request_id,created_at FROM contacts ORDER BY user_id,contact_user_id`)
	if err != nil {
		return err
	}
	for contacts.Next() {
		var userID, peerID int64
		var remark, group, source sql.NullString
		var request sql.NullInt64
		var created time.Time
		if err = contacts.Scan(&userID, &peerID, &remark, &group, &source, &request, &created); err != nil {
			contacts.Close()
			return err
		}
		if userID <= 0 || peerID <= 0 || userID == peerID {
			contacts.Close()
			return fmt.Errorf("invalid legacy contact pair")
		}
		low, high := sortedPair(legacyUUID("user", userID), legacyUUID("user", peerID))
		if _, err = i.target.Exec(ctx, `INSERT INTO pulse.friendships(user_low,user_high,created_at) VALUES($1,$2,$3)
			ON CONFLICT(user_low,user_high) DO UPDATE SET created_at=LEAST(pulse.friendships.created_at,EXCLUDED.created_at)`, low, high, created); err != nil {
			contacts.Close()
			return err
		}
		if _, err = i.target.Exec(ctx, `INSERT INTO pulse.contact_metadata(user_id,peer_id,remark,group_name,source_type,legacy_source_request_id,created_at)
 VALUES($1,$2,$3,$4,$5,$6,$7)`, legacyUUID("user", userID), legacyUUID("user", peerID), nullString(remark), nullString(group), nullOrString(source), nullInt(request), created); err != nil {
			contacts.Close()
			return err
		}
		i.counts["contacts"]++
	}
	err = contacts.Err()
	contacts.Close()
	if err != nil {
		return err
	}

	requests, err := i.source.QueryContext(ctx, `SELECT id,from_user_id,to_user_id,message,status,created_at,updated_at FROM contact_requests ORDER BY id`)
	if err != nil {
		return err
	}
	for requests.Next() {
		var id, sender, target int64
		var note sql.NullString
		var status string
		var created, updated time.Time
		if err = requests.Scan(&id, &sender, &target, &note, &status, &created, &updated); err != nil {
			requests.Close()
			return err
		}
		if status != "pending" && status != "accepted" && status != "rejected" && status != "blocked" {
			requests.Close()
			return fmt.Errorf("unknown legacy contact request status")
		}
		var decided any
		if status != "pending" {
			decided = updated
		}
		if _, err = i.target.Exec(ctx, `INSERT INTO pulse.friend_requests(id,requester_id,target_id,note,status,created_at,decided_at)
 VALUES($1,$2,$3,$4,$5,$6,$7)`, legacyUUID("friend_request", id), legacyUUID("user", sender), legacyUUID("user", target), nullString(note), status, created, decided); err != nil {
			requests.Close()
			return err
		}
		if err = i.addID(ctx, "friend_request", id); err != nil {
			requests.Close()
			return err
		}
		i.counts["contact_requests"]++
	}
	err = requests.Err()
	requests.Close()
	if err != nil {
		return err
	}
	// The Go trigger creates current-day request notifications. They are not the
	// historical notification rows and must be replaced by their own import.
	if _, err = i.target.Exec(ctx, "DELETE FROM pulse.notifications"); err != nil {
		return err
	}
	if _, err = i.target.Exec(ctx, "DELETE FROM pulse.user_outbox"); err != nil {
		return err
	}

	blocks, err := i.source.QueryContext(ctx, "SELECT blocker_id,blocked_id,reason,created_at FROM user_blocks ORDER BY blocker_id,blocked_id")
	if err != nil {
		return err
	}
	for blocks.Next() {
		var blocker, blocked int64
		var reason sql.NullString
		var created time.Time
		if err = blocks.Scan(&blocker, &blocked, &reason, &created); err != nil {
			blocks.Close()
			return err
		}
		if _, err = i.target.Exec(ctx, `INSERT INTO pulse.blocks(user_id,peer_id,reason,created_at) VALUES($1,$2,$3,$4)`, legacyUUID("user", blocker), legacyUUID("user", blocked), nullOrString(reason), created); err != nil {
			blocks.Close()
			return err
		}
		i.counts["user_blocks"]++
	}
	err = blocks.Err()
	blocks.Close()
	return err
}
