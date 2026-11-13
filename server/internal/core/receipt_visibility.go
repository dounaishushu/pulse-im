package core

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Callers lock the user's state row first. Ranges are disjoint and nonadjacent,
// so receipt queries only need the nearest earlier range for each member.
func excludeReceiptRange(ctx context.Context, tx pgx.Tx, who Identity, cid, kind string, first, last int64) error {
	if first > last {
		return nil
	}
	_, err := tx.Exec(ctx, `WITH merged AS (
        DELETE FROM pulse.receipt_exclusions WHERE conversation_id=$1 AND user_id=$2 AND kind=$3
        AND first_seq <= $5::bigint + 1 AND last_seq >= $4::bigint - 1
        RETURNING first_seq,last_seq
    ) INSERT INTO pulse.receipt_exclusions(conversation_id,user_id,kind,first_seq,last_seq)
        SELECT $1,$2,$3,LEAST($4::bigint,COALESCE(min(first_seq),$4::bigint)),
            GREATEST($5::bigint,COALESCE(max(last_seq),$5::bigint)) FROM merged`,
		cid, who.UserID, kind, first, last)
	return err
}

type receiptState struct {
	ReadSeq, DeliveredSeq, ClearSeq   int64
	LegacyReadSeq, LegacyDeliveredSeq int64
}

func lockReceiptState(ctx context.Context, tx pgx.Tx, who Identity, cid string) (receiptState, error) {
	var st receiptState
	err := tx.QueryRow(ctx, `SELECT read_seq,delivered_seq,clear_seq,legacy_read_override_seq,legacy_delivered_override_seq FROM pulse.user_states
        WHERE conversation_id=$1 AND user_id=$2 FOR UPDATE`, cid, who.UserID).
		Scan(&st.ReadSeq, &st.DeliveredSeq, &st.ClearSeq, &st.LegacyReadSeq, &st.LegacyDeliveredSeq)
	return st, err
}

func excludeUnobserved(ctx context.Context, tx pgx.Tx, who Identity, cid string, st receiptState, first, last int64) error {
	if err := excludeReceiptRange(ctx, tx, who, cid, "read", max(first, st.ReadSeq+1), last); err != nil {
		return err
	}
	if err := excludeReceiptRange(ctx, tx, who, cid, "delivered", max(first, st.DeliveredSeq+1), last); err != nil {
		return err
	}
	if err := excludeReceiptRange(ctx, tx, who, cid, "legacy_read", max(first, st.LegacyReadSeq+1), last); err != nil {
		return err
	}
	return excludeReceiptRange(ctx, tx, who, cid, "legacy_delivered", max(first, st.LegacyDeliveredSeq+1), last)
}
