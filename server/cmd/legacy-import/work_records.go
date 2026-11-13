package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

func convertWorkSnapshot(raw []byte) ([]byte, error) {
	var old []map[string]any
	if err := json.Unmarshal(raw, &old); err != nil {
		return nil, err
	}
	result := make([]map[string]any, 0, len(old))
	for _, question := range old {
		code, _ := question["question_uuid"].(string)
		if code == "" {
			return nil, fmt.Errorf("old work snapshot lacks question_uuid")
		}
		oldID, ok := question["id"].(float64)
		if !ok || oldID <= 0 || oldID != float64(int64(oldID)) {
			return nil, fmt.Errorf("old work snapshot has invalid question id")
		}
		id := legacyUUID("question", int64(oldID))
		image := ""
		answer, _ := question["correct_answer"].(bool)
		result = append(result, map[string]any{"id": id, "code": code, "media_id": legacyUUID("question_media", int64(oldID)), "image_url": image, "correct": answer, "version": "1"})
	}
	return json.Marshal(result)
}

func (i *importer) importWorkRecords(ctx context.Context) error {
	rows, e := i.source.QueryContext(ctx, `SELECT id,user_id,task_id,task_date,employee_type,status,
 start_at,submitted_at,reviewed_at,reviewer_id,reviewer_admin_id,duration_seconds,
 total_questions,correct_count,wrong_count,unit_price,wage,answers_json,
 question_snapshot_json,review_results_json,review_note,created_at,updated_at
 FROM work_task_records ORDER BY id`)
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var id, user, task int64
		var day time.Time
		var employee, status, unit, wage, note string
		var submitted, reviewed sql.NullTime
		var reviewer, admin sql.NullInt64
		var duration int64
		var total, correct, wrong int
		var answers, oldSnapshot, results []byte
		var started, created, updated time.Time
		if e = rows.Scan(&id, &user, &task, &day, &employee, &status, &started, &submitted, &reviewed,
			&reviewer, &admin, &duration, &total, &correct, &wrong, &unit, &wage, &answers,
			&oldSnapshot, &results, &note, &created, &updated); e != nil {
			return e
		}
		if !json.Valid(answers) || !json.Valid(oldSnapshot) || !json.Valid(results) {
			return fmt.Errorf("invalid legacy work record JSON")
		}
		if status != "in_progress" && status != "pending_review" && status != "reviewed" {
			return fmt.Errorf("invalid legacy work record status")
		}
		unitMillis, e := moneyMillis(unit)
		if e != nil {
			return e
		}
		wageMillis, e := moneyMillis(wage)
		if e != nil {
			return e
		}
		questions, e := convertWorkSnapshot(oldSnapshot)
		if e != nil {
			return fmt.Errorf("legacy record %d: %w", id, e)
		}
		var oldQuestions []struct {
			ID   int64  `json:"id"`
			Code string `json:"question_uuid"`
		}
		if e = json.Unmarshal(oldSnapshot, &oldQuestions); e != nil {
			return e
		}
		questionByCode := map[string]string{}
		for _, oldQuestion := range oldQuestions {
			questionByCode[oldQuestion.Code] = legacyUUID("question", oldQuestion.ID)
		}
		var answersMap map[string]any
		if e = json.Unmarshal(answers, &answersMap); e != nil {
			return e
		}
		cleanAnswers := map[string]bool{}
		for code, value := range answersMap {
			if answer, ok := value.(bool); ok {
				questionID, ok := questionByCode[code]
				if !ok {
					return fmt.Errorf("legacy record answer references missing question")
				}
				cleanAnswers[questionID] = answer
			} else {
				return fmt.Errorf("legacy work answer is not boolean")
			}
		}
		var oldResults map[string]bool
		if e = json.Unmarshal(results, &oldResults); e != nil {
			return e
		}
		cleanResults := map[string]bool{}
		for code, value := range oldResults {
			questionID, ok := questionByCode[code]
			if !ok {
				return fmt.Errorf("legacy work review references missing question")
			}
			cleanResults[questionID] = value
		}
		_, e = i.target.Exec(ctx, `INSERT INTO pulse.work_records(id,task_id,user_id,task_date,employee_type,
 unit_millis,status,questions,answers,results,review_note,total,correct_count,wage_millis,
 started_at,submitted_at,reviewed_at,duration_seconds)
 VALUES($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
			legacyUUID("record", id), legacyUUID("task", task), legacyUUID("user", user), day.Format("2006-01-02"),
			employee, unitMillis, status, json.RawMessage(questions), cleanAnswers, cleanResults, note,
			total, correct, wageMillis, started, nullTime(submitted), nullTime(reviewed), duration)
		if e != nil {
			return fmt.Errorf("legacy work record %d: %w", id, e)
		}
		payload, _ := json.Marshal(map[string]any{"user_id": user, "task_id": task, "task_date": day.Format("2006-01-02"), "status": status, "employee_type": employee, "start_at": started, "submitted_at": nullTime(submitted), "reviewed_at": nullTime(reviewed), "reviewer_id": nullInt(reviewer), "reviewer_admin_id": nullInt(admin), "duration_seconds": duration, "total_questions": total, "correct_count": correct, "wrong_count": wrong, "unit_price": unit, "wage": wage, "answers_json": json.RawMessage(answers), "question_snapshot_json": json.RawMessage(oldSnapshot), "review_results_json": json.RawMessage(results), "review_note": note, "created_at": created, "updated_at": updated})
		_, e = i.target.Exec(ctx, `INSERT INTO pulse.legacy_work_snapshots(entity,legacy_id,target_id,payload)
 VALUES('record',$1,$2,$3)`, id, legacyUUID("record", id), json.RawMessage(payload))
		if e != nil {
			return e
		}
		if e = i.addID(ctx, "record", id); e != nil {
			return e
		}
		i.counts["work_task_records"]++
	}
	return rows.Err()
}
