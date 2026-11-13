package core

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
)

func (s *Service) ControlDispatch(ctx context.Context, admin AdminIdentity, id, action string) error {
	if !validID(id) || (action != "disable" && action != "delete") {
		return ErrInvalid
	}
	return s.adminWrite(ctx, admin, "dispatch", "dispatch."+action, "dispatch", id, func(tx pgx.Tx) error {
		// Sender, batch, then plan is the same lock order as a queued send.
		var sender string
		if e := tx.QueryRow(ctx, "SELECT sender_id::text FROM pulse.dispatch_plans WHERE id=$1", id).Scan(&sender); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, "SELECT id FROM pulse.users WHERE id=$1 FOR SHARE", sender); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, "UPDATE pulse.send_batches SET status='cancelled',updated_at=now() WHERE plan_id=$1 AND status IN('pending','running')", id); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, "UPDATE pulse.dispatch_plans SET enabled=false,version=version+1,next_run=NULL,updated_at=now() WHERE id=$1", id); e != nil {
			return e
		}
		if action == "delete" {
			if _, e := tx.Exec(ctx, "UPDATE pulse.send_batches SET plan_id=NULL WHERE plan_id=$1", id); e != nil {
				return e
			}
			_, e := tx.Exec(ctx, "DELETE FROM pulse.dispatch_plans WHERE id=$1", id)
			return e
		}
		return nil
	})
}
func (a *API) registerDeliveryControls(mux *http.ServeMux) {
	s := a.Service
	for _, action := range []string{"disable", "delete"} {
		mux.HandleFunc("POST /api/v2/admin/dispatch-plans/{id}/"+action, a.adminWrap("dispatch", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
			e := s.ControlDispatch(r.Context(), who, r.PathValue("id"), action)
			if e == nil {
				w.WriteHeader(204)
			}
			return e
		}))
	}
	mux.HandleFunc("POST /api/v2/send-batches/{id}/retry", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		id := r.PathValue("id")
		if !validID(id) {
			return ErrInvalid
		}
		tx, e := s.Store.Pool.Begin(r.Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(r.Context())
		if _, e = lockIdentity(r.Context(), tx, who); e != nil {
			return e
		}
		var status string
		if e = tx.QueryRow(r.Context(), "SELECT status FROM pulse.send_batches WHERE id=$1 AND user_id=$2 AND admin_id IS NULL FOR UPDATE", id, who.UserID).Scan(&status); errors.Is(e, pgx.ErrNoRows) {
			return ErrMissing
		} else if e != nil {
			return e
		}
		if status != "partial" {
			return ErrConflict
		}
		items, e := tx.Exec(r.Context(), "UPDATE pulse.send_batch_items SET status='pending',due_at=now(),attempts=0,error_code='',message_id=NULL,lease_token=NULL,lease_until=NULL WHERE batch_id=$1 AND status='failed'", id)
		if e != nil {
			return e
		}
		if items.RowsAffected() == 0 {
			return ErrConflict
		}
		if _, e = tx.Exec(r.Context(), "UPDATE pulse.send_batches SET status='pending',updated_at=now() WHERE id=$1", id); e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e != nil {
			return e
		}
		writeJSON(w, 202, map[string]string{"id": id})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/admin/dispatch-runs/{id}", a.adminWrap("dispatch", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		id := r.PathValue("id")
		if !validID(id) {
			return ErrInvalid
		}
		return adminRows(w, r, s, `SELECT jsonb_build_object('ordinal',i.ordinal,'conversation_id',i.conversation_id,'status',i.status,'error_code',i.error_code,'message_id',i.message_id,'attempts',i.attempts,'due_at',i.due_at) FROM pulse.send_batch_items i JOIN pulse.send_batches b ON b.id=i.batch_id WHERE i.batch_id=$3 AND b.kind='dispatch' ORDER BY i.ordinal LIMIT $1 OFFSET $2`, id)
	}))
}
