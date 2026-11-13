package core

import (
	"net/http"
	"strings"
)

func (a *API) registerClientQueries(mux *http.ServeMux) {
	s := a.Service
	a.registerClientPages(mux)
	a.registerClientReceipts(mux)
	mux.HandleFunc("GET /api/v2/client/config", a.wrap(false, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
		v, e := s.PublicConfig(r.Context())
		if e != nil {
			return e
		}
		writeJSON(w, 200, v)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/me/profile", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		item, err := s.profile(r.Context(), who, who.UserID)
		if err != nil {
			return err
		}
		writeJSON(w, 200, item)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/client/users/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		item, err := s.ClientUser(r.Context(), who, r.PathValue("id"), r.URL.Query().Get("conversation_id"))
		if err != nil {
			return err
		}
		writeJSON(w, 200, item)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/client/conversations", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		items, err := s.ClientConversations(r.Context(), who, r.URL.Query().Get("after"), "")
		if err != nil {
			return err
		}
		next := ""
		if len(items) == 100 {
			next = items[99].ID
		}
		writeJSON(w, 200, map[string]any{"items": items, "next_after": next})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/conversations/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		items, err := s.ClientConversations(r.Context(), who, "", r.PathValue("id"))
		if err != nil {
			return err
		}
		writeJSON(w, 200, items[0])
		return nil
	}))
	mux.HandleFunc("GET /api/v2/client/friends", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		after := r.URL.Query().Get("after")
		if after != "" && !validID(after) {
			return ErrInvalid
		}
		ids, err := s.Friends(r.Context(), who, after)
		if err != nil {
			return err
		}
		rows, err := s.Store.Pool.Query(r.Context(), "SELECT id::text,CASE WHEN account_is_internal THEN '' ELSE account END,COALESCE(NULLIF(nickname,''),CASE WHEN account_is_internal THEN '' ELSE account END),internal_staff,COALESCE(avatar_id::text,''),COALESCE(legacy_public_id,public_id) FROM pulse.users WHERE id=ANY($1::uuid[]) AND active ORDER BY id", ids)
		if err != nil {
			return err
		}
		defer rows.Close()
		items := []ClientUser{}
		for rows.Next() {
			u := ClientUser{IsContact: true}
			if err = rows.Scan(&u.ID, &u.Account, &u.Nickname, &u.InternalStaff, &u.AvatarID, &u.PublicID); err != nil {
				return err
			}
			items = append(items, u)
		}
		if err = rows.Err(); err != nil {
			return err
		}
		next := ""
		if len(ids) == 100 {
			next = ids[99]
		}
		writeJSON(w, 200, map[string]any{"items": items, "next_after": next})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/groups/{id}/member-profiles", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		if _, err := s.GroupDetails(r.Context(), who, r.PathValue("id")); err != nil {
			return err
		}
		items, err := s.ClientMembers(r.Context(), who, r.PathValue("id"), r.URL.Query().Get("after"))
		if err != nil {
			return err
		}
		next := ""
		if len(items) == 100 {
			next = items[99]["id"].(string)
		}
		writeJSON(w, 200, map[string]any{"items": items, "next_after": next})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/conversations/{id}/history", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		q := r.URL.Query()
		after, e := parseSeq(q.Get("after_seq"), 0)
		if e != nil {
			return e
		}
		before, e := parseSeq(q.Get("before_seq"), 0)
		if e != nil {
			return e
		}
		floor, e := parseSeq(q.Get("floor_seq"), 0)
		if e != nil {
			return e
		}
		limit, e := parseSeq(q.Get("limit"), 50)
		if e != nil || limit < 1 || limit > 100 {
			return ErrInvalid
		}
		var upper, version *int64
		if q.Has("snapshot_max_seq") {
			n, e := parseSeq(q.Get("snapshot_max_seq"), -1)
			if e != nil || n < 0 {
				return ErrInvalid
			}
			upper = &n
		}
		if q.Has("membership_version") {
			n, e := parseSeq(q.Get("membership_version"), -1)
			if e != nil || n < 1 {
				return ErrInvalid
			}
			version = &n
		}
		if q.Get("order") != "" && q.Get("order") != "asc" && q.Get("order") != "desc" {
			return ErrInvalid
		}
		page, err := s.History(r.Context(), who, r.PathValue("id"), after, before, floor, upper, int(limit), q.Get("order") != "asc", version)
		if err != nil {
			return err
		}
		writeJSON(w, 200, page)
		return nil
	}))
	mux.HandleFunc("POST /api/v2/groups/join", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var input struct {
			InviteCode string `json:"invite_code"`
		}
		if err := decode(w, r, &input); err != nil {
			return err
		}
		if len(input.InviteCode) != 64 {
			return ErrInvalid
		}
		var id string
		if err := s.Store.Pool.QueryRow(r.Context(), "SELECT id::text FROM pulse.conversations WHERE invite_code_hash=$1 AND active AND kind='group'", digest(strings.TrimSpace(input.InviteCode))).Scan(&id); err != nil {
			return ErrForbidden
		}
		if err := s.JoinGroup(r.Context(), who, id, input.InviteCode); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]string{"id": id})
		return nil
	}))
}
