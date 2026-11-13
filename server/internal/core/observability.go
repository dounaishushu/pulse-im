package core

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"runtime"
	"runtime/debug"
	"time"
)

func (s *Service) ObserveWorker(ctx context.Context, name string, fn func(context.Context) error) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = &Fault{503, "worker_panic"}
			slog.Error("background worker recovered", "worker", name)
		}
		code := ""
		if err != nil {
			code = "temporarily_unavailable"
			var fault *Fault
			if errors.As(err, &fault) {
				code = fault.Code
			}
		}
		finish, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_, _ = s.Store.Pool.Exec(finish, `INSERT INTO pulse.worker_heartbeats(name,last_started,last_finished,last_success,error_code,runs) VALUES($1,now(),now(),CASE WHEN $2='' THEN now() END,$2,1) ON CONFLICT(name) DO UPDATE SET last_started=now(),last_finished=now(),last_success=CASE WHEN $2='' THEN now() ELSE pulse.worker_heartbeats.last_success END,error_code=$2,runs=pulse.worker_heartbeats.runs+1`, name, code)
	}()
	return fn(ctx)
}
func (a *API) registerObservability(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/admin/health", a.adminWrap("stats", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		started := time.Now()
		dbErr := s.Store.Pool.Ping(r.Context())
		dbMS := time.Since(started).Milliseconds()
		redisErr := s.Cache.Client.Ping(r.Context()).Err()
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		var queues []byte
		e := s.Store.Pool.QueryRow(r.Context(), `SELECT jsonb_build_object('message_outbox',(SELECT count(*) FROM pulse.outbox),'oldest_outbox_seconds',COALESCE((SELECT extract(epoch FROM now()-min(created_at)) FROM pulse.outbox),0),'media_pending',(SELECT count(*) FROM pulse.media WHERE status IN('pending','receiving','queued','processing')),'media_failed',(SELECT count(*) FROM pulse.media WHERE status='failed'),'send_pending',(SELECT count(*) FROM pulse.send_batches WHERE status IN('pending','running')),'push_pending',(SELECT count(*) FROM pulse.push_jobs),'telegram_pending',(SELECT count(*) FROM pulse.telegram_updates WHERE status='pending'),'maintenance_pending',(SELECT count(*) FROM pulse.maintenance_runs WHERE status IN('pending','running')),'workers',COALESCE((SELECT jsonb_agg(to_jsonb(h)) FROM pulse.worker_heartbeats h),'[]'::jsonb))`).Scan(&queues)
		if e != nil {
			return e
		}
		stat := s.Store.Pool.Stat()
		out := map[string]any{"database_ready": dbErr == nil, "database_latency_ms": dbMS, "redis_ready": redisErr == nil, "websocket_connections": len(a.Hub.SessionIDs()), "queued_ws_bytes": a.Hub.queuedBytes.Load(), "goroutines": runtime.NumGoroutine(), "heap_alloc_bytes": mem.HeapAlloc, "heap_sys_bytes": mem.HeapSys, "gc_cycles": mem.NumGC, "gc_pause_total_ns": mem.PauseTotalNs, "gomaxprocs": runtime.GOMAXPROCS(0), "go_memory_limit_bytes": debug.SetMemoryLimit(-1), "db_connections": stat.TotalConns(), "db_acquired": stat.AcquiredConns(), "db_empty_acquires": stat.EmptyAcquireCount(), "queues": json.RawMessage(queues), "apns_configured": s.Push.Available("ios"), "fcm_configured": s.Push.Available("android"), "telegram_configured": s.Telegram.Enabled()}
		if s.Media != nil {
			free, _ := storageFree(s.Media.root)
			out["media_free_bytes"] = free
			out["media_active_uploads"] = len(s.Media.uploads)
			out["media_probe_configured"] = s.Media.probe != ""
		}
		writeJSON(w, 200, out)
		return nil
	}))
}
