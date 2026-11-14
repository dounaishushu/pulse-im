package core

import (
	"encoding/json"
	"net/http"
)

// Reply context is read under the current viewer's history boundary. Saved
// snapshots must never reveal a parent hidden by a later clear or deletion.
func (a *API) registerReplyContext(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v2/conversations/{id}/reply-contexts", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid := r.PathValue("id")
		var in struct {
			IDs []string `json:"message_ids"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		if !validID(cid) || len(in.IDs) < 1 || len(in.IDs) > 100 {
			return ErrInvalid
		}
		seen := map[string]bool{}
		for _, id := range in.IDs {
			if !validID(id) || seen[id] {
				return ErrInvalid
			}
			seen[id] = true
		}
		tx, err := a.Service.Store.Pool.Begin(r.Context())
		if err != nil {
			return err
		}
		defer tx.Rollback(r.Context())
		if _, err = lockIdentity(r.Context(), tx, who); err != nil {
			return err
		}
		access, err := authorize(r.Context(), tx, who, cid, false)
		if err != nil {
			return err
		}
		rows, err := tx.Query(r.Context(), `SELECT child.id::text,parent.seq::text,
		CASE WHEN NOT parent.revoked AND parent.seq>GREATEST($3::bigint,$4::bigint-1) AND (NOT parent.manager_only OR $6)
		AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.user_id=$2 AND d.message_id=parent.id)
		THEN (to_jsonb(parent)-'request_hash')||jsonb_build_object('seq',parent.seq::text,'event_seq',parent.event_seq::text,'version',parent.version::text,
		'sender',jsonb_build_object('name',COALESCE(NULLIF(author.nickname,''),'会话成员'),'avatar_id',COALESCE(author.avatar_id::text,''))) ELSE NULL END
		FROM pulse.messages child JOIN pulse.messages parent ON parent.id=child.reply_to AND parent.conversation_id=child.conversation_id
		JOIN pulse.users author ON author.id=parent.sender_id
		WHERE child.conversation_id=$1 AND child.id=ANY($5::uuid[]) AND NOT child.revoked AND child.seq>GREATEST($3::bigint,$4::bigint-1) AND (NOT child.manager_only OR $6)
		AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.user_id=$2 AND d.message_id=child.id)`, cid, who.UserID, access.ClearSeq, access.VisibleFrom, in.IDs, access.managesGroup())
		if err != nil {
			return err
		}
		items := []map[string]any{}
		for rows.Next() {
			var id, seq string
			var message json.RawMessage
			if err = rows.Scan(&id, &seq, &message); err != nil {
				rows.Close()
				return err
			}
			items = append(items, map[string]any{"message_id": id, "reply_seq": seq, "message": message})
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(items) != len(in.IDs) {
			return ErrForbidden
		}
		if err = tx.Commit(r.Context()); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return nil
	}))
}
