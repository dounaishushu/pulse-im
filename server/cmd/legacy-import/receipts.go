package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
)

func importReceiptFacts(ctx context.Context, i *importer) error {
	rows, err := i.source.QueryContext(ctx, `SELECT message_id,user_id,status,updated_at
 FROM message_receipts ORDER BY message_id,user_id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	const batchSize = 5000
	values := make([][]any, 0, batchSize)
	flush := func() error {
		if len(values) == 0 {
			return nil
		}
		copied, e := i.target.CopyFrom(ctx, pgx.Identifier{"pulse", "receipt_facts"},
			[]string{"message_id", "user_id", "status", "updated_at"}, pgx.CopyFromRows(values))
		if e != nil {
			return e
		}
		if copied != int64(len(values)) {
			return fmt.Errorf("receipt COPY inserted %d of %d rows", copied, len(values))
		}
		values = values[:0]
		return nil
	}
	for rows.Next() {
		var messageID, userID int64
		var status string
		var updated time.Time
		if err = rows.Scan(&messageID, &userID, &status, &updated); err != nil {
			return err
		}
		if status != "read" && status != "delivered" {
			return fmt.Errorf("invalid receipt status")
		}
		if _, ok := i.messageIDs[messageID]; !ok {
			return fmt.Errorf("receipt references missing legacy message %d", messageID)
		}
		values = append(values, []any{legacyUUID("message", messageID), legacyUUID("user", userID), status, updated})
		i.counts["message_receipts"]++
		if len(values) == batchSize {
			if err = flush(); err != nil {
				return err
			}
		}
		if i.counts["message_receipts"]%500000 == 0 {
			fmt.Fprintln(os.Stderr, "receipt rows copied:", i.counts["message_receipts"])
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if err = flush(); err != nil {
		return err
	}
	var stored int64
	if err = i.target.QueryRow(ctx, "SELECT count(*) FROM pulse.receipt_facts").Scan(&stored); err != nil {
		return err
	}
	if stored != i.counts["message_receipts"] {
		return fmt.Errorf("receipt count mismatch: copied %d stored %d", i.counts["message_receipts"], stored)
	}
	return nil
}
