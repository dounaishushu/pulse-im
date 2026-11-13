package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"pulse.im/server/internal/core"
)

func moneyMillis(raw string) (int64, error) {
	parts := strings.Split(raw, ".")
	if len(parts) > 2 || len(parts) == 0 {
		return 0, fmt.Errorf("invalid money value")
	}
	whole, e := strconv.ParseInt(parts[0], 10, 64)
	if e != nil || whole < 0 || whole > 10_000_000 {
		return 0, fmt.Errorf("money out of range")
	}
	fraction := "000"
	if len(parts) == 2 {
		if len(parts[1]) > 3 {
			return 0, fmt.Errorf("money precision lost")
		}
		fraction = (parts[1] + "000")[:3]
	}
	millis, e := strconv.ParseInt(fraction, 10, 64)
	if e != nil {
		return 0, e
	}
	return whole*1000 + millis, nil
}

func importWork(ctx context.Context, i *importer) error {
	questionManifestPath := os.Getenv("PULSE_LEGACY_QUESTION_MEDIA_MANIFEST")
	questionRoot := os.Getenv("PULSE_LEGACY_QUESTION_MEDIA_ROOT")
	if questionManifestPath == "" || questionRoot == "" || i.mediaRoot == "" {
		return fmt.Errorf("question media archive is required")
	}
	rawManifest, e := os.ReadFile(questionManifestPath)
	if e != nil {
		return e
	}
	var questionManifest struct {
		Count    int   `json:"count"`
		Failures []any `json:"failures"`
		Items    []struct {
			QuestionID int64  `json:"question_id"`
			Path       string `json:"path"`
			Bytes      int64  `json:"bytes"`
			SHA256     string `json:"sha256"`
		} `json:"items"`
	}
	if e = json.Unmarshal(rawManifest, &questionManifest); e != nil {
		return e
	}
	if len(questionManifest.Failures) != 0 || questionManifest.Count != len(questionManifest.Items) {
		return fmt.Errorf("question media archive incomplete")
	}
	byQuestion := map[int64]mediaManifestItem{}
	for _, item := range questionManifest.Items {
		if item.QuestionID <= 0 || filepath.Base(item.Path) != item.Path {
			return fmt.Errorf("unsafe question media filename")
		}
		byQuestion[item.QuestionID] = mediaManifestItem{Path: item.Path, Bytes: item.Bytes, SHA256: item.SHA256}
	}
	questionMediaStore, e := core.NewMediaStore(i.mediaRoot, os.Getenv("PULSE_FFPROBE"))
	if e != nil {
		return e
	}
	var fallbackAdmin string
	if e := i.target.QueryRow(ctx, "SELECT id::text FROM pulse.admin_accounts WHERE role='superadmin' AND active ORDER BY id LIMIT 1").Scan(&fallbackAdmin); e != nil {
		return fmt.Errorf("work tasks require an active superadmin: %w", e)
	}
	tasks, e := i.source.QueryContext(ctx, `SELECT id,task_key,name,description,open_time,estimated_minutes,
 question_count,intern_unit_price,formal_unit_price,status,sort_order,created_at,updated_at
 FROM work_tasks ORDER BY id`)
	if e != nil {
		return e
	}
	for tasks.Next() {
		var id int64
		var key, name, status, intern, formal string
		var description sql.NullString
		var openTime string
		var estimated, questions, order int
		var created, updated time.Time
		if e = tasks.Scan(&id, &key, &name, &description, &openTime, &estimated, &questions, &intern, &formal, &status, &order, &created, &updated); e != nil {
			tasks.Close()
			return e
		}
		internMillis, e := moneyMillis(intern)
		if e != nil {
			tasks.Close()
			return e
		}
		formalMillis, e := moneyMillis(formal)
		if e != nil {
			tasks.Close()
			return e
		}
		if status != "enabled" && status != "disabled" {
			tasks.Close()
			return fmt.Errorf("unknown work task status")
		}
		_, e = i.target.Exec(ctx, `INSERT INTO pulse.work_tasks(id,task_key,name,description,open_time,
 estimated_minutes,question_count,intern_millis,formal_millis,enabled,sort_order,created_by,
 created_at,updated_at) VALUES($1,$2,$3,$4,$5::time,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
			legacyUUID("task", id), key, name, nullString(description), openTime, estimated, questions,
			internMillis, formalMillis, status == "enabled", order, fallbackAdmin, created, updated)
		if e != nil {
			tasks.Close()
			return fmt.Errorf("legacy task %d: %w", id, e)
		}
		if e = i.addID(ctx, "task", id); e != nil {
			tasks.Close()
			return e
		}
		i.counts["work_tasks"]++
	}
	e = tasks.Err()
	tasks.Close()
	if e != nil {
		return e
	}
	questions, e := i.source.QueryContext(ctx, `SELECT id,question_uuid,image_url,correct_answer,created_at,updated_at FROM work_questions ORDER BY id`)
	if e != nil {
		return e
	}
	for questions.Next() {
		var id int64
		var code, imageURL string
		var correct bool
		var created, updated time.Time
		if e = questions.Scan(&id, &code, &imageURL, &correct, &created, &updated); e != nil {
			questions.Close()
			return e
		}
		entry, ok := byQuestion[id]
		if !ok {
			questions.Close()
			return fmt.Errorf("legacy question image missing from archive")
		}
		file := filepath.Join(questionRoot, entry.Path)
		info, statErr := os.Lstat(file)
		if statErr != nil || !info.Mode().IsRegular() || info.Size() != entry.Bytes {
			questions.Close()
			return fmt.Errorf("legacy question image file missing")
		}
		mediaID := legacyUUID("question_media", id)
		prepared, prepareErr := i.preparedMedia(fmt.Sprintf("question/%d", id), "question", entry.Path,
			entry, func() (core.LegacyMediaFile, error) {
				return questionMediaStore.PrepareLegacyMedia(ctx, mediaID, "question", entry.Path, file)
			})
		if prepareErr != nil || prepared.SourceBytes != entry.Bytes || prepared.SHA256 != entry.SHA256 {
			questions.Close()
			return fmt.Errorf("legacy question image invalid: %v", prepareErr)
		}
		h := legacyDigest("question_media:" + strconv.FormatInt(id, 10))
		requestID := "legacy_question_" + hex.EncodeToString(h)[:48]
		_, e = i.target.Exec(ctx, `INSERT INTO pulse.media(id,admin_owner_id,request_id,request_hash,kind,
 filename,expected_bytes,expected_sha256,original,status,mime,bytes,width,height,duration_ms,
 compression_applied,source_path,content_path,preview_path,created_at,updated_at)
 VALUES($1,$2,$3,$4,'question',$5,$6,$7,true,'ready',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
			mediaID, fallbackAdmin, requestID, h, prepared.Filename, entry.Bytes, entry.SHA256, prepared.MIME,
			prepared.ContentBytes, prepared.Width, prepared.Height, prepared.DurationMS, prepared.CompressionApplied,
			prepared.SourcePath, prepared.ContentPath, prepared.PreviewPath, created, updated)
		if e != nil {
			questions.Close()
			return e
		}
		if _, e = i.target.Exec(ctx, `INSERT INTO pulse.work_questions(id,code,media_id,image_url,correct,created_at,updated_at)
 VALUES($1,$2,$3,'',$4,$5,$6)`, legacyUUID("question", id), code, mediaID, correct, created, updated); e != nil {
			questions.Close()
			return fmt.Errorf("legacy question %d: %w", id, e)
		}
		if e = i.addID(ctx, "question", id); e != nil {
			questions.Close()
			return e
		}
		i.counts["work_questions"]++
		i.counts["question_media"]++
	}
	e = questions.Err()
	questions.Close()
	if e != nil {
		return e
	}
	codes, e := i.source.QueryContext(ctx, `SELECT task_id,task_date,code FROM work_task_codes ORDER BY id`)
	if e != nil {
		return e
	}
	for codes.Next() {
		var task int64
		var day time.Time
		var code string
		if e = codes.Scan(&task, &day, &code); e != nil {
			codes.Close()
			return e
		}
		if _, e = i.target.Exec(ctx, "INSERT INTO pulse.work_codes(task_id,task_date,code) VALUES($1,$2::date,$3)", legacyUUID("task", task), day.Format("2006-01-02"), code); e != nil {
			codes.Close()
			return e
		}
		i.counts["work_task_codes"]++
	}
	e = codes.Err()
	codes.Close()
	if e != nil {
		return e
	}
	daily, e := i.source.QueryContext(ctx, `SELECT id,task_id,task_date,question_ids_json,questions_snapshot_json,
 total_count,correct_count,wrong_count,created_at,updated_at FROM work_task_daily_questions ORDER BY id`)
	if e != nil {
		return e
	}
	for daily.Next() {
		var id, task int64
		var day time.Time
		var ids, snapshot []byte
		var total, correct, wrong int
		var created, updated time.Time
		if e = daily.Scan(&id, &task, &day, &ids, &snapshot, &total, &correct, &wrong, &created, &updated); e != nil {
			daily.Close()
			return e
		}
		if !json.Valid(ids) || !json.Valid(snapshot) {
			daily.Close()
			return fmt.Errorf("invalid old daily question snapshot")
		}
		converted, e := convertWorkSnapshot(snapshot)
		if e != nil {
			daily.Close()
			return e
		}
		_, e = i.target.Exec(ctx, "INSERT INTO pulse.work_daily(task_id,task_date,questions) VALUES($1,$2::date,$3)", legacyUUID("task", task), day.Format("2006-01-02"), json.RawMessage(converted))
		if e != nil {
			daily.Close()
			return e
		}
		payload, _ := json.Marshal(map[string]any{"task_id": task, "task_date": day.Format("2006-01-02"), "question_ids_json": json.RawMessage(ids), "questions_snapshot_json": json.RawMessage(snapshot), "total_count": total, "correct_count": correct, "wrong_count": wrong, "created_at": created, "updated_at": updated})
		_, e = i.target.Exec(ctx, "INSERT INTO pulse.legacy_work_snapshots(entity,legacy_id,target_id,payload) VALUES('daily',$1,$2,$3)", id, legacyUUID("task", task), json.RawMessage(payload))
		if e != nil {
			daily.Close()
			return e
		}
		i.counts["work_task_daily_questions"]++
	}
	e = daily.Err()
	daily.Close()
	if e != nil {
		return e
	}
	return i.importWorkRecords(ctx)
}
