package core

import (
	"net/http"
)

func clientPage(r *http.Request) (int, int, error) {
	p, e := parseSeq(r.URL.Query().Get("page"), 1)
	if e != nil || p < 1 || p > 1000 {
		return 0, 0, ErrInvalid
	}
	size, e := parseSeq(r.URL.Query().Get("size"), 50)
	if e != nil || size < 1 || size > 100 {
		return 0, 0, ErrInvalid
	}
	return int(p), int(size), nil
}
func (a *API) registerClientPages(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/client/conversation-page", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		page, size, err := clientPage(r)
		if err != nil {
			return err
		}
		kind := r.URL.Query().Get("kind")
		if kind != "" && kind != "direct" && kind != "group" && kind != "channel" && kind != "saved" {
			return ErrInvalid
		}
		items, err := s.clientConversationWindow(r.Context(), who, "", "", (page-1)*size, size, kind, true)
		if err != nil {
			return err
		}
		var count int
		if err = s.Store.Pool.QueryRow(r.Context(), `SELECT count(*) FROM pulse.members m JOIN pulse.conversations c ON c.id=m.conversation_id
   WHERE m.user_id=$1 AND m.active AND c.active AND EXISTS(SELECT 1 FROM pulse.user_states st WHERE st.conversation_id=c.id AND st.user_id=$1 AND NOT st.hidden) AND ($2='' OR c.kind=$2)`, who.UserID, kind).Scan(&count); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"items": items, "page": page, "size": size, "total": count, "has_more": page*size < count})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/client/friend-page", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		page, size, err := clientPage(r)
		if err != nil {
			return err
		}
		rows, err := s.Store.Pool.Query(r.Context(), `SELECT u.id::text,CASE WHEN u.account_is_internal THEN '' ELSE u.account END,COALESCE(NULLIF(u.nickname,''),CASE WHEN u.account_is_internal THEN '' ELSE u.account END),u.internal_staff,COALESCE(u.avatar_id::text,''),COALESCE(u.legacy_public_id,u.public_id) FROM pulse.friendships f
   JOIN pulse.users u ON u.id=CASE WHEN f.user_low=$1 THEN f.user_high ELSE f.user_low END AND u.active
   WHERE f.user_low=$1 OR f.user_high=$1 ORDER BY u.id LIMIT $2 OFFSET $3`, who.UserID, size, (page-1)*size)
		if err != nil {
			return err
		}
		items := []ClientUser{}
		for rows.Next() {
			u := ClientUser{IsContact: true}
			if err = rows.Scan(&u.ID, &u.Account, &u.Nickname, &u.InternalStaff, &u.AvatarID, &u.PublicID); err != nil {
				rows.Close()
				return err
			}
			items = append(items, u)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		var count int
		if err = s.Store.Pool.QueryRow(r.Context(), `SELECT count(*) FROM pulse.friendships f JOIN pulse.users u ON u.id=CASE WHEN f.user_low=$1 THEN f.user_high ELSE f.user_low END AND u.active
   WHERE f.user_low=$1 OR f.user_high=$1`, who.UserID).Scan(&count); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"items": items, "page": page, "size": size, "total": count, "has_more": page*size < count})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/client/friend-request-page", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		page, size, err := clientPage(r)
		if err != nil {
			return err
		}
		column := "target_id"
		switch r.URL.Query().Get("direction") {
		case "incoming":
		case "outgoing":
			column = "requester_id"
		default:
			return ErrInvalid
		}
		status := r.URL.Query().Get("status")
		if status != "" && status != "pending" && status != "accepted" && status != "rejected" && status != "blocked" {
			return ErrInvalid
		}
		rows, err := s.Store.Pool.Query(r.Context(), `SELECT f.id::text,f.requester_id::text,f.target_id::text,f.note,f.status,f.created_at,f.decided_at,CASE WHEN a.account_is_internal THEN '' ELSE a.account END,CASE WHEN b.account_is_internal THEN '' ELSE b.account END
   FROM pulse.friend_requests f JOIN pulse.users a ON a.id=f.requester_id JOIN pulse.users b ON b.id=f.target_id
   WHERE f.`+column+`=$1 AND($2='' OR f.status=$2) ORDER BY f.id LIMIT $3 OFFSET $4`, who.UserID, status, size, (page-1)*size)
		if err != nil {
			return err
		}
		type view struct {
			FriendRequestView
			RequesterAccount string `json:"requester_account"`
			TargetAccount    string `json:"target_account"`
		}
		items := []view{}
		for rows.Next() {
			var v view
			if err = rows.Scan(&v.ID, &v.RequesterID, &v.TargetID, &v.Note, &v.Status, &v.CreatedAt, &v.DecidedAt, &v.RequesterAccount, &v.TargetAccount); err != nil {
				rows.Close()
				return err
			}
			items = append(items, v)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		var count int
		if err = s.Store.Pool.QueryRow(r.Context(), "SELECT count(*) FROM pulse.friend_requests WHERE "+column+"=$1 AND($2='' OR status=$2)", who.UserID, status).Scan(&count); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"items": items, "page": page, "size": size, "total": count, "has_more": page*size < count})
		return nil
	}))
}
