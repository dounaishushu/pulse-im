package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type coreReconciliation struct {
	Complete        bool             `json:"complete"`
	Scope           string           `json:"scope"`
	SourceCounts    map[string]int64 `json:"source_counts"`
	TargetCounts    map[string]int64 `json:"target_counts"`
	ReceiptsChecked int64            `json:"receipts_checked"`
	ReceiptDigest   string           `json:"receipt_digest"`
}

func reconcileCore(ctx context.Context, source *sql.DB, target *pgxpool.Pool) error {
	report := coreReconciliation{Complete: false, Scope: "core-only", SourceCounts: map[string]int64{}, TargetCounts: map[string]int64{}}
	for _, pair := range [][2]string{
		{"users", "users"}, {"conversations", "conversations"}, {"conversation_members", "members"},
		{"messages", "messages"}, {"message_receipts", "receipt_facts"},
		{"contacts", "contact_metadata"}, {"contact_requests", "friend_requests"},
		{"user_blocks", "blocks"}, {"message_deletions", "message_deletions"},
		{"message_pins", "message_pins"},
	} {
		var oldCount, newCount int64
		if err := source.QueryRowContext(ctx, "SELECT count(*) FROM `"+pair[0]+"`").Scan(&oldCount); err != nil {
			return err
		}
		if err := target.QueryRow(ctx, "SELECT count(*) FROM pulse."+pair[1]).Scan(&newCount); err != nil {
			return err
		}
		report.SourceCounts[pair[0]] = oldCount
		report.TargetCounts[pair[1]] = newCount
		if oldCount != newCount {
			return fmt.Errorf("table count mismatch for %s", pair[0])
		}
	}
	for _, entity := range []string{"user", "conversation", "message", "friend_request"} {
		var count int64
		if err := target.QueryRow(ctx, "SELECT count(*) FROM pulse.legacy_ids WHERE entity=$1", entity).Scan(&count); err != nil {
			return err
		}
		key := map[string]string{"user": "users", "conversation": "conversations", "message": "messages", "friend_request": "contact_requests"}[entity]
		if count != report.SourceCounts[key] {
			return fmt.Errorf("legacy id map mismatch for %s", entity)
		}
	}
	var maxMessage int64
	if err := source.QueryRowContext(ctx, "SELECT COALESCE(MAX(id),0) FROM messages").Scan(&maxMessage); err != nil {
		return err
	}
	sourceHash, targetHash := sha256.New(), sha256.New()
	for first := int64(1); first <= maxMessage; first += 1024 {
		last := first + 1023
		if last > maxMessage {
			last = maxMessage
		}
		oldRows, err := source.QueryContext(ctx, `SELECT message_id,user_id,status,updated_at
 FROM message_receipts WHERE message_id BETWEEN ? AND ? ORDER BY message_id,user_id`, first, last)
		if err != nil {
			return err
		}
		newRows, err := target.Query(ctx, `SELECT m.legacy_id,u.legacy_id,r.status,r.updated_at
 FROM pulse.legacy_ids m JOIN pulse.receipt_facts r ON r.message_id=m.new_id
 JOIN pulse.legacy_ids u ON u.entity='user' AND u.new_id=r.user_id
 WHERE m.entity='message' AND m.legacy_id BETWEEN $1 AND $2
 ORDER BY m.legacy_id,u.legacy_id`, first, last)
		if err != nil {
			oldRows.Close()
			return err
		}
		for oldRows.Next() {
			var oldMessage, oldUser int64
			var oldStatus string
			var oldWhen time.Time
			if err = oldRows.Scan(&oldMessage, &oldUser, &oldStatus, &oldWhen); err != nil {
				oldRows.Close()
				newRows.Close()
				return err
			}
			if !newRows.Next() {
				oldRows.Close()
				newRows.Close()
				return fmt.Errorf("receipt target ended early in segment %d", first)
			}
			var newMessage, newUser int64
			var newStatus string
			var newWhen time.Time
			if err = newRows.Scan(&newMessage, &newUser, &newStatus, &newWhen); err != nil {
				oldRows.Close()
				newRows.Close()
				return err
			}
			if oldMessage != newMessage || oldUser != newUser || oldStatus != newStatus || !oldWhen.Equal(newWhen) {
				oldRows.Close()
				newRows.Close()
				return fmt.Errorf("receipt mismatch in segment %d", first)
			}
			digestReceipt(sourceHash, oldMessage, oldUser, oldStatus, oldWhen)
			digestReceipt(targetHash, newMessage, newUser, newStatus, newWhen)
			report.ReceiptsChecked++
		}
		if err = oldRows.Err(); err != nil {
			oldRows.Close()
			newRows.Close()
			return err
		}
		if newRows.Next() {
			oldRows.Close()
			newRows.Close()
			return fmt.Errorf("receipt target has extra rows in segment %d", first)
		}
		if err = newRows.Err(); err != nil {
			oldRows.Close()
			newRows.Close()
			return err
		}
		oldRows.Close()
		newRows.Close()
		if (first/1024)%10 == 0 {
			fmt.Fprintln(os.Stderr, "reconciled receipt rows:", report.ReceiptsChecked)
		}
	}
	if report.ReceiptsChecked != report.SourceCounts["message_receipts"] {
		return fmt.Errorf("receipt comparison did not cover every row")
	}
	if hex.EncodeToString(sourceHash.Sum(nil)) != hex.EncodeToString(targetHash.Sum(nil)) {
		return fmt.Errorf("receipt digest mismatch")
	}
	report.ReceiptDigest = hex.EncodeToString(sourceHash.Sum(nil))
	encoded, err := json.Marshal(report)
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}

func digestReceipt(h hash.Hash, mid, uid int64, status string, at time.Time) {
	fmt.Fprintf(h, "%d/%d/%s/%s\n", mid, uid, status, at.UTC().Format(time.RFC3339Nano))
}
