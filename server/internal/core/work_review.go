package core

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
)

type ReviewInput struct {
	RequestID string          `json:"request_id"`
	Results   map[string]bool `json:"results"`
	Note      string          `json:"note"`
}

func (s *Service) ReviewWork(ctx context.Context, who AdminIdentity, id string, in ReviewInput) error {
	if !validID(id) || !requestPattern.MatchString(in.RequestID) || !validText(in.Note, 0, 2000) || len(in.Results) > 1000 {
		return ErrInvalid
	}
	raw, _ := json.Marshal(in)
	fingerprint := digest(string(raw))
	return s.adminWrite(ctx, who, "records", "record.review", "record", id, func(tx pgx.Tx) error {
		var status, priorRequest string
		var hash, snapshot []byte
		var unit int64
		e := tx.QueryRow(ctx, "SELECT status,COALESCE(review_request,''),review_hash,questions,unit_millis FROM pulse.work_records WHERE id=$1 FOR UPDATE", id).Scan(&status, &priorRequest, &hash, &snapshot, &unit)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrMissing
		}
		if e != nil {
			return e
		}
		if status == "reviewed" {
			if priorRequest == in.RequestID && equalBytes(hash, fingerprint) {
				return nil
			}
			return ErrConflict
		}
		if status != "pending_review" {
			return ErrConflict
		}
		var questions []WorkQuestion
		if e = json.Unmarshal(snapshot, &questions); e != nil {
			return e
		}
		if len(in.Results) != len(questions) {
			return ErrInvalid
		}
		correct := 0
		for _, q := range questions {
			result, ok := in.Results[q.ID]
			if !ok {
				return ErrInvalid
			}
			if result {
				correct++
			}
		}
		results, _ := json.Marshal(in.Results)
		_, e = tx.Exec(ctx, "UPDATE pulse.work_records SET status='reviewed',correct_count=$2,wage_millis=$3,results=$4,review_note=$5,review_request=$6,review_hash=$7,reviewed_at=now(),version=version+1 WHERE id=$1", id, correct, int64(correct)*unit, results, in.Note, in.RequestID, fingerprint)
		return e
	})
}
func (a *API) registerWorkReview(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("POST /api/v2/admin/task-records/{id}/review", a.adminWrap("records", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in ReviewInput
		if e := decodeLimit(w, r, &in, 128<<10); e != nil {
			return e
		}
		e := s.ReviewWork(r.Context(), who, r.PathValue("id"), in)
		if e == nil {
			w.WriteHeader(204)
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/task-records", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		return adminRows(w, r, s, "SELECT (to_jsonb(r)-'questions'-'answers'-'results'-'review_hash')||jsonb_build_object('version',version::text,'unit_price',to_char(unit_millis::numeric/1000,'FM999999990.000'),'wage',to_char(wage_millis::numeric/1000,'FM999999990.000')) FROM pulse.work_records r WHERE user_id=$3 ORDER BY task_date DESC,id LIMIT $1 OFFSET $2", who.UserID)
	}))
	mux.HandleFunc("GET /api/v2/admin/task-codes", a.adminWrap("tasks", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		rows, e := s.Store.Pool.Query(r.Context(), "SELECT id::text,name FROM pulse.work_tasks ORDER BY id LIMIT 1000")
		if e != nil {
			return e
		}
		items := []map[string]string{}
		for rows.Next() {
			var id, name string
			if e = rows.Scan(&id, &name); e != nil {
				rows.Close()
				return e
			}
			items = append(items, map[string]string{"task_id": id, "task_name": name})
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		date := workDate()
		for _, item := range items {
			code, e := s.TaskCode(r.Context(), who, item["task_id"], date, false)
			if e != nil {
				return e
			}
			item["code"] = code
		}
		writeJSON(w, 200, map[string]any{"date": date, "items": items})
		return nil
	}))
}
