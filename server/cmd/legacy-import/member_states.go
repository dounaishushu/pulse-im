package main

import (
	"context"
	"fmt"
	"sort"
	"time"
)

type oldProgress struct {
	Through, Cleared int64
	Role             string
	Joined, Updated  time.Time
}

func (i *importer) localSequence(conversationID, legacyMessageID int64) int64 {
	if legacyMessageID <= 0 {
		return 0
	}
	ids := i.conversationMessageIDs[conversationID]
	return int64(sort.Search(len(ids), func(n int) bool { return ids[n] > legacyMessageID }))
}

func importMemberStates(ctx context.Context, i *importer) error {
	progress := map[int64]map[int64]oldProgress{}
	rows, err := i.source.QueryContext(ctx, `SELECT conversation_id,user_id,through_message_id,
 cleared_before_message_id,member_role,joined_at,updated_at FROM conversation_read_progress`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var cid, uid int64
		var p oldProgress
		if err = rows.Scan(&cid, &uid, &p.Through, &p.Cleared, &p.Role, &p.Joined, &p.Updated); err != nil {
			rows.Close()
			return err
		}
		if progress[cid] == nil {
			progress[cid] = map[int64]oldProgress{}
		}
		progress[cid][uid] = p
		i.counts["conversation_read_progress"]++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for cid, members := range i.members {
		for _, m := range members {
			var until any
			if m.MutedUntil.Valid {
				until = m.MutedUntil.Time
			}
			_, err = i.target.Exec(ctx, `INSERT INTO pulse.members(
 conversation_id,user_id,role,active,muted,muted_until,visible_from_seq,
 visible_from_event_seq,membership_version,history_allowed,joined_at)
 VALUES($1,$2,$3,true,false,$4,1,1,1,true,$5)`, legacyUUID("conversation", cid), legacyUUID("user", m.UserID), m.Role, until, m.JoinedAt)
			if err != nil {
				return fmt.Errorf("legacy member in conversation %d: %w", cid, err)
			}
			clear := i.localSequence(cid, m.ClearedBefore)
			if p, ok := progress[cid][m.UserID]; ok {
				clear = max(clear, i.localSequence(cid, p.Cleared))
			}
			_, err = i.target.Exec(ctx, `INSERT INTO pulse.user_states(
 conversation_id,user_id,read_seq,delivered_seq,clear_seq,pinned,
 muted_notifications,archived,hidden)
 VALUES($1,$2,0,0,$3,$4,$5,$6,$7)`, legacyUUID("conversation", cid), legacyUUID("user", m.UserID), clear, m.Pinned, m.MutedNotifications, m.Archived, m.HiddenAt.Valid)
			if err != nil {
				return err
			}
			if p, ok := progress[cid][m.UserID]; ok {
				_, err = i.target.Exec(ctx, `INSERT INTO pulse.legacy_read_progress(conversation_id,user_id,
 through_seq,source_clear_seq,source_member_role,source_joined_at,source_updated_at)
 VALUES($1,$2,$3,$4,$5,$6,$7)`, legacyUUID("conversation", cid), legacyUUID("user", m.UserID),
					i.localSequence(cid, p.Through), i.localSequence(cid, p.Cleared), p.Role, p.Joined, p.Updated)
				if err != nil {
					return err
				}
			}
			i.counts["member_states"]++
		}
	}
	if i.counts["member_states"] != i.counts["conversation_members"] {
		return fmt.Errorf("member-state count mismatch")
	}
	return nil
}
