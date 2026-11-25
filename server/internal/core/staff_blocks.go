package core

import (
	"context"
	"sort"

	"github.com/jackc/pgx/v5"
)

// Serialize role changes and the operator backfill before either takes user
// locks. Normal contact operations retain their existing participant/pair gates.
func lockStaffBlockPolicy(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(765220261125001)")
	return err
}

// ReleaseProtectedStaffBlocks is an operator maintenance primitive. Public block
// writes already deny ordinary users, including holders of old staff tokens.
func (s *Service) ReleaseProtectedStaffBlocks(ctx context.Context) (int, error) {
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if err = lockStaffBlockPolicy(ctx, tx); err != nil {
		return 0, err
	}
	count, err := releaseProtectedStaffBlocksTx(ctx, tx, "")
	if err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	if count > 0 {
		s.notify()
	}
	return count, nil
}

// The caller holds the role-policy gate. A scoped call runs only when a user's
// internal_staff flag changes; ordinary reads and sends do no backfill work.
func releaseProtectedStaffBlocksTx(ctx context.Context, tx pgx.Tx, user string) (int, error) {
	rows, err := tx.Query(ctx, `SELECT b.user_id::text,b.peer_id::text FROM pulse.blocks b
		JOIN pulse.users actor ON actor.id=b.user_id
		JOIN pulse.users target ON target.id=b.peer_id
		WHERE NOT actor.internal_staff AND target.internal_staff
		AND ($1::uuid IS NULL OR b.user_id=$1 OR b.peer_id=$1)
		ORDER BY LEAST(b.user_id,b.peer_id),GREATEST(b.user_id,b.peer_id),b.user_id`, optionalUUID(user))
	if err != nil {
		return 0, err
	}
	type relation struct{ actor, peer, cid string }
	var pairs []relation
	var participants []string
	for rows.Next() {
		var pair relation
		if err = rows.Scan(&pair.actor, &pair.peer); err != nil {
			rows.Close()
			return 0, err
		}
		pairs = append(pairs, pair)
		participants = append(participants, pair.actor, pair.peer)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(pairs) == 0 {
		return 0, err
	}
	if err = lockBlockParticipants(ctx, tx, participants, false); err != nil {
		return 0, err
	}
	var conversations []string
	for i := range pairs {
		pair := &pairs[i]
		if err = lockPair(ctx, tx, pair.actor, pair.peer); err != nil {
			return 0, err
		}
		pair.cid, err = existingDirect(ctx, tx, pair.actor, pair.peer)
		if err != nil {
			return 0, err
		}
		if pair.cid != "" {
			conversations = append(conversations, pair.cid)
		}
	}
	if err = lockConversations(ctx, tx, conversations); err != nil {
		return 0, err
	}
	count := 0
	var changedUsers []string
	for _, pair := range pairs {
		command, err := tx.Exec(ctx, `DELETE FROM pulse.blocks b USING pulse.users actor,pulse.users target
			WHERE b.user_id=$1 AND b.peer_id=$2 AND actor.id=b.user_id AND target.id=b.peer_id
			AND NOT actor.internal_staff AND target.internal_staff`, pair.actor, pair.peer)
		if err != nil {
			return 0, err
		}
		if command.RowsAffected() == 0 {
			continue
		}
		count++
		changedUsers = append(changedUsers, pair.actor, pair.peer)
		if pair.cid != "" {
			if err = membershipHint(ctx, tx, pair.cid, ""); err != nil {
				return 0, err
			}
		}
	}
	sort.Strings(changedUsers)
	for i, uid := range changedUsers {
		if i > 0 && changedUsers[i-1] == uid {
			continue
		}
		if _, err = tx.Exec(ctx, `INSERT INTO pulse.user_outbox(user_id) VALUES($1)
			ON CONFLICT(user_id) DO UPDATE SET version=pulse.user_outbox.version+1`, uid); err != nil {
			return 0, err
		}
	}
	return count, nil
}
