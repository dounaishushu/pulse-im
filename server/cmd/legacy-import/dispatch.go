package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"pulse.im/server/internal/core"
)

func importDispatch(ctx context.Context, i *importer) error {
	rows, e := i.source.QueryContext(ctx, `SELECT id,creator_admin_id,sender_id,recipient_type,
 recipient_ids_json,trigger_type,execute_at,cron_expression,steps_json,status,version,
 next_run_at,last_executed_at,last_error,created_at,updated_at FROM dispatch_tasks ORDER BY id`)
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var id, admin, sender int64
		var recipientType, trigger, status string
		var targetsRaw, stepsRaw []byte
		var execute, next, lastRun sql.NullTime
		var cron, lastError sql.NullString
		var version int64
		var created, updated time.Time
		if e = rows.Scan(&id, &admin, &sender, &recipientType, &targetsRaw, &trigger, &execute, &cron,
			&stepsRaw, &status, &version, &next, &lastRun, &lastError, &created, &updated); e != nil {
			return e
		}
		if !json.Valid(targetsRaw) || !json.Valid(stepsRaw) || recipientType != "group" && recipientType != "user" {
			return fmt.Errorf("invalid legacy dispatch payload")
		}
		var oldTargets []int64
		if e = json.Unmarshal(targetsRaw, &oldTargets); e != nil {
			return e
		}
		var oldSteps []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			ImageURL string `json:"image_url"`
			Delay    int    `json:"delay_seconds"`
		}
		if e = json.Unmarshal(stepsRaw, &oldSteps); e != nil {
			return e
		}
		targets := make([]string, 0, len(oldTargets))
		for _, target := range oldTargets {
			if target <= 0 {
				return fmt.Errorf("invalid dispatch recipient")
			}
			if recipientType == "group" {
				targets = append(targets, legacyUUID("conversation", target))
			} else {
				return fmt.Errorf("user-target legacy dispatch requires direct-conversation mapping")
			}
		}
		steps := make([]core.SendInput, 0, len(oldSteps))
		delays := make([]int, 0, len(oldSteps))
		for _, step := range oldSteps {
			input := core.SendInput{Kind: step.Type, Body: step.Text}
			if step.Type == "text_image" {
				input.Kind = "image"
			}
			if step.Type != "text" {
				media, ok := i.dispatchImage(step.ImageURL)
				if !ok {
					return fmt.Errorf("dispatch image URL has no verified archived file")
				}
				input.MediaID = media.ID
			}
			if step.Type != "text" && step.Type != "image" && step.Type != "text_image" {
				return fmt.Errorf("unsupported old dispatch step")
			}
			steps = append(steps, input)
			delays = append(delays, step.Delay)
		}
		var runAt *time.Time
		if execute.Valid {
			runAt = &execute.Time
		}
		plan := core.DispatchInput{Name: fmt.Sprintf("旧分发计划 %d", id), SenderID: legacyUUID("user", sender),
			Targets: targets, Steps: steps, Delays: delays, Cron: nullString(cron), RunAt: runAt, Enabled: false}
		payload, e := json.Marshal(plan)
		if e != nil {
			return e
		}
		planID := legacyUUID("dispatch", id)
		_, e = i.target.Exec(ctx, `INSERT INTO pulse.dispatch_plans(id,admin_id,sender_id,name,payload,
 cron,run_at,next_run,enabled,version,last_status,created_at,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,false,$9,$10,$11,$12)`, planID, legacyUUID("admin", admin), legacyUUID("user", sender),
			plan.Name, json.RawMessage(payload), nullString(cron), nullTime(execute), nullTime(next), version, status, created, updated)
		if e != nil {
			return e
		}
		original, _ := json.Marshal(map[string]any{"recipient_type": recipientType, "recipient_ids_json": json.RawMessage(targetsRaw),
			"trigger_type": trigger, "steps_json": json.RawMessage(stepsRaw), "status": status, "version": version,
			"last_executed_at": nullTime(lastRun), "last_error": nullOrString(lastError)})
		if _, e = i.target.Exec(ctx, "INSERT INTO pulse.legacy_dispatch_tasks(legacy_id,plan_id,source_payload) VALUES($1,$2,$3)", id, planID, json.RawMessage(original)); e != nil {
			return e
		}
		if e = i.addID(ctx, "dispatch", id); e != nil {
			return e
		}
		i.counts["dispatch_tasks"]++
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	runs, e := i.source.QueryContext(ctx, `SELECT id,task_id,task_version,scheduled_at,status,
 step_index,recipient_index,next_step_at,lease_until,started_at,finished_at,last_error,
 created_at,updated_at FROM dispatch_task_runs ORDER BY id`)
	if e != nil {
		return e
	}
	defer runs.Close()
	for runs.Next() {
		var id, task int64
		var version, step, recipient int
		var scheduled, next, created, updated time.Time
		var status string
		var lease, started, finished sql.NullTime
		var lastError sql.NullString
		if e = runs.Scan(&id, &task, &version, &scheduled, &status, &step, &recipient, &next, &lease,
			&started, &finished, &lastError, &created, &updated); e != nil {
			return e
		}
		payload, _ := json.Marshal(map[string]any{"task_version": version, "scheduled_at": scheduled, "status": status,
			"step_index": step, "recipient_index": recipient, "next_step_at": next, "lease_until": nullTime(lease),
			"started_at": nullTime(started), "finished_at": nullTime(finished), "last_error": nullOrString(lastError),
			"created_at": created, "updated_at": updated})
		if _, e = i.target.Exec(ctx, "INSERT INTO pulse.legacy_dispatch_runs(legacy_id,legacy_task_id,source_payload) VALUES($1,$2,$3)", id, task, json.RawMessage(payload)); e != nil {
			return e
		}
		i.counts["dispatch_task_runs"]++
	}
	return runs.Err()
}

func (i *importer) dispatchImage(rawURL string) (legacyMedia, bool) {
	if path, ok := importedURLPath(rawURL); ok {
		media, found := i.mediaPaths[path]
		return media, found
	}
	if !strings.HasPrefix(rawURL, "https://nim-nosdn.netease.im/") {
		return legacyMedia{}, false
	}
	messageID, found := i.imageURLMessageIDs[rawURL]
	if !found || messageID <= 0 {
		return legacyMedia{}, false
	}
	media, ok := i.mediaPaths[fmt.Sprintf("external/message/%d", messageID)]
	return media, ok
}
