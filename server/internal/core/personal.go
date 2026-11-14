package core

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Personal changes use a per-user sequence, so clearing or deleting one view
// never rewrites the shared conversation sequence or another member's history.
func personalChange(ctx context.Context, tx pgx.Tx, who Identity, cid, kind, mid string, boundary int64, reminder *bool) (State, error) {
	st := State{UserID: who.UserID}
	var err error
	if kind == "history.cleared" {
		err = tx.QueryRow(ctx, `UPDATE pulse.user_states SET clear_seq=GREATEST(clear_seq,$3),
			personal_seq=personal_seq+1,version=version+1,reminder=false
			WHERE conversation_id=$1 AND user_id=$2 AND clear_seq<$3
			RETURNING read_seq,delivered_seq,clear_seq,version,personal_seq,reminder`, cid, who.UserID, boundary).
			Scan(&st.ReadSeq, &st.DeliveredSeq, &st.ClearSeq, &st.Version, &st.PersonalSeq, &st.Reminder)
	} else if kind == "reminder.changed" {
		err = tx.QueryRow(ctx, `UPDATE pulse.user_states SET reminder=$3,personal_seq=personal_seq+1,version=version+1
			WHERE conversation_id=$1 AND user_id=$2 AND reminder<>$3
			RETURNING read_seq,delivered_seq,clear_seq,version,personal_seq,reminder`, cid, who.UserID, *reminder).
			Scan(&st.ReadSeq, &st.DeliveredSeq, &st.ClearSeq, &st.Version, &st.PersonalSeq, &st.Reminder)
	} else {
		err = tx.QueryRow(ctx, `UPDATE pulse.user_states SET personal_seq=personal_seq+1,version=version+1
			WHERE conversation_id=$1 AND user_id=$2
			RETURNING read_seq,delivered_seq,clear_seq,version,personal_seq,reminder`, cid, who.UserID).
			Scan(&st.ReadSeq, &st.DeliveredSeq, &st.ClearSeq, &st.Version, &st.PersonalSeq, &st.Reminder)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `SELECT read_seq,delivered_seq,clear_seq,version,personal_seq,reminder
			FROM pulse.user_states WHERE conversation_id=$1 AND user_id=$2`, cid, who.UserID).
			Scan(&st.ReadSeq, &st.DeliveredSeq, &st.ClearSeq, &st.Version, &st.PersonalSeq, &st.Reminder)
		return st, err
	}
	if err != nil {
		return st, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO pulse.personal_events
		(conversation_id,user_id,seq,kind,message_id,boundary_seq,reminder)
		VALUES($1,$2,$3,$4,NULLIF($5,'')::uuid,$6,$7)`,
		cid, who.UserID, st.PersonalSeq, kind, mid, optionalBoundary(kind, boundary), reminder); err != nil {
		return st, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO pulse.outbox(id,conversation_id,event_seq,kind,subject_id,state_version)
		VALUES($1,$2,0,'personal.changed',$3,$4)`, newID(), cid, who.UserID, st.PersonalSeq)
	return st, err
}

func optionalBoundary(kind string, boundary int64) any {
	if kind == "history.cleared" {
		return boundary
	}
	return nil
}

func (s *Service) ClearHistory(ctx context.Context, who Identity, cid string, through int64) (State, error) {
	st := State{UserID: who.UserID}
	if !validID(cid) || through < 0 {
		return st, ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return st, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return st, err
	}
	if err = lockDirectConversations(ctx, tx, []string{cid}); err != nil {
		return st, err
	}
	if err = lockConversations(ctx, tx, []string{cid}); err != nil {
		return st, err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return st, err
	}
	// The client retains this boundary on retries; a later message is never
	// included merely because the original response was lost.
	if through > a.MessageSeq {
		return st, ErrInvalid
	}
	before, err := lockReceiptState(ctx, tx, who, cid)
	if err != nil {
		return st, err
	}
	if err = excludeUnobserved(ctx, tx, who, cid, before, before.ClearSeq+1, through); err != nil {
		return st, err
	}
	st, err = personalChange(ctx, tx, who, cid, "history.cleared", "", through, nil)
	if err != nil {
		return st, err
	}
	if who.administrator != nil {
		if err = auditTx(ctx, tx, *who.administrator, "history.clear", "user", who.UserID, map[string]any{"conversation_id": cid, "through_seq": through}); err != nil {
			return st, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return st, err
	}
	s.notify()
	return st, nil
}

func (s *Service) DeletePersonalMessages(ctx context.Context, who Identity, cid string, ids []string) (State, error) {
	st := State{UserID: who.UserID}
	if len(ids) < 1 || len(ids) > 100 {
		return st, ErrInvalid
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if !validID(id) || seen[id] {
			return st, ErrInvalid
		}
		seen[id] = true
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return st, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return st, err
	}
	if err = lockDirectConversations(ctx, tx, []string{cid}); err != nil {
		return st, err
	}
	if err = lockConversations(ctx, tx, []string{cid}); err != nil {
		return st, err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return st, err
	}
	before, err := lockReceiptState(ctx, tx, who, cid)
	if err != nil {
		return st, err
	}
	for _, id := range ids {
		var seq int64
		var managerOnly bool
		err = tx.QueryRow(ctx, `SELECT seq,manager_only FROM pulse.messages WHERE id=$1 AND conversation_id=$2`, id, cid).Scan(&seq, &managerOnly)
		if errors.Is(err, pgx.ErrNoRows) {
			return st, ErrMissing
		}
		if err != nil {
			return st, err
		}
		if (managerOnly && !a.managesGroup()) || seq < a.VisibleFrom || seq <= a.ClearSeq {
			return st, ErrForbidden
		}
		command, err := tx.Exec(ctx, `INSERT INTO pulse.message_deletions(user_id,message_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, who.UserID, id)
		if err != nil {
			return st, err
		}
		if command.RowsAffected() == 0 {
			continue
		}
		if err = excludeUnobserved(ctx, tx, who, cid, before, seq, seq); err != nil {
			return st, err
		}
		st, err = personalChange(ctx, tx, who, cid, "message.deleted", id, 0, nil)
		if err != nil {
			return st, err
		}
	}
	if st.PersonalSeq == 0 {
		err = tx.QueryRow(ctx, `SELECT read_seq,delivered_seq,clear_seq,version,personal_seq,reminder
			FROM pulse.user_states WHERE conversation_id=$1 AND user_id=$2`, cid, who.UserID).
			Scan(&st.ReadSeq, &st.DeliveredSeq, &st.ClearSeq, &st.Version, &st.PersonalSeq, &st.Reminder)
		if err != nil {
			return st, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return st, err
	}
	s.notify()
	return st, nil
}

func (s *Service) SetReminder(ctx context.Context, who Identity, cid string, value bool) (State, error) {
	st := State{UserID: who.UserID}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return st, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return st, err
	}
	if _, err = authorize(ctx, tx, who, cid, false); err != nil {
		return st, err
	}
	st, err = personalChange(ctx, tx, who, cid, "reminder.changed", "", 0, &value)
	if err != nil {
		return st, err
	}
	if err = tx.Commit(ctx); err != nil {
		return st, err
	}
	s.notify()
	return st, nil
}

func (s *Service) PersonalSync(ctx context.Context, who Identity, cid string, after int64, upper *int64, limit int) (PersonalPage, error) {
	page := PersonalPage{Events: make([]PersonalEvent, 0), NextAfterSeq: after}
	if after < 0 || limit < 1 || limit > 100 {
		return page, ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return page, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return page, err
	}
	if _, err = authorize(ctx, tx, who, cid, false); err != nil {
		return page, err
	}
	var current int64
	if err = tx.QueryRow(ctx, `SELECT personal_seq FROM pulse.user_states WHERE conversation_id=$1 AND user_id=$2`, cid, who.UserID).Scan(&current); err != nil {
		return page, err
	}
	until := current
	if upper != nil {
		until = *upper
	}
	if until < after || until > current {
		return page, ErrInvalid
	}
	page.SnapshotMaxSeq = until
	rows, err := tx.Query(ctx, `SELECT seq,kind,COALESCE(message_id::text,''),COALESCE(boundary_seq,0),reminder
		FROM pulse.personal_events WHERE conversation_id=$1 AND user_id=$2 AND seq>$3 AND seq<=$4
		ORDER BY seq LIMIT $5`, cid, who.UserID, after, until, limit)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var ev PersonalEvent
		if err = rows.Scan(&ev.Seq, &ev.Kind, &ev.MessageID, &ev.BoundarySeq, &ev.Reminder); err != nil {
			return page, err
		}
		page.NextAfterSeq = ev.Seq
		page.Events = append(page.Events, ev)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	page.HasMore = page.NextAfterSeq < until
	rows.Close()
	return page, tx.Commit(ctx)
}

func (s *Service) Unread(ctx context.Context, who Identity, cid string, capCount int) (Unread, error) {
	result := Unread{}
	if capCount < 1 || capCount > 999 {
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
	var readSeq, legacyDeliveredSeq int64
	if err = tx.QueryRow(ctx, `SELECT read_seq,legacy_delivered_override_seq FROM pulse.user_states WHERE conversation_id=$1 AND user_id=$2`, cid, who.UserID).Scan(&readSeq, &legacyDeliveredSeq); err != nil {
		return result, err
	}
	rows, err := tx.Query(ctx, `SELECT 1 FROM pulse.messages msg
		WHERE msg.conversation_id=$1 AND msg.seq>GREATEST($3::bigint,$4::bigint)
		AND ((NOT msg.imported_legacy AND msg.seq>$2::bigint AND
		      NOT EXISTS(SELECT 1 FROM pulse.receipt_facts rf WHERE rf.message_id=msg.id AND rf.user_id=$5)) OR
		     (msg.imported_legacy AND msg.seq>$6::bigint AND
		      NOT EXISTS(SELECT 1 FROM pulse.receipt_facts rf WHERE rf.message_id=msg.id AND rf.user_id=$5)))
		AND msg.sender_id<>$5 AND NOT msg.revoked AND (NOT msg.manager_only OR $8)
		AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.message_id=msg.id AND d.user_id=$5)
		ORDER BY msg.seq LIMIT $7`, cid, readSeq, a.ClearSeq, a.VisibleFrom-1, who.UserID, legacyDeliveredSeq, capCount+1, a.managesGroup())
	if err != nil {
		return result, err
	}
	for rows.Next() {
		result.Count++
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return result, err
	}
	rows.Close()
	if result.Count > capCount {
		result.Count = capCount
		result.Truncated = true
	}
	return result, tx.Commit(ctx)
}
