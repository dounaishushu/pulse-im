package core

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Pair rows serialize friend/block mutations and direct sends even when a
// friendship or block row does not yet exist. All callers lock these before
// the direct conversation row; membership mutations lock their conversation.
func lockPair(ctx context.Context, tx pgx.Tx, one, two string) error {
	_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1147))", directKey(one, two))
	return err
}

// Group joins read all manager/block relations while holding this participant's
// shared gate. Block writes take both participant gates exclusively, in ID order,
// before any pair/conversation locks. No global admission lock is required.
func lockBlockParticipants(ctx context.Context, tx pgx.Tx, ids []string, shared bool) error {
	ids = append([]string(nil), ids...)
	sort.Strings(ids)
	statement := "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1148))"
	if shared {
		statement = "SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 1148))"
	}
	for i, id := range ids {
		if i > 0 && id == ids[i-1] {
			continue
		}
		if _, err := tx.Exec(ctx, statement, id); err != nil {
			return err
		}
	}
	return nil
}

func directKey(one, two string) string {
	ids := []string{one, two}
	sort.Strings(ids)
	return ids[0] + ":" + ids[1]
}
func lockDirectConversations(ctx context.Context, tx pgx.Tx, ids []string) error {
	rows, err := tx.Query(ctx, `SELECT direct_key FROM pulse.conversations WHERE id=ANY($1::uuid[])
		AND kind='direct' ORDER BY direct_key`, ids)
	if err != nil {
		return err
	}
	keys := make([]string, 0)
	for rows.Next() {
		var key string
		if err = rows.Scan(&key); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, key)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	participants := make([]string, 0, len(keys)*2)
	for _, key := range keys {
		participants = append(participants, strings.Split(key, ":")...)
	}
	if err = lockContactPrivacy(ctx, tx, participants, false); err != nil {
		return err
	}
	for i, key := range keys {
		if i > 0 && key == keys[i-1] {
			continue
		}
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1147))", key); err != nil {
			return err
		}
	}
	return nil
}
func existingDirect(ctx context.Context, tx pgx.Tx, one, two string) (string, error) {
	var id string
	err := tx.QueryRow(ctx, "SELECT id::text FROM pulse.conversations WHERE direct_key=$1", directKey(one, two)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}
func ensureDirectTx(ctx context.Context, tx pgx.Tx, one, two string) (string, error) {
	ids := []string{one, two}
	sort.Strings(ids)
	if existing, err := existingDirect(ctx, tx, one, two); err != nil {
		return "", err
	} else if existing != "" {
		var active bool
		if err = tx.QueryRow(ctx, "SELECT active FROM pulse.conversations WHERE id=$1", existing).Scan(&active); err != nil {
			return "", err
		}
		if !active {
			return "", ErrForbidden
		}
		return existing, nil
	}
	id := newID()
	err := tx.QueryRow(ctx, `INSERT INTO pulse.conversations(id,kind,direct_key) VALUES($1,'direct',$2) RETURNING id::text`, id, directKey(one, two)).Scan(&id)
	if err != nil {
		return "", err
	}
	for _, uid := range ids {
		var messageSeq, eventSeq int64
		if err = tx.QueryRow(ctx, "SELECT message_seq,event_seq FROM pulse.conversations WHERE id=$1", id).Scan(&messageSeq, &eventSeq); err != nil {
			return "", err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO pulse.members(conversation_id,user_id,visible_from_seq,visible_from_event_seq,history_allowed)
			VALUES($1,$2,$3,$4,true) ON CONFLICT(conversation_id,user_id) DO UPDATE SET active=true,
			visible_from_seq=CASE WHEN pulse.members.active THEN pulse.members.visible_from_seq ELSE EXCLUDED.visible_from_seq END,
			visible_from_event_seq=CASE WHEN pulse.members.active THEN pulse.members.visible_from_event_seq ELSE EXCLUDED.visible_from_event_seq END`,
			id, uid, messageSeq+1, eventSeq+1); err != nil {
			return "", err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO pulse.user_states(conversation_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", id, uid); err != nil {
			return "", err
		}
	}
	return id, nil
}

func checkPair(ctx context.Context, tx pgx.Tx, one, two string, requireFriend bool) error {
	var valid, blocked, friends bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pulse.users WHERE id=$1 AND active),
		EXISTS(SELECT 1 FROM pulse.blocks WHERE (user_id=$1 AND peer_id=$2) OR (user_id=$2 AND peer_id=$1)),
		EXISTS(SELECT 1 FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid)
			AND user_high=GREATEST($1::uuid,$2::uuid))`, two, one).Scan(&valid, &blocked, &friends)
	if err != nil {
		return err
	}
	if !valid || blocked || (requireFriend && !friends) {
		return ErrForbidden
	}
	return nil
}

func (s *Service) FriendRequest(ctx context.Context, who Identity, target, note string) (string, error) {
	return s.FriendRequestInContext(ctx, who, target, note, "")
}

func (s *Service) FriendRequestInContext(ctx context.Context, who Identity, target, note, groupID string) (string, error) {
	return s.friendRequestWithSource(ctx, who, target, note, groupID, "", "")
}
func (s *Service) friendRequestWithSource(ctx context.Context, who Identity, target, note, groupID, cardCID, cardID string) (string, error) {
	if groupID != "" && !validID(groupID) {
		return "", ErrInvalid
	}
	if !validID(target) || target == who.UserID || !validText(note, 0, 300) {
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
	var canAdd bool
	if err = tx.QueryRow(ctx, "SELECT can_add_friends FROM pulse.users WHERE id=$1", who.UserID).Scan(&canAdd); err != nil {
		return "", err
	}
	if !canAdd {
		return "", ErrForbidden
	}
	if err = lockPair(ctx, tx, who.UserID, target); err != nil {
		return "", err
	}
	if err = checkPair(ctx, tx, who.UserID, target, false); err != nil {
		return "", err
	}
	if cardCID != "" {
		ids := []string{cardCID}
		direct, e := existingDirect(ctx, tx, who.UserID, target)
		if e != nil {
			return "", e
		}
		if direct != "" {
			ids = append(ids, direct)
		}
		if e = lockConversations(ctx, tx, ids); e != nil {
			return "", e
		}
		card, e := visibleMessage(ctx, tx, who, cardCID, cardID)
		if e != nil {
			return "", e
		}
		var content MessageContent
		if card.Kind != "contact" || json.Unmarshal(card.Content, &content) != nil || content.Contact == nil || content.Contact.ID != target {
			return "", ErrForbidden
		}
		var blocked bool
		if e = tx.QueryRow(ctx, "SELECT block_member_friend_requests FROM pulse.conversations WHERE id=$1", cardCID).Scan(&blocked); e != nil {
			return "", e
		}
		if blocked {
			return "", ErrForbidden
		}
	}
	if groupID != "" {
		ids := []string{groupID}
		direct, err := existingDirect(ctx, tx, who.UserID, target)
		if err != nil {
			return "", err
		}
		if direct != "" {
			ids = append(ids, direct)
		}
		// Mutual requests can also reopen a direct conversation. Acquire both
		// in the same order as forwarding before reading source-group policy.
		if err = lockConversations(ctx, tx, ids); err != nil {
			return "", err
		}
		var allowed bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pulse.conversations c
			JOIN pulse.members actor ON actor.conversation_id=c.id AND actor.user_id=$2 AND actor.active
			JOIN pulse.members target ON target.conversation_id=c.id AND target.user_id=$3 AND target.active
			WHERE c.id=$1 AND c.kind='group' AND c.active AND NOT c.block_member_friend_requests)`,
			groupID, who.UserID, target).Scan(&allowed)
		if err != nil {
			return "", err
		}
		if !allowed {
			return "", ErrForbidden
		}
	}
	var allowed bool
	if err = tx.QueryRow(ctx, "SELECT allow_friend_requests FROM pulse.users WHERE id=$1 AND active", target).Scan(&allowed); err != nil {
		return "", err
	}
	if !allowed {
		return "", ErrForbidden
	}
	var friend bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid)
		AND user_high=GREATEST($1::uuid,$2::uuid))`, who.UserID, target).Scan(&friend); err != nil {
		return "", err
	}
	if friend {
		return "", ErrConflict
	}
	var reverse string
	err = tx.QueryRow(ctx, `SELECT id::text FROM pulse.friend_requests
		WHERE requester_id=$1 AND target_id=$2 AND status='pending'`, target, who.UserID).Scan(&reverse)
	if err == nil {
		if _, err = befriendTx(ctx, tx, who.UserID, target); err != nil {
			return "", err
		}
		if err = tx.Commit(ctx); err != nil {
			return "", err
		}
		s.notify()
		return reverse, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	id := newID()
	err = tx.QueryRow(ctx, `INSERT INTO pulse.friend_requests(id,requester_id,target_id,note)
		VALUES($1,$2,$3,$4) ON CONFLICT(requester_id,target_id) WHERE status='pending'
		DO UPDATE SET note=EXCLUDED.note RETURNING id::text`, id, who.UserID, target, note).Scan(&id)
	if err != nil {
		return "", err
	}
	return id, tx.Commit(ctx)
}

func (s *Service) friendRequestReceipt(ctx context.Context, who Identity, id string) (map[string]string, error) {
	var status, conversation string
	err := s.Store.Pool.QueryRow(ctx, `SELECT r.status,COALESCE((SELECT c.id::text FROM pulse.conversations c WHERE c.direct_key=LEAST(r.requester_id,r.target_id)::text||':'||GREATEST(r.requester_id,r.target_id)::text AND c.active AND r.status='accepted'),'')
		FROM pulse.friend_requests r WHERE r.id=$1 AND $2 IN(r.requester_id,r.target_id)`, id, who.UserID).Scan(&status, &conversation)
	if err != nil {
		return nil, err
	}
	result := map[string]string{"id": id, "status": status}
	if conversation != "" {
		result["conversation_id"] = conversation
	}
	return result, nil
}

// befriendTx requires the caller to hold the pair lock and validate consent.
func befriendTx(ctx context.Context, tx pgx.Tx, one, two string) (string, error) {
	id, err := existingDirect(ctx, tx, one, two)
	if err != nil {
		return "", err
	}
	if id != "" {
		if err = lockConversations(ctx, tx, []string{id}); err != nil {
			return "", err
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO pulse.friendships(user_low,user_high)
		VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid)) ON CONFLICT DO NOTHING`, one, two); err != nil {
		return "", err
	}
	id, err = ensureDirectTx(ctx, tx, one, two)
	if err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, `UPDATE pulse.friend_requests SET status='accepted',decided_at=now()
		WHERE status='pending' AND ((requester_id=$1 AND target_id=$2) OR (requester_id=$2 AND target_id=$1))`, one, two); err != nil {
		return "", err
	}
	if err = membershipHint(ctx, tx, id, ""); err != nil {
		return "", err
	}
	return id, nil
}

func (s *Service) AddFriendAsStaff(ctx context.Context, who Identity, target string) (string, error) {
	if !validID(target) || target == who.UserID {
		return "", ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	internal, err := lockIdentity(ctx, tx, who)
	if err != nil {
		return "", err
	}
	if !internal {
		return "", ErrForbidden
	}
	if err = lockPair(ctx, tx, who.UserID, target); err != nil {
		return "", err
	}
	if err = checkPair(ctx, tx, who.UserID, target, false); err != nil {
		return "", err
	}
	id, err := befriendTx(ctx, tx, who.UserID, target)
	if err != nil {
		return "", err
	}
	if err = notifyUserTx(ctx, tx, target, "friend.added", who.UserID, who.UserID); err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	s.notify()
	return id, nil
}

func (s *Service) DecideFriendRequest(ctx context.Context, who Identity, id string, accept bool) (string, error) {
	if !validID(id) {
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
	var requester, target string
	var status string
	err = tx.QueryRow(ctx, "SELECT requester_id::text,target_id::text,status FROM pulse.friend_requests WHERE id=$1", id).Scan(&requester, &target, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrMissing
	}
	if err != nil {
		return "", err
	}
	if target != who.UserID {
		return "", ErrForbidden
	}
	if err = lockPair(ctx, tx, requester, target); err != nil {
		return "", err
	}
	var lockedRequester, lockedTarget string
	if err = tx.QueryRow(ctx, `SELECT requester_id::text,target_id::text,status
		FROM pulse.friend_requests WHERE id=$1 FOR UPDATE`, id).Scan(&lockedRequester, &lockedTarget, &status); err != nil {
		return "", err
	}
	if lockedRequester != requester || lockedTarget != target {
		return "", ErrConflict
	}
	if status != "pending" {
		wanted := "rejected"
		if accept {
			wanted = "accepted"
		}
		if status != wanted {
			return "", ErrConflict
		}
		direct := ""
		if accept {
			direct, err = existingDirect(ctx, tx, requester, target)
			if err != nil {
				return "", err
			}
		}
		return direct, tx.Commit(ctx)
	}
	decision := "rejected"
	direct := ""
	if accept {
		if err = checkPair(ctx, tx, target, requester, false); err != nil {
			return "", err
		}
		decision = "accepted"
		direct, err = befriendTx(ctx, tx, requester, target)
		if err != nil {
			return "", err
		}
	}
	if _, err = tx.Exec(ctx, "UPDATE pulse.friend_requests SET status=$2,decided_at=now() WHERE id=$1", id, decision); err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	if accept {
		s.notify()
	}
	return direct, nil
}

type PublicUser struct {
	ID      string `json:"id"`
	Account string `json:"account"`
}

func (s *Service) LookupAccount(ctx context.Context, who Identity, account string) (PublicUser, error) {
	result := PublicUser{}
	account = normalizeAccount(account)
	if !validText(account, 3, 64) || len(account) > 64 {
		return result, ErrInvalid
	}
	err := s.Store.Pool.QueryRow(ctx, `SELECT id::text,account FROM pulse.users WHERE account=$1 AND NOT account_is_internal AND active
		AND NOT EXISTS(SELECT 1 FROM pulse.blocks b WHERE
			(b.user_id=$2 AND b.peer_id=pulse.users.id) OR (b.user_id=pulse.users.id AND b.peer_id=$2))`, account, who.UserID).
		Scan(&result.ID, &result.Account)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, ErrMissing
	}
	return result, err
}

type FriendRequestView struct {
	ID          string     `json:"id"`
	RequesterID string     `json:"requester_id"`
	TargetID    string     `json:"target_id"`
	Note        string     `json:"note"`
	Status      string     `json:"status"`
	CreatedAt   time.Time  `json:"created_at"`
	DecidedAt   *time.Time `json:"decided_at,omitempty"`
}

func (s *Service) FriendRequests(ctx context.Context, who Identity, direction, after string) ([]FriendRequestView, error) {
	if direction != "incoming" && direction != "outgoing" {
		return nil, ErrInvalid
	}
	if after == "" {
		after = "00000000-0000-0000-0000-000000000000"
	} else if !validID(after) {
		return nil, ErrInvalid
	}
	column := "target_id"
	if direction == "outgoing" {
		column = "requester_id"
	}
	rows, err := s.Store.Pool.Query(ctx, `SELECT id::text,requester_id::text,target_id::text,note,status,created_at,decided_at
		FROM pulse.friend_requests WHERE `+column+`=$1 AND id>$2 ORDER BY id LIMIT 100`, who.UserID, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := make([]FriendRequestView, 0)
	for rows.Next() {
		var item FriendRequestView
		if err = rows.Scan(&item.ID, &item.RequesterID, &item.TargetID, &item.Note, &item.Status, &item.CreatedAt, &item.DecidedAt); err != nil {
			return nil, err
		}
		list = append(list, item)
	}
	return list, rows.Err()
}

func (s *Service) Block(ctx context.Context, who Identity, peer string, blocked bool) error {
	return s.BlockWithReason(ctx, who, peer, blocked, "")
}

func (s *Service) BlockWithReason(ctx context.Context, who Identity, peer string, blocked bool, reason string) error {
	if !validID(peer) || peer == who.UserID {
		return ErrInvalid
	}
	if !validText(reason, 0, 255) {
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
	if err = lockBlockParticipants(ctx, tx, []string{who.UserID, peer}, false); err != nil {
		return err
	}
	if err = lockPair(ctx, tx, who.UserID, peer); err != nil {
		return err
	}
	id, err := existingDirect(ctx, tx, who.UserID, peer)
	if err != nil {
		return err
	}
	if id != "" {
		if err = lockConversations(ctx, tx, []string{id}); err != nil {
			return err
		}
	}
	changed := false
	if blocked {
		var valid bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pulse.users WHERE id=$1 AND active)", peer).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return ErrMissing
		}
		command, e := tx.Exec(ctx, `INSERT INTO pulse.blocks(user_id,peer_id,reason,created_at) VALUES($1,$2,NULLIF($3,''),now())
			ON CONFLICT(user_id,peer_id) DO UPDATE SET reason=EXCLUDED.reason WHERE $3<>'' AND COALESCE(pulse.blocks.reason,'')<>COALESCE(EXCLUDED.reason,'')`, who.UserID, peer, reason)
		err = e
		changed = command.RowsAffected() > 0
	} else {
		command, e := tx.Exec(ctx, "DELETE FROM pulse.blocks WHERE user_id=$1 AND peer_id=$2", who.UserID, peer)
		err = e
		changed = command.RowsAffected() > 0
	}
	if err != nil {
		return err
	}
	if id != "" && changed {
		if err = membershipHint(ctx, tx, id, ""); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if id != "" && changed {
		s.notify()
	}
	return nil
}

func (s *Service) RemoveFriend(ctx context.Context, who Identity, peer string) error {
	if !validID(peer) || peer == who.UserID {
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
	if err = lockPair(ctx, tx, who.UserID, peer); err != nil {
		return err
	}
	id, err := existingDirect(ctx, tx, who.UserID, peer)
	if err != nil {
		return err
	}
	if id != "" {
		if err = lockConversations(ctx, tx, []string{id}); err != nil {
			return err
		}
	}
	command, err := tx.Exec(ctx, `DELETE FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid)
		AND user_high=GREATEST($1::uuid,$2::uuid)`, who.UserID, peer)
	if err != nil {
		return err
	}
	if id != "" && command.RowsAffected() > 0 {
		if err = membershipHint(ctx, tx, id, ""); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if id != "" && command.RowsAffected() > 0 {
		s.notify()
	}
	return nil
}

func (s *Service) Friends(ctx context.Context, who Identity, after string) ([]string, error) {
	if after == "" {
		after = "00000000-0000-0000-0000-000000000000"
	}
	rows, err := s.Store.Pool.Query(ctx, `SELECT peer.id::text FROM pulse.friendships f
		JOIN pulse.users peer ON peer.id=CASE WHEN f.user_low=$1 THEN f.user_high ELSE f.user_low END AND peer.active
		WHERE (f.user_low=$1 OR f.user_high=$1) AND peer.id>$2 ORDER BY peer.id LIMIT 100`, who.UserID, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := make([]string, 0)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		list = append(list, id)
	}
	return list, rows.Err()
}

func (s *Service) Blocks(ctx context.Context, who Identity, after string) ([]string, error) {
	if after == "" {
		after = "00000000-0000-0000-0000-000000000000"
	} else if !validID(after) {
		return nil, ErrInvalid
	}
	rows, err := s.Store.Pool.Query(ctx, `SELECT peer_id::text FROM pulse.blocks WHERE user_id=$1 AND peer_id>$2
		ORDER BY peer_id LIMIT 100`, who.UserID, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]string, 0)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		items = append(items, id)
	}
	return items, rows.Err()
}

func (s *Service) IncomingFriendRequests(ctx context.Context, who Identity) ([]string, error) {
	rows, err := s.Store.Pool.Query(ctx, `SELECT id::text FROM pulse.friend_requests WHERE target_id=$1 AND status='pending'
		ORDER BY created_at DESC,id DESC LIMIT 100`, who.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := make([]string, 0)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		list = append(list, id)
	}
	return list, rows.Err()
}

func normalizeAccount(account string) string { return strings.ToLower(strings.TrimSpace(account)) }
