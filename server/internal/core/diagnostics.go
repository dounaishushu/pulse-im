package core

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

func (a *API) registerDiagnostics(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("POST /api/v2/client/diagnostics", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			Platform string          `json:"platform"`
			Version  string          `json:"version"`
			Report   json.RawMessage `json:"report"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		if len(in.Report) == 0 || len(in.Report) > 24<<10 || !validText(in.Version, 1, 64) {
			return ErrInvalid
		}
		switch in.Platform {
		case "pc", "web", "android", "ios":
		default:
			return ErrInvalid
		}
		var meta struct {
			Schema int    `json:"schema_version"`
			ID     string `json:"diagnostic_id"`
		}
		if err := json.Unmarshal(in.Report, &meta); err != nil {
			return ErrInvalid
		}
		id := newID()
		if meta.Schema == 2 {
			if !validID(meta.ID) {
				return ErrInvalid
			}
			id = meta.ID
		}
		reply := func() {
			result := map[string]any{"id": id}
			if meta.Schema == 2 {
				result["schema_version"] = 2
				result["diagnostic_id"] = meta.ID
				result["report_id"] = id
			}
			writeJSON(w, http.StatusCreated, result)
		}
		find := func() (bool, error) {
			var same bool
			err := s.Store.Pool.QueryRow(r.Context(), "SELECT report=$3::jsonb AND platform=$4 FROM pulse.client_diagnostics WHERE id=$1 AND user_id=$2", id, who.UserID, in.Report, in.Platform).Scan(&same)
			if errors.Is(err, pgx.ErrNoRows) {
				return false, nil
			}
			if err != nil {
				return false, err
			}
			if !same {
				return false, ErrConflict
			}
			return true, nil
		}
		// 重试同一份报告只返回确认，不重复占用额度，也不把旧故障当作新事件入库。
		if meta.Schema == 2 {
			found, err := find()
			if err != nil {
				return err
			}
			if found {
				reply()
				return nil
			}
		}
		if err := s.Cache.Allow(r.Context(), "diagnostics", who.UserID, 5, time.Hour); err != nil {
			return err
		}
		command, err := s.Store.Pool.Exec(r.Context(), "INSERT INTO pulse.client_diagnostics(id,user_id,platform,version,report) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING", id, who.UserID, in.Platform, in.Version, in.Report)
		if err != nil {
			return err
		}
		if command.RowsAffected() == 0 {
			found, err := find()
			if err != nil {
				return err
			}
			if !found {
				return ErrConflict
			}
		}
		reply()
		return nil
	}))
}
