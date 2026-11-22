package core

import (
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/robfig/cron/v3"
	"net/http"
	"strings"
	"time"
)

var dispatchCronParser = cron.NewParser(cron.SecondOptional | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)

func nextDispatchCronTime(expression string, now time.Time) (time.Time, error) {
	expression = strings.TrimSpace(expression)
	if (strings.HasPrefix(expression, "TZ=") || strings.HasPrefix(expression, "CRON_TZ=")) && !strings.Contains(expression, " ") {
		return time.Time{}, &Fault{400, "dispatch_cron_invalid"}
	}
	schedule, err := dispatchCronParser.Parse(expression)
	if err != nil {
		return time.Time{}, &Fault{400, "dispatch_cron_invalid"}
	}
	next := schedule.Next(now.In(workTimezone))
	if next.IsZero() {
		return time.Time{}, &Fault{400, "dispatch_cron_invalid"}
	}
	return next.UTC(), nil
}

type dispatchScheduleInput struct {
	Cron   string     `json:"cron"`
	RunAt  *time.Time `json:"run_at"`
	Delays []int      `json:"delays_seconds"`
}
type dispatchSchedulePreview struct {
	BaseAt   time.Time   `json:"base_at"`
	Steps    []time.Time `json:"steps"`
	Timezone string      `json:"timezone"`
}

func previewDispatchSchedule(in dispatchScheduleInput, now time.Time) (dispatchSchedulePreview, error) {
	out := dispatchSchedulePreview{Timezone: "Asia/Shanghai", Steps: []time.Time{}}
	if (in.Cron == "") == (in.RunAt == nil) || len(in.Delays) < 1 || len(in.Delays) > 100 {
		return out, ErrInvalid
	}
	if in.Cron != "" {
		base, err := nextDispatchCronTime(in.Cron, now)
		if err != nil {
			return out, err
		}
		out.BaseAt = base
	} else {
		out.BaseAt = in.RunAt.UTC()
	}
	due := out.BaseAt
	for _, delay := range in.Delays {
		if delay < 0 || delay > 86400 {
			return out, ErrInvalid
		}
		due = due.Add(time.Duration(delay) * time.Second)
		out.Steps = append(out.Steps, due)
	}
	return out, nil
}
func (a *API) registerDispatchSchedule(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v2/admin/dispatch-plans/preview", a.adminWrap("dispatch", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in dispatchScheduleInput
		if err := decode(w, r, &in); err != nil {
			return err
		}
		preview, err := previewDispatchSchedule(in, time.Now())
		if err == nil {
			writeJSON(w, 200, preview)
		}
		return err
	}))
	mux.HandleFunc("GET /api/v2/admin/dispatch-plans/{id}", a.adminWrap("dispatch", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		id := r.PathValue("id")
		if !validID(id) {
			return ErrInvalid
		}
		var result json.RawMessage
		err := a.Service.Store.Pool.QueryRow(r.Context(), `SELECT to_jsonb(p)||jsonb_build_object('version',version::text) FROM pulse.dispatch_plans p WHERE id=$1`, id).Scan(&result)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrMissing
		}
		if err != nil {
			return err
		}
		writeJSON(w, 200, result)
		return nil
	}))
}
