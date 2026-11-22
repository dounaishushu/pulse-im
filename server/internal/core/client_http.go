package core

import (
	"net/http"
	"strings"
)

func (a *API) registerClientQueries(mux *http.ServeMux) {
	s := a.Service
	a.registerClientPages(mux)
	a.registerClientReceipts(mux)
	a.registerClientOpen(mux)
	a.registerClientPresence(mux)
	mux.HandleFunc("POST /api/v2/client/conversation-updates", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			IDs []string `json:"conversation_ids"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		if len(in.IDs) < 1 || len(in.IDs) > 100 {
			return ErrInvalid
		}
		seen := make(map[string]bool, len(in.IDs))
		for i, id := range in.IDs {
			id = strings.ToLower(id)
			if !validID(id) || seen[id] {
				return ErrInvalid
			}
			in.IDs[i], seen[id] = id, true
		}
		// 一次查询合并多个会话提示；退出、隐藏和无权查看的会话只返回移除标记。
		items, err := s.clientConversationSelection(r.Context(), who, "", "", 0, 100, "", false, in.IDs)
		if err != nil {
			return err
		}
		for _, item := range items {
			delete(seen, item.ID)
		}
		removed := make([]string, 0, len(seen))
		for _, id := range in.IDs {
			if seen[id] {
				removed = append(removed, id)
			}
		}
		writeJSON(w, 200, map[string]any{"items": items, "removed_ids": removed, "incremental": true})
		return nil
	}))
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
		rows, err := s.Store.Pool.Query(r.Context(), `SELECT u.id::text,CASE WHEN u.account_is_internal THEN '' ELSE u.account END,COALESCE(NULLIF(u.nickname,''),CASE WHEN u.account_is_internal THEN '' ELSE u.account END),u.internal_staff,COALESCE(u.avatar_id::text,''),COALESCE(u.legacy_public_id,u.public_id),COALESCE(cm.remark,''),COALESCE(cm.group_name,'') FROM pulse.users u LEFT JOIN pulse.contact_metadata cm ON cm.user_id=$2 AND cm.peer_id=u.id WHERE u.id=ANY($1::uuid[]) AND u.active ORDER BY u.id`, ids, who.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		items := []ClientUser{}
		for rows.Next() {
			u := ClientUser{IsContact: true}
			if err = rows.Scan(&u.ID, &u.Account, &u.Nickname, &u.InternalStaff, &u.AvatarID, &u.PublicID, &u.Remark, &u.GroupName); err != nil {
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
		limit, err := parseSeq(r.URL.Query().Get("limit"), 100)
		if err != nil {
			return err
		}
		version := r.URL.Query().Get("directory_version")
		if version != "" && version != "2" {
			return ErrInvalid
		}
		restriction := r.URL.Query().Get("restriction")
		if restriction != "" && (restriction != "muted" || version != "2") {
			return ErrInvalid
		}
		roles := r.URL.Query().Get("roles")
		if roles != "" && (roles != "managers" || version != "2") {
			return ErrInvalid
		}
		page, err := s.clientMemberPage(r.Context(), who, r.PathValue("id"), r.URL.Query().Get("q"), r.URL.Query().Get("after"), int(limit), version == "", restriction == "muted", roles == "managers")
		if err != nil {
			return err
		}
		writeJSON(w, 200, page)
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
