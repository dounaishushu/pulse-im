package core

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

func (s *Service) GroupSearch(ctx context.Context, who Identity, cid, q, after string, invite bool) ([]map[string]any, error) {
	return s.GroupSearchPage(ctx, who, cid, q, after, invite, 100)
}

func (s *Service) GroupSearchPage(ctx context.Context, who Identity, cid, q, after string, invite bool, limit int) ([]map[string]any, error) {
	items, _, err := s.GroupSearchCursor(ctx, who, cid, q, after, invite, limit)
	return items, err
}

func (s *Service) GroupSearchCursor(ctx context.Context, who Identity, cid, q, after string, invite bool, limit int) ([]map[string]any, string, error) {
	if !validID(cid) || !validText(q, 0, 100) {
		return nil, "", ErrInvalid
	}
	if limit < 1 || limit > 100 {
		return nil, "", ErrInvalid
	}
	if after == "" {
		after = "00000000-0000-0000-0000-000000000000"
	}
	if !validID(after) {
		return nil, "", ErrInvalid
	}
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return nil, "", e
	}
	defer tx.Rollback(ctx)
	if _, e = lockIdentity(ctx, tx, who); e != nil {
		return nil, "", e
	}
	ac, e := authorize(ctx, tx, who, cid, false)
	if e != nil {
		return nil, "", e
	}
	if ac.Kind != "group" && ac.Kind != "channel" {
		return nil, "", ErrForbidden
	}
	manager := ac.Role == "owner" || ac.Role == "admin"
	if invite && !manager {
		return nil, "", ErrForbidden
	}
	var restricted bool
	if e = tx.QueryRow(ctx, "SELECT block_member_friend_requests FROM pulse.conversations WHERE id=$1", cid).Scan(&restricted); e != nil {
		return nil, "", e
	}
	pattern := "%" + strings.NewReplacer("%", "\\%", "_", "\\_").Replace(q) + "%"
	rows, e := tx.Query(ctx, `SELECT u.id::text,CASE WHEN u.account_is_internal THEN '' ELSE u.account END,COALESCE(NULLIF(u.nickname,''),CASE WHEN u.account_is_internal THEN '' ELSE u.account END),COALESCE(u.legacy_public_id,u.public_id),COALESCE(u.avatar_id::text,''),COALESCE(m.role,''),COALESCE(m.muted OR COALESCE(m.muted_until>now(),false),false),COALESCE(cm.remark,'') FROM pulse.users u
 LEFT JOIN pulse.members m ON m.user_id=u.id AND m.conversation_id=$1 AND m.active LEFT JOIN pulse.contact_metadata cm ON cm.user_id=$2 AND cm.peer_id=u.id
 WHERE u.active AND u.id>$3 AND (CASE WHEN $4 THEN m.user_id IS NULL AND u.id<>$2 AND (EXISTS(SELECT 1 FROM pulse.friendships f WHERE f.user_low=LEAST($2::uuid,u.id) AND f.user_high=GREATEST($2::uuid,u.id)) OR EXISTS(SELECT 1 FROM pulse.conversations c JOIN pulse.members actor ON actor.conversation_id=c.id AND actor.user_id=$2 AND actor.active JOIN pulse.members peer ON peer.conversation_id=c.id AND peer.user_id=u.id AND peer.active JOIN pulse.user_states st ON st.conversation_id=c.id AND st.user_id=$2 AND NOT st.hidden WHERE c.kind='direct' AND c.active)) AND NOT EXISTS(SELECT 1 FROM pulse.blocks b WHERE(b.user_id=u.id AND b.peer_id=$2)OR(b.user_id=$2 AND b.peer_id=u.id)) ELSE m.user_id IS NOT NULL AND($5 OR(NOT $6 AND EXISTS(SELECT 1 FROM pulse.friendships f WHERE f.user_low=LEAST($2::uuid,u.id) AND f.user_high=GREATEST($2::uuid,u.id))) OR($6 AND m.role IN('owner','admin'))) END)
	AND((NOT u.account_is_internal AND u.account ILIKE $7) OR u.nickname ILIKE $7 OR COALESCE(u.legacy_public_id,u.public_id) ILIKE $7 OR cm.remark ILIKE $7) ORDER BY u.id LIMIT $8`, cid, who.UserID, after, invite, manager, restricted || ac.Kind == "channel", pattern, limit+1)
	if e != nil {
		return nil, "", e
	}
	out := []map[string]any{}
	for rows.Next() {
		var id, account, nick, pid, avatar, role, remark string
		var muted bool
		if e = rows.Scan(&id, &account, &nick, &pid, &avatar, &role, &muted, &remark); e != nil {
			rows.Close()
			return nil, "", e
		}
		out = append(out, map[string]any{"id": id, "account": account, "nickname": nick, "public_id": pid, "avatar_id": avatar, "role": role, "muted": muted, "remark": remark})
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, "", e
	}
	rawHasMore := len(out) > limit
	lastRaw := ""
	if len(out) > 0 {
		lastRaw = out[len(out)-1]["id"].(string)
	}
	if invite {
		allowed := out[:0]
		for _, u := range out {
			if e = contactAllowed(ctx, tx, who.UserID, u["id"].(string), "group_invites"); e == nil {
				allowed = append(allowed, u)
			} else if !errors.Is(e, ErrForbidden) {
				return nil, "", e
			}
		}
		out = allowed
	}
	next := ""
	if len(out) > limit {
		out = out[:limit]
		next = out[len(out)-1]["id"].(string)
	} else if rawHasMore {
		next = lastRaw
	}
	return out, next, tx.Commit(ctx)
}
func (a *API) registerClientCompletion(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/groups/{id}/invite-candidates", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		limit, e := parseSeq(r.URL.Query().Get("limit"), 50)
		if e != nil {
			return e
		}
		items, next, e := s.GroupSearchCursor(r.Context(), who, r.PathValue("id"), r.URL.Query().Get("q"), r.URL.Query().Get("after"), true, int(limit))
		if e != nil {
			return e
		}
		writeJSON(w, 200, map[string]any{"items": items, "next_after": next})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/groups/{id}/search-members", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		limit, err := parseSeq(r.URL.Query().Get("limit"), 100)
		if err != nil {
			return err
		}
		items, next, err := s.GroupSearchCursor(r.Context(), who, r.PathValue("id"), r.URL.Query().Get("q"), r.URL.Query().Get("after"), false, int(limit))
		if err != nil {
			return err
		}
		group, err := s.GroupDetails(r.Context(), who, r.PathValue("id"))
		if err != nil {
			return err
		}
		manager := group.MyRole == "owner" || group.MyRole == "admin"
		writeJSON(w, 200, map[string]any{"items": items, "next_after": next, "conversation_id": group.ID, "can_search": manager, "can_mention_all": manager})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/contacts", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		after := r.URL.Query().Get("after")
		if after == "" {
			after = "00000000-0000-0000-0000-000000000000"
		}
		if !validID(after) {
			return ErrInvalid
		}
		ids, e := s.Friends(r.Context(), who, after)
		if e != nil {
			return e
		}
		items := []Profile{}
		for _, id := range ids {
			v, e := s.profile(r.Context(), who, id)
			if e != nil {
				return e
			}
			items = append(items, v)
		}
		next := ""
		if len(ids) == 100 {
			next = ids[99]
		}
		writeJSON(w, 200, map[string]any{"items": items, "next_after": next})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/conversations/{id}/mentions", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid := r.PathValue("id")
		if !validID(cid) {
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
		ac, e := authorize(r.Context(), tx, who, cid, false)
		if e != nil {
			return e
		}
		rows, e := tx.Query(r.Context(), `SELECT msg.id::text,msg.seq FROM pulse.messages msg JOIN pulse.user_states st ON st.conversation_id=msg.conversation_id AND st.user_id=$2 WHERE msg.conversation_id=$1 AND NOT msg.revoked AND msg.sender_id<>$2 AND msg.seq>GREATEST(st.clear_seq,$3::bigint-1) AND (NOT msg.manager_only OR $4) AND ((NOT msg.imported_legacy AND msg.seq>st.read_seq) OR (msg.imported_legacy AND msg.seq>st.legacy_read_override_seq)) AND NOT EXISTS(SELECT 1 FROM pulse.receipt_facts rf WHERE rf.message_id=msg.id AND rf.user_id=$2 AND rf.status='read') AND(NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.message_id=msg.id AND d.user_id=$2)) AND((msg.content->>'mention_all')='true' OR EXISTS(SELECT 1 FROM pulse.message_mentions m WHERE m.message_id=msg.id AND m.user_id=$2)) ORDER BY msg.seq LIMIT 100`, cid, who.UserID, ac.VisibleFrom, ac.managesGroup())
		if e != nil {
			return e
		}
		items := []map[string]string{}
		for rows.Next() {
			var id string
			var seq int64
			if e = rows.Scan(&id, &seq); e != nil {
				rows.Close()
				return e
			}
			items = append(items, map[string]string{"id": id, "seq": strconv.FormatInt(seq, 10)})
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e == nil {
			writeJSON(w, 200, map[string]any{"items": items})
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/conversations/{id}/messages/{message}/contact", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid, mid := r.PathValue("id"), r.PathValue("message")
		if !validID(cid) || !validID(mid) {
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
		m, e := visibleMessage(r.Context(), tx, who, cid, mid)
		if e != nil {
			return e
		}
		var content MessageContent
		if m.Kind != "contact" || json.Unmarshal(m.Content, &content) != nil || content.Contact == nil {
			return ErrInvalid
		}
		var blocked bool
		if e = tx.QueryRow(r.Context(), "SELECT block_member_friend_requests FROM pulse.conversations WHERE id=$1", cid).Scan(&blocked); e != nil {
			return e
		}
		if blocked {
			return ErrForbidden
		}
		if e = tx.Commit(r.Context()); e != nil {
			return e
		}
		v, e := s.profile(r.Context(), who, content.Contact.ID)
		if e != nil {
			return e
		}
		var canAdd bool
		if e = s.Store.Pool.QueryRow(r.Context(), `SELECT actor.can_add_friends AND u.allow_friend_requests
			AND NOT EXISTS(SELECT 1 FROM pulse.blocks b WHERE(b.user_id=u.id AND b.peer_id=$2) OR (b.user_id=$2 AND b.peer_id=u.id))
			FROM pulse.users u JOIN pulse.users actor ON actor.id=$2 WHERE u.id=$1 AND u.active AND actor.active`, content.Contact.ID, who.UserID).Scan(&canAdd); e != nil {
			return e
		}
		writeJSON(w, 200, map[string]any{"user": v, "is_contact": v.IsContact, "can_add_friend": canAdd && !v.IsContact,
			"add_friend_restriction": map[bool]string{true: "", false: "对方的隐私或屏蔽设置不允许添加"}[canAdd && !v.IsContact],
			"source_conversation_id": cid, "source_message_id": m.Seq})
		return nil
	}))
	mux.HandleFunc("POST /api/v2/conversations/{id}/messages/{message}/contact-request", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			Note string `json:"note"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		cid, mid := r.PathValue("id"), r.PathValue("message")
		if !validID(cid) || !validID(mid) {
			return ErrInvalid
		}
		id, e := s.friendRequestFromCard(r.Context(), who, cid, mid, in.Note)
		if e == nil {
			var result map[string]string
			result, e = s.friendRequestReceipt(r.Context(), who, id)
			if e == nil {
				writeJSON(w, 200, result)
			}
		}
		return e
	}))
}
func (s *Service) friendRequestFromCard(ctx context.Context, who Identity, cid, mid, note string) (string, error) {
	// Read only the target reference here; the request transaction revalidates the source visibility under the conversation lock.
	var target string
	e := s.Store.Pool.QueryRow(ctx, "SELECT content#>>'{contact,id}' FROM pulse.messages WHERE id=$1 AND conversation_id=$2 AND kind='contact'", mid, cid).Scan(&target)
	if e != nil {
		return "", ErrForbidden
	}
	return s.friendRequestWithSource(ctx, who, target, note, "", cid, mid)
}
