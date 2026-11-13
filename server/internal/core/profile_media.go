package core

import (
	"github.com/jackc/pgx/v5"
	"net/http"
)

func (a *API) registerAvatars(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("PUT /api/v2/me/avatar", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			MediaID string `json:"media_id"`
			Version int64  `json:"expected_version,string"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if !validID(in.MediaID) || in.Version < 1 {
			return ErrInvalid
		}
		tx, e := s.Store.Pool.Begin(r.Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(r.Context())
		if _, e = tx.Exec(r.Context(), "SELECT id FROM pulse.users WHERE id=$1 FOR UPDATE", who.UserID); e != nil {
			return e
		}
		if _, e = lockIdentity(r.Context(), tx, who); e != nil {
			return e
		}
		var owned bool
		if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM pulse.media WHERE id=$1 AND owner_id=$2 AND status='ready' AND kind IN('image','avatar'))", in.MediaID, who.UserID).Scan(&owned); e != nil {
			return e
		}
		if !owned {
			return ErrForbidden
		}
		cmd, e := tx.Exec(r.Context(), "UPDATE pulse.users SET avatar_id=$2,profile_version=profile_version+1 WHERE id=$1 AND profile_version=$3", who.UserID, in.MediaID, in.Version)
		if e != nil {
			return e
		}
		if cmd.RowsAffected() != 1 {
			return ErrConflict
		}
		if e = tx.Commit(r.Context()); e == nil {
			w.WriteHeader(204)
		}
		return e
	}))
	mux.HandleFunc("PUT /api/v2/groups/{id}/avatar", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			MediaID string `json:"media_id"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		cid := r.PathValue("id")
		if !validID(cid) || !validID(in.MediaID) {
			return ErrInvalid
		}
		tx, e := s.Store.Pool.Begin(r.Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(r.Context())
		if _, e = lockIdentity(r.Context(), tx, who); e != nil {
			return e
		}
		if e = lockConversations(r.Context(), tx, []string{cid}); e != nil {
			return e
		}
		ac, e := authorize(r.Context(), tx, who, cid, false)
		if e != nil {
			return e
		}
		if (ac.Kind != "group" && ac.Kind != "channel") || ac.Role == "member" {
			return ErrForbidden
		}
		var owned bool
		if e = tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM pulse.media WHERE id=$1 AND owner_id=$2 AND status='ready' AND kind IN('image','avatar'))", in.MediaID, who.UserID).Scan(&owned); e != nil {
			return e
		}
		if !owned {
			return ErrForbidden
		}
		if _, e = tx.Exec(r.Context(), "UPDATE pulse.conversations SET avatar_id=$2 WHERE id=$1", cid, in.MediaID); e != nil {
			return e
		}
		if e = membershipHint(r.Context(), tx, cid, ""); e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e == nil {
			s.notify()
			w.WriteHeader(204)
		}
		return e
	}))
	mux.HandleFunc("PUT /api/v2/admin/users/{id}/avatar", a.adminWrap("users", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in struct {
			MediaID string `json:"media_id"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		uid := r.PathValue("id")
		if !validID(uid) || !validID(in.MediaID) {
			return ErrInvalid
		}
		e := s.adminWrite(r.Context(), who, "users", "user.avatar", "user", uid, func(tx pgx.Tx) error {
			var allowed bool
			if e := tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM pulse.media WHERE id=$1 AND admin_owner_id=$2 AND status='ready' AND kind='avatar')", in.MediaID, who.ID).Scan(&allowed); e != nil {
				return e
			}
			if !allowed {
				return ErrForbidden
			}
			cmd, e := tx.Exec(r.Context(), "UPDATE pulse.users SET avatar_id=$2,profile_version=profile_version+1 WHERE id=$1 AND deleted_at IS NULL", uid, in.MediaID)
			if e == nil && cmd.RowsAffected() == 0 {
				return ErrMissing
			}
			return e
		})
		if e == nil {
			w.WriteHeader(204)
		}
		return e
	}))
}
