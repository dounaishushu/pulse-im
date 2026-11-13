package core

import (
	"context"
	"net/http"
)

// ReceiptBatch keeps a visible page's read indicators in one bounded query.
// Like Receipts, it reveals only counts for the sender's visible messages.
func (s *Service) ReceiptBatch(ctx context.Context, who Identity, cid string, ids []string) ([]ReceiptSummary, error) {
	if !validID(cid) || len(ids) == 0 || len(ids) > 100 {
		return nil, ErrInvalid
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if !validID(id) || seen[id] {
			return nil, ErrInvalid
		}
		seen[id] = true
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return nil, err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return nil, err
	}
	if a.Kind == "channel" {
		return nil, ErrForbidden
	}
	rows, err := tx.Query(ctx, `SELECT msg.id::text, count(m.user_id)+`+receiptOrphanRecipients+`,
		count(m.user_id) FILTER (WHERE `+receiptDeliveredPredicate+`) + `+receiptOrphanDelivered+`,
		count(m.user_id) FILTER (WHERE `+receiptReadPredicate+`) + `+receiptOrphanRead+`
        FROM pulse.messages msg
        LEFT JOIN pulse.members m ON m.conversation_id=msg.conversation_id
          AND m.user_id<>$3 AND m.active AND m.visible_from_seq<=msg.seq
        LEFT JOIN pulse.user_states st ON st.conversation_id=m.conversation_id AND st.user_id=m.user_id
        WHERE msg.id=ANY($1::uuid[]) AND msg.conversation_id=$2 AND msg.sender_id=$3
          AND NOT msg.revoked AND msg.seq >= $4 AND msg.seq > $5
          AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.message_id=msg.id AND d.user_id=$3)
        GROUP BY msg.id`, ids, cid, who.UserID, a.VisibleFrom, a.ClearSeq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := make(map[string]ReceiptSummary, len(ids))
	for rows.Next() {
		var item ReceiptSummary
		if err = rows.Scan(&item.MessageID, &item.RecipientCount, &item.DeliveredCount, &item.ReadCount); err != nil {
			return nil, err
		}
		byID[item.MessageID] = item
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(byID) != len(ids) {
		return nil, ErrForbidden
	}
	result := make([]ReceiptSummary, 0, len(ids))
	for _, id := range ids {
		result = append(result, byID[id])
	}
	return result, tx.Commit(ctx)
}

func (a *API) registerClientReceipts(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v2/conversations/{id}/message-receipts", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var input struct {
			MessageIDs []string `json:"message_ids"`
		}
		if err := decode(w, r, &input); err != nil {
			return err
		}
		items, err := a.Service.ReceiptBatch(r.Context(), who, r.PathValue("id"), input.MessageIDs)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
		return nil
	}))
}
