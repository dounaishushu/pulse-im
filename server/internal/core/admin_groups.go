package core

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
)

type AdminGroupInput struct {
	Title        string `json:"title"`
	OwnerID      string `json:"owner_id"`
	Kind         string `json:"kind"`
	Description  string `json:"description"`
	Announcement string `json:"announcement"`
	Policy       string `json:"join_policy"`
	Limit        int    `json:"member_limit"`
	BlockFriends bool   `json:"block_member_friend_requests"`
	MuteAll      bool   `json:"mute_all"`
	Offset       int    `json:"display_count_offset"`
	Active       bool   `json:"active"`
	Delete       bool   `json:"delete"`
}

func (s *Service) AdminSaveGroup(ctx context.Context, who AdminIdentity, id string, in AdminGroupInput) (GroupCreated, error) {
	out := GroupCreated{ID: id}
	create := id == ""
	if create {
		out.ID = newID()
		out.InviteCode = opaqueToken()
	}
	if !validID(out.ID) || !validID(in.OwnerID) || !validText(in.Title, 1, 128) || !validText(in.Description, 0, 500) || !validText(in.Announcement, 0, 10000) || (in.Kind != "group" && in.Kind != "channel") || (in.Policy != "open" && in.Policy != "invite" && in.Policy != "closed") || in.Limit < 2 || in.Limit > 5000 || in.Offset < 0 || in.Offset > 1000000 {
		return out, ErrInvalid
	}
	e := s.adminWrite(ctx, who, "groups", "group.save", "group", out.ID, func(tx pgx.Tx) error {
		var active bool
		if e := tx.QueryRow(ctx, "SELECT active FROM pulse.users WHERE id=$1 FOR SHARE", in.OwnerID).Scan(&active); e != nil {
			return e
		}
		if !active {
			return ErrForbidden
		}
		if create {
			_, e := tx.Exec(ctx, `INSERT INTO pulse.conversations(id,kind,title,description,announcement,join_policy,member_limit,block_member_friend_requests,mute_all,display_count_offset,active,invite_code_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, out.ID, in.Kind, in.Title, in.Description, in.Announcement, in.Policy, in.Limit, in.BlockFriends, in.MuteAll, in.Offset, in.Active, digest(out.InviteCode))
			if e != nil {
				return e
			}
		} else {
			if e := lockConversations(ctx, tx, []string{id}); e != nil {
				return e
			}
			var kind string
			var deleted bool
			var count int
			e := tx.QueryRow(ctx, "SELECT kind,deleted_at IS NOT NULL,(SELECT count(*) FROM pulse.members WHERE conversation_id=$1 AND active) FROM pulse.conversations WHERE id=$1", id).Scan(&kind, &deleted, &count)
			if e != nil {
				return e
			}
			if deleted || kind != in.Kind {
				return ErrConflict
			}
			var member bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pulse.members WHERE conversation_id=$1 AND user_id=$2 AND active)", id, in.OwnerID).Scan(&member); e != nil {
				return e
			}
			if !member {
				count++
			}
			if in.Limit < count {
				return ErrConflict
			}
			_, e = tx.Exec(ctx, `UPDATE pulse.conversations SET title=$2,description=$3,announcement=$4,join_policy=$5,member_limit=$6,block_member_friend_requests=$7,mute_all=$8,display_count_offset=$9,active=$10 AND NOT $11,deleted_at=CASE WHEN $11 THEN now() ELSE deleted_at END,updated_at=now() WHERE id=$1`, id, in.Title, in.Description, in.Announcement, in.Policy, in.Limit, in.BlockFriends, in.MuteAll, in.Offset, in.Active, in.Delete)
			if e != nil {
				return e
			}
		}
		if _, e := tx.Exec(ctx, "UPDATE pulse.members SET role='member',membership_version=membership_version+1 WHERE conversation_id=$1 AND role='owner' AND user_id<>$2", out.ID, in.OwnerID); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `INSERT INTO pulse.members(conversation_id,user_id,role,history_allowed) VALUES($1,$2,'owner',true) ON CONFLICT(conversation_id,user_id) DO UPDATE SET role='owner',active=true,muted=false,membership_version=CASE WHEN pulse.members.active AND pulse.members.role='owner' THEN pulse.members.membership_version ELSE pulse.members.membership_version+1 END`, out.ID, in.OwnerID); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, "INSERT INTO pulse.user_states(conversation_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", out.ID, in.OwnerID); e != nil {
			return e
		}
		return membershipHint(ctx, tx, out.ID, "")
	})
	if e == nil {
		s.notify()
	}
	return out, e
}
func (a *API) registerAdminGroups(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/admin/groups", a.adminWrap("groups", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		return adminRows(w, r, s, `SELECT (to_jsonb(c)-'invite_code_hash')||jsonb_build_object('message_seq',message_seq::text,'event_seq',event_seq::text,'owner_id',(SELECT user_id FROM pulse.members WHERE conversation_id=c.id AND role='owner' LIMIT 1),'member_count',(SELECT count(*) FROM pulse.members WHERE conversation_id=c.id AND active),'legacy_numeric_id',(SELECT legacy_id FROM pulse.legacy_ids WHERE entity='conversation' AND new_id=c.id)) FROM pulse.conversations c WHERE kind IN('group','channel') AND deleted_at IS NULL AND(title ILIKE $3 OR public_id ILIKE $3 OR EXISTS(SELECT 1 FROM pulse.members m JOIN pulse.users u ON u.id=m.user_id WHERE m.conversation_id=c.id AND m.role='owner' AND(u.account ILIKE $3 OR u.nickname ILIKE $3))) ORDER BY updated_at DESC,id LIMIT $1 OFFSET $2`, "%"+r.URL.Query().Get("q")+"%")
	}))
	for _, path := range []string{"POST /api/v2/admin/groups", "PUT /api/v2/admin/groups/{id}"} {
		mux.HandleFunc(path, a.adminWrap("groups", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
			var in AdminGroupInput
			if e := decodeLimit(w, r, &in, 64<<10); e != nil {
				return e
			}
			v, e := s.AdminSaveGroup(r.Context(), who, r.PathValue("id"), in)
			if e == nil {
				writeJSON(w, 200, v)
			}
			return e
		}))
	}
	mux.HandleFunc("PUT /api/v2/admin/users/{id}/history", a.adminWrap("users", true, func(w http.ResponseWriter, r *http.Request, admin AdminIdentity) error {
		var in struct {
			ConversationID string `json:"conversation_id"`
			Through        int64  `json:"through_seq,string"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		uid := r.PathValue("id")
		if !validID(uid) {
			return ErrInvalid
		}
		who := Identity{UserID: uid, administrator: &admin, adminModule: "users"}
		v, e := s.ClearHistory(r.Context(), who, in.ConversationID, in.Through)
		if e != nil {
			return e
		}
		writeJSON(w, 200, v)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/staff/users/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		uid := r.PathValue("id")
		if !validID(uid) {
			return ErrInvalid
		}
		tx, e := s.Store.Pool.Begin(r.Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(r.Context())
		internal, e := lockIdentity(r.Context(), tx, who)
		if e != nil {
			return e
		}
		if !internal {
			return ErrForbidden
		}
		cid := r.URL.Query().Get("conversation_id")
		if cid != "" {
			if !validID(cid) {
				return ErrInvalid
			}
			ac, e := authorize(r.Context(), tx, who, cid, false)
			if e != nil {
				return e
			}
			if ac.Role != "owner" && ac.Role != "admin" {
				return ErrForbidden
			}
		}
		var raw []byte
		e = tx.QueryRow(r.Context(), `SELECT jsonb_build_object('id',u.id,'account',u.account,'nickname',u.nickname,'phone',u.phone,'registration_ip',u.registration_ip,'logins',COALESCE((SELECT jsonb_agg(to_jsonb(l)-'user_id'-'account') FROM(SELECT ip,platform,device_name,created_at FROM pulse.login_events WHERE user_id=u.id AND success ORDER BY id DESC LIMIT 20)l),'[]'::jsonb)) FROM pulse.users u WHERE u.id=$1 AND u.active`, uid).Scan(&raw)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrMissing
		}
		if e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e == nil {
			writeJSON(w, 200, json.RawMessage(raw))
		}
		return e
	}))
}
