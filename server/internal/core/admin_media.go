package core

import (
	"net/http"
	"os"
	"time"
)

func (a *API) registerAdminMedia(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("POST /api/v2/admin/media/uploads", a.adminWrap("", false, func(w http.ResponseWriter, r *http.Request, admin AdminIdentity) error {
		var in UploadInput
		if e := decode(w, r, &in); e != nil {
			return e
		}
		module := ""
		switch in.Kind {
		case "question":
			module = "questions"
		case "avatar":
			module = "users"
		case "image", "video":
			module = "dispatch"
		default:
			return ErrForbidden
		}
		who := Identity{administrator: &admin, adminModule: module}
		v, e := s.CreateUpload(r.Context(), who, in)
		if e == nil {
			writeJSON(w, 201, v)
		}
		return e
	}))
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		path := method + " /api/v2/admin/media/{id}"
		if method == "PUT" {
			path += "/bytes"
		}
		mux.HandleFunc(path, a.adminWrap("", false, func(w http.ResponseWriter, r *http.Request, admin AdminIdentity) error {
			id := r.PathValue("id")
			if !validID(id) {
				return ErrInvalid
			}
			var kind string
			e := s.Store.Pool.QueryRow(r.Context(), "SELECT kind FROM pulse.media WHERE id=$1 AND admin_owner_id=$2", id, admin.ID).Scan(&kind)
			if e != nil {
				return ErrForbidden
			}
			module := "dispatch"
			if kind == "question" {
				module = "questions"
			}
			if kind == "avatar" {
				module = "users"
			}
			if !adminPermission(admin.Role, admin.Permissions, module, true) {
				return ErrForbidden
			}
			who := Identity{administrator: &admin, adminModule: module}
			switch r.Method {
			case "GET":
				v, e := s.MediaStatus(r.Context(), who, id)
				if e == nil {
					writeJSON(w, 200, v)
				}
				return e
			case "PUT":
				_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(120 * time.Second))
				_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(150 * time.Second))
				r.Body = http.MaxBytesReader(w, r.Body, 100<<20)
				v, e := s.UploadBytes(r.Context(), who, id, r.Body)
				if e == nil {
					writeJSON(w, 202, v)
				}
				return e
			default:
				e := s.CancelUpload(r.Context(), who, id)
				if e == nil {
					w.WriteHeader(204)
				}
				return e
			}
		}))
	}
	mux.HandleFunc("GET /api/v2/admin/media/{id}/content", a.adminWrap("", false, func(w http.ResponseWriter, r *http.Request, admin AdminIdentity) error {
		id := r.PathValue("id")
		if !validID(id) || s.Media == nil {
			return ErrInvalid
		}
		var kind, name, mimeType, owner string
		var created time.Time
		e := s.Store.Pool.QueryRow(r.Context(), "SELECT kind,content_path,mime,COALESCE(admin_owner_id::text,''),created_at FROM pulse.media WHERE id=$1 AND status='ready'", id).Scan(&kind, &name, &mimeType, &owner, &created)
		if e != nil {
			return ErrForbidden
		}
		module := "dispatch"
		if kind == "question" {
			module = "questions"
		}
		if kind == "avatar" {
			module = "users"
		}
		allowed := owner == admin.ID && adminPermission(admin.Role, admin.Permissions, module, false)
		if !allowed {
			var used bool
			if (kind == "avatar" || kind == "image") && adminPermission(admin.Role, admin.Permissions, "users", false) {
				e = s.Store.Pool.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM pulse.users WHERE avatar_id=$1 AND deleted_at IS NULL)", id).Scan(&used)
			}
			if e == nil && !used && adminPermission(admin.Role, admin.Permissions, "questions", false) {
				e = s.Store.Pool.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM pulse.work_questions WHERE media_id=$1)", id).Scan(&used)
			}
			if e == nil && !used && adminPermission(admin.Role, admin.Permissions, "records", false) {
				e = s.Store.Pool.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM pulse.work_records WHERE questions @> jsonb_build_array(jsonb_build_object('media_id',$1::text))) OR EXISTS(SELECT 1 FROM pulse.work_records r JOIN pulse.users u ON u.id=r.user_id WHERE u.avatar_id=$1::uuid)", id).Scan(&used)
			}
			if e == nil && !used && adminPermission(admin.Role, admin.Permissions, "dispatch", false) {
				e = s.Store.Pool.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM pulse.dispatch_plans WHERE payload->'steps' @> jsonb_build_array(jsonb_build_object('media_id',$1::text)))", id).Scan(&used)
			}
			if e == nil && !used && adminPermission(admin.Role, admin.Permissions, "groups", false) {
				e = s.Store.Pool.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM pulse.conversations WHERE avatar_id=$1)", id).Scan(&used)
			}
			if e == nil && !used && adminPermission(admin.Role, admin.Permissions, "messages", false) {
				e = s.Store.Pool.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM pulse.message_media mm JOIN pulse.messages m ON m.id=mm.message_id AND NOT m.revoked WHERE mm.media_id=$1)", id).Scan(&used)
			}
			if e != nil {
				return e
			}
			allowed = used
		}
		if !allowed {
			return ErrForbidden
		}
		path, e := s.Media.path(name)
		if e != nil {
			return e
		}
		file, e := os.Open(path)
		if e != nil {
			return ErrMissing
		}
		defer file.Close()
		w.Header().Set("Content-Type", mimeType)
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(120 * time.Second))
		http.ServeContent(w, r, "media", created, file)
		return nil
	}))

}
