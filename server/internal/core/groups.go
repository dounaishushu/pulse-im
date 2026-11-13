package core

import (
	"context"
	"crypto/subtle"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type GroupCreated struct {
	ID         string `json:"id"`
	InviteCode string `json:"invite_code"`
}

type GroupSettings struct {
	Title                     *string `json:"title,omitempty"`
	Description               *string `json:"description,omitempty"`
	Announcement              *string `json:"announcement,omitempty"`
	JoinPolicy                *string `json:"join_policy,omitempty"`
	MemberLimit               *int    `json:"member_limit,omitempty"`
	BlockMemberFriendRequests *bool   `json:"block_member_friend_requests,omitempty"`
}

type GroupDetails struct {
	PublicID    string `json:"public_id"`
	AvatarID    string `json:"avatar_id"`
	MemberCount int    `json:"member_count"`
	OwnerID     string `json:"owner_id"`
	HistoryScope
	ID                        string `json:"id"`
	Kind                      string `json:"kind"`
	Title                     string `json:"title"`
	Description               string `json:"description"`
	Announcement              string `json:"announcement"`
	JoinPolicy                string `json:"join_policy"`
	MemberLimit               int    `json:"member_limit"`
	BlockMemberFriendRequests bool   `json:"block_member_friend_requests"`
	MuteAll                   bool   `json:"mute_all"`
	MyRole                    string `json:"my_role"`
	MyMuted                   bool   `json:"my_muted"`
}

func (s *Service) GroupDetails(ctx context.Context, who Identity, cid string) (GroupDetails, error) {
	result := GroupDetails{ID: cid}
	if !validID(cid) {
		return result, ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return result, err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return result, err
	}
	if a.Kind != "group" && a.Kind != "channel" {
		return result, ErrForbidden
	}
	result.MyRole, result.MyMuted = a.Role, a.Muted
	result.HistoryScope = scopeOf(a)
	err = tx.QueryRow(ctx, `SELECT kind,title,description,announcement,join_policy,member_limit,
		block_member_friend_requests,mute_all,(SELECT count(*) FROM pulse.members WHERE conversation_id=$1 AND active),
        COALESCE((SELECT user_id::text FROM pulse.members WHERE conversation_id=$1 AND active AND role='owner' LIMIT 1),''),public_id,COALESCE(avatar_id::text,'') FROM pulse.conversations WHERE id=$1`, cid).
		Scan(&result.Kind, &result.Title, &result.Description, &result.Announcement, &result.JoinPolicy,
			&result.MemberLimit, &result.BlockMemberFriendRequests, &result.MuteAll, &result.MemberCount, &result.OwnerID, &result.PublicID, &result.AvatarID)
	if err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

func (s *Service) UpdateGroupSettings(ctx context.Context, who Identity, cid string, input GroupSettings) (GroupDetails, error) {
	result := GroupDetails{ID: cid}
	if !validID(cid) {
		return result, ErrInvalid
	}
	if input.Title == nil && input.Description == nil && input.Announcement == nil && input.JoinPolicy == nil &&
		input.MemberLimit == nil && input.BlockMemberFriendRequests == nil {
		return result, ErrInvalid
	}
	if input.Title != nil && (!validText(*input.Title, 1, 128) || strings.TrimSpace(*input.Title) == "") {
		return result, ErrInvalid
	}
	if input.Description != nil && (!validText(*input.Description, 0, 500)) {
		return result, ErrInvalid
	}
	if input.Announcement != nil && (!validText(*input.Announcement, 0, 10000)) {
		return result, ErrInvalid
	}
	if input.JoinPolicy != nil && *input.JoinPolicy != "open" && *input.JoinPolicy != "invite" && *input.JoinPolicy != "closed" {
		return result, ErrInvalid
	}
	if input.MemberLimit != nil && (*input.MemberLimit < 2 || *input.MemberLimit > 5000) {
		return result, ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return result, err
	}
	if err = lockConversations(ctx, tx, []string{cid}); err != nil {
		return result, err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return result, err
	}
	if (a.Kind != "group" && a.Kind != "channel") || (a.Role != "owner" && a.Role != "admin") {
		return result, ErrForbidden
	}
	if input.MemberLimit != nil {
		var count int
		if err = tx.QueryRow(ctx, "SELECT count(*) FROM pulse.members WHERE conversation_id=$1 AND active", cid).Scan(&count); err != nil {
			return result, err
		}
		if *input.MemberLimit < count {
			return result, ErrConflict
		}
	}
	err = tx.QueryRow(ctx, `UPDATE pulse.conversations SET title=COALESCE($2,title),
		description=COALESCE($3,description),announcement=COALESCE($4,announcement),
		join_policy=COALESCE($5,join_policy),member_limit=COALESCE($6,member_limit),
		block_member_friend_requests=COALESCE($7,block_member_friend_requests),updated_at=now()
		WHERE id=$1 RETURNING kind,title,description,announcement,join_policy,member_limit,
		block_member_friend_requests,mute_all`, cid, input.Title, input.Description, input.Announcement,
		input.JoinPolicy, input.MemberLimit, input.BlockMemberFriendRequests).
		Scan(&result.Kind, &result.Title, &result.Description, &result.Announcement, &result.JoinPolicy,
			&result.MemberLimit, &result.BlockMemberFriendRequests, &result.MuteAll)
	if err != nil {
		return result, err
	}
	result.MyRole, result.MyMuted = a.Role, a.Muted
	result.HistoryScope = scopeOf(a)
	if err = membershipHint(ctx, tx, cid, ""); err != nil {
		return result, err
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	s.notify()
	return result, nil
}

func (s *Service) RotateGroupInvite(ctx context.Context, who Identity, cid string) (string, error) {
	if !validID(cid) {
		return "", ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return "", err
	}
	if err = lockConversations(ctx, tx, []string{cid}); err != nil {
		return "", err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return "", err
	}
	if (a.Kind != "group" && a.Kind != "channel") || (a.Role != "owner" && a.Role != "admin") {
		return "", ErrForbidden
	}
	code := opaqueToken()
	if _, err = tx.Exec(ctx, `UPDATE pulse.conversations SET invite_code_hash=$2,invite_code_changed_at=now()
		WHERE id=$1`, cid, digest(code)); err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return code, nil
}

func membershipHint(ctx context.Context, tx pgx.Tx, cid, subject string) error {
	_, err := tx.Exec(ctx, `INSERT INTO pulse.outbox(id,conversation_id,event_seq,kind,subject_id)
		VALUES($1,$2,0,'membership.changed',NULLIF($3,'')::uuid)`, newID(), cid, subject)
	return err
}

func (s *Service) CreateGroup(ctx context.Context, who Identity, title string, initial []string) (GroupCreated, error) {
	return s.CreateGroupWithPrivacy(ctx, who, title, initial, false)
}
func (s *Service) CreateGroupWithPrivacy(ctx context.Context, who Identity, title string, initial []string, blockMemberFriends bool) (GroupCreated, error) {
	return s.createGroupKindAvatar(ctx, who, title, initial, blockMemberFriends, "group", "")
}
func (s *Service) createGroupKind(ctx context.Context, who Identity, title string, initial []string, blockMemberFriends bool, kind string) (GroupCreated, error) {
	return s.createGroupKindAvatar(ctx, who, title, initial, blockMemberFriends, kind, "")
}
func (s *Service) CreateGroupWithAvatar(ctx context.Context, who Identity, title string, initial []string, blockMemberFriends bool, avatarID string) (GroupCreated, error) {
	return s.createGroupKindAvatar(ctx, who, title, initial, blockMemberFriends, "group", avatarID)
}
func (s *Service) createGroupKindAvatar(ctx context.Context, who Identity, title string, initial []string, blockMemberFriends bool, kind, avatarID string) (GroupCreated, error) {
	result := GroupCreated{}
	if !validText(title, 1, 128) || strings.TrimSpace(title) == "" || len(initial) > 499 {
		return result, ErrInvalid
	}
	if avatarID != "" && !validID(avatarID) {
		return result, ErrInvalid
	}
	seen := map[string]bool{who.UserID: true}
	for _, id := range initial {
		if !validID(id) || seen[id] {
			return result, ErrInvalid
		}
		seen[id] = true
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return result, err
	}
	var allowed bool
	if err = tx.QueryRow(ctx, "SELECT can_create_group FROM pulse.users WHERE id=$1 AND active", who.UserID).Scan(&allowed); err != nil {
		return result, err
	}
	if !allowed {
		return result, ErrForbidden
	}
	initial = append([]string(nil), initial...)
	sort.Strings(initial)
	if err = lockContactPrivacy(ctx, tx, initial, false); err != nil {
		return result, err
	}
	for _, id := range initial {
		if err = lockPair(ctx, tx, who.UserID, id); err != nil {
			return result, err
		}
		if err = checkGroupInvite(ctx, tx, who.UserID, id); err != nil {
			return result, err
		}
	}
	if avatarID != "" {
		var owned bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pulse.media WHERE id=$1 AND owner_id=$2 AND status='ready' AND kind IN('image','avatar'))", avatarID, who.UserID).Scan(&owned); err != nil {
			return result, err
		}
		if !owned {
			return result, ErrForbidden
		}
	}
	result.ID, result.InviteCode = newID(), opaqueToken()
	_, err = tx.Exec(ctx, `INSERT INTO pulse.conversations(id,kind,title,join_policy,invite_code_hash,invite_code_changed_at,block_member_friend_requests,avatar_id)
		VALUES($1,$5,$2,'invite',$3,now(),$4,$6)`, result.ID, title, digest(result.InviteCode), blockMemberFriends, kind, optionalUUID(avatarID))
	if err != nil {
		return result, err
	}
	for _, id := range append([]string{who.UserID}, initial...) {
		role := "member"
		if id == who.UserID {
			role = "owner"
		}
		if _, err = tx.Exec(ctx, `INSERT INTO pulse.members(conversation_id,user_id,role,history_allowed) VALUES($1,$2,$3,true)`, result.ID, id, role); err != nil {
			return result, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO pulse.user_states(conversation_id,user_id) VALUES($1,$2)`, result.ID, id); err != nil {
			return result, err
		}
		if id != who.UserID {
			if err = notifyUserTx(ctx, tx, id, "group.invited", who.UserID, result.ID); err != nil {
				return result, err
			}
		}
	}
	if err = membershipHint(ctx, tx, result.ID, ""); err != nil {
		return result, err
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	s.notify()
	return result, nil
}

func checkGroupInvite(ctx context.Context, tx pgx.Tx, actor, target string) error {
	return contactAllowed(ctx, tx, actor, target, "group_invites")
}

func (s *Service) InviteGroupMember(ctx context.Context, who Identity, cid, target string) error {
	return s.InviteGroupMemberWithHistory(ctx, who, cid, target, false)
}
func (s *Service) InviteGroupMemberWithHistory(ctx context.Context, who Identity, cid, target string, allowHistory bool) error {
	if !validID(cid) || !validID(target) || target == who.UserID {
		return ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return err
	}
	if err = lockContactPrivacy(ctx, tx, []string{target}, false); err != nil {
		return err
	}
	if err = lockPair(ctx, tx, who.UserID, target); err != nil {
		return err
	}
	if err = lockConversations(ctx, tx, []string{cid}); err != nil {
		return err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return err
	}
	if a.Kind != "group" && a.Kind != "channel" {
		return ErrForbidden
	}
	if a.Role != "owner" && a.Role != "admin" {
		return ErrForbidden
	}
	var blocked bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pulse.blocks
		WHERE (user_id=$1 AND peer_id=$2) OR (user_id=$2 AND peer_id=$1))`, who.UserID, target).Scan(&blocked); err != nil {
		return err
	}
	if blocked {
		return ErrForbidden
	}
	if err = checkGroupInvite(ctx, tx, who.UserID, target); err != nil {
		return err
	}
	changed, err := joinGroupTx(ctx, tx, cid, target, a.MessageSeq+1, a.EventSeq+1, allowHistory)
	if err != nil {
		return err
	}
	if changed {
		if err = notifyUserTx(ctx, tx, target, "group.invited", who.UserID, cid); err != nil {
			return err
		}
		if err = membershipHint(ctx, tx, cid, ""); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if changed {
		s.notify()
	}
	return nil
}

type InviteResult struct {
	UserID string `json:"user_id"`
	Added  bool   `json:"added"`
	Error  string `json:"error,omitempty"`
}

func (s *Service) InviteGroupMembers(ctx context.Context, who Identity, cid string, targets []string) ([]InviteResult, error) {
	return s.InviteGroupMembersWithHistory(ctx, who, cid, targets, false)
}
func (s *Service) InviteGroupMembersWithHistory(ctx context.Context, who Identity, cid string, targets []string, allowHistory bool) ([]InviteResult, error) {
	if !validID(cid) || len(targets) < 1 || len(targets) > 50 {
		return nil, ErrInvalid
	}
	seen := make(map[string]bool, len(targets))
	for _, id := range targets {
		if !validID(id) || seen[id] {
			return nil, ErrInvalid
		}
		seen[id] = true
	}
	results := make([]InviteResult, 0, len(targets))
	for _, id := range targets {
		result := InviteResult{UserID: id}
		err := s.InviteGroupMemberWithHistory(ctx, who, cid, id, allowHistory)
		if err == nil {
			result.Added = true
		} else {
			var fault *Fault
			if errors.As(err, &fault) {
				result.Error = fault.Code
			} else {
				return results, err
			}
		}
		results = append(results, result)
	}
	return results, nil
}

func joinGroupTx(ctx context.Context, tx pgx.Tx, cid, target string, fromMessage, fromEvent int64, allowHistory bool) (bool, error) {
	var count, maximum int
	if err := tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM pulse.members WHERE conversation_id=$1 AND active),
		member_limit FROM pulse.conversations WHERE id=$1`, cid).Scan(&count, &maximum); err != nil {
		return false, err
	}
	var current bool
	err := tx.QueryRow(ctx, "SELECT active FROM pulse.members WHERE conversation_id=$1 AND user_id=$2", cid, target).Scan(&current)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	if current {
		return false, nil
	}
	if count >= maximum {
		return false, &Fault{409, "group_full"}
	}
	if allowHistory {
		fromMessage, fromEvent = 1, 1
	}
	_, err = tx.Exec(ctx, `INSERT INTO pulse.members(conversation_id,user_id,role,active,muted,visible_from_seq,visible_from_event_seq,history_allowed)
		VALUES($1,$2,'member',true,false,$3,$4,$5)
		ON CONFLICT(conversation_id,user_id) DO UPDATE SET role='member',active=true,muted=false,
		visible_from_seq=EXCLUDED.visible_from_seq,visible_from_event_seq=EXCLUDED.visible_from_event_seq,
		history_allowed=EXCLUDED.history_allowed,joined_at=now(),membership_version=pulse.members.membership_version+1`,
		cid, target, fromMessage, fromEvent, allowHistory)
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, "INSERT INTO pulse.user_states(conversation_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", cid, target)
	return true, err
}

func (s *Service) JoinGroup(ctx context.Context, who Identity, cid, inviteCode string) error {
	if !validID(cid) || (inviteCode != "" && len(inviteCode) != 64) {
		return ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return err
	}
	if err = lockBlockParticipants(ctx, tx, []string{who.UserID}, true); err != nil {
		return err
	}
	if err = lockConversations(ctx, tx, []string{cid}); err != nil {
		return err
	}
	var kind, policy string
	var active bool
	var stored []byte
	var messageSeq, eventSeq int64
	err = tx.QueryRow(ctx, `SELECT kind,join_policy,active,invite_code_hash,message_seq,event_seq
		FROM pulse.conversations WHERE id=$1`, cid).Scan(&kind, &policy, &active, &stored, &messageSeq, &eventSeq)
	if err != nil {
		return err
	}
	if !active || (kind != "group" && kind != "channel") {
		return ErrForbidden
	}
	var alreadyMember bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pulse.members
		WHERE conversation_id=$1 AND user_id=$2 AND active)`, cid, who.UserID).Scan(&alreadyMember); err != nil {
		return err
	}
	if alreadyMember {
		return tx.Commit(ctx)
	}
	if policy == "closed" || (policy == "invite" && (inviteCode == "" || subtle.ConstantTimeCompare(stored, digest(inviteCode)) != 1)) {
		return ErrForbidden
	}
	var blocked bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pulse.members m JOIN pulse.blocks b
		ON ((b.user_id=m.user_id AND b.peer_id=$2) OR (b.user_id=$2 AND b.peer_id=m.user_id))
		WHERE m.conversation_id=$1 AND m.active AND m.role IN ('owner','admin'))`, cid, who.UserID).Scan(&blocked); err != nil {
		return err
	}
	if blocked {
		return ErrForbidden
	}
	changed, err := joinGroupTx(ctx, tx, cid, who.UserID, messageSeq+1, eventSeq+1, false)
	if err != nil {
		return err
	}
	if changed {
		if err = membershipHint(ctx, tx, cid, ""); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if changed {
		s.notify()
	}
	return nil
}

func (s *Service) SetGroupMute(ctx context.Context, who Identity, cid, target string, muted bool) error {
	if !validID(cid) || !validID(target) {
		return ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return err
	}
	if err = lockConversations(ctx, tx, []string{cid}); err != nil {
		return err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return err
	}
	if (a.Kind != "group" && a.Kind != "channel") || (a.Role != "owner" && a.Role != "admin") {
		return ErrForbidden
	}
	var role string
	var current bool
	var until *time.Time
	err = tx.QueryRow(ctx, "SELECT role,muted,muted_until FROM pulse.members WHERE conversation_id=$1 AND user_id=$2 AND active", cid, target).Scan(&role, &current, &until)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrMissing
	}
	if err != nil {
		return err
	}
	if role == "owner" || (a.Role == "admin" && role == "admin") {
		return ErrForbidden
	}
	changed := current != muted || until != nil
	if changed {
		if _, err = tx.Exec(ctx, "UPDATE pulse.members SET muted=$3,muted_until=NULL WHERE conversation_id=$1 AND user_id=$2", cid, target, muted); err != nil {
			return err
		}
		if err = membershipHint(ctx, tx, cid, ""); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if changed {
		s.notify()
	}
	return nil
}

func (s *Service) SetGroupMuteAll(ctx context.Context, who Identity, cid string, muted bool) error {
	if !validID(cid) {
		return ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return err
	}
	if err = lockConversations(ctx, tx, []string{cid}); err != nil {
		return err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return err
	}
	if (a.Kind != "group" && a.Kind != "channel") || (a.Role != "owner" && a.Role != "admin") {
		return ErrForbidden
	}
	if a.MuteAll != muted {
		if _, err = tx.Exec(ctx, "UPDATE pulse.conversations SET mute_all=$2 WHERE id=$1", cid, muted); err != nil {
			return err
		}
		if err = membershipHint(ctx, tx, cid, ""); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if a.MuteAll != muted {
		s.notify()
	}
	return nil
}

func (s *Service) SetGroupRole(ctx context.Context, who Identity, cid, target, role string) error {
	if !validID(cid) || !validID(target) || (role != "admin" && role != "member") {
		return ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return err
	}
	if err = lockConversations(ctx, tx, []string{cid}); err != nil {
		return err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return err
	}
	if (a.Kind != "group" && a.Kind != "channel") || a.Role != "owner" {
		return ErrForbidden
	}
	var current string
	err = tx.QueryRow(ctx, "SELECT role FROM pulse.members WHERE conversation_id=$1 AND user_id=$2 AND active", cid, target).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrMissing
	}
	if err != nil {
		return err
	}
	if current == "owner" {
		return ErrForbidden
	}
	if current != role {
		if _, err = tx.Exec(ctx, "UPDATE pulse.members SET role=$3 WHERE conversation_id=$1 AND user_id=$2", cid, target, role); err != nil {
			return err
		}
		if err = membershipHint(ctx, tx, cid, ""); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if current != role {
		s.notify()
	}
	return nil
}

func (s *Service) RemoveGroupMember(ctx context.Context, who Identity, cid, target string) error {
	if !validID(cid) || !validID(target) {
		return ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return err
	}
	if err = lockConversations(ctx, tx, []string{cid}); err != nil {
		return err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return err
	}
	if a.Kind != "group" && a.Kind != "channel" {
		return ErrForbidden
	}
	var role string
	err = tx.QueryRow(ctx, "SELECT role FROM pulse.members WHERE conversation_id=$1 AND user_id=$2 AND active", cid, target).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrMissing
	}
	if err != nil {
		return err
	}
	if target == who.UserID {
		if role == "owner" {
			return ErrForbidden
		}
	} else {
		if a.Role != "owner" && a.Role != "admin" {
			return ErrForbidden
		}
		if role == "owner" || (a.Role == "admin" && role == "admin") {
			return ErrForbidden
		}
	}
	if _, err = tx.Exec(ctx, "UPDATE pulse.members SET active=false,muted=false WHERE conversation_id=$1 AND user_id=$2", cid, target); err != nil {
		return err
	}
	if err = membershipHint(ctx, tx, cid, ""); err != nil {
		return err
	}
	if target != who.UserID {
		if err = notifyUserTx(ctx, tx, target, "group.removed", who.UserID, cid); err != nil {
			return err
		}
	}
	if err = membershipHint(ctx, tx, cid, target); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify()
	return nil
}

func (s *Service) TransferGroup(ctx context.Context, who Identity, cid, target string) error {
	if !validID(cid) || !validID(target) || target == who.UserID {
		return ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return err
	}
	if err = lockConversations(ctx, tx, []string{cid}); err != nil {
		return err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return err
	}
	if (a.Kind != "group" && a.Kind != "channel") || a.Role != "owner" {
		return ErrForbidden
	}
	var role string
	err = tx.QueryRow(ctx, "SELECT role FROM pulse.members WHERE conversation_id=$1 AND user_id=$2 AND active", cid, target).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrMissing
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "UPDATE pulse.members SET role='member' WHERE conversation_id=$1 AND user_id=$2", cid, who.UserID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "UPDATE pulse.members SET role='owner',muted=false WHERE conversation_id=$1 AND user_id=$2", cid, target); err != nil {
		return err
	}
	if err = membershipHint(ctx, tx, cid, ""); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify()
	return nil
}

func (s *Service) DissolveGroup(ctx context.Context, who Identity, cid string) error {
	if !validID(cid) {
		return ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return err
	}
	if err = lockConversations(ctx, tx, []string{cid}); err != nil {
		return err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return err
	}
	if (a.Kind != "group" && a.Kind != "channel") || a.Role != "owner" {
		return ErrForbidden
	}
	if _, err = tx.Exec(ctx, "UPDATE pulse.conversations SET active=false WHERE id=$1", cid); err != nil {
		return err
	}
	if err = membershipHint(ctx, tx, cid, ""); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.notify()
	return nil
}

func (s *Service) GroupMembers(ctx context.Context, who Identity, cid, after string) ([]string, error) {
	if !validID(cid) || (after != "" && !validID(after)) {
		return nil, ErrInvalid
	}
	if after == "" {
		after = "00000000-0000-0000-0000-000000000000"
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
	var restricted bool
	if err = tx.QueryRow(ctx, "SELECT block_member_friend_requests FROM pulse.conversations WHERE id=$1", cid).Scan(&restricted); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT m.user_id::text FROM pulse.members m WHERE m.conversation_id=$1
		AND m.active AND m.user_id>$2 AND ($3::bool=false OR $4::bool=true OR m.role IN ('owner','admin'))
		ORDER BY m.user_id LIMIT 100`, cid, after, restricted || a.Kind == "channel", a.Role == "owner" || a.Role == "admin")
	if err != nil {
		return nil, err
	}
	result := make([]string, 0)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}
