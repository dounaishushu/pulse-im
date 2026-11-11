package core

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Sync(ctx context.Context, who Identity, cid string, after int64, upper *int64, limit int) (SyncPage, error) {
	return s.SyncMembership(ctx, who, cid, after, upper, limit, nil)
}
func (s *Service) SyncMembership(ctx context.Context, who Identity, cid string, after int64, upper *int64, limit int, expectedMembership *int64) (SyncPage, error) {
	result := SyncPage{Events: make([]SyncEvent, 0), NextAfterSeq: after}
	if after < 0 || limit < 1 || limit > 100 {
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
	if expectedMembership != nil && *expectedMembership != a.MembershipVersion {
		return result, &Fault{409, "membership_changed"}
	}
	result.HistoryScope = scopeOf(a)
	until := a.EventSeq
	if upper != nil {
		until = *upper
	}
	if until < after || until > a.EventSeq {
		return result, ErrInvalid
	}
	result.SnapshotMaxSeq = until
	// Scan a bounded raw event page, even when all its records are invisible.
	// Advancing over filtered events avoids an endless empty-page loop.
	rows, err := tx.Query(ctx, `SELECT e.seq,e.kind,m.id::text,m.conversation_id::text,m.seq,m.event_seq,
        m.sender_id::text,m.request_id,CASE WHEN m.revoked THEN '' ELSE m.body END,m.revoked,m.version,m.created_at,m.updated_at,
		e.seq >= $5 AND m.seq >= $6 AND m.seq > $7 AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.message_id=m.id AND d.user_id=$8)
        FROM (SELECT * FROM pulse.events WHERE conversation_id=$1 AND seq>$2 AND seq<=$3 ORDER BY seq LIMIT $4) e
		JOIN pulse.messages m ON m.id=e.message_id ORDER BY e.seq`, cid, after, until, limit, a.VisibleFromEvent, a.VisibleFrom, a.ClearSeq, who.UserID)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var event SyncEvent
		var visible bool
		m := &event.Message
		err = rows.Scan(&event.Seq, &event.Kind, &m.ID, &m.ConversationID, &m.Seq, &m.EventSeq, &m.SenderID, &m.RequestID,
			&m.Body, &m.Revoked, &m.Version, &m.CreatedAt, &m.UpdatedAt, &visible)
		if err != nil {
			rows.Close()
			return result, err
		}
		m.CreatedAt = m.CreatedAt.UTC()
		m.UpdatedAt = m.UpdatedAt.UTC()
		result.NextAfterSeq = event.Seq
		if visible {
			result.Events = append(result.Events, event)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	result.HasMore = result.NextAfterSeq < until
	return result, tx.Commit(ctx)
}
func (s *Service) Advance(ctx context.Context, who Identity, cid string, seq int64, read bool) (State, error) {
	state := State{UserID: who.UserID}
	if seq < 0 {
		return state, ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return state, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return state, err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return state, err
	}
	if seq > a.MessageSeq {
		return state, ErrInvalid
	}
	if seq > 0 && seq < a.VisibleFrom {
		return state, ErrForbidden
	}
	readSeq := int64(0)
	if read {
		readSeq = seq
	}
	// Only this member's state row is written. Receipts don't increment or lock
	// the conversation event sequence used by message writers.
	err = tx.QueryRow(ctx, `UPDATE pulse.user_states SET
        read_seq=GREATEST(read_seq,$3),delivered_seq=GREATEST(delivered_seq,$4),version=version+1
        WHERE conversation_id=$1 AND user_id=$2 AND (read_seq<$3 OR delivered_seq<$4)
		RETURNING read_seq,delivered_seq,clear_seq,version,personal_seq,reminder`, cid, who.UserID, readSeq, seq).
		Scan(&state.ReadSeq, &state.DeliveredSeq, &state.ClearSeq, &state.Version, &state.PersonalSeq, &state.Reminder)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, "SELECT read_seq,delivered_seq,clear_seq,version,personal_seq,reminder FROM pulse.user_states WHERE conversation_id=$1 AND user_id=$2", cid, who.UserID).
			Scan(&state.ReadSeq, &state.DeliveredSeq, &state.ClearSeq, &state.Version, &state.PersonalSeq, &state.Reminder)
		if err != nil {
			return state, err
		}
		return state, tx.Commit(ctx)
	}
	if err != nil {
		return state, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO pulse.outbox(id,conversation_id,event_seq,kind,subject_id,state_version)
        VALUES($1,$2,0,'state.changed',$3,$4)`, newID(), cid, who.UserID, state.Version); err != nil {
		return state, err
	}
	if err = tx.Commit(ctx); err != nil {
		return state, err
	}
	s.notify()
	return state, nil
}

// States only exposes the caller's private cursors for multi-device recovery.
// Other members' individual watermarks are never part of the public contract.
func (s *Service) States(ctx context.Context, who Identity, cid, after string) ([]State, error) {
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return nil, err
	}
	if _, err = authorize(ctx, tx, who, cid, false); err != nil {
		return nil, err
	}
	st := State{UserID: who.UserID}
	err = tx.QueryRow(ctx, "SELECT read_seq,delivered_seq,clear_seq,version,personal_seq,reminder FROM pulse.user_states WHERE conversation_id=$1 AND user_id=$2", cid, who.UserID).
		Scan(&st.ReadSeq, &st.DeliveredSeq, &st.ClearSeq, &st.Version, &st.PersonalSeq, &st.Reminder)
	if err != nil {
		return nil, err
	}
	return []State{st}, tx.Commit(ctx)
}

type ReceiptSummary struct {
	MessageID      string `json:"message_id"`
	RecipientCount int64  `json:"recipient_count"`
	DeliveredCount int64  `json:"delivered_count"`
	ReadCount      int64  `json:"read_count"`
}

func (s *Service) Receipts(ctx context.Context, who Identity, cid, mid string) (ReceiptSummary, error) {
	result := ReceiptSummary{MessageID: mid}
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
	if a.Kind == "channel" {
		return result, ErrForbidden
	}
	var seq int64
	err = tx.QueryRow(ctx, `SELECT seq FROM pulse.messages msg WHERE id=$1 AND conversation_id=$2 AND sender_id=$3 AND NOT revoked
        AND seq >= $4 AND seq > $5 AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.message_id=msg.id AND d.user_id=$3)`,
		mid, cid, who.UserID, a.VisibleFrom, a.ClearSeq).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, ErrForbidden
	}
	if err != nil {
		return result, err
	}
	err = tx.QueryRow(ctx, `SELECT count(*),
		count(*) FILTER(WHERE st.delivered_seq >= $3 AND COALESCE((
			SELECT e.last_seq < $3 FROM pulse.receipt_exclusions e
			WHERE e.conversation_id=m.conversation_id AND e.user_id=m.user_id AND e.kind='delivered' AND e.first_seq<=$3
			ORDER BY e.first_seq DESC LIMIT 1),true)),
		count(*) FILTER(WHERE st.read_seq >= $3 AND COALESCE((
			SELECT e.last_seq < $3 FROM pulse.receipt_exclusions e
			WHERE e.conversation_id=m.conversation_id AND e.user_id=m.user_id AND e.kind='read' AND e.first_seq<=$3
			ORDER BY e.first_seq DESC LIMIT 1),true))
        FROM pulse.members m JOIN pulse.user_states st USING(conversation_id,user_id)
        WHERE m.conversation_id=$1 AND m.user_id<>$2 AND m.active AND m.visible_from_seq<=$3`, cid, who.UserID, seq).
		Scan(&result.RecipientCount, &result.DeliveredCount, &result.ReadCount)
	if err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
