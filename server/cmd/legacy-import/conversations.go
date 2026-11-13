package main

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"time"
)

type oldMember struct {
	UserID                               int64
	Role                                 string
	MutedUntil                           sql.NullTime
	MutedNotifications, Pinned, Archived bool
	ClearedBefore                        int64
	HiddenAt                             sql.NullTime
	JoinedAt                             time.Time
}

func loadMembers(ctx context.Context, i *importer) error {
	rows, err := i.source.QueryContext(ctx, `SELECT conversation_id,user_id,role,muted_until,
 notifications_muted,is_pinned,is_archived,cleared_before_message_id,hidden_at,joined_at
 FROM conversation_members ORDER BY conversation_id,user_id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int64
		var m oldMember
		if err = rows.Scan(&cid, &m.UserID, &m.Role, &m.MutedUntil, &m.MutedNotifications,
			&m.Pinned, &m.Archived, &m.ClearedBefore, &m.HiddenAt, &m.JoinedAt); err != nil {
			return err
		}
		if cid <= 0 || m.UserID <= 0 || (m.Role != "owner" && m.Role != "admin" && m.Role != "member") {
			return fmt.Errorf("invalid old member row")
		}
		i.members[cid] = append(i.members[cid], m)
		i.counts["conversation_members"]++
	}
	return rows.Err()
}

func importConversations(ctx context.Context, i *importer) error {
	rows, err := i.source.QueryContext(ctx, `SELECT id,type,name,owner_id,avatar_url,description,
 announcement,invite_code,allow_member_add_friend,max_members,member_count_offset,
 all_muted,join_method,status,created_at,updated_at FROM conversations ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var oldKind, oldJoin, status string
		var title, avatar, description, announcement, invite sql.NullString
		var owner sql.NullInt64
		var allowFriends, muteAll bool
		var maxMembers, countOffset int
		var created, updated time.Time
		if err = rows.Scan(&id, &oldKind, &title, &owner, &avatar, &description, &announcement, &invite,
			&allowFriends, &maxMembers, &countOffset, &muteAll, &oldJoin, &status, &created, &updated); err != nil {
			return err
		}
		if id <= 0 || maxMembers < 2 || maxMembers > 5000 {
			return fmt.Errorf("legacy conversation %d has invalid capacity", id)
		}
		kind := oldKind
		switch oldKind {
		case "direct", "group", "channel":
		case "favorites":
			kind = "saved"
		default:
			return fmt.Errorf("legacy conversation %d has unsupported kind %s", id, oldKind)
		}
		active := status == "active"
		if status != "active" && status != "disabled" && status != "deleted" {
			return fmt.Errorf("legacy conversation %d has unknown status", id)
		}
		policy := "open"
		switch oldJoin {
		case "free":
			policy = "open"
		case "invite":
			policy = "invite"
		case "approval":
			policy = "closed"
		default:
			return fmt.Errorf("legacy conversation %d has unknown join policy", id)
		}
		var directKey any
		if kind == "direct" {
			members := i.members[id]
			if len(members) != 2 {
				return fmt.Errorf("legacy direct conversation %d does not have two members", id)
			}
			pair := []string{legacyUUID("user", members[0].UserID), legacyUUID("user", members[1].UserID)}
			sort.Strings(pair)
			directKey = pair[0] + ":" + pair[1]
		}
		var inviteHash any
		if invite.Valid && invite.String != "" {
			inviteHash = legacyDigest(invite.String)
		}
		var deleted any
		if status == "deleted" {
			deleted = updated
		}
		_, err = i.target.Exec(ctx, `INSERT INTO pulse.conversations(
 id,kind,direct_key,title,active,mute_all,updated_at,member_limit,join_policy,
 invite_code_hash,invite_code_changed_at,announcement,description,block_member_friend_requests,
 deleted_at,display_count_offset,legacy_avatar_url,created_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
			legacyUUID("conversation", id), kind, directKey, nullString(title), active, muteAll, updated,
			maxMembers, policy, inviteHash, created, nullString(announcement), nullString(description),
			!allowFriends, deleted, countOffset, nullOrString(avatar), created)
		if err != nil {
			return fmt.Errorf("legacy conversation %d: %w", id, err)
		}
		if err = i.addID(ctx, "conversation", id); err != nil {
			return err
		}
		if kind == "saved" {
			if !owner.Valid || owner.Int64 <= 0 {
				return fmt.Errorf("legacy favorites conversation %d has no owner", id)
			}
			if _, err = i.target.Exec(ctx, `INSERT INTO pulse.saved_conversations(user_id,conversation_id)
 VALUES($1,$2)`, legacyUUID("user", owner.Int64), legacyUUID("conversation", id)); err != nil {
				return err
			}
		}
		i.counts["conversations"]++
	}
	return rows.Err()
}
