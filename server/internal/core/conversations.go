package core

import (
	"context"
	"errors"
	"sort"

	"github.com/jackc/pgx/v5"
)

type access struct {
	Kind, Role                                                    string
	MessageSeq, EventSeq, VisibleFrom, VisibleFromEvent, ClearSeq int64
	Muted, MuteAll, CanSend                                       bool
	MembershipVersion                                             int64
	HistoryAllowed                                                bool
}
type ConversationAccess struct {
	ConversationID string `json:"conversation_id"`
	Kind           string `json:"kind"`
	Role           string `json:"role"`
	CanSend        bool   `json:"can_send"`
	Reason         string `json:"reason,omitempty"`
	HistoryScope
}

func (s *Service) ConversationAccess(ctx context.Context, who Identity, cid string) (ConversationAccess, error) {
	result := ConversationAccess{ConversationID: cid}
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
	result.Kind, result.Role, result.CanSend = a.Kind, a.Role, true
	result.HistoryScope = scopeOf(a)
	switch {
	case !a.CanSend:
		result.CanSend = false
		result.Reason = "account_mute"
	case a.Muted:
		result.CanSend = false
		result.Reason = "member_mute"
	case a.MuteAll && a.Role == "member":
		result.CanSend = false
		result.Reason = "group_mute_all"
	case a.Kind == "channel" && a.Role == "member":
		result.CanSend = false
		result.Reason = "channel_read_only"
	case a.Kind == "direct":
		_, err = authorize(ctx, tx, who, cid, true)
		if errors.Is(err, ErrForbidden) {
			result.CanSend = false
			result.Reason = "peer_unavailable"
			err = nil
		}
		if err != nil {
			return result, err
		}
	}
	return result, tx.Commit(ctx)
}

func authorize(ctx context.Context, tx pgx.Tx, who Identity, cid string, write bool) (access, error) {
	var a access
	err := tx.QueryRow(ctx, `SELECT c.kind,m.role,c.message_seq,c.event_seq,m.visible_from_seq,m.visible_from_event_seq,
        st.clear_seq,m.muted,c.mute_all,u.can_send,m.membership_version,m.history_allowed
        FROM pulse.conversations c JOIN pulse.members m ON m.conversation_id=c.id
        JOIN pulse.users u ON u.id=m.user_id
        JOIN pulse.user_states st ON st.conversation_id=c.id AND st.user_id=m.user_id
        WHERE c.id=$1 AND m.user_id=$2 AND c.active AND m.active AND u.active
		FOR SHARE OF m`, cid, who.UserID).Scan(&a.Kind, &a.Role, &a.MessageSeq, &a.EventSeq, &a.VisibleFrom, &a.VisibleFromEvent, &a.ClearSeq, &a.Muted, &a.MuteAll, &a.CanSend, &a.MembershipVersion, &a.HistoryAllowed)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, ErrForbidden
	}
	if err != nil {
		return a, err
	}
	if !write {
		return a, nil
	}
	if !a.CanSend || a.Muted || (a.MuteAll && a.Role == "member") || (a.Kind == "channel" && a.Role == "member") {
		return a, ErrForbidden
	}
	if a.Kind == "direct" {
		var peer string
		err = tx.QueryRow(ctx, `SELECT user_id::text FROM pulse.members WHERE conversation_id=$1 AND user_id<>$2 AND active`, cid, who.UserID).Scan(&peer)
		if errors.Is(err, pgx.ErrNoRows) {
			return a, ErrForbidden
		}
		if err != nil {
			return a, err
		}
		if err = contactAllowed(ctx, tx, who.UserID, peer, "temporary_chat"); err != nil {
			return a, err
		}
	}
	return a, nil
}

func lockConversations(ctx context.Context, tx pgx.Tx, ids []string) error {
	unique := make([]string, 0, len(ids))
	for _, id := range ids {
		if !validID(id) {
			return ErrInvalid
		}
		unique = append(unique, id)
	}
	sort.Strings(unique)
	for i, id := range unique {
		if i > 0 && id == unique[i-1] {
			continue
		}
		var found string
		err := tx.QueryRow(ctx, "SELECT id::text FROM pulse.conversations WHERE id=$1 FOR UPDATE", id).Scan(&found)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
	}
	return nil
}
func (s *Service) Direct(ctx context.Context, who Identity, peerID string) (string, error) {
	if !validID(peerID) || peerID == who.UserID {
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
	if err = lockContactPrivacy(ctx, tx, []string{who.UserID, peerID}, false); err != nil {
		return "", err
	}
	if err = lockPair(ctx, tx, who.UserID, peerID); err != nil {
		return "", err
	}
	id, err := existingDirect(ctx, tx, who.UserID, peerID)
	if err != nil {
		return "", err
	}
	created := id == ""
	if id != "" {
		if err = lockConversations(ctx, tx, []string{id}); err != nil {
			return "", err
		}
	}
	if err = contactAllowed(ctx, tx, who.UserID, peerID, "temporary_chat"); err != nil {
		return "", err
	}
	id, err = ensureDirectTx(ctx, tx, who.UserID, peerID)
	if err != nil {
		return "", err
	}
	if created {
		if err = membershipHint(ctx, tx, id, ""); err != nil {
			return "", err
		}
	}
	if _, err = authorize(ctx, tx, who, id, false); err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	if created {
		s.notify()
	}
	return id, nil
}
func (s *Service) Conversations(ctx context.Context, who Identity, after string) ([]Conversation, error) {
	// IDs are UUID strings. Stable ID pagination is intentional; the client
	// can sort the retrieved conversation metadata for its own presentation.
	if after == "" {
		after = "00000000-0000-0000-0000-000000000000"
	}
	rows, err := s.Store.Pool.Query(ctx, `SELECT c.id::text,c.kind,c.title,c.message_seq,c.event_seq,
		st.user_id::text,st.read_seq,st.delivered_seq,st.clear_seq,st.version,st.personal_seq,st.reminder,
		m.visible_from_seq,m.visible_from_event_seq,m.membership_version,m.history_allowed,
		(c.kind='direct' AND NOT EXISTS(SELECT 1 FROM pulse.friendships f WHERE f.user_low=split_part(c.direct_key,':',1)::uuid AND f.user_high=split_part(c.direct_key,':',2)::uuid))
        FROM pulse.members m JOIN pulse.conversations c ON c.id=m.conversation_id
        JOIN pulse.user_states st ON st.conversation_id=c.id AND st.user_id=m.user_id
        WHERE m.user_id=$1 AND m.active AND c.active AND c.id>$2 ORDER BY c.id LIMIT 100`, who.UserID, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Conversation, 0)
	for rows.Next() {
		var c Conversation
		if err = rows.Scan(&c.ID, &c.Kind, &c.Title, &c.MessageSeq, &c.EventSeq, &c.State.UserID, &c.State.ReadSeq, &c.State.DeliveredSeq, &c.State.ClearSeq, &c.State.Version, &c.State.PersonalSeq, &c.State.Reminder, &c.VisibleFromSeq, &c.VisibleFromEventSeq, &c.MembershipVersion, &c.HistoryAllowed, &c.Temporary); err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}
