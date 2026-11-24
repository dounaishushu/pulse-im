package core

import (
	"bytes"
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
		THEN (to_jsonb(parent)-'request_hash'-'search_text')||jsonb_build_object('seq',parent.seq::text,'event_seq',parent.event_seq::text,'version',parent.version::text,
		'sender',jsonb_build_object('name',COALESCE(NULLIF(author.nickname,''),'会话成员'),'avatar_id',COALESCE((CASE WHEN author.deleted_at IS NULL THEN author.avatar_id END)::text,''))) ELSE NULL END
		FROM pulse.messages child JOIN pulse.messages parent ON parent.id=child.reply_to AND parent.conversation_id=child.conversation_id
		JOIN pulse.users author ON author.id=parent.sender_id
		WHERE child.conversation_id=$1 AND child.id=ANY($5::uuid[]) AND NOT child.revoked AND child.seq>GREATEST($3::bigint,$4::bigint-1) AND (NOT child.manager_only OR $6)
		AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.user_id=$2 AND d.message_id=child.id)`, cid, who.UserID, access.ClearSeq, access.VisibleFrom, in.IDs, access.managesGroup())
		if err != nil {
			return err
		}
		contexts := make(map[string]map[string]any, len(in.IDs))
		mentionMessages := []*Message{}
		type originalContext struct {
			id      string
			raw     json.RawMessage
			content json.RawMessage
		}
		originals := []originalContext{}
		for rows.Next() {
			var id, seq string
			var message json.RawMessage
			if err = rows.Scan(&id, &seq, &message); err != nil {
				rows.Close()
				return err
			}
			var parent *Message
			if len(message) > 0 {
				err = json.Unmarshal(message, &parent)
			}
			if err != nil {
				rows.Close()
				return err
			}
			if parent != nil {
				mentionMessages = append(mentionMessages, parent)
				originals = append(originals, originalContext{id, message, parent.Content})
			}
			contexts[id] = map[string]any{"message_id": id, "reply_seq": seq, "message": message}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if err = hydrateMentionUsers(r.Context(), tx, mentionMessages...); err != nil {
			return err
		}
		for i, original := range originals {
			if bytes.Equal(original.content, mentionMessages[i].Content) {
				continue
			}
			// Preserve reply fields and apply the same safe legacy body as history.
			var fields map[string]json.RawMessage
			if err = json.Unmarshal(original.raw, &fields); err != nil {
				return err
			}
			fields["content"] = mentionMessages[i].Content
			if fields["body"], err = json.Marshal(mentionMessages[i].Body); err != nil {
				return err
			}
			raw, err := json.Marshal(fields)
			if err != nil {
				return err
			}
			contexts[original.id]["message"] = json.RawMessage(raw)
		}
		items := make([]map[string]any, 0, len(in.IDs))
		for _, id := range in.IDs {
			item, found := contexts[id]
			if !found {
				// 历史读取与引用补齐之间，来源可能已撤回、删除或变得不可见。
				// 只标记该项不可用；不能把内容变化误报成整段会话的权限拒绝。
				// 回显调用方已有的 ID，不泄露隐藏来源的引用位置或正文。
				item = map[string]any{"message_id": id, "reply_seq": "0", "message": nil}
			}
			items = append(items, item)
		}
		if err = tx.Commit(r.Context()); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return nil
	}))
}
