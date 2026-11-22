package core

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type BulkPasswordInput struct {
	RequestID string   `json:"request_id"`
	UserIDs   []string `json:"user_ids"`
	Password  string   `json:"password"`
}
type BulkPasswordResult struct {
	Count    int      `json:"count"`
	UserIDs  []string `json:"user_ids"`
	Replayed bool     `json:"-"`
}
type passwordResetReceipt struct {
	Result BulkPasswordResult `json:"result"`
	// An Argon2 verifier, never plaintext or a fast password digest. This permits
	// safe retries even after a user subsequently changes their password again.
	Verifier string `json:"verifier"`
}

func (s *Service) BulkResetPasswords(ctx context.Context, who AdminIdentity, in BulkPasswordInput) (BulkPasswordResult, error) {
	out := BulkPasswordResult{}
	if !requestPattern.MatchString(in.RequestID) || len(in.UserIDs) < 1 || len(in.UserIDs) > 100 {
		return out, &Fault{400, "bulk_reset_selection_invalid"}
	}
	if len(in.Password) < 8 || len(in.Password) > 128 {
		return out, &Fault{400, "bulk_password_invalid"}
	}
	ids := append([]string(nil), in.UserIDs...)
	sort.Strings(ids)
	for i, id := range ids {
		if !validID(id) || (i > 0 && ids[i-1] == id) {
			return out, &Fault{400, "bulk_reset_selection_invalid"}
		}
	}
	fingerprint := digest("user-password-reset:v1:" + strings.Join(ids, ":"))
	// Share the durable admin mutation receipts with batch-create, with a
	// domain-separated request hash. A cross-operation request ID is a conflict.
	readReceipt := func(tx pgx.Tx) (bool, error) {
		var raw, hash []byte
		err := tx.QueryRow(ctx, "SELECT result,request_hash FROM pulse.admin_create_requests WHERE admin_id=$1 AND request_id=$2", who.ID, in.RequestID).Scan(&raw, &hash)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if !equalBytes(hash, fingerprint) {
			return false, ErrConflict
		}
		var receipt passwordResetReceipt
		if json.Unmarshal(raw, &receipt) != nil || !verifyPassword(in.Password, receipt.Verifier) {
			return false, ErrConflict
		}
		out = receipt.Result
		out.Replayed = true
		return true, nil
	}
	select {
	case s.passwordSlots <- struct{}{}:
		defer func() { <-s.passwordSlots }()
	default:
		return out, ErrBusy
	}
	check, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer check.Rollback(ctx)
	if err = lockAdmin(ctx, check, who, "users", true); err != nil {
		return out, err
	}
	prior, err := readReceipt(check)
	if err != nil {
		return out, err
	}
	if prior {
		return out, check.Commit(ctx)
	}
	var count int
	if err = check.QueryRow(ctx, "SELECT count(*) FROM pulse.users WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL", ids).Scan(&count); err != nil {
		return out, err
	}
	if count != len(ids) {
		return out, &Fault{409, "bulk_reset_user_unavailable"}
	}
	if err = check.Commit(ctx); err != nil {
		return out, err
	}
	hashes := make(map[string]string, len(ids))
	for _, id := range ids {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		hash, err := hashPassword(in.Password)
		if err != nil {
			return out, err
		}
		hashes[id] = hash
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if err = lockAdmin(ctx, tx, who, "users", true); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,7156))", who.ID+":"+in.RequestID); err != nil {
		return out, err
	}
	prior, err = readReceipt(tx)
	if err != nil {
		return out, err
	}
	if prior {
		return out, tx.Commit(ctx)
	}
	// Sorted user locks precede session locks, matching single-user password changes.
	for _, id := range ids {
		var deleted *time.Time
		err = tx.QueryRow(ctx, "SELECT deleted_at FROM pulse.users WHERE id=$1 FOR UPDATE", id).Scan(&deleted)
		if errors.Is(err, pgx.ErrNoRows) || deleted != nil {
			return out, &Fault{409, "bulk_reset_user_unavailable"}
		}
		if err != nil {
			return out, err
		}
	}
	for _, id := range ids {
		if _, err = tx.Exec(ctx, "UPDATE pulse.users SET password_hash=$2,profile_version=profile_version+1 WHERE id=$1", id, hashes[id]); err != nil {
			return out, err
		}
		if err = s.saveUserPasswordCopy(ctx, tx, id, in.Password, hashes[id]); err != nil {
			return out, err
		}
		if _, err = tx.Exec(ctx, "UPDATE pulse.login_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", id); err != nil {
			return out, err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO pulse.user_outbox(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET version=pulse.user_outbox.version+1", id); err != nil {
			return out, err
		}
	}
	out = BulkPasswordResult{Count: len(ids), UserIDs: ids}
	raw, _ := json.Marshal(passwordResetReceipt{Result: out, Verifier: hashes[ids[0]]})
	if _, err = tx.Exec(ctx, "INSERT INTO pulse.admin_create_requests(admin_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)", who.ID, in.RequestID, fingerprint, raw); err != nil {
		return out, err
	}
	if err = auditTx(ctx, tx, who, "user.password-reset-batch", "users", "", map[string]any{"count": len(ids), "user_ids": ids, "request_id": in.RequestID}); err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return BulkPasswordResult{}, err
	}
	s.notify()
	return out, nil
}
func (a *API) registerBulkPasswords(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v2/admin/users/password-reset-batch", a.adminWrap("users", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(150 * time.Second))
		var in BulkPasswordInput
		if err := decode(w, r, &in); err != nil {
			return err
		}
		result, err := a.Service.BulkResetPasswords(r.Context(), who, in)
		if err != nil {
			return err
		}
		if !result.Replayed {
			for _, id := range result.UserIDs {
				a.Hub.CloseUser(id)
			}
		}
		writeJSON(w, 200, result)
		return nil
	}))
}
