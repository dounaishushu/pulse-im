package core

import (
	"context"
	"errors"
	"sort"

	"github.com/jackc/pgx/v5"
)

type PrivacyRule struct {
	Visibility string   `json:"visibility"`
	Allow      []string `json:"allow"`
	Deny       []string `json:"deny"`
}
type ContactPrivacy struct {
	Phone                 PrivacyRule         `json:"phone"`
	PhoneSearch           PrivacyRule         `json:"phone_search"`
	LastSeen              PrivacyRule         `json:"last_seen"`
	VoiceCall             PrivacyRule         `json:"voice_call"`
	VoiceCallPeerToPeer   string              `json:"voice_call_peer_to_peer"`
	ShowActiveSessions    bool                `json:"show_active_sessions"`
	ExceptionUsers        []map[string]string `json:"exception_users"`
	TemporaryChat         PrivacyRule         `json:"temporary_chat"`
	GroupInvites          PrivacyRule         `json:"group_invites"`
	Version               int64               `json:"version,string"`
	CanManageGroupInvites bool                `json:"can_manage_group_invites"`
}
type PrivacyPatch struct {
	Phone               *PrivacyRule `json:"phone,omitempty"`
	PhoneSearch         *PrivacyRule `json:"phone_search,omitempty"`
	LastSeen            *PrivacyRule `json:"last_seen,omitempty"`
	VoiceCall           *PrivacyRule `json:"voice_call,omitempty"`
	VoiceCallPeerToPeer *string      `json:"voice_call_peer_to_peer,omitempty"`
	ShowActiveSessions  *bool        `json:"show_active_sessions,omitempty"`
	TemporaryChat       *PrivacyRule `json:"temporary_chat,omitempty"`
	GroupInvites        *PrivacyRule `json:"group_invites,omitempty"`
	ExpectedVersion     *int64       `json:"expected_version,string"`
}

// Contact policy gates precede pair and conversation locks. Keeping settings
// outside the users table avoids upgrading the authenticated user's SHARE lock.
func lockContactPrivacy(ctx context.Context, tx pgx.Tx, ids []string, exclusive bool) error {
	ids = append([]string(nil), ids...)
	sort.Strings(ids)
	query := "SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text,1149))"
	if exclusive {
		query = "SELECT pg_advisory_xact_lock(hashtextextended($1::text,1149))"
	}
	for i, id := range ids {
		if !validID(id) {
			return ErrInvalid
		}
		if i > 0 && ids[i-1] == id {
			continue
		}
		if _, err := tx.Exec(ctx, query, id); err != nil {
			return err
		}
	}
	return nil
}

// The caller holds a shared policy gate and pair lock for mutation paths.
// Privacy belongs to the recipient; internal staff never bypasses it.
func contactAllowed(ctx context.Context, tx pgx.Tx, actor, target, scope string) error {
	if scope != "temporary_chat" && scope != "group_invites" {
		return ErrInvalid
	}
	var active, blocked, friends bool
	var visibility, effect string
	err := tx.QueryRow(ctx, `SELECT u.active,
        EXISTS(SELECT 1 FROM pulse.blocks WHERE (user_id=$1 AND peer_id=$2) OR (user_id=$2 AND peer_id=$1)),
        EXISTS(SELECT 1 FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid)),
        COALESCE(CASE WHEN $3='temporary_chat' THEN p.temporary_chat ELSE p.group_invites END,'everyone'),COALESCE(e.effect,'')
        FROM pulse.users u LEFT JOIN pulse.privacy_settings p ON p.user_id=u.id
        LEFT JOIN pulse.privacy_exceptions e ON e.user_id=u.id AND e.scope=$3 AND e.peer_id=$1
        WHERE u.id=$2`, actor, target, scope).Scan(&active, &blocked, &friends, &visibility, &effect)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	if !active || blocked {
		return ErrForbidden
	}
	// Temporary-chat preferences apply only to noncontacts. A global block
	// continues to reject existing friends in either direction.
	if scope == "temporary_chat" && friends {
		return nil
	}
	if effect == "deny" {
		return ErrForbidden
	}
	if effect == "allow" || visibility == "everyone" || (visibility == "contacts" && friends) {
		return nil
	}
	return ErrForbidden
}

func readContactPrivacy(ctx context.Context, tx pgx.Tx, who Identity, internal bool) (ContactPrivacy, error) {
	result := ContactPrivacy{TemporaryChat: PrivacyRule{Visibility: "everyone", Allow: []string{}, Deny: []string{}}, GroupInvites: PrivacyRule{Visibility: "everyone", Allow: []string{}, Deny: []string{}}, CanManageGroupInvites: internal, Phone: PrivacyRule{Visibility: "nobody", Allow: []string{}, Deny: []string{}}, PhoneSearch: PrivacyRule{Visibility: "everyone", Allow: []string{}, Deny: []string{}}, LastSeen: PrivacyRule{Visibility: "everyone", Allow: []string{}, Deny: []string{}}, VoiceCall: PrivacyRule{Visibility: "everyone", Allow: []string{}, Deny: []string{}}, VoiceCallPeerToPeer: "everyone", ShowActiveSessions: true}
	err := tx.QueryRow(ctx, `SELECT temporary_chat,group_invites,phone,last_seen,phone_search,voice_call,voice_call_peer_to_peer,show_active_sessions,version FROM pulse.privacy_settings WHERE user_id=$1`, who.UserID).Scan(&result.TemporaryChat.Visibility, &result.GroupInvites.Visibility, &result.Phone.Visibility, &result.LastSeen.Visibility, &result.PhoneSearch.Visibility, &result.VoiceCall.Visibility, &result.VoiceCallPeerToPeer, &result.ShowActiveSessions, &result.Version)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	rows, err := tx.Query(ctx, `SELECT e.scope,e.peer_id::text,e.effect,CASE WHEN u.account_is_internal THEN '' ELSE u.account END FROM pulse.privacy_exceptions e JOIN pulse.users u ON u.id=e.peer_id WHERE e.user_id=$1 ORDER BY e.scope,e.peer_id`, who.UserID)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var scope, peer, effect, account string
		if err = rows.Scan(&scope, &peer, &effect, &account); err != nil {
			return result, err
		}
		result.ExceptionUsers = append(result.ExceptionUsers, map[string]string{"id": peer, "account": account})
		rule := &result.TemporaryChat
		switch scope {
		case "group_invites":
			rule = &result.GroupInvites
		case "phone":
			rule = &result.Phone
		case "phone_search":
			rule = &result.PhoneSearch
		case "last_seen":
			rule = &result.LastSeen
		case "voice_call":
			rule = &result.VoiceCall
		}
		if effect == "allow" {
			rule.Allow = append(rule.Allow, peer)
		} else {
			rule.Deny = append(rule.Deny, peer)
		}
	}
	return result, rows.Err()
}
func (s *Service) ContactPrivacy(ctx context.Context, who Identity) (ContactPrivacy, error) {
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return ContactPrivacy{}, err
	}
	defer tx.Rollback(ctx)
	internal, err := lockIdentity(ctx, tx, who)
	if err != nil {
		return ContactPrivacy{}, err
	}
	if err = lockContactPrivacy(ctx, tx, []string{who.UserID}, false); err != nil {
		return ContactPrivacy{}, err
	}
	result, err := readContactPrivacy(ctx, tx, who, internal)
	if err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
func validatePrivacyRule(who Identity, rule *PrivacyRule) error {
	if rule == nil {
		return nil
	}
	if rule.Visibility != "everyone" && rule.Visibility != "contacts" && rule.Visibility != "nobody" {
		return ErrInvalid
	}
	if len(rule.Allow) > 100 || len(rule.Deny) > 100 {
		return ErrInvalid
	}
	seen := map[string]bool{}
	for _, list := range [][]string{rule.Allow, rule.Deny} {
		for _, id := range list {
			if !validID(id) || id == who.UserID || seen[id] {
				return ErrInvalid
			}
			seen[id] = true
		}
	}
	return nil
}
func (s *Service) UpdateContactPrivacy(ctx context.Context, who Identity, input PrivacyPatch) (ContactPrivacy, error) {
	if input.ExpectedVersion == nil || *input.ExpectedVersion < 0 || (input.TemporaryChat == nil && input.GroupInvites == nil && input.Phone == nil && input.PhoneSearch == nil && input.LastSeen == nil && input.VoiceCall == nil && input.VoiceCallPeerToPeer == nil && input.ShowActiveSessions == nil) {
		return ContactPrivacy{}, ErrInvalid
	}
	for _, rule := range []*PrivacyRule{input.TemporaryChat, input.GroupInvites, input.Phone, input.PhoneSearch, input.LastSeen, input.VoiceCall} {
		if err := validatePrivacyRule(who, rule); err != nil {
			return ContactPrivacy{}, err
		}
	}
	if input.PhoneSearch != nil && input.PhoneSearch.Visibility == "nobody" {
		return ContactPrivacy{}, ErrInvalid
	}
	if input.VoiceCallPeerToPeer != nil && *input.VoiceCallPeerToPeer != "everyone" && *input.VoiceCallPeerToPeer != "contacts" && *input.VoiceCallPeerToPeer != "nobody" {
		return ContactPrivacy{}, ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return ContactPrivacy{}, err
	}
	defer tx.Rollback(ctx)
	internal, err := lockIdentity(ctx, tx, who)
	if err != nil {
		return ContactPrivacy{}, err
	}
	if (input.GroupInvites != nil || input.Phone != nil || input.PhoneSearch != nil || input.LastSeen != nil || input.VoiceCall != nil || input.VoiceCallPeerToPeer != nil) && !internal {
		return ContactPrivacy{}, ErrForbidden
	}
	if err = lockContactPrivacy(ctx, tx, []string{who.UserID}, true); err != nil {
		return ContactPrivacy{}, err
	}
	current, err := readContactPrivacy(ctx, tx, who, internal)
	if err != nil {
		return current, err
	}
	if current.Version != *input.ExpectedVersion {
		return current, ErrConflict
	}
	temporary, invite := current.TemporaryChat.Visibility, current.GroupInvites.Visibility
	phone, lastSeen := current.Phone.Visibility, current.LastSeen.Visibility
	phoneSearch, voiceCall := current.PhoneSearch.Visibility, current.VoiceCall.Visibility
	voiceP2P, showSessions := current.VoiceCallPeerToPeer, current.ShowActiveSessions
	if input.Phone != nil {
		phone = input.Phone.Visibility
	}
	if input.LastSeen != nil {
		lastSeen = input.LastSeen.Visibility
	}
	if input.PhoneSearch != nil {
		phoneSearch = input.PhoneSearch.Visibility
	}
	if input.VoiceCall != nil {
		voiceCall = input.VoiceCall.Visibility
	}
	if input.VoiceCallPeerToPeer != nil {
		voiceP2P = *input.VoiceCallPeerToPeer
	}
	if input.ShowActiveSessions != nil {
		showSessions = *input.ShowActiveSessions
	}
	if input.TemporaryChat != nil {
		temporary = input.TemporaryChat.Visibility
	}
	if input.GroupInvites != nil {
		invite = input.GroupInvites.Visibility
	}
	if _, err = tx.Exec(ctx, `INSERT INTO pulse.privacy_settings(user_id,temporary_chat,group_invites,phone,last_seen,phone_search,voice_call,voice_call_peer_to_peer,show_active_sessions)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id) DO UPDATE SET temporary_chat=$2,group_invites=$3,phone=$4,last_seen=$5,phone_search=$6,voice_call=$7,voice_call_peer_to_peer=$8,show_active_sessions=$9,version=pulse.privacy_settings.version+1,updated_at=now()`, who.UserID, temporary, invite, phone, lastSeen, phoneSearch, voiceCall, voiceP2P, showSessions); err != nil {
		return current, err
	}
	for _, change := range []struct {
		scope string
		rule  *PrivacyRule
	}{{"temporary_chat", input.TemporaryChat}, {"group_invites", input.GroupInvites}, {"phone", input.Phone}, {"phone_search", input.PhoneSearch}, {"last_seen", input.LastSeen}, {"voice_call", input.VoiceCall}} {
		if change.rule == nil {
			continue
		}
		all := append(append([]string{}, change.rule.Allow...), change.rule.Deny...)
		var count int
		if err = tx.QueryRow(ctx, "SELECT count(*) FROM pulse.users WHERE id=ANY($1::uuid[])", all).Scan(&count); err != nil {
			return current, err
		}
		if count != len(all) {
			return current, ErrInvalid
		}
		if _, err = tx.Exec(ctx, "DELETE FROM pulse.privacy_exceptions WHERE user_id=$1 AND scope=$2", who.UserID, change.scope); err != nil {
			return current, err
		}
		for _, entry := range []struct {
			effect string
			ids    []string
		}{{"allow", change.rule.Allow}, {"deny", change.rule.Deny}} {
			if _, err = tx.Exec(ctx, `INSERT INTO pulse.privacy_exceptions(user_id,scope,peer_id,effect)
                SELECT $1,$2,id,$4 FROM unnest($3::uuid[]) AS id`, who.UserID, change.scope, entry.ids, entry.effect); err != nil {
				return current, err
			}
		}
	}
	if input.TemporaryChat != nil {
		// Invalidate existing input capabilities without disclosing the policy
		// or exception list to peers. Message authorization remains immediate.
		if _, err = tx.Exec(ctx, `INSERT INTO pulse.outbox(id,conversation_id,event_seq,kind)
            SELECT gen_random_uuid(),m.conversation_id,0,'membership.changed' FROM pulse.members m
            JOIN pulse.conversations c ON c.id=m.conversation_id AND c.kind='direct' AND c.active
            WHERE m.user_id=$1 AND m.active`, who.UserID); err != nil {
			return current, err
		}
	}
	result, err := readContactPrivacy(ctx, tx, who, internal)
	if err != nil {
		return result, err
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	s.notify()
	return result, nil
}
