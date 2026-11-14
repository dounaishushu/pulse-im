package core

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

type IndividualReceipt struct {
	MessageID string    `json:"message_id"`
	Status    string    `json:"status"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ReceiptOne preserves the old sparse per-message delivery/read operation.
// It never advances a contiguous watermark or manufactures older receipts.
func (s *Service) ReceiptOne(ctx context.Context, who Identity, cid, mid, status string) (IndividualReceipt, error) {
	result := IndividualReceipt{MessageID: mid}
	if !validID(cid) || !validID(mid) || (status != "delivered" && status != "read") {
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
	if a.Kind == "channel" {
		return result, ErrForbidden
	}
	// Serialize with personal clear/delete and cursor advances for this member.
	var version int64
	if err = tx.QueryRow(ctx, `SELECT version FROM pulse.user_states
        WHERE conversation_id=$1 AND user_id=$2 FOR UPDATE`, cid, who.UserID).Scan(&version); err != nil {
		return result, err
	}
	var seq int64
	err = tx.QueryRow(ctx, `SELECT seq FROM pulse.messages msg WHERE msg.id=$1 AND msg.conversation_id=$2
		AND msg.sender_id<>$3 AND NOT msg.revoked AND msg.seq>=$4 AND msg.seq>$5 AND (NOT msg.manager_only OR $6)
        AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.message_id=msg.id AND d.user_id=$3)`,
		mid, cid, who.UserID, a.VisibleFrom, a.ClearSeq, a.managesGroup()).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, ErrForbidden
	}
	if err != nil {
		return result, err
	}
	changed := true
	err = tx.QueryRow(ctx, `INSERT INTO pulse.receipt_facts(message_id,user_id,status,updated_at)
        VALUES($1,$2,$3,now())
        ON CONFLICT(message_id,user_id) DO UPDATE SET status='read',updated_at=now()
        WHERE pulse.receipt_facts.status='delivered' AND EXCLUDED.status='read'
        RETURNING status,updated_at`, mid, who.UserID, status).Scan(&result.Status, &result.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		changed = false
		err = tx.QueryRow(ctx, `SELECT status,updated_at FROM pulse.receipt_facts
            WHERE message_id=$1 AND user_id=$2`, mid, who.UserID).Scan(&result.Status, &result.UpdatedAt)
	}
	if err != nil {
		return result, err
	}
	if changed {
		if err = tx.QueryRow(ctx, `UPDATE pulse.user_states SET version=version+1
            WHERE conversation_id=$1 AND user_id=$2 RETURNING version`, cid, who.UserID).Scan(&version); err != nil {
			return result, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO pulse.outbox(id,conversation_id,event_seq,kind,subject_id,state_version)
            VALUES($1,$2,0,'state.changed',$3,$4)`, newID(), cid, who.UserID, version); err != nil {
			return result, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return result, err
	}
	if changed {
		s.notify()
	}
	return result, nil
}

func (a *API) registerIndividualReceipts(mux *http.ServeMux) {
	mux.HandleFunc("PUT /api/v2/conversations/{id}/messages/{message}/receipt", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var input struct {
			Status string `json:"status"`
		}
		if err := decode(w, r, &input); err != nil {
			return err
		}
		result, err := a.Service.ReceiptOne(r.Context(), who, r.PathValue("id"), r.PathValue("message"), input.Status)
		if err == nil {
			writeJSON(w, http.StatusOK, result)
		}
		return err
	}))
}
