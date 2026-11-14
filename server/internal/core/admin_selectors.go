package core

import (
	"net/http"
	"strings"
)

// Selectors expose only the identifiers and display names required by an
// authorized editor; group or dispatch access does not grant full user access.
func (a *API) registerAdminSelectors(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v2/admin/select-options", a.adminWrap("", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		scope, kind := r.URL.Query().Get("scope"), r.URL.Query().Get("kind")
		if scope != "groups" && scope != "dispatch" {
			return ErrInvalid
		}
		if !adminPermission(who.Role, who.Permissions, scope, true) {
			return ErrForbidden
		}
		text := r.URL.Query().Get("q")
		if len(text) > 128 {
			return ErrInvalid
		}
		q := "%" + strings.NewReplacer("%", "\\%", "_", "\\_").Replace(text) + "%"
		if kind == "sender" || kind == "user" {
			return adminRows(w, r, a.Service, `SELECT jsonb_build_object('id',id,'name',nickname,'username',account) FROM pulse.users WHERE active AND deleted_at IS NULL AND(account ILIKE $3 OR nickname ILIKE $3 OR public_id ILIKE $3 OR legacy_public_id ILIKE $3 OR id::text ILIKE $3 OR EXISTS(SELECT 1 FROM pulse.legacy_ids l WHERE l.entity='user' AND l.new_id=pulse.users.id AND l.legacy_id::text ILIKE $3)) ORDER BY account,id LIMIT $1 OFFSET $2`, q)
		}
		if kind == "group" && scope == "dispatch" {
			return adminRows(w, r, a.Service, `SELECT jsonb_build_object('id',id,'name',title) FROM pulse.conversations WHERE kind IN('group','channel') AND active AND deleted_at IS NULL AND(title ILIKE $3 OR public_id ILIKE $3) ORDER BY title,id LIMIT $1 OFFSET $2`, q)
		}
		return ErrInvalid
	}))
}
