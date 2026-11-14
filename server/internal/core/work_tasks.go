package core

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var taskKeyPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)
var moneyPattern = regexp.MustCompile(`^[0-9]{1,6}(\.[0-9]{1,3})?$`)

func moneyMillis(raw string) (int64, error) {
	if !moneyPattern.MatchString(raw) {
		return 0, ErrInvalid
	}
	parts := strings.Split(raw, ".")
	whole, _ := strconv.ParseInt(parts[0], 10, 64)
	fraction := "000"
	if len(parts) == 2 {
		fraction = (parts[1] + "000")[:3]
	}
	decimal, _ := strconv.ParseInt(fraction, 10, 64)
	n := whole*1000 + decimal
	if n > 100000000 {
		return 0, ErrInvalid
	}
	return n, nil
}
func moneyAmount(n int64) string { return fmt.Sprintf("%d.%03d", n/1000, n%1000) }

var workTimezone = time.FixedZone("Asia/Shanghai", 8*3600)

func workDate() string { return time.Now().In(workTimezone).Format("2006-01-02") }

type WorkTaskInput struct {
	Key         string `json:"task_key"`
	Name        string `json:"name"`
	Description string `json:"description"`
	OpenTime    string `json:"open_time"`
	Estimated   int    `json:"estimated_minutes"`
	Questions   int    `json:"question_count"`
	Intern      string `json:"intern_unit_price"`
	Formal      string `json:"formal_unit_price"`
	Enabled     bool   `json:"enabled"`
	Order       int    `json:"sort_order"`
	Expected    int64  `json:"expected_version,string"`
}
type WorkQuestion struct {
	ID       string `json:"id"`
	Code     string `json:"code"`
	MediaID  string `json:"media_id"`
	ImageURL string `json:"image_url"`
	Correct  *bool  `json:"correct,omitempty"`
	Version  int64  `json:"version,string"`
}
type WorkRecord struct {
	ID           string          `json:"id"`
	TaskID       string          `json:"task_id"`
	UserID       string          `json:"user_id"`
	Date         string          `json:"task_date"`
	Employee     string          `json:"employee_type"`
	Status       string          `json:"status"`
	TaskName     string          `json:"task_name"`
	Nickname     string          `json:"nickname"`
	AvatarID     string          `json:"avatar_id"`
	StartedAt    time.Time       `json:"started_at"`
	SubmittedAt  *time.Time      `json:"submitted_at"`
	ReviewedAt   *time.Time      `json:"reviewed_at"`
	Unit         string          `json:"unit_price"`
	Wage         string          `json:"wage"`
	Total        int             `json:"total"`
	CorrectCount int             `json:"correct_count"`
	Duration     int64           `json:"duration_seconds"`
	Version      int64           `json:"version,string"`
	Questions    []WorkQuestion  `json:"questions"`
	Answers      map[string]bool `json:"answers"`
	Results      map[string]bool `json:"results"`
	Note         string          `json:"review_note"`
}

func (s *Service) SaveWorkTask(ctx context.Context, who AdminIdentity, id string, in WorkTaskInput) (string, error) {
	if !taskKeyPattern.MatchString(in.Key) || !validText(in.Name, 1, 120) || !validText(in.Description, 0, 5000) || in.Estimated < 1 || in.Estimated > 1440 || in.Questions < 2 || in.Questions > 1000 || in.Questions%2 != 0 || in.Order < 0 {
		return "", ErrInvalid
	}
	if len(in.OpenTime) == 5 {
		in.OpenTime += ":00"
	}
	if _, e := time.Parse("15:04:05", in.OpenTime); e != nil {
		return "", ErrInvalid
	}
	intern, e := moneyMillis(in.Intern)
	if e != nil {
		return "", e
	}
	formal, e := moneyMillis(in.Formal)
	if e != nil {
		return "", e
	}
	if max(intern, formal)*int64(in.Questions) > 9999999999 {
		return "", ErrInvalid
	}
	create := id == ""
	if create {
		id = newID()
	}
	if !validID(id) {
		return "", ErrInvalid
	}
	e = s.adminWrite(ctx, who, "tasks", "task.save", "task", id, func(tx pgx.Tx) error {
		if !create {
			var version int64
			if e := tx.QueryRow(ctx, "SELECT version FROM pulse.work_tasks WHERE id=$1 FOR UPDATE", id).Scan(&version); e != nil {
				return e
			}
			if version != in.Expected {
				return ErrConflict
			}
		}
		if in.Enabled {
			for _, answer := range []bool{false, true} {
				var count int
				if e := tx.QueryRow(ctx, "SELECT count(*) FROM(SELECT 1 FROM pulse.work_questions WHERE correct=$1 LIMIT $2)q", answer, in.Questions/2).Scan(&count); e != nil {
					return e
				}
				if count < in.Questions/2 {
					return &Fault{409, "question_pool_insufficient"}
				}
			}
		}
		// Existing daily snapshots keep their count, so also validate today's captured maximum wage.
		var dailyCount int
		if e := tx.QueryRow(ctx, "SELECT COALESCE((SELECT jsonb_array_length(questions) FROM pulse.work_daily WHERE task_id=$1 AND task_date=$2),0)", id, workDate()).Scan(&dailyCount); e != nil {
			return e
		}
		if max(intern, formal)*int64(dailyCount) > 9999999999 {
			return ErrInvalid
		}
		if create {
			_, e := tx.Exec(ctx, "INSERT INTO pulse.work_tasks(id,task_key,name,description,open_time,estimated_minutes,question_count,intern_millis,formal_millis,enabled,sort_order,created_by) VALUES($1,$2,$3,$4,$5::time,$6,$7,$8,$9,$10,$11,$12)", id, in.Key, in.Name, in.Description, in.OpenTime, in.Estimated, in.Questions, intern, formal, in.Enabled, in.Order, who.ID)
			return e
		}
		_, e := tx.Exec(ctx, "UPDATE pulse.work_tasks SET task_key=$2,name=$3,description=$4,open_time=$5::time,estimated_minutes=$6,question_count=$7,intern_millis=$8,formal_millis=$9,enabled=$10,sort_order=$11,version=version+1,updated_at=now() WHERE id=$1", id, in.Key, in.Name, in.Description, in.OpenTime, in.Estimated, in.Questions, intern, formal, in.Enabled, in.Order)
		return e
	})
	return id, e
}
func (s *Service) SaveQuestion(ctx context.Context, who AdminIdentity, id string, in WorkQuestion) (string, error) {
	create := id == ""
	if create {
		id = newID()
		if in.Code == "" {
			in.Code = newID()
		}
	}
	if !validID(id) || (create && !validID(in.Code)) || in.Correct == nil || ((in.MediaID == "") == (in.ImageURL == "")) || (in.MediaID != "" && !validID(in.MediaID)) || (in.ImageURL != "" && !safeURL(in.ImageURL, false)) {
		return "", ErrInvalid
	}
	e := s.adminWrite(ctx, who, "questions", "question.save", "question", id, func(tx pgx.Tx) error {
		if in.MediaID != "" {
			var owned bool
			if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pulse.media m WHERE m.id=$1 AND m.status='ready' AND (m.admin_owner_id=$2 AND m.kind='question' OR EXISTS(SELECT 1 FROM pulse.work_questions q WHERE q.media_id=m.id)))", in.MediaID, who.ID).Scan(&owned); e != nil {
				return e
			}
			if !owned {
				return ErrForbidden
			}
		}
		if create {
			_, e := tx.Exec(ctx, "INSERT INTO pulse.work_questions(id,code,media_id,image_url,correct) VALUES($1,$2,$3,$4,$5)", id, in.Code, optionalUUID(in.MediaID), in.ImageURL, *in.Correct)
			return e
		}
		cmd, e := tx.Exec(ctx, "UPDATE pulse.work_questions SET media_id=$2,image_url=$3,correct=$4,version=version+1,updated_at=now() WHERE id=$1 AND version=$5", id, optionalUUID(in.MediaID), in.ImageURL, *in.Correct, in.Version)
		if e == nil && cmd.RowsAffected() != 1 {
			return ErrConflict
		}
		return e
	})
	return id, e
}
func dailyCodeTx(ctx context.Context, tx pgx.Tx, taskID, date string, reset bool) (string, error) {
	var old string
	e := tx.QueryRow(ctx, "SELECT code FROM pulse.work_codes WHERE task_id=$1 AND task_date=$2", taskID, date).Scan(&old)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return "", e
	}
	if old != "" && !reset {
		return old, nil
	}
	code := old
	for code == old {
		n, e := rand.Int(rand.Reader, big.NewInt(1000000))
		if e != nil {
			return "", e
		}
		code = fmt.Sprintf("%06d", n.Int64())
	}
	_, e = tx.Exec(ctx, "INSERT INTO pulse.work_codes(task_id,task_date,code) VALUES($1,$2,$3) ON CONFLICT(task_id,task_date) DO UPDATE SET code=$3,version=pulse.work_codes.version+1", taskID, date, code)
	return code, e
}
func (s *Service) TaskCode(ctx context.Context, who AdminIdentity, id, date string, reset bool) (string, error) {
	if !validID(id) {
		return "", ErrInvalid
	}
	if _, e := time.Parse("2006-01-02", date); e != nil {
		return "", ErrInvalid
	}
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	if e = lockAdmin(ctx, tx, who, "tasks", reset); e != nil {
		return "", e
	}
	var found string
	if e = tx.QueryRow(ctx, "SELECT id::text FROM pulse.work_tasks WHERE id=$1 FOR UPDATE", id).Scan(&found); e != nil {
		return "", e
	}
	code, e := dailyCodeTx(ctx, tx, id, date, reset)
	if e != nil {
		return "", e
	}
	if reset {
		if e = auditTx(ctx, tx, who, "task.code.reset", "task", id, map[string]string{"date": date}); e != nil {
			return "", e
		}
	}
	return code, tx.Commit(ctx)
}
func (s *Service) StartTask(ctx context.Context, who Identity, id, code string) (WorkRecord, error) {
	if !validID(id) || len(code) != 6 {
		return WorkRecord{}, ErrInvalid
	}
	if e := s.Cache.Allow(ctx, "task-code", who.UserID, 10, time.Minute); e != nil {
		return WorkRecord{}, e
	}
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return WorkRecord{}, e
	}
	defer tx.Rollback(ctx)
	if _, e = lockIdentity(ctx, tx, who); e != nil {
		return WorkRecord{}, e
	}
	var enabled, formal bool
	var opening string
	var count int
	var intern, full int64
	e = tx.QueryRow(ctx, "SELECT enabled,open_time::text,question_count,intern_millis,formal_millis FROM pulse.work_tasks WHERE id=$1 FOR UPDATE", id).Scan(&enabled, &opening, &count, &intern, &full)
	if errors.Is(e, pgx.ErrNoRows) {
		return WorkRecord{}, ErrMissing
	}
	if e != nil {
		return WorkRecord{}, e
	}
	if !enabled {
		return WorkRecord{}, ErrForbidden
	}
	if time.Now().In(workTimezone).Format("15:04:05") < opening {
		return WorkRecord{}, &Fault{409, "task_not_open"}
	}
	date := workDate()
	expected, e := dailyCodeTx(ctx, tx, id, date, false)
	if e != nil {
		return WorkRecord{}, e
	}
	if subtle.ConstantTimeCompare([]byte(code), []byte(expected)) != 1 {
		return WorkRecord{}, &Fault{403, "task_code_invalid"}
	}
	var recordID string
	e = tx.QueryRow(ctx, "SELECT id::text FROM pulse.work_records WHERE task_id=$1 AND user_id=$2 AND task_date=$3", id, who.UserID, date).Scan(&recordID)
	if e == nil {
		if e = tx.Commit(ctx); e != nil {
			return WorkRecord{}, e
		}
		return s.WorkRecord(ctx, who, recordID, false)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return WorkRecord{}, e
	}
	var snapshot []byte
	e = tx.QueryRow(ctx, "SELECT questions FROM pulse.work_daily WHERE task_id=$1 AND task_date=$2", id, date).Scan(&snapshot)
	if errors.Is(e, pgx.ErrNoRows) {
		questions := []WorkQuestion{}
		for _, answer := range []bool{false, true} {
			rows, e := tx.Query(ctx, "SELECT id::text,code::text,COALESCE(media_id::text,''),image_url,correct,version FROM pulse.work_questions WHERE correct=$1 ORDER BY random() LIMIT $2", answer, count/2)
			if e != nil {
				return WorkRecord{}, e
			}
			before := len(questions)
			for rows.Next() {
				var q WorkQuestion
				if e = rows.Scan(&q.ID, &q.Code, &q.MediaID, &q.ImageURL, &q.Correct, &q.Version); e != nil {
					rows.Close()
					return WorkRecord{}, e
				}
				questions = append(questions, q)
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return WorkRecord{}, e
			}
			if len(questions)-before != count/2 {
				return WorkRecord{}, &Fault{409, "question_pool_insufficient"}
			}
		}
		// Shuffle the balanced set so answer category cannot be inferred from its position.
		for i := len(questions) - 1; i > 0; i-- {
			n, e := rand.Int(rand.Reader, big.NewInt(int64(i+1)))
			if e != nil {
				return WorkRecord{}, e
			}
			j := int(n.Int64())
			questions[i], questions[j] = questions[j], questions[i]
		}
		snapshot, _ = json.Marshal(questions)
		if _, e = tx.Exec(ctx, "INSERT INTO pulse.work_daily(task_id,task_date,questions) VALUES($1,$2,$3)", id, date, snapshot); e != nil {
			return WorkRecord{}, e
		}
	} else if e != nil {
		return WorkRecord{}, e
	}
	if e = tx.QueryRow(ctx, "SELECT formal_employee FROM pulse.users WHERE id=$1", who.UserID).Scan(&formal); e != nil {
		return WorkRecord{}, e
	}
	unit, employee := intern, "intern"
	if formal {
		unit, employee = full, "formal"
	}
	var questions []WorkQuestion
	if e = json.Unmarshal(snapshot, &questions); e != nil {
		return WorkRecord{}, e
	}
	if unit*int64(len(questions)) > 9999999999 {
		return WorkRecord{}, ErrInvalid
	}
	recordID = newID()
	if _, e = tx.Exec(ctx, "INSERT INTO pulse.work_records(id,task_id,user_id,task_date,employee_type,unit_millis,questions,total) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", recordID, id, who.UserID, date, employee, unit, snapshot, len(questions)); e != nil {
		return WorkRecord{}, e
	}
	for _, q := range questions {
		if q.MediaID != "" {
			if _, e = tx.Exec(ctx, "INSERT INTO pulse.work_record_media(record_id,media_id) VALUES($1,$2) ON CONFLICT DO NOTHING", recordID, q.MediaID); e != nil {
				return WorkRecord{}, e
			}
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return WorkRecord{}, e
	}
	return s.WorkRecord(ctx, who, recordID, false)
}
func (s *Service) WorkRecord(ctx context.Context, who Identity, id string, admin bool) (WorkRecord, error) {
	var out WorkRecord
	if !validID(id) {
		return out, ErrInvalid
	}
	var raw, answers []byte
	var unit, wage int64
	e := s.Store.Pool.QueryRow(ctx, `SELECT r.id::text,r.task_id::text,r.user_id::text,r.task_date::text,r.employee_type,r.status,r.started_at,r.submitted_at,r.reviewed_at,r.unit_millis,r.wage_millis,r.total,r.correct_count,r.duration_seconds,r.version,r.questions,r.answers,r.results,r.review_note,t.name,u.nickname,COALESCE(u.avatar_id::text,'') FROM pulse.work_records r JOIN pulse.work_tasks t ON t.id=r.task_id JOIN pulse.users u ON u.id=r.user_id WHERE r.id=$1 AND($3 OR r.user_id=$2)`, id, optionalUUID(who.UserID), admin).Scan(&out.ID, &out.TaskID, &out.UserID, &out.Date, &out.Employee, &out.Status, &out.StartedAt, &out.SubmittedAt, &out.ReviewedAt, &unit, &wage, &out.Total, &out.CorrectCount, &out.Duration, &out.Version, &raw, &answers, &out.Results, &out.Note, &out.TaskName, &out.Nickname, &out.AvatarID)
	if errors.Is(e, pgx.ErrNoRows) {
		return out, ErrForbidden
	}
	if e != nil {
		return out, e
	}
	if e = json.Unmarshal(raw, &out.Questions); e != nil {
		return out, e
	}
	if e = json.Unmarshal(answers, &out.Answers); e != nil {
		return out, e
	}
	if out.Results == nil {
		out.Results = map[string]bool{}
	}
	out.Unit, out.Wage = moneyAmount(unit), moneyAmount(wage)
	if !admin {
		for i := range out.Questions {
			out.Questions[i].Correct = nil
		}
	}
	return out, nil
}

type WorkAnswersInput struct {
	Answers  map[string]bool `json:"answers"`
	Expected int64           `json:"expected_version,string"`
}

func (s *Service) SaveWorkAnswers(ctx context.Context, who Identity, id string, in WorkAnswersInput, submit bool) (WorkRecord, error) {
	if !validID(id) || len(in.Answers) > 1000 || in.Expected < 1 {
		return WorkRecord{}, ErrInvalid
	}
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return WorkRecord{}, e
	}
	defer tx.Rollback(ctx)
	if _, e = lockIdentity(ctx, tx, who); e != nil {
		return WorkRecord{}, e
	}
	var status string
	var raw, answers []byte
	var version, unit int64
	e = tx.QueryRow(ctx, "SELECT status,questions,answers,version,unit_millis FROM pulse.work_records WHERE id=$1 AND user_id=$2 FOR UPDATE", id, who.UserID).Scan(&status, &raw, &answers, &version, &unit)
	if errors.Is(e, pgx.ErrNoRows) {
		return WorkRecord{}, ErrForbidden
	}
	if e != nil {
		return WorkRecord{}, e
	}
	if status == "reviewed" && submit {
		if e = tx.Commit(ctx); e != nil {
			return WorkRecord{}, e
		}
		return s.WorkRecord(ctx, who, id, false)
	}
	if status != "in_progress" && status != "pending_review" {
		return WorkRecord{}, ErrConflict
	}
	if version != in.Expected {
		return WorkRecord{}, ErrConflict
	}
	if status == "pending_review" && !submit {
		return WorkRecord{}, ErrConflict
	}
	if status == "pending_review" {
		in.Answers = nil
	}
	var questions []WorkQuestion
	var merged map[string]bool
	if e = json.Unmarshal(raw, &questions); e != nil {
		return WorkRecord{}, e
	}
	if e = json.Unmarshal(answers, &merged); e != nil {
		return WorkRecord{}, e
	}
	valid := map[string]bool{}
	for _, q := range questions {
		valid[q.ID] = true
	}
	for key, value := range in.Answers {
		if !valid[key] {
			return WorkRecord{}, ErrInvalid
		}
		merged[key] = value
	}
	if submit && len(merged) != len(questions) {
		return WorkRecord{}, &Fault{400, "answers_incomplete"}
	}
	correct := 0
	results := map[string]bool{}
	if submit {
		for _, q := range questions {
			if q.Correct == nil {
				return WorkRecord{}, ErrConflict
			}
			match := merged[q.ID] == *q.Correct
			results[q.ID] = match
			if match {
				correct++
			}
		}
	}
	encoded, _ := json.Marshal(merged)
	resultRaw, _ := json.Marshal(results)
	_, e = tx.Exec(ctx, `UPDATE pulse.work_records SET answers=$2,version=version+1,status=CASE WHEN $3 THEN 'reviewed' ELSE status END,correct_count=CASE WHEN $3 THEN $4 ELSE correct_count END,wage_millis=CASE WHEN $3 THEN $5 ELSE wage_millis END,results=CASE WHEN $3 THEN $6 ELSE results END,submitted_at=CASE WHEN $3 THEN COALESCE(submitted_at,now()) ELSE submitted_at END,reviewed_at=CASE WHEN $3 THEN now() ELSE reviewed_at END,duration_seconds=CASE WHEN $3 THEN GREATEST(0,extract(epoch FROM now()-started_at)::bigint) ELSE duration_seconds END WHERE id=$1`, id, encoded, submit, correct, int64(correct)*unit, resultRaw)
	if e != nil {
		return WorkRecord{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return WorkRecord{}, e
	}
	return s.WorkRecord(ctx, who, id, false)
}

const workRecordFilterSQL = `($3='' OR rec.user_id::text=$3 OR EXISTS(SELECT 1 FROM pulse.legacy_ids l WHERE l.entity='user' AND l.new_id=rec.user_id AND l.legacy_id::text=$3))
 AND ($4='' OR rec.task_id::text=$4 OR EXISTS(SELECT 1 FROM pulse.legacy_ids l WHERE l.entity='task' AND l.new_id=rec.task_id AND l.legacy_id::text=$4))
 AND ($5='' OR rec.status=$5) AND ($6='' OR rec.task_date::text=$6)
 AND ($7='' OR rec.task_date::text>=$7) AND ($8='' OR rec.task_date::text<=$8)`

func workRecordFilter(r *http.Request) ([]any, error) {
	q := r.URL.Query()
	for _, key := range []string{"user_id", "task_id"} {
		if id := q.Get(key); id != "" && !validID(id) {
			if n, err := strconv.ParseInt(id, 10, 64); err != nil || n < 1 {
				return nil, ErrInvalid
			}
		}
	}
	if status := q.Get("status"); status != "" && status != "in_progress" && status != "pending_review" && status != "reviewed" {
		return nil, ErrInvalid
	}
	for _, key := range []string{"date", "date_from", "date_to"} {
		if date := q.Get(key); date != "" {
			if _, err := time.Parse("2006-01-02", date); err != nil {
				return nil, ErrInvalid
			}
		}
	}
	if q.Get("date_from") != "" && q.Get("date_to") != "" && q.Get("date_from") > q.Get("date_to") {
		return nil, ErrInvalid
	}
	return []any{q.Get("user_id"), q.Get("task_id"), q.Get("status"), q.Get("date"), q.Get("date_from"), q.Get("date_to")}, nil
}

func (a *API) registerWorkTasks(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/tasks", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		return s.clientTaskPage(w, r, who)
	}))
	mux.HandleFunc("POST /api/v2/tasks/{id}/start", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			Code string `json:"code"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		v, e := s.StartTask(r.Context(), who, r.PathValue("id"), in.Code)
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/task-records/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		v, e := s.WorkRecord(r.Context(), who, r.PathValue("id"), false)
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
	for _, action := range []string{"answers", "submit"} {
		submit := action == "submit"
		mux.HandleFunc("PUT /api/v2/task-records/{id}/"+action, a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
			var in WorkAnswersInput
			if e := decodeLimit(w, r, &in, 128<<10); e != nil {
				return e
			}
			v, e := s.SaveWorkAnswers(r.Context(), who, r.PathValue("id"), in, submit)
			if e == nil {
				writeJSON(w, 200, v)
			}
			return e
		}))
	}
	mux.HandleFunc("GET /api/v2/admin/tasks", a.adminWrap("tasks", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		values := r.URL.Query()
		for _, key := range []string{"q", "key", "name"} {
			if len(values.Get(key)) > 128 {
				return ErrInvalid
			}
		}
		status := values.Get("status")
		if status != "" && status != "enabled" && status != "disabled" {
			return ErrInvalid
		}
		pattern := func(value string) string {
			return "%" + strings.NewReplacer("%", "\\%", "_", "\\_").Replace(value) + "%"
		}
		return adminRows(w, r, s, "SELECT to_jsonb(t)||jsonb_build_object('version',version::text,'intern_unit_price',to_char(intern_millis::numeric/1000,'FM999999990.000'),'formal_unit_price',to_char(formal_millis::numeric/1000,'FM999999990.000')) FROM pulse.work_tasks t WHERE(task_key ILIKE $3 OR name ILIKE $3) AND task_key ILIKE $4 AND name ILIKE $5 AND($6='' OR enabled=($6='enabled')) ORDER BY sort_order,id LIMIT $1 OFFSET $2", pattern(values.Get("q")), pattern(values.Get("key")), pattern(values.Get("name")), status)
	}))
	for _, path := range []string{"POST /api/v2/admin/tasks", "PUT /api/v2/admin/tasks/{id}"} {
		mux.HandleFunc(path, a.adminWrap("tasks", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
			var in WorkTaskInput
			if e := decode(w, r, &in); e != nil {
				return e
			}
			id, e := s.SaveWorkTask(r.Context(), who, r.PathValue("id"), in)
			if e == nil {
				writeJSON(w, 200, map[string]string{"id": id})
			}
			return e
		}))
	}
	mux.HandleFunc("DELETE /api/v2/admin/tasks/{id}", a.adminWrap("tasks", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		id := r.PathValue("id")
		if !validID(id) {
			return ErrInvalid
		}
		e := s.adminWrite(r.Context(), who, "tasks", "task.delete", "task", id, func(tx pgx.Tx) error {
			var found string
			if e := tx.QueryRow(r.Context(), "SELECT id::text FROM pulse.work_tasks WHERE id=$1 FOR UPDATE", id).Scan(&found); e != nil {
				return e
			}
			var used bool
			if e := tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM pulse.work_records WHERE task_id=$1)", id).Scan(&used); e != nil {
				return e
			}
			if used {
				return &Fault{409, "task_has_records"}
			}
			_, e := tx.Exec(r.Context(), "DELETE FROM pulse.work_tasks WHERE id=$1", id)
			return e
		})
		if e == nil {
			w.WriteHeader(204)
		}
		return e
	}))
	for _, method := range []string{"GET", "POST"} {
		reset := method == "POST"
		mux.HandleFunc(method+" /api/v2/admin/tasks/{id}/code", a.adminWrap("tasks", reset, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
			date := r.URL.Query().Get("date")
			if date == "" {
				date = workDate()
			}
			v, e := s.TaskCode(r.Context(), who, r.PathValue("id"), date, reset)
			if e == nil {
				writeJSON(w, 200, map[string]string{"date": date, "code": v})
			}
			return e
		}))
	}
	mux.HandleFunc("GET /api/v2/admin/questions", a.adminWrap("questions", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		return adminRows(w, r, s, "SELECT to_jsonb(q)||jsonb_build_object('version',version::text) FROM pulse.work_questions q WHERE code::text ILIKE $3 AND($4='' OR correct::text=$4) ORDER BY created_at DESC,id LIMIT $1 OFFSET $2", "%"+r.URL.Query().Get("q")+"%", r.URL.Query().Get("correct"))
	}))
	for _, path := range []string{"POST /api/v2/admin/questions", "PUT /api/v2/admin/questions/{id}"} {
		mux.HandleFunc(path, a.adminWrap("questions", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
			var in WorkQuestion
			if e := decode(w, r, &in); e != nil {
				return e
			}
			id, e := s.SaveQuestion(r.Context(), who, r.PathValue("id"), in)
			if e == nil {
				writeJSON(w, 200, map[string]string{"id": id})
			}
			return e
		}))
	}
	mux.HandleFunc("POST /api/v2/admin/questions/delete", a.adminWrap("questions", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in struct {
			IDs []string `json:"ids"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if len(in.IDs) < 1 || len(in.IDs) > 100 {
			return ErrInvalid
		}
		for _, id := range in.IDs {
			if !validID(id) {
				return ErrInvalid
			}
		}
		e := s.adminWrite(r.Context(), who, "questions", "question.delete", "question", "", func(tx pgx.Tx) error {
			_, e := tx.Exec(r.Context(), "DELETE FROM pulse.work_questions WHERE id=ANY($1::uuid[])", in.IDs)
			return e
		})
		if e == nil {
			w.WriteHeader(204)
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/admin/task-records", a.adminWrap("records", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		filters, err := workRecordFilter(r)
		if err != nil {
			return err
		}
		return adminRows(w, r, s, `SELECT (to_jsonb(rec)-'questions'-'answers'-'results'-'review_hash')||jsonb_build_object('version',rec.version::text,'wage',to_char(wage_millis::numeric/1000,'FM999999990.000'),'unit_price',to_char(unit_millis::numeric/1000,'FM999999990.000'),'task_name',t.name,'nickname',u.nickname,'avatar_id',u.avatar_id) FROM pulse.work_records rec JOIN pulse.users u ON u.id=rec.user_id JOIN pulse.work_tasks t ON t.id=rec.task_id WHERE `+workRecordFilterSQL+` ORDER BY rec.task_date DESC,rec.id LIMIT $1 OFFSET $2`, filters...)
	}))
	mux.HandleFunc("GET /api/v2/admin/task-records/{id}", a.adminWrap("records", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		v, e := s.WorkRecord(r.Context(), Identity{}, r.PathValue("id"), true)
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
}
