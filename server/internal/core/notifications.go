package core

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"net/http"
	"time"
)

func notifyUserTx(ctx context.Context, tx pgx.Tx, uid, kind, actor, target string) error {
	_, e := tx.Exec(ctx, "INSERT INTO pulse.notifications(user_id,kind,actor_id,target_id) VALUES($1,$2,$3,$4)", uid, kind, optionalUUID(actor), optionalUUID(target))
	return e
}
func (s *Service) dispatchUserChanges(ctx context.Context, h *Hub) error {
	rows, e := s.Store.Pool.Query(ctx, "SELECT user_id::text,version FROM pulse.user_outbox ORDER BY user_id LIMIT 100")
	if e != nil {
		return e
	}
	type item struct {
		uid string
		v   int64
	}
	items := []item{}
	ids := []string{}
	for rows.Next() {
		var it item
		if e = rows.Scan(&it.uid, &it.v); e != nil {
			rows.Close()
			return e
		}
		items = append(items, it)
		ids = append(ids, it.uid)
	}
	e = rows.Err()
	rows.Close()
	if e != nil || len(ids) == 0 {
		return e
	}
	sessions, e := s.Store.Pool.Query(ctx, `SELECT s.user_id::text,s.id::text FROM pulse.login_sessions s JOIN pulse.users u ON u.id=s.user_id AND u.active WHERE s.user_id=ANY($1::uuid[]) AND s.revoked_at IS NULL AND s.expires_at>now()`, ids)
	if e != nil {
		return e
	}
	byUser := map[string][]string{}
	for sessions.Next() {
		var uid, sid string
		if e = sessions.Scan(&uid, &sid); e != nil {
			sessions.Close()
			return e
		}
		byUser[uid] = append(byUser[uid], sid)
	}
	e = sessions.Err()
	sessions.Close()
	if e != nil {
		return e
	}
	for _, it := range items {
		h.Deliver(byUser[it.uid], Hint{Type: "user.changed", UserID: it.uid, StateVersion: it.v})
		if _, e = s.Store.Pool.Exec(ctx, "DELETE FROM pulse.user_outbox WHERE user_id=$1 AND version=$2", it.uid, it.v); e != nil {
			return e
		}
	}
	return nil
}
func (a *API) registerNotifications(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/friend-chats", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		after, err := parseSeq(r.URL.Query().Get("after_id"), 0)
		if err != nil {
			return err
		}
		rows, err := s.Store.Pool.Query(r.Context(), `SELECT n.id::text,n.actor_id::text,c.id::text
			FROM pulse.notifications n JOIN pulse.members a ON a.user_id=n.user_id AND a.active
			JOIN pulse.members b ON b.conversation_id=a.conversation_id AND b.user_id=n.actor_id AND b.active
			JOIN pulse.conversations c ON c.id=a.conversation_id AND c.kind='direct' AND c.active
			WHERE n.user_id=$1 AND n.id>$2 AND n.kind IN('friend.accepted','friend.added')
			ORDER BY n.id LIMIT 100`, who.UserID, after)
		if err != nil {
			return err
		}
		items := []map[string]string{}
		for rows.Next() {
			var item = map[string]string{}
			var notificationID, peerID, conversationID string
			if err = rows.Scan(&notificationID, &peerID, &conversationID); err != nil {
				rows.Close()
				return err
			}
			item["id"], item["peer_user_id"], item["conversation_id"] = notificationID, peerID, conversationID
			items = append(items, item)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/notifications", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		before, e := parseSeq(r.URL.Query().Get("before_id"), 9223372036854775807)
		if e != nil {
			return e
		}
		limit, e := parseSeq(r.URL.Query().Get("limit"), 30)
		if e != nil || limit < 1 || limit > 100 {
			return ErrInvalid
		}
		rows, e := s.Store.Pool.Query(r.Context(), `SELECT jsonb_build_object(
			'id',n.id::text,'kind',n.kind,'type',COALESCE(NULLIF(n.legacy_type,''),n.kind),
			'actor_id',n.actor_id,'actor_name',COALESCE(NULLIF(actor.nickname,''),actor.account,''),
			'actor_avatar_id',COALESCE(actor.avatar_id::text,''),'target_id',n.target_id,'reference_id',n.reference_id,
			'conversation_id',CASE WHEN n.kind IN('group.invited','group.removed') THEN n.target_id::text ELSE '' END,
			'group_name',COALESCE(c.title,''),'can_open_group',n.kind='group.invited' AND c.id IS NOT NULL,
			'request_id',COALESCE(n.reference_id::text,''),'request_status',COALESCE(NULLIF(n.legacy_request_status,''),NULLIF(n.handled,''),fr.status,''),
			'message',COALESCE(n.legacy_body->>'message',n.legacy_body->>'content',n.legacy_body->>'text',''),
			'read_at',n.read_at,'unread',n.read_at IS NULL,'handled',n.handled,'created_at',n.created_at)
			FROM pulse.notifications n LEFT JOIN pulse.users actor ON actor.id=n.actor_id
			LEFT JOIN pulse.conversations c ON c.id=n.target_id AND n.kind IN('group.invited','group.removed')
			LEFT JOIN pulse.friend_requests fr ON fr.id=n.reference_id
			WHERE n.user_id=$1 AND n.id<$2 ORDER BY n.id DESC LIMIT $3`, who.UserID, before, limit+1)
		if e != nil {
			return e
		}
		items := []json.RawMessage{}
		nextBefore := ""
		for rows.Next() {
			var raw []byte
			if e = rows.Scan(&raw); e != nil {
				rows.Close()
				return e
			}
			items = append(items, raw)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		hasMore := int64(len(items)) > limit
		if hasMore {
			items = items[:limit]
			var last struct {
				ID string `json:"id"`
			}
			if e = json.Unmarshal(items[len(items)-1], &last); e != nil {
				return e
			}
			nextBefore = last.ID
		}
		var unread int
		if e = s.Store.Pool.QueryRow(r.Context(), "SELECT count(*) FROM(SELECT 1 FROM pulse.notifications WHERE user_id=$1 AND read_at IS NULL LIMIT 1000)n", who.UserID).Scan(&unread); e != nil {
			return e
		}
		writeJSON(w, 200, map[string]any{"items": items, "unread_count": min(unread, 999), "unread_truncated": unread == 1000, "has_more": hasMore, "next_before_id": nextBefore})
		return nil
	}))
	mux.HandleFunc("PUT /api/v2/notifications/read", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			IDs     []int64 `json:"ids"`
			Through int64   `json:"through_id,string"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if len(in.IDs) > 100 || in.Through < 0 || (len(in.IDs) == 0 && in.Through == 0) || (len(in.IDs) > 0 && in.Through > 0) {
			return ErrInvalid
		}
		for _, id := range in.IDs {
			if id <= 0 {
				return ErrInvalid
			}
		}
		_, e := s.Store.Pool.Exec(r.Context(), "UPDATE pulse.notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL AND(id=ANY($2::bigint[]) OR($3::bigint>0 AND id<=$3))", who.UserID, in.IDs, in.Through)
		if e == nil {
			w.WriteHeader(204)
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/me/notifications", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var enabled, preview, sound bool
		var v int64
		e := s.Store.Pool.QueryRow(r.Context(), `SELECT COALESCE(p.enabled,true),COALESCE(p.preview,true),COALESCE(p.sound,true),COALESCE(p.version,0) FROM pulse.users u LEFT JOIN pulse.notification_preferences p ON p.user_id=u.id WHERE u.id=$1`, who.UserID).Scan(&enabled, &preview, &sound, &v)
		if e == nil {
			writeJSON(w, 200, map[string]any{"enabled": enabled, "preview": preview, "sound": sound, "version": v})
		}
		return e
	}))
	mux.HandleFunc("PUT /api/v2/me/notifications", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			Enabled bool  `json:"enabled"`
			Preview bool  `json:"preview"`
			Sound   bool  `json:"sound"`
			Version int64 `json:"expected_version,string"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if in.Version < 0 {
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
		if _, e = tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(hashtextextended($1,7154))", who.UserID); e != nil {
			return e
		}
		var old int64
		e = tx.QueryRow(r.Context(), "SELECT COALESCE((SELECT version FROM pulse.notification_preferences WHERE user_id=$1),0)", who.UserID).Scan(&old)
		if e != nil {
			return e
		}
		if old != in.Version {
			return ErrConflict
		}
		_, e = tx.Exec(r.Context(), `INSERT INTO pulse.notification_preferences(user_id,enabled,preview,sound) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET enabled=$2,preview=$3,sound=$4,version=pulse.notification_preferences.version+1`, who.UserID, in.Enabled, in.Preview, in.Sound)
		if e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e == nil {
			writeJSON(w, 200, map[string]any{"version": old + 1})
		}
		return e
	}))
	mux.HandleFunc("POST /api/v2/client/diagnostics", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		if e := s.Cache.Allow(r.Context(), "diagnostics", who.UserID, 5, time.Hour); e != nil {
			return e
		}
		var in struct {
			Platform string          `json:"platform"`
			Version  string          `json:"version"`
			Report   json.RawMessage `json:"report"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if len(in.Report) == 0 || len(in.Report) > 24<<10 || !validText(in.Version, 1, 64) {
			return ErrInvalid
		}
		switch in.Platform {
		case "pc", "web", "android", "ios":
		default:
			return ErrInvalid
		}
		id := newID()
		_, e := s.Store.Pool.Exec(r.Context(), "INSERT INTO pulse.client_diagnostics(id,user_id,platform,version,report) VALUES($1,$2,$3,$4,$5)", id, who.UserID, in.Platform, in.Version, in.Report)
		if e == nil {
			writeJSON(w, 201, map[string]string{"id": id})
		}
		return e
	}))
}
