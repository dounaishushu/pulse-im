package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/robfig/cron/v3"
	"net/http"
	"time"
)

type SendOperation struct {
	ConversationID string    `json:"conversation_id"`
	Input          SendInput `json:"input"`
	DelaySeconds   int       `json:"delay_seconds"`
}

func (s *Service) CreateSendBatch(ctx context.Context, who Identity, requestID, kind string, ops []SendOperation, plan string, version int64) (string, error) {
	if !requestPattern.MatchString(requestID) || len(ops) == 0 || len(ops) > 10000 {
		return "", ErrInvalid
	}
	for _, op := range ops {
		if !validID(op.ConversationID) || op.DelaySeconds < 0 || op.DelaySeconds > 86400 {
			return "", ErrInvalid
		}
		copy := op.Input
		copy.RequestID = "validate"
		if e := validateSend(copy); e != nil {
			return "", e
		}
	}
	raw, _ := json.Marshal(struct {
		Kind string
		Ops  []SendOperation
	}{kind, ops})
	fingerprint := digest(string(raw))
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	internal, e := lockIdentity(ctx, tx, who)
	if e != nil {
		return "", e
	}
	if kind == "broadcast" && !internal {
		return "", ErrForbidden
	}
	if kind == "dispatch" && who.administrator == nil {
		return "", ErrForbidden
	}
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,7155))", who.UserID); e != nil {
		return "", e
	}
	var id string
	var prior []byte
	e = tx.QueryRow(ctx, "SELECT id::text,request_hash FROM pulse.send_batches WHERE user_id=$1 AND request_id=$2", who.UserID, requestID).Scan(&id, &prior)
	if e == nil {
		if !equalBytes(prior, fingerprint) {
			return "", ErrConflict
		}
		return id, tx.Commit(ctx)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return "", e
	}
	var pending int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM pulse.send_batches WHERE user_id=$1 AND status IN('pending','running')", who.UserID).Scan(&pending); e != nil {
		return "", e
	}
	if pending >= 10 {
		return "", &Fault{429, "send_queue_full"}
	}
	id = newID()
	var admin any
	if who.administrator != nil {
		admin = who.administrator.ID
	}
	_, e = tx.Exec(ctx, "INSERT INTO pulse.send_batches(id,user_id,session_id,admin_id,plan_id,plan_version,request_id,request_hash,kind,total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", id, who.UserID, optionalUUID(who.SessionID), admin, optionalUUID(plan), version, requestID, fingerprint, kind, len(ops))
	if e != nil {
		return "", e
	}
	values := make([][]any, 0, len(ops))
	due := time.Now().UTC()
	for i, op := range ops {
		due = due.Add(time.Duration(op.DelaySeconds) * time.Second)
		op.Input.RequestID = fmt.Sprintf("batch:%s:%d", id, i)
		payload, _ := json.Marshal(op.Input)
		values = append(values, []any{id, i, op.ConversationID, payload, due})
	}
	if _, e = tx.CopyFrom(ctx, pgx.Identifier{"pulse", "send_batch_items"}, []string{"batch_id", "ordinal", "conversation_id", "payload", "due_at"}, pgx.CopyFromRows(values)); e != nil {
		return "", e
	}
	return id, tx.Commit(ctx)
}
func lockSendExecution(ctx context.Context, tx pgx.Tx, who Identity) error {
	if who.batchID != "" {
		var state string
		if e := tx.QueryRow(ctx, "SELECT status FROM pulse.send_batches WHERE id=$1 FOR SHARE", who.batchID).Scan(&state); e != nil {
			return e
		}
		if state != "pending" && state != "running" {
			return &Fault{409, "batch_cancelled"}
		}
	}
	if who.planID != "" {
		var enabled bool
		var version int64
		if e := tx.QueryRow(ctx, "SELECT enabled,version FROM pulse.dispatch_plans WHERE id=$1 FOR SHARE", who.planID).Scan(&enabled, &version); e != nil {
			return e
		}
		if !enabled || version != who.planVersion {
			return &Fault{409, "dispatch_cancelled"}
		}
	}
	return nil
}
func (s *Service) ProcessSendOnce(ctx context.Context) (bool, error) {
	type job struct {
		batch, cid, lease string
		ordinal           int
		who               Identity
		payload           []byte
	}
	j := job{lease: newID()}
	var admin, plan string
	var session string
	var version int64
	e := s.Store.Pool.QueryRow(ctx, `WITH candidate AS(SELECT i.batch_id,i.ordinal FROM pulse.send_batch_items i JOIN pulse.send_batches b ON b.id=i.batch_id WHERE b.status IN('pending','running') AND i.due_at<=now() AND(i.status='pending' OR(i.status='running' AND i.lease_until<now())) AND NOT EXISTS(SELECT 1 FROM pulse.send_batch_items p WHERE p.batch_id=i.batch_id AND p.ordinal<i.ordinal AND p.status IN('pending','running')) ORDER BY i.due_at,i.batch_id,i.ordinal LIMIT 1 FOR UPDATE OF i SKIP LOCKED)
 UPDATE pulse.send_batch_items i SET status='running',lease_token=$1,lease_until=now()+interval '20 seconds',attempts=attempts+1 FROM candidate c,pulse.send_batches b WHERE i.batch_id=c.batch_id AND i.ordinal=c.ordinal AND b.id=i.batch_id RETURNING i.batch_id::text,i.ordinal,i.conversation_id::text,i.payload,b.user_id::text,COALESCE(b.session_id::text,''),COALESCE(b.admin_id::text,''),COALESCE(b.plan_id::text,''),COALESCE(b.plan_version,0)`, j.lease).Scan(&j.batch, &j.ordinal, &j.cid, &j.payload, &j.who.UserID, &session, &admin, &plan, &version)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	j.who.SessionID = session
	j.who.batchID = j.batch
	j.who.planID = plan
	j.who.planVersion = version
	if admin != "" {
		j.who.administrator = &AdminIdentity{ID: admin, RequestID: newID()}
		j.who.adminModule = "dispatch"
	}
	_, _ = s.Store.Pool.Exec(ctx, "UPDATE pulse.send_batches SET status='running',updated_at=now() WHERE id=$1 AND status='pending'", j.batch)
	var input SendInput
	e = json.Unmarshal(j.payload, &input)
	var result SendResult
	if e == nil {
		if plan != "" {
			result, e = s.SendCompound(ctx, j.who, j.cid, input)
		} else {
			result, e = s.Send(ctx, j.who, j.cid, input)
		}
	}
	code := ""
	status := "sent"
	retry := false
	if e != nil {
		status = "failed"
		code = "delivery_failed"
		var f *Fault
		if errors.As(e, &f) {
			code = f.Code
			retry = f.Status == 429 || f.Status == 503
		} else {
			retry = true
		}
	}
	finish, done := context.WithTimeout(context.Background(), 3*time.Second)
	defer done()
	if retry {
		_, e = s.Store.Pool.Exec(finish, `UPDATE pulse.send_batch_items SET status=CASE WHEN attempts<5 THEN 'pending' ELSE 'failed' END,due_at=now()+make_interval(secs=>LEAST(30,attempts*2)),error_code=$4,lease_token=NULL,lease_until=NULL WHERE batch_id=$1 AND ordinal=$2 AND lease_token=$3`, j.batch, j.ordinal, j.lease, code)
	} else {
		_, e = s.Store.Pool.Exec(finish, `UPDATE pulse.send_batch_items SET status=$4,error_code=$5,message_id=$6,lease_token=NULL,lease_until=NULL WHERE batch_id=$1 AND ordinal=$2 AND lease_token=$3`, j.batch, j.ordinal, j.lease, status, code, optionalUUID(result.Message.ID))
	}
	if e != nil {
		return true, e
	}
	_, e = s.Store.Pool.Exec(finish, `UPDATE pulse.send_batches b SET status=CASE WHEN EXISTS(SELECT 1 FROM pulse.send_batch_items i WHERE i.batch_id=b.id AND i.status='failed') THEN 'partial' ELSE 'completed' END,updated_at=now() WHERE b.id=$1 AND b.status IN('pending','running') AND NOT EXISTS(SELECT 1 FROM pulse.send_batch_items i WHERE i.batch_id=b.id AND i.status IN('pending','running'))`, j.batch)
	return true, e
}

type DispatchInput struct {
	Name     string      `json:"name"`
	SenderID string      `json:"sender_id"`
	Targets  []string    `json:"conversation_ids"`
	Steps    []SendInput `json:"steps"`
	Delays   []int       `json:"delays_seconds"`
	Cron     string      `json:"cron"`
	RunAt    *time.Time  `json:"run_at"`
	Enabled  bool        `json:"enabled"`
	Expected int64       `json:"expected_version,string"`
}

func (s *Service) SaveDispatch(ctx context.Context, who AdminIdentity, id string, in DispatchInput) (string, error) {
	if !validText(in.Name, 1, 120) || !validID(in.SenderID) || len(in.Targets) < 1 || len(in.Targets) > 100 || len(in.Steps) < 1 || len(in.Steps) > 100 || len(in.Delays) != len(in.Steps) || (in.Cron == "") == (in.RunAt == nil) {
		return "", ErrInvalid
	}
	seen := map[string]bool{}
	for _, id := range in.Targets {
		if !validID(id) || seen[id] {
			return "", ErrInvalid
		}
		seen[id] = true
	}
	for i, step := range in.Steps {
		step.RequestID = "validate"
		if e := validateSend(step); e != nil {
			return "", e
		}
		if step.Kind != "" && step.Kind != "text" && step.Kind != "image" {
			return "", ErrInvalid
		}
		if !validText(step.Body, 0, 2000) || in.Delays[i] < 0 || in.Delays[i] > 86400 {
			return "", ErrInvalid
		}
	}
	var next time.Time
	if in.Cron != "" {
		schedule, e := cron.ParseStandard(in.Cron)
		if e != nil {
			return "", ErrInvalid
		}
		next = schedule.Next(time.Now().In(workTimezone))
		if next.IsZero() {
			return "", ErrInvalid
		}
	} else {
		next = *in.RunAt
		if !next.After(time.Now()) {
			return "", ErrInvalid
		}
	}
	create := id == ""
	if create {
		id = newID()
	}
	if !validID(id) {
		return "", ErrInvalid
	}
	payload, _ := json.Marshal(in)
	e := s.adminWrite(ctx, who, "dispatch", "dispatch.save", "dispatch", id, func(tx pgx.Tx) error {
		var active bool
		if e := tx.QueryRow(ctx, "SELECT active FROM pulse.users WHERE id=$1", in.SenderID).Scan(&active); e != nil {
			return e
		}
		if !active {
			return ErrForbidden
		}
		if create {
			_, e := tx.Exec(ctx, "INSERT INTO pulse.dispatch_plans(id,admin_id,sender_id,name,payload,cron,run_at,next_run,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", id, who.ID, in.SenderID, in.Name, payload, in.Cron, in.RunAt, next, in.Enabled)
			return e
		}
		var version int64
		if e := tx.QueryRow(ctx, "SELECT version FROM pulse.dispatch_plans WHERE id=$1 FOR UPDATE", id).Scan(&version); e != nil {
			return e
		}
		if version != in.Expected {
			return ErrConflict
		}
		var running bool
		if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pulse.send_batches WHERE plan_id=$1 AND status IN('pending','running'))", id).Scan(&running); e != nil {
			return e
		}
		if running && in.Enabled {
			return &Fault{409, "dispatch_running"}
		}
		_, e := tx.Exec(ctx, "UPDATE pulse.dispatch_plans SET sender_id=$2,name=$3,payload=$4,cron=$5,run_at=$6,next_run=$7,enabled=$8,version=version+1,updated_at=now() WHERE id=$1", id, in.SenderID, in.Name, payload, in.Cron, in.RunAt, next, in.Enabled)
		return e
	})
	return id, e
}
func (s *Service) ScheduleDispatchOnce(ctx context.Context) (bool, error) {
	// The due instant is part of the durable batch key, including after scheduler restart.
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return false, e
	}
	defer tx.Rollback(ctx)
	var id, admin, sender, cronExpr string
	var raw []byte
	var version int64
	var due time.Time
	e = tx.QueryRow(ctx, `SELECT id::text,admin_id::text,sender_id::text,payload,version,next_run,cron FROM pulse.dispatch_plans WHERE enabled AND next_run<=now() ORDER BY next_run,id LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id, &admin, &sender, &raw, &version, &due, &cronExpr)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	var in DispatchInput
	if e = json.Unmarshal(raw, &in); e != nil {
		return true, e
	}
	var role string
	var permissions []string
	e = tx.QueryRow(ctx, "SELECT role,permissions FROM pulse.admin_accounts WHERE id=$1 AND active", admin).Scan(&role, &permissions)
	if e != nil || !adminPermission(role, permissions, "dispatch", true) {
		_, e = tx.Exec(ctx, "UPDATE pulse.dispatch_plans SET enabled=false,last_status='permission_revoked' WHERE id=$1", id)
		if e == nil {
			e = tx.Commit(ctx)
		}
		return true, e
	}
	// Schedule an idempotent batch outside the row lock; next_run is advanced only after durable admission.
	if e = tx.Commit(ctx); e != nil {
		return true, e
	}
	ops := []SendOperation{}
	for i, input := range in.Steps {
		for j, cid := range in.Targets {
			delay := 0
			if j == 0 {
				delay = in.Delays[i]
			}
			ops = append(ops, SendOperation{cid, input, delay})
		}
	}

	who := Identity{UserID: sender, administrator: &AdminIdentity{ID: admin, RequestID: newID()}, adminModule: "dispatch"}
	request := fmt.Sprintf("dispatch:%s:%d", id, due.Unix())
	_, e = s.CreateSendBatch(ctx, who, request, "dispatch", ops, id, version)
	if e != nil {
		return true, e
	}
	var next any
	if cronExpr != "" {
		parsed, err := cron.ParseStandard(cronExpr)
		if err != nil {
			return true, err
		}
		next = parsed.Next(time.Now().In(workTimezone)).UTC()
	}
	_, e = s.Store.Pool.Exec(ctx, "UPDATE pulse.dispatch_plans SET next_run=$3,last_status='queued',updated_at=now() WHERE id=$1 AND version=$2 AND next_run=$4", id, version, next, due)
	return true, e
}
func (s *Service) RunDeliveryJobs(ctx context.Context) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	nextSchedule := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if time.Now().After(nextSchedule) {
			pass, cancel := context.WithTimeout(ctx, 8*time.Second)
			_ = s.ObserveWorker(pass, "dispatch.scheduler", func(c context.Context) error { _, e := s.ScheduleDispatchOnce(c); return e })
			cancel()
			nextSchedule = time.Now().Add(time.Second)
		}
		for i := 0; i < 16; i++ {
			pass, cancel := context.WithTimeout(ctx, 8*time.Second)
			var done bool
			e := s.ObserveWorker(pass, "send.queue", func(c context.Context) error { var err error; done, err = s.ProcessSendOnce(c); return err })
			cancel()
			if !done || e != nil || ctx.Err() != nil {
				break
			}
		}
	}
}
func (a *API) registerDeliveryJobs(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("POST /api/v2/forward-batches", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			RequestID string   `json:"request_id"`
			Sources   []string `json:"message_ids"`
			Targets   []string `json:"conversation_ids"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if len(in.Sources) < 1 || len(in.Sources) > 100 || len(in.Targets) < 1 || len(in.Targets) > 100 {
			return ErrInvalid
		}
		ops := []SendOperation{}
		for _, cid := range in.Targets {
			for _, mid := range in.Sources {
				ops = append(ops, SendOperation{ConversationID: cid, Input: SendInput{SourceMessageID: mid}})
			}
		}
		id, e := s.CreateSendBatch(r.Context(), who, in.RequestID, "forward", ops, "", 0)
		if e == nil {
			writeJSON(w, 202, map[string]string{"id": id})
		}
		return e
	}))
	mux.HandleFunc("POST /api/v2/broadcasts", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			RequestID   string   `json:"request_id"`
			Targets     []string `json:"conversation_ids"`
			Body        string   `json:"body"`
			Attachments []struct {
				ID   string `json:"id"`
				Kind string `json:"kind"`
			} `json:"attachments"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if len(in.Targets) < 1 || len(in.Targets) > 100 || len(in.Attachments) > 10 || !validText(in.Body, 0, 5000) {
			return ErrInvalid
		}
		ops := []SendOperation{}
		for _, cid := range in.Targets {
			if in.Body != "" {
				ops = append(ops, SendOperation{ConversationID: cid, Input: SendInput{Body: in.Body}})
			}
			for _, item := range in.Attachments {
				if item.Kind != "image" && item.Kind != "video" {
					return ErrInvalid
				}
				ops = append(ops, SendOperation{ConversationID: cid, Input: SendInput{Kind: item.Kind, MediaID: item.ID}})
			}
		}
		id, e := s.CreateSendBatch(r.Context(), who, in.RequestID, "broadcast", ops, "", 0)
		if e == nil {
			writeJSON(w, 202, map[string]string{"id": id})
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/send-batches/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		id := r.PathValue("id")
		if !validID(id) {
			return ErrInvalid
		}
		return adminRows(w, r, s, `SELECT jsonb_build_object('ordinal',i.ordinal,'conversation_id',i.conversation_id,'status',i.status,'error_code',i.error_code,'message_id',i.message_id,'attempts',i.attempts,'batch_status',b.status,'total',b.total) FROM pulse.send_batch_items i JOIN pulse.send_batches b ON b.id=i.batch_id WHERE i.batch_id=$3 AND b.user_id=$4 ORDER BY i.ordinal LIMIT $1 OFFSET $2`, id, who.UserID)
	}))
	mux.HandleFunc("DELETE /api/v2/send-batches/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		id := r.PathValue("id")
		if !validID(id) {
			return ErrInvalid
		}
		cmd, e := s.Store.Pool.Exec(r.Context(), "UPDATE pulse.send_batches SET status='cancelled',updated_at=now() WHERE id=$1 AND user_id=$2 AND admin_id IS NULL AND status IN('pending','running','partial')", id, who.UserID)
		if e != nil {
			return e
		}
		if cmd.RowsAffected() == 0 {
			return ErrConflict
		}
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/admin/dispatch-plans", a.adminWrap("dispatch", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		return adminRows(w, r, s, "SELECT to_jsonb(p)||jsonb_build_object('version',version::text) FROM pulse.dispatch_plans p ORDER BY created_at DESC,id LIMIT $1 OFFSET $2")
	}))
	for _, path := range []string{"POST /api/v2/admin/dispatch-plans", "PUT /api/v2/admin/dispatch-plans/{id}"} {
		mux.HandleFunc(path, a.adminWrap("dispatch", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
			var in DispatchInput
			if e := decodeLimit(w, r, &in, 512<<10); e != nil {
				return e
			}
			id, e := s.SaveDispatch(r.Context(), who, r.PathValue("id"), in)
			if e == nil {
				writeJSON(w, 200, map[string]string{"id": id})
			}
			return e
		}))
	}
	mux.HandleFunc("GET /api/v2/admin/dispatch-runs", a.adminWrap("dispatch", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		return adminRows(w, r, s, "SELECT to_jsonb(b)-'request_hash' FROM pulse.send_batches b WHERE kind='dispatch' ORDER BY created_at DESC,id LIMIT $1 OFFSET $2")
	}))
}
