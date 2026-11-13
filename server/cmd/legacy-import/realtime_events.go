package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

func importRealtimeEvents(ctx context.Context, i *importer) error {
	rows, err := i.source.QueryContext(ctx, "SELECT * FROM realtime_events ORDER BY id")
	if err != nil {
		return err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return err
	}
	values := make([][]any, 0, 2000)
	flush := func() error {
		if len(values) == 0 {
			return nil
		}
		copied, err := i.target.CopyFrom(ctx, pgx.Identifier{"pulse", "legacy_realtime_events"},
			[]string{"legacy_id", "payload"}, pgx.CopyFromRows(values))
		if err != nil {
			return err
		}
		if copied != int64(len(values)) {
			return fmt.Errorf("legacy realtime event copy count differs")
		}
		values = values[:0]
		return nil
	}
	for rows.Next() {
		cell := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for index := range cell {
			pointers[index] = &cell[index]
		}
		if err = rows.Scan(pointers...); err != nil {
			return err
		}
		var id int64
		object := make(map[string]any, len(columns))
		for index, name := range columns {
			value := cell[index]
			if name == "id" {
				id, err = legacyPositiveIDCell(value)
				if err != nil {
					return err
				}
			}
			switch raw := value.(type) {
			case []byte:
				object[name] = string(raw)
			case time.Time:
				object[name] = raw.Format(time.RFC3339Nano)
			default:
				object[name] = raw
			}
		}
		if id <= 0 {
			return fmt.Errorf("missing legacy realtime event ID")
		}
		payload, err := json.Marshal(object)
		if err != nil {
			return err
		}
		values = append(values, []any{id, json.RawMessage(payload)})
		i.counts["realtime_events"]++
		if len(values) == cap(values) {
			if err = flush(); err != nil {
				return err
			}
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	return flush()
}
