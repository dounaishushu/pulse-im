package core

import (
	"context"
	"log/slog"
	"time"
)

type Delivery struct {
	ID, Lease string
	Hint      Hint
}

func (s *Store) Claim(ctx context.Context, limit int) ([]Delivery, error) {
	if limit < 1 || limit > 128 {
		return nil, ErrInvalid
	}
	lease := newID()
	rows, err := s.Pool.Query(ctx, `UPDATE pulse.outbox b SET lease_token=$1,lease_until=now()+interval '15 seconds',attempts=b.attempts+1
        WHERE b.id IN (SELECT id FROM pulse.outbox WHERE available_at<=now() AND
            (lease_until IS NULL OR lease_until<now()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT $2)
        RETURNING b.id::text,b.conversation_id::text,b.kind,b.event_seq,COALESCE(b.subject_id::text,''),b.state_version`, lease, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Delivery, 0)
	for rows.Next() {
		d := Delivery{Lease: lease}
		if err = rows.Scan(&d.ID, &d.Hint.ConversationID, &d.Hint.Type, &d.Hint.EventSeq, &d.Hint.UserID, &d.Hint.StateVersion); err != nil {
			return nil, err
		}
		result = append(result, d)
	}
	return result, rows.Err()
}
func (s *Store) Finish(ctx context.Context, d Delivery) error {
	_, err := s.Pool.Exec(ctx, "DELETE FROM pulse.outbox WHERE id=$1 AND lease_token=$2", d.ID, d.Lease)
	return err
}
func (s *Store) Retry(ctx context.Context, d Delivery) error {
	_, err := s.Pool.Exec(ctx, `UPDATE pulse.outbox SET lease_token=NULL,lease_until=NULL,
        available_at=now()+(LEAST(attempts,30)*interval '1 second') WHERE id=$1 AND lease_token=$2`, d.ID, d.Lease)
	return err
}
func (s *Store) Recipients(ctx context.Context, cid, subject string, membership bool) ([]string, error) {
	rows, err := s.Pool.Query(ctx, `SELECT s.id::text FROM pulse.login_sessions s
        JOIN pulse.users u ON u.id=s.user_id AND u.active
        JOIN pulse.members m ON m.user_id=u.id AND m.conversation_id=$1
        JOIN pulse.conversations c ON c.id=m.conversation_id
        WHERE s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
		AND ((m.active AND (c.active OR $3)) OR ($3 AND c.kind='direct')
			OR ($3 AND s.user_id=$2 AND $2::uuid IS NOT NULL))
        AND ($2::uuid IS NULL OR s.user_id=$2)`, cid, optionalUUID(subject), membership)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
func optionalUUID(id string) any {
	if id == "" {
		return nil
	}
	return id
}
func (s *Store) FinishBatch(ctx context.Context, deliveries []Delivery) error {
	if len(deliveries) == 0 {
		return nil
	}
	ids := make([]string, 0, len(deliveries))
	lease := deliveries[0].Lease
	for _, d := range deliveries {
		if d.Lease != lease {
			return ErrInvalid
		}
		ids = append(ids, d.ID)
	}
	_, err := s.Pool.Exec(ctx, "DELETE FROM pulse.outbox WHERE id=ANY($1::uuid[]) AND lease_token=$2", ids, lease)
	return err
}
func (s *Service) DispatchOnce(ctx context.Context, h *Hub) (int, error) {
	deliveries, err := s.Store.Claim(ctx, 32)
	if err != nil {
		return 0, err
	}
	// Multiple commits in a hot conversation need one invalidation per batch,
	// not a full recipient query and network fan-out for every event.
	grouped := make(map[string]map[string]Hint)
	for _, d := range deliveries {
		hints := grouped[d.Hint.ConversationID]
		if hints == nil {
			hints = map[string]Hint{}
			grouped[d.Hint.ConversationID] = hints
		}
		key := d.Hint.Type + ":" + d.Hint.UserID
		previous, exists := hints[key]
		if !exists || d.Hint.EventSeq > previous.EventSeq || d.Hint.StateVersion > previous.StateVersion {
			hints[key] = d.Hint
		}
	}
	for cid, hints := range grouped {
		activeSessions, err := s.Store.Recipients(ctx, cid, "", false)
		if err != nil {
			return 0, err
		}
		for _, hint := range hints {
			if hint.Type == "membership.changed" && hint.UserID != "" {
				sessions, err := s.Store.Recipients(ctx, cid, hint.UserID, true)
				if err != nil {
					return 0, err
				}
				h.Deliver(sessions, hint)
				continue
			}
			if hint.Type == "membership.changed" {
				sessions, err := s.Store.Recipients(ctx, cid, "", true)
				if err != nil {
					return 0, err
				}
				h.Deliver(sessions, hint)
			} else {
				h.Deliver(activeSessions, hint)
			}
		}
	}
	if err = s.Store.FinishBatch(ctx, deliveries); err != nil {
		return 0, err
	}
	if err := s.dispatchUserChanges(ctx, h); err != nil {
		return 0, err
	}
	return len(deliveries), nil
}
func (s *Service) RunDispatcher(ctx context.Context, h *Hub) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-s.Wake:
		}
		for {
			batch, cancel := context.WithTimeout(ctx, 5*time.Second)
			var count int
			err := s.ObserveWorker(batch, "message.outbox", func(c context.Context) error { var e error; count, e = s.DispatchOnce(c, h); return e })
			cancel()
			if err != nil {
				if ctx.Err() == nil {
					slog.Warn("outbox dispatch deferred")
				}
				break
			}
			if count < 32 {
				break
			}
			if ctx.Err() != nil {
				return
			}
		}
	}
}
