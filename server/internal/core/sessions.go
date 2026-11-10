package core

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type DeviceSession struct {
	ID        string    `json:"id"`
	DeviceID  string    `json:"device_id"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	Current   bool      `json:"current"`
}

func (s *Service) Sessions(ctx context.Context, who Identity) ([]DeviceSession, error) {
	rows, err := s.Store.Pool.Query(ctx, `SELECT id::text,device_id,created_at,expires_at
		FROM pulse.login_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()
		ORDER BY created_at DESC,id DESC LIMIT 8`, who.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]DeviceSession, 0)
	for rows.Next() {
		var item DeviceSession
		if err = rows.Scan(&item.ID, &item.DeviceID, &item.CreatedAt, &item.ExpiresAt); err != nil {
			return nil, err
		}
		item.Current = item.ID == who.SessionID
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) RevokeSession(ctx context.Context, who Identity, id string) error {
	if !validID(id) {
		return ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Serialize same-account session mutations before taking a shared actor
	// session lock; two devices revoking each other must not deadlock.
	var userID string
	err = tx.QueryRow(ctx, "SELECT id::text FROM pulse.users WHERE id=$1 AND active FOR UPDATE", who.UserID).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnauthorized
	}
	if err != nil {
		return err
	}
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE pulse.login_sessions SET revoked_at=now()
		WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, id, who.UserID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrMissing
	}
	return tx.Commit(ctx)
}

func (s *Service) ChangePassword(ctx context.Context, who Identity, oldPassword, newPassword string) error {
	if len(oldPassword) == 0 || len(oldPassword) > 256 {
		return ErrInvalid
	}
	select {
	case s.passwordSlots <- struct{}{}:
		defer func() { <-s.passwordSlots }()
	default:
		return ErrBusy
	}
	var stored string
	err := s.Store.Pool.QueryRow(ctx, "SELECT password_hash FROM pulse.users WHERE id=$1 AND active", who.UserID).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnauthorized
	}
	if err != nil {
		return err
	}
	if !verifyPassword(oldPassword, stored) {
		return ErrUnauthorized
	}
	newHash, err := hashPassword(newPassword)
	if err != nil {
		return err
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var current string
	err = tx.QueryRow(ctx, "SELECT password_hash FROM pulse.users WHERE id=$1 AND active FOR UPDATE", who.UserID).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnauthorized
	}
	if err != nil {
		return err
	}
	if current != stored {
		return ErrConflict
	}
	// Revalidate the actor's session after acquiring the user lock. This blocks
	// a second concurrent password change with a stale authenticated request.
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "UPDATE pulse.users SET password_hash=$2 WHERE id=$1", who.UserID, newHash); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "UPDATE pulse.login_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", who.UserID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
