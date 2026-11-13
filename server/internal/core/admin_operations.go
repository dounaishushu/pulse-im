package core

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strings"
	"time"
)

func (s *Service) adminWrite(ctx context.Context, who AdminIdentity, module, action, kind, id string, fn func(pgx.Tx) error) error {
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if e = lockAdmin(ctx, tx, who, module, true); e != nil {
		return e
	}
	if e = fn(tx); e != nil {
		return uniqueFault(e)
	}
	if e = auditTx(ctx, tx, who, action, kind, id, map[string]any{}); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	if module == "sensitive_words" {
		s.invalidateWords()
	}
	return nil
}

type AdminUserPatch struct {
	Account             *string `json:"account"`
	Nickname            *string `json:"nickname"`
	Phone               *string `json:"phone"`
	Password            string  `json:"password"`
	Active              *bool   `json:"active"`
	Delete              bool    `json:"delete"`
	Internal            *bool   `json:"internal_staff"`
	Formal              *bool   `json:"formal_employee"`
	CanSend             *bool   `json:"can_send"`
	CanAddFriends       *bool   `json:"can_add_friends"`
	CanCreateGroup      *bool   `json:"can_create_group"`
	CanViewDevices      *bool   `json:"can_view_devices"`
	AllowFriendRequests *bool   `json:"allow_friend_requests"`
	Expected            int64   `json:"expected_version,string"`
}

func (s *Service) AdminSaveUser(ctx context.Context, who AdminIdentity, id string, in AdminUserPatch) error {
	if !validID(id) || in.Expected < 1 {
		return ErrInvalid
	}
	if in.Account != nil {
		*in.Account = normalizeAccount(*in.Account)
		if !validText(*in.Account, 3, 64) {
			return ErrInvalid
		}
	}
	if in.Nickname != nil && !validText(*in.Nickname, 2, 32) {
		return ErrInvalid
	}
	if in.Phone != nil && *in.Phone != "" && !phonePattern.MatchString(*in.Phone) {
		return ErrInvalid
	}
	hash := ""
	if in.Password != "" {
		select {
		case s.passwordSlots <- struct{}{}:
			defer func() { <-s.passwordSlots }()
		default:
			return ErrBusy
		}
		var e error
		hash, e = hashPassword(in.Password)
		if e != nil {
			return e
		}
	}
	return s.adminWrite(ctx, who, "users", "user.update", "user", id, func(tx pgx.Tx) error {
		var version int64
		var deleted *time.Time
		if e := tx.QueryRow(ctx, "SELECT profile_version,deleted_at FROM pulse.users WHERE id=$1 FOR UPDATE", id).Scan(&version, &deleted); errors.Is(e, pgx.ErrNoRows) {
			return ErrMissing
		} else if e != nil {
			return e
		}
		if version != in.Expected {
			return ErrConflict
		}
		if deleted != nil {
			return &Fault{409, "user_deleted"}
		}
		_, e := tx.Exec(ctx, `UPDATE pulse.users SET account=COALESCE($2,account),account_is_internal=CASE WHEN $2::text IS NULL THEN account_is_internal ELSE false END,account_changes=CASE WHEN $2::text IS NULL THEN account_changes ELSE 1 END,nickname=COALESCE($3,nickname),phone=CASE WHEN $4::text IS NULL THEN phone ELSE NULLIF($4,'') END,password_hash=COALESCE(NULLIF($5,''),password_hash),active=CASE WHEN $7 THEN false ELSE COALESCE($6,active) END,deleted_at=CASE WHEN $7 THEN now() ELSE deleted_at END,internal_staff=COALESCE($8,internal_staff),formal_employee=COALESCE($9,formal_employee),can_send=COALESCE($10,can_send),can_add_friends=COALESCE($11,can_add_friends),can_create_group=COALESCE($12,can_create_group),can_view_devices=COALESCE($13,can_view_devices),allow_friend_requests=COALESCE($14,allow_friend_requests),profile_version=profile_version+1 WHERE id=$1`, id, in.Account, in.Nickname, in.Phone, hash, in.Active, in.Delete, in.Internal, in.Formal, in.CanSend, in.CanAddFriends, in.CanCreateGroup, in.CanViewDevices, in.AllowFriendRequests)
		if e != nil {
			return e
		}
		if hash != "" || in.Delete || (in.Active != nil && !*in.Active) {
			if _, e = tx.Exec(ctx, "UPDATE pulse.login_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", id); e != nil {
				return e
			}
		}
		_, e = tx.Exec(ctx, "INSERT INTO pulse.user_outbox(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET version=pulse.user_outbox.version+1", id)
		return e
	})
}
func (a *API) registerAdminOperations(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/admin/users", a.adminWrap("users", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		q := "%" + strings.NewReplacer("%", "\\%", "_", "\\_").Replace(r.URL.Query().Get("q")) + "%"
		if len(q) > 202 {
			return ErrInvalid
		}
		status := r.URL.Query().Get("status")
		if status != "" && status != "active" && status != "frozen" && status != "deleted" {
			return ErrInvalid
		}
		return adminRows(w, r, s, `SELECT (to_jsonb(u)-'password_hash')||jsonb_build_object('profile_version',u.profile_version::text,'legacy_numeric_id',(SELECT legacy_id FROM pulse.legacy_ids WHERE entity='user' AND new_id=u.id)) FROM pulse.users u WHERE(account ILIKE $3 OR nickname ILIKE $3 OR phone ILIKE $3 OR public_id ILIKE $3 OR registration_ip::text ILIKE $3 OR EXISTS(SELECT 1 FROM pulse.login_events l WHERE l.user_id=u.id AND l.success AND l.ip::text ILIKE $3)) AND($4='' OR($4='active' AND active AND deleted_at IS NULL)OR($4='frozen' AND NOT active AND deleted_at IS NULL)OR($4='deleted' AND deleted_at IS NOT NULL)) ORDER BY created_at DESC,id LIMIT $1 OFFSET $2`, q, status)
	}))
	mux.HandleFunc("PATCH /api/v2/admin/users/{id}", a.adminWrap("users", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in AdminUserPatch
		if e := decode(w, r, &in); e != nil {
			return e
		}
		id := r.PathValue("id")
		e := s.AdminSaveUser(r.Context(), who, id, in)
		if e == nil {
			if in.Password != "" || in.Delete || (in.Active != nil && !*in.Active) {
				a.Hub.CloseUser(id)
			}
			w.WriteHeader(204)
		}
		return e
	}))
	mux.HandleFunc("POST /api/v2/admin/users/{id}/restore", a.adminWrap("users", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		id := r.PathValue("id")
		if !validID(id) {
			return ErrInvalid
		}
		err := s.adminWrite(r.Context(), who, "users", "user.restore", "user", id, func(tx pgx.Tx) error {
			cmd, e := tx.Exec(r.Context(), "UPDATE pulse.users SET active=true,deleted_at=NULL,profile_version=profile_version+1 WHERE id=$1 AND deleted_at IS NOT NULL", id)
			if e != nil {
				return e
			}
			if cmd.RowsAffected() != 1 {
				return ErrConflict
			}
			return nil
		})
		if err == nil {
			w.WriteHeader(204)
		}
		return err
	}))
	mux.HandleFunc("POST /api/v2/admin/users", a.adminWrap("users", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in struct {
			Account  string `json:"account"`
			Nickname string `json:"nickname"`
			Password string `json:"password"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if !validText(in.Account, 3, 64) || !validText(in.Nickname, 2, 32) {
			return ErrInvalid
		}
		select {
		case s.passwordSlots <- struct{}{}:
			defer func() { <-s.passwordSlots }()
		default:
			return ErrBusy
		}
		hash, e := hashPassword(in.Password)
		if e != nil {
			return e
		}
		id := newID()
		e = s.adminWrite(r.Context(), who, "users", "user.create", "user", id, func(tx pgx.Tx) error {
			_, e := tx.Exec(r.Context(), "INSERT INTO pulse.users(id,account,nickname,password_hash) VALUES($1,$2,$3,$4)", id, normalizeAccount(in.Account), in.Nickname, hash)
			return e
		})
		if e == nil {
			writeJSON(w, 201, map[string]string{"id": id})
		}
		return e
	}))
	mux.HandleFunc("POST /api/v2/admin/users/{id}/logout", a.adminWrap("users", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		id := r.PathValue("id")
		if !validID(id) {
			return ErrInvalid
		}
		e := s.adminWrite(r.Context(), who, "users", "user.logout", "user", id, func(tx pgx.Tx) error {
			if _, e := tx.Exec(r.Context(), "SELECT id FROM pulse.users WHERE id=$1 FOR UPDATE", id); e != nil {
				return e
			}
			_, e := tx.Exec(r.Context(), "UPDATE pulse.login_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", id)
			return e
		})
		if e == nil {
			a.Hub.CloseUser(id)
			w.WriteHeader(204)
		}
		return e
	}))
	mux.HandleFunc("POST /api/v2/admin/users/{id}/clear-history", a.adminWrap("users", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		id := r.PathValue("id")
		if !validID(id) {
			return ErrInvalid
		}
		clearedConversations, hiddenMessages := 0, int64(0)
		err := s.adminWrite(r.Context(), who, "users", "user.clear_chat", "user", id, func(tx pgx.Tx) error {
			var active bool
			if err := tx.QueryRow(r.Context(), "SELECT active AND deleted_at IS NULL FROM pulse.users WHERE id=$1 FOR SHARE", id).Scan(&active); errors.Is(err, pgx.ErrNoRows) {
				return ErrMissing
			} else if err != nil {
				return err
			} else if !active {
				return ErrForbidden
			}
			rows, err := tx.Query(r.Context(), "SELECT conversation_id::text FROM pulse.members WHERE user_id=$1 AND active ORDER BY conversation_id", id)
			if err != nil {
				return err
			}
			conversations := []string{}
			for rows.Next() {
				var cid string
				if err = rows.Scan(&cid); err != nil {
					rows.Close()
					return err
				}
				conversations = append(conversations, cid)
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
			if err = lockDirectConversations(r.Context(), tx, conversations); err != nil {
				return err
			}
			if err = lockConversations(r.Context(), tx, conversations); err != nil {
				return err
			}
			viewer := Identity{UserID: id, administrator: &who}
			for _, cid := range conversations {
				var boundary int64
				if err = tx.QueryRow(r.Context(), "SELECT message_seq FROM pulse.conversations WHERE id=$1 AND active", cid).Scan(&boundary); errors.Is(err, pgx.ErrNoRows) {
					continue
				} else if err != nil {
					return err
				}
				state, stateErr := lockReceiptState(r.Context(), tx, viewer, cid)
				if stateErr != nil {
					return stateErr
				}
				if boundary <= state.ClearSeq {
					continue
				}
				var count int64
				if err = tx.QueryRow(r.Context(), `SELECT count(*) FROM pulse.messages msg JOIN pulse.members m ON m.conversation_id=msg.conversation_id AND m.user_id=$2 AND m.active
					WHERE msg.conversation_id=$1 AND msg.seq>GREATEST(m.visible_from_seq-1,$3) AND msg.seq<=$4 AND NOT msg.revoked
					AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.user_id=$2 AND d.message_id=msg.id)`, cid, id, state.ClearSeq, boundary).Scan(&count); err != nil {
					return err
				}
				if err = excludeUnobserved(r.Context(), tx, viewer, cid, state, state.ClearSeq+1, boundary); err != nil {
					return err
				}
				if _, err = personalChange(r.Context(), tx, viewer, cid, "history.cleared", "", boundary, nil); err != nil {
					return err
				}
				clearedConversations++
				hiddenMessages += count
			}
			return nil
		})
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"cleared_conversations": clearedConversations, "hidden_messages": hiddenMessages})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/admin/devices", a.adminWrap("devices", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		return adminRows(w, r, s, `SELECT jsonb_build_object('user_id',u.id,'account',u.account,'nickname',u.nickname,'platform',b.platform,'device_name',b.device_name,'device_digest',encode(b.device_hash,'hex'),'bound_at',b.bound_at,'last_login_at',b.last_login_at) FROM pulse.mobile_bindings b JOIN pulse.users u ON u.id=b.user_id WHERE(u.account ILIKE $3 OR u.nickname ILIKE $3) ORDER BY b.bound_at DESC LIMIT $1 OFFSET $2`, "%"+r.URL.Query().Get("q")+"%")
	}))
	mux.HandleFunc("POST /api/v2/admin/devices/unbind", a.adminWrap("devices", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in struct {
			UserID       string `json:"user_id"`
			All          bool   `json:"all"`
			Confirmation string `json:"confirmation"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if in.All {
			if in.UserID != "" || in.Confirmation != "UNBIND_ALL" {
				return ErrInvalid
			}
		} else if !validID(in.UserID) {
			return ErrInvalid
		}
		e := s.adminWrite(r.Context(), who, "devices", "device.unbind", "user", in.UserID, func(tx pgx.Tx) error {
			_, e := tx.Exec(r.Context(), "DELETE FROM pulse.mobile_bindings WHERE $1 OR user_id=$2", in.All, optionalUUID(in.UserID))
			return e
		})
		if e == nil {
			w.WriteHeader(204)
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/admin/audit", a.adminWrap("audit", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		return adminRows(w, r, s, `SELECT to_jsonb(a)||jsonb_build_object('id',id::text) FROM pulse.admin_audit a WHERE($3='' OR action=$3) AND($4='' OR target_type=$4) ORDER BY id DESC LIMIT $1 OFFSET $2`, r.URL.Query().Get("action"), r.URL.Query().Get("target_type"))
	}))
	mux.HandleFunc("GET /api/v2/admin/login-events", a.adminWrap("audit", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		return adminRows(w, r, s, `SELECT to_jsonb(l)||jsonb_build_object('id',id::text) FROM pulse.login_events l WHERE($3='' OR account=$3) AND($4='' OR ip::text=$4) ORDER BY id DESC LIMIT $1 OFFSET $2`, r.URL.Query().Get("account"), r.URL.Query().Get("ip"))
	}))
	mux.HandleFunc("GET /api/v2/admin/diagnostics", a.adminWrap("audit", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		return adminRows(w, r, s, `SELECT to_jsonb(d) FROM pulse.client_diagnostics d ORDER BY created_at DESC,id LIMIT $1 OFFSET $2`)
	}))
	mux.HandleFunc("GET /api/v2/admin/stats", a.adminWrap("stats", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var raw []byte
		e := s.Store.Pool.QueryRow(r.Context(), `SELECT jsonb_build_object('users',(SELECT count(*) FROM pulse.users),'active_users',(SELECT count(*) FROM pulse.users WHERE active),'frozen_users',(SELECT count(*) FROM pulse.users WHERE NOT active AND deleted_at IS NULL),'deleted_users',(SELECT count(*) FROM pulse.users WHERE deleted_at IS NOT NULL),'recently_active',(SELECT count(*) FROM pulse.users WHERE active AND last_active_at>now()-interval '60 seconds'),'conversations',(SELECT count(*) FROM pulse.conversations WHERE active),'messages',(SELECT count(*) FROM pulse.messages),'messages_today',(SELECT count(*) FROM pulse.messages WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'),'successful_logins_today',(SELECT count(*) FROM pulse.login_events WHERE success AND created_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'),'outbox_pending',(SELECT count(*) FROM pulse.outbox))`).Scan(&raw)
		if e == nil {
			writeJSON(w, 200, json.RawMessage(raw))
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/admin/regions", a.adminWrap("stats", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		return adminRows(w, r, s, `SELECT jsonb_build_object('country',COALESCE(NULLIF(l.country,''),'unknown'),'province',COALESCE(NULLIF(l.province,''),'unknown'),'users',count(*)) FROM pulse.users u LEFT JOIN pulse.ip_locations l ON l.ip=u.registration_ip GROUP BY l.country,l.province ORDER BY count(*) DESC LIMIT $1 OFFSET $2`)
	}))
	mux.HandleFunc("GET /api/v2/admin/unusual-logins", a.adminWrap("stats", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		return adminRows(w, r, s, `WITH x AS(SELECT l.id,l.user_id,l.ip,l.created_at,p.country,p.province,p.city,lag(p.country||'/'||p.province||'/'||p.city)OVER(PARTITION BY l.user_id ORDER BY l.id) previous FROM pulse.login_events l JOIN pulse.ip_locations p ON p.ip=l.ip WHERE l.success AND p.status='resolved') SELECT to_jsonb(x)||jsonb_build_object('id',id::text) FROM x WHERE previous IS NOT NULL AND previous<>country||'/'||province||'/'||city ORDER BY id DESC LIMIT $1 OFFSET $2`)
	}))
	mux.HandleFunc("GET /api/v2/admin/messages", a.adminWrap("messages", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		cid, sender, peer := r.URL.Query().Get("conversation_id"), r.URL.Query().Get("sender_id"), r.URL.Query().Get("peer_id")
		for _, id := range []string{cid, sender, peer} {
			if id != "" && !validID(id) {
				return ErrInvalid
			}
		}
		kind, conversationType := r.URL.Query().Get("kind"), r.URL.Query().Get("conversation_type")
		switch kind {
		case "", "text", "image", "video", "audio", "file", "contact", "shake":
		default:
			return ErrInvalid
		}
		switch conversationType {
		case "", "direct", "group", "channel", "saved":
		default:
			return ErrInvalid
		}
		return adminRows(w, r, s, `SELECT (to_jsonb(m)-'request_hash'-'body'-'content')||jsonb_build_object('body',CASE WHEN m.revoked THEN '' ELSE m.body END,'content',CASE WHEN m.revoked THEN '{}'::jsonb ELSE m.content END,'seq',m.seq::text,'event_seq',m.event_seq::text,'version',m.version::text,
		'conversation_type',c.kind,'conversation_name',c.title,'sender_account',u.account,'sender_nickname',u.nickname,'sender_public_id',COALESCE(u.legacy_public_id,u.public_id),
		'recipients',CASE WHEN c.kind='direct' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'account',p.account,'nickname',p.nickname,'public_id',COALESCE(p.legacy_public_id,p.public_id)) ORDER BY p.id) FROM pulse.members mm JOIN pulse.users p ON p.id=mm.user_id WHERE mm.conversation_id=c.id AND mm.user_id<>m.sender_id),'[]'::jsonb) ELSE '[]'::jsonb END)
		FROM pulse.messages m JOIN pulse.conversations c ON c.id=m.conversation_id JOIN pulse.users u ON u.id=m.sender_id
		WHERE($3::uuid IS NULL OR m.conversation_id=$3) AND($4::uuid IS NULL OR m.sender_id=$4) AND($5='' OR m.kind=$5) AND m.body ILIKE $6
		AND($7::uuid IS NULL OR(c.kind='direct' AND EXISTS(SELECT 1 FROM pulse.members mm WHERE mm.conversation_id=c.id AND mm.user_id=$7 AND mm.user_id<>m.sender_id)))
		AND($8='' OR c.kind=$8) ORDER BY m.created_at DESC,m.id LIMIT $1 OFFSET $2`, optionalUUID(cid), optionalUUID(sender), kind, "%"+escapeLike(r.URL.Query().Get("q"))+"%", optionalUUID(peer), conversationType)
	}))
	mux.HandleFunc("DELETE /api/v2/admin/messages/{id}", a.adminWrap("messages", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		id := r.PathValue("id")
		if !validID(id) {
			return ErrInvalid
		}
		e := s.adminWrite(r.Context(), who, "messages", "message.revoke", "message", id, func(tx pgx.Tx) error {
			var cid string
			if e := tx.QueryRow(r.Context(), "SELECT conversation_id::text FROM pulse.messages WHERE id=$1", id).Scan(&cid); errors.Is(e, pgx.ErrNoRows) {
				return ErrMissing
			} else if e != nil {
				return e
			}
			if e := lockConversations(r.Context(), tx, []string{cid}); e != nil {
				return e
			}
			var revoked bool
			if e := tx.QueryRow(r.Context(), "SELECT revoked FROM pulse.messages WHERE id=$1", id).Scan(&revoked); e != nil {
				return e
			}
			if revoked {
				return nil
			}
			var seq int64
			if e := tx.QueryRow(r.Context(), "UPDATE pulse.conversations SET event_seq=event_seq+1 WHERE id=$1 RETURNING event_seq", cid).Scan(&seq); e != nil {
				return e
			}
			if _, e := tx.Exec(r.Context(), "UPDATE pulse.messages SET revoked=true,body='',content='{}',version=version+1,event_seq=$2,updated_at=now() WHERE id=$1", id, seq); e != nil {
				return e
			}
			if _, e := tx.Exec(r.Context(), "DELETE FROM pulse.message_pins WHERE message_id=$1", id); e != nil {
				return e
			}
			return recordEvent(r.Context(), tx, cid, seq, "message.revoked", id)
		})
		if e == nil {
			s.notify()
			w.WriteHeader(204)
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/admin/users/{id}/devices", a.adminWrap("users", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		id := r.PathValue("id")
		if !validID(id) {
			return ErrInvalid
		}
		var visible bool
		e := s.Store.Pool.QueryRow(r.Context(), "SELECT can_view_devices FROM pulse.users WHERE id=$1 AND deleted_at IS NULL", id).Scan(&visible)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrMissing
		}
		if e != nil {
			return e
		}
		if !visible {
			writeJSON(w, 200, map[string]any{"hidden": true, "items": []any{}})
			return nil
		}
		return adminRows(w, r, s, `SELECT jsonb_build_object('id',s.id,'platform',s.platform,'device_name',s.device_name,'created_at',s.created_at,'last_used_at',s.last_used_at,'expires_at',s.expires_at,'revoked_at',s.revoked_at,'push_registered',EXISTS(SELECT 1 FROM pulse.push_devices d WHERE d.session_id=s.id AND d.enabled)) FROM pulse.login_sessions s WHERE s.user_id=$3 ORDER BY s.last_used_at DESC,s.id LIMIT $1 OFFSET $2`, id)
	}))

}
