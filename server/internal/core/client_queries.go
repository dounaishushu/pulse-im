package core

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"time"
)

type ClientUser struct {
	ID            string `json:"id"`
	Account       string `json:"account"`
	Nickname      string `json:"nickname"`
	InternalStaff bool   `json:"internal_staff"`
	IsContact     bool   `json:"is_contact"`
	AvatarID      string `json:"avatar_id,omitempty"`
	PublicID      string `json:"public_id,omitempty"`
	Remark        string `json:"remark"`
	GroupName     string `json:"group_name"`
}

func (s *Service) ClientUser(ctx context.Context, who Identity, id, cid string) (ClientUser, error) {
	var out ClientUser
	if !validID(id) || (cid != "" && !validID(cid)) {
		return out, ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return out, err
	}
	if cid != "" {
		a, e := authorize(ctx, tx, who, cid, false)
		if e != nil {
			return out, e
		}
		var allowed bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pulse.members m JOIN pulse.conversations c ON c.id=m.conversation_id
   WHERE c.id=$1 AND m.user_id=$2 AND m.active AND (NOT c.block_member_friend_requests OR $3))`, cid, id, a.Role == "owner" || a.Role == "admin").Scan(&allowed); e != nil {
			return out, e
		}
		if !allowed {
			return out, ErrForbidden
		}
	}
	err = tx.QueryRow(ctx, `SELECT u.id::text,CASE WHEN u.account_is_internal THEN '' ELSE u.account END,COALESCE(NULLIF(u.nickname,''),CASE WHEN u.account_is_internal THEN '' ELSE u.account END),u.internal_staff,COALESCE(u.avatar_id::text,''),COALESCE(u.legacy_public_id,u.public_id),COALESCE(cm.remark,''),COALESCE(cm.group_name,''),
 EXISTS(SELECT 1 FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid))
 FROM pulse.users u LEFT JOIN pulse.contact_metadata cm ON cm.user_id=$1 AND cm.peer_id=u.id WHERE u.id=$2 AND u.active AND ($1=$2 OR $3::uuid IS NOT NULL OR
 EXISTS(SELECT 1 FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid)) OR
 EXISTS(SELECT 1 FROM pulse.members a JOIN pulse.members b USING(conversation_id) JOIN pulse.conversations c ON c.id=a.conversation_id
 WHERE a.user_id=$1 AND b.user_id=$2 AND a.active AND b.active AND c.active AND c.kind='direct'))`, who.UserID, id, optionalUUID(cid)).Scan(&out.ID, &out.Account, &out.Nickname, &out.InternalStaff, &out.AvatarID, &out.PublicID, &out.Remark, &out.GroupName, &out.IsContact)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrForbidden
	}
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

type ClientConversation struct {
	ConversationPreferences
	UpdatedAt       time.Time `json:"updated_at"`
	UnreadTruncated bool      `json:"unread_truncated"`
	AvatarID        string    `json:"avatar_id"`
	Conversation
	PeerID            string   `json:"peer_id"`
	PeerName          string   `json:"peer_name"`
	Role              string   `json:"my_role"`
	Muted             bool     `json:"my_muted"`
	MuteAll           bool     `json:"mute_all"`
	CanSend           bool     `json:"can_send"`
	LastMessage       *Message `json:"last_message"`
	Unread            int      `json:"unread_count"`
	UnreadMentions    int      `json:"unread_mention_count"`
	LastMentionSeq    int64    `json:"last_mention_seq,string"`
	MentionsTruncated bool     `json:"mentions_truncated"`
}

func (s *Service) ClientConversations(ctx context.Context, who Identity, after, only string) ([]ClientConversation, error) {
	return s.clientConversationWindow(ctx, who, after, only, 0, 100, "", false)
}
func (s *Service) clientConversationWindow(ctx context.Context, who Identity, after, only string, offset, limit int, kind string, byActivity bool) ([]ClientConversation, error) {
	if after == "" {
		after = "00000000-0000-0000-0000-000000000000"
	}
	if !validID(after) || (only != "" && !validID(only)) {
		return nil, ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return nil, err
	}
	order := "c.id"
	if byActivity {
		order = "st.pinned DESC,c.updated_at DESC,c.id DESC"
	}
	rows, err := tx.Query(ctx, `SELECT c.id::text,c.kind,c.title,COALESCE((CASE WHEN c.kind='direct' THEN peer.avatar_id ELSE c.avatar_id END)::text,''),c.updated_at,c.message_seq,c.event_seq,m.visible_from_seq,m.visible_from_event_seq,m.membership_version,m.history_allowed,
 st.read_seq,st.delivered_seq,st.clear_seq,st.version,st.personal_seq,st.reminder,st.pinned,st.muted_notifications,st.archived,st.hidden,COALESCE(st.folder_id::text,''),st.preference_version,
 COALESCE(peer.id::text,''),COALESCE(NULLIF(peer.nickname,''),CASE WHEN peer.account_is_internal THEN '' ELSE peer.account END,''),m.role,(m.muted OR COALESCE(m.muted_until>now(),false)),c.mute_all,
 u.can_send AND COALESCE(c.kind<>'direct' OR (peer.active AND
 NOT EXISTS(SELECT 1 FROM pulse.blocks b WHERE (b.user_id=$1 AND b.peer_id=peer.id) OR (b.user_id=peer.id AND b.peer_id=$1)) AND
 (f.user_low IS NOT NULL OR (COALESCE(e.effect,'')<>'deny' AND (e.effect='allow' OR COALESCE(p.temporary_chat,'everyone')='everyone')))),false),
 f.user_low IS NOT NULL,
 (SELECT count(*) FROM (SELECT 1 FROM pulse.messages msg WHERE msg.conversation_id=c.id AND msg.seq>GREATEST(st.clear_seq,m.visible_from_seq-1)
 AND (NOT msg.manager_only OR m.role IN('owner','admin'))
 AND ((NOT msg.imported_legacy AND msg.seq>st.read_seq AND
       NOT EXISTS(SELECT 1 FROM pulse.receipt_facts rf WHERE rf.message_id=msg.id AND rf.user_id=$1)) OR
      (msg.imported_legacy AND msg.seq>st.legacy_delivered_override_seq AND
       NOT EXISTS(SELECT 1 FROM pulse.receipt_facts rf WHERE rf.message_id=msg.id AND rf.user_id=$1)))
 AND msg.sender_id<>$1 AND NOT msg.revoked AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.user_id=$1 AND d.message_id=msg.id) LIMIT 1000) unread)
 FROM pulse.members m JOIN pulse.conversations c ON c.id=m.conversation_id JOIN pulse.user_states st USING(conversation_id,user_id)
 JOIN pulse.users u ON u.id=m.user_id
 LEFT JOIN pulse.users peer ON c.kind='direct' AND peer.id=(CASE WHEN split_part(c.direct_key,':',1)::uuid=$1 THEN split_part(c.direct_key,':',2)::uuid ELSE split_part(c.direct_key,':',1)::uuid END)
 LEFT JOIN pulse.friendships f ON f.user_low=LEAST($1::uuid,peer.id) AND f.user_high=GREATEST($1::uuid,peer.id)
 LEFT JOIN pulse.privacy_settings p ON p.user_id=peer.id
 LEFT JOIN pulse.privacy_exceptions e ON e.user_id=peer.id AND e.peer_id=$1 AND e.scope='temporary_chat'
 WHERE m.user_id=$1 AND m.active AND c.active AND (NOT st.hidden OR $3::uuid IS NOT NULL) AND c.id>$2 AND ($3::uuid IS NULL OR c.id=$3) AND ($4='' OR c.kind=$4)
 ORDER BY `+order+` LIMIT $5 OFFSET $6`, who.UserID, after, optionalUUID(only), kind, limit, offset)
	if err != nil {
		return nil, err
	}
	result := make([]ClientConversation, 0)
	ids := make([]string, 0)
	for rows.Next() {
		var c ClientConversation
		var friend, canSend bool
		c.State.UserID = who.UserID
		if err = rows.Scan(&c.ID, &c.Kind, &c.Title, &c.AvatarID, &c.UpdatedAt, &c.MessageSeq, &c.EventSeq, &c.VisibleFromSeq, &c.VisibleFromEventSeq, &c.MembershipVersion, &c.HistoryAllowed,
			&c.State.ReadSeq, &c.State.DeliveredSeq, &c.State.ClearSeq, &c.State.Version, &c.State.PersonalSeq, &c.State.Reminder, &c.Pinned, &c.ConversationPreferences.Muted, &c.Archived, &c.Hidden, &c.FolderID, &c.ConversationPreferences.Version, &c.PeerID, &c.PeerName, &c.Role, &c.Muted, &c.MuteAll, &canSend, &friend, &c.Unread); err != nil {
			rows.Close()
			return nil, err
		}
		if c.Unread > 999 {
			c.Unread = 999
			c.UnreadTruncated = true
		}
		c.UpdatedAt = c.UpdatedAt.UTC()
		c.Temporary = c.Kind == "direct" && !friend
		c.CanSend = canSend && !c.Muted && !(c.MuteAll && c.Role == "member") && !(c.Kind == "channel" && c.Role == "member")
		ids = append(ids, c.ID)
		result = append(result, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	// One indexed lateral lookup per visible conversation; no per-message fanout writes.
	messages, err := tx.Query(ctx, `SELECT msg.id::text,msg.conversation_id::text,msg.seq,msg.event_seq,msg.sender_id::text,msg.request_id,msg.body,msg.revoked,msg.version,msg.created_at,msg.updated_at,msg.kind,msg.content,COALESCE(msg.reply_to::text,''),`+messageSenderColumn+`
 FROM pulse.members m JOIN pulse.user_states st USING(conversation_id,user_id)
 JOIN LATERAL (SELECT * FROM pulse.messages p WHERE p.conversation_id=m.conversation_id AND p.seq>=m.visible_from_seq AND p.seq>st.clear_seq AND NOT p.revoked
 AND (NOT p.manager_only OR m.role IN('owner','admin'))
 AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.user_id=$1 AND d.message_id=p.id) ORDER BY p.seq DESC LIMIT 1) msg ON true
 WHERE m.user_id=$1 AND m.conversation_id=ANY($2::uuid[])`, who.UserID, ids)
	if err != nil {
		return nil, err
	}
	last := map[string]Message{}
	for messages.Next() {
		var m Message
		if err = scanMessage(messages, &m); err != nil {
			messages.Close()
			return nil, err
		}
		last[m.ConversationID] = m
	}
	err = messages.Err()
	messages.Close()
	if err != nil {
		return nil, err
	}
	// Aggregate reminders for the visible page, including muted groups. Sparse
	// receipts, personal deletion and join/clear boundaries use the same rules
	// as /mentions; at most 1000 matching messages are counted per conversation.
	mentions, err := tx.Query(ctx, `SELECT c.id::text,summary.count,summary.last_seq FROM pulse.conversations c
		JOIN pulse.members m ON m.conversation_id=c.id AND m.user_id=$1 AND m.active
		JOIN pulse.user_states st USING(conversation_id,user_id)
		CROSS JOIN LATERAL (SELECT count(*),COALESCE(max(seq),0) last_seq FROM (
			SELECT msg.seq FROM pulse.messages msg WHERE msg.conversation_id=c.id AND NOT msg.revoked
			AND (NOT msg.manager_only OR m.role IN('owner','admin'))
			AND (msg.content ? 'mentions' OR msg.content->>'mention_all'='true') AND msg.sender_id<>$1
			AND msg.seq>GREATEST(st.clear_seq,m.visible_from_seq-1)
			AND ((NOT msg.imported_legacy AND msg.seq>st.read_seq) OR (msg.imported_legacy AND msg.seq>st.legacy_read_override_seq))
			AND NOT EXISTS(SELECT 1 FROM pulse.receipt_facts rf WHERE rf.message_id=msg.id AND rf.user_id=$1 AND rf.status='read')
			AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.message_id=msg.id AND d.user_id=$1)
			AND (msg.content->>'mention_all'='true' OR EXISTS(SELECT 1 FROM pulse.message_mentions mm WHERE mm.message_id=msg.id AND mm.user_id=$1))
			ORDER BY msg.seq DESC LIMIT 1000
		) matched) summary WHERE c.id=ANY($2::uuid[]) AND c.kind='group' AND c.active`, who.UserID, ids)
	if err != nil {
		return nil, err
	}
	byConversation := make(map[string]int, len(result))
	for i := range result {
		byConversation[result[i].ID] = i
	}
	for mentions.Next() {
		var cid string
		var count int
		var last int64
		if err = mentions.Scan(&cid, &count, &last); err != nil {
			mentions.Close()
			return nil, err
		}
		if i, ok := byConversation[cid]; ok {
			result[i].UnreadMentions, result[i].LastMentionSeq = min(count, 999), last
			result[i].MentionsTruncated = count > 999
		}
	}
	err = mentions.Err()
	mentions.Close()
	if err != nil {
		return nil, err
	}
	for i := range result {
		if m, ok := last[result[i].ID]; ok {
			result[i].LastMessage = &m
		}

	}
	if only != "" && len(result) == 0 {
		return nil, ErrForbidden
	}
	return result, tx.Commit(ctx)
}

type HistoryPage struct {
	HistoryScope
	Items          []Message `json:"items"`
	SnapshotMaxSeq int64     `json:"snapshot_max_seq,string"`
	NextAfterSeq   int64     `json:"next_after_seq,string"`
	ClearSeq       int64     `json:"clear_seq,string"`
	HasMore        bool      `json:"has_more"`
}

func (s *Service) History(ctx context.Context, who Identity, cid string, after, before, floor int64, upper *int64, limit int, descending bool, version *int64) (HistoryPage, error) {
	out := HistoryPage{Items: []Message{}}
	if !validID(cid) || after < 0 || before < 0 || floor < 0 || limit < 1 || limit > 100 {
		return out, ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return out, err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return out, err
	}
	if version != nil && *version != a.MembershipVersion {
		return out, &Fault{409, "membership_changed"}
	}
	out.HistoryScope = scopeOf(a)
	out.ClearSeq = a.ClearSeq
	out.SnapshotMaxSeq = a.MessageSeq
	if upper != nil {
		if *upper < 0 || *upper > a.MessageSeq {
			return out, ErrInvalid
		}
		out.SnapshotMaxSeq = *upper
	}
	maximum := out.SnapshotMaxSeq
	if before > 0 {
		maximum = min(maximum, before)
	}
	order := "ASC"
	if descending {
		order = "DESC"
	}
	rows, err := tx.Query(ctx, `SELECT `+messageColumns+` FROM pulse.messages msg WHERE conversation_id=$1 AND seq>$2 AND seq>GREATEST($3::bigint,$4::bigint-1,$5::bigint-1) AND seq<=$6 AND NOT revoked
 AND (NOT msg.manager_only OR $9) AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.user_id=$7 AND d.message_id=msg.id) ORDER BY seq `+order+` LIMIT $8`, cid, after, a.ClearSeq, a.VisibleFrom, floor, maximum, who.UserID, limit+1, a.managesGroup())
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var m Message
		if err = scanMessage(rows, &m); err != nil {
			rows.Close()
			return out, err
		}
		out.Items = append(out.Items, m)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	out.HasMore = len(out.Items) > limit
	if out.HasMore {
		out.Items = out.Items[:limit]
	}
	out.NextAfterSeq = maximum
	if out.HasMore {
		out.NextAfterSeq = out.Items[len(out.Items)-1].Seq
	}
	return out, tx.Commit(ctx)
}
func (s *Service) ClientMembers(ctx context.Context, who Identity, cid, after string) ([]map[string]any, error) {
	// GroupMembers enforces the existing restricted-directory policy. Recheck in
	// the projection query so permission changes cannot widen the returned set.
	if !validID(cid) {
		return nil, ErrInvalid
	}
	if after == "" {
		after = "00000000-0000-0000-0000-000000000000"
	}
	if !validID(after) {
		return nil, ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return nil, err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return nil, err
	}
	if a.Kind != "group" && a.Kind != "channel" {
		return nil, ErrForbidden
	}
	rows, err := tx.Query(ctx, `SELECT u.id::text,CASE WHEN u.account_is_internal THEN '' ELSE u.account END,COALESCE(NULLIF(u.nickname,''),CASE WHEN u.account_is_internal THEN '' ELSE u.account END),m.role,m.muted,COALESCE(m.muted_until>now(),false),COALESCE(m.muted_until::text,''),u.internal_staff,COALESCE(u.avatar_id::text,''),COALESCE(u.legacy_public_id,u.public_id),COALESCE(cm.remark,'') FROM pulse.members m
 JOIN pulse.users u ON u.id=m.user_id AND u.active JOIN pulse.conversations c ON c.id=m.conversation_id AND c.active
 JOIN pulse.members viewer ON viewer.conversation_id=c.id AND viewer.user_id=$2 AND viewer.active
 LEFT JOIN pulse.contact_metadata cm ON cm.user_id=$2 AND cm.peer_id=u.id
 WHERE c.id=$1 AND c.kind IN ('group','channel') AND m.active AND m.user_id>$3
 AND (viewer.role IN ('owner','admin') OR (c.kind='group' AND NOT c.block_member_friend_requests) OR m.role IN ('owner','admin')) ORDER BY m.user_id LIMIT 100`, cid, who.UserID, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, account, nickname, role, avatarID, publicID, remark string
		var permanent, timed, staff bool
		var mutedUntil string
		if err = rows.Scan(&id, &account, &nickname, &role, &permanent, &timed, &mutedUntil, &staff, &avatarID, &publicID, &remark); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "account": account, "nickname": nickname, "remark": remark, "public_id": publicID, "avatar_id": avatarID, "role": role, "muted": permanent || timed, "muted_permanent": permanent, "muted_until": mutedUntil, "internal_staff": staff})
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	return out, tx.Commit(ctx)
}
