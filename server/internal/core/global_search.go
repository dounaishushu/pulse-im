package core

import (
	"net/http"
	"strings"
	"time"
)

func (a *API) registerGlobalSearch(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/messages/search", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		q := r.URL.Query()
		text := q.Get("q")
		kind := q.Get("kind")
		sender := q.Get("sender_id")
		cid := q.Get("conversation_id")
		before := q.Get("before_id")
		if !validText(text, 0, 200) {
			return ErrInvalid
		}
		for _, id := range []string{sender, cid, before} {
			if id != "" && !validID(id) {
				return ErrInvalid
			}
		}
		switch kind {
		case "", "text", "image", "video", "audio", "file", "contact", "shake":
		default:
			return ErrInvalid
		}
		limit, e := parseSeq(q.Get("limit"), 50)
		if e != nil || limit < 1 || limit > 100 {
			return ErrInvalid
		}
		var from, to *time.Time
		for _, f := range []struct {
			name string
			ptr  **time.Time
		}{{"from", &from}, {"to", &to}} {
			if q.Get(f.name) != "" {
				t, e := time.Parse(time.RFC3339, q.Get(f.name))
				if e != nil {
					return ErrInvalid
				}
				*f.ptr = &t
			}
		}
		tx, e := s.Store.Pool.Begin(r.Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(r.Context())
		if _, e = lockIdentity(r.Context(), tx, who); e != nil {
			return e
		}
		if cid != "" {
			if _, e = authorize(r.Context(), tx, who, cid, false); e != nil {
				return e
			}
		}
		rows, e := tx.Query(r.Context(), `SELECT msg.id::text,msg.conversation_id::text,msg.seq,msg.event_seq,msg.sender_id::text,msg.request_id,msg.body,msg.revoked,msg.version,msg.created_at,msg.updated_at,msg.kind,msg.content,COALESCE(msg.reply_to::text,'')
 FROM pulse.messages msg JOIN pulse.conversations c ON c.id=msg.conversation_id AND c.active JOIN pulse.members m ON m.conversation_id=c.id AND m.user_id=$1 AND m.active JOIN pulse.user_states st ON st.conversation_id=c.id AND st.user_id=m.user_id
 WHERE NOT msg.revoked AND msg.seq>GREATEST(st.clear_seq,m.visible_from_seq-1) AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.user_id=$1 AND d.message_id=msg.id)
 AND($2::uuid IS NULL OR c.id=$2) AND($3::uuid IS NULL OR msg.sender_id=$3) AND($4='' OR msg.kind=$4) AND msg.search_text ILIKE $5
 AND($6::timestamptz IS NULL OR msg.created_at>=$6) AND($7::timestamptz IS NULL OR msg.created_at<$7) AND($8::uuid IS NULL OR msg.id<$8) ORDER BY msg.id DESC LIMIT $9`, who.UserID, optionalUUID(cid), optionalUUID(sender), kind, "%"+escapeLike(text)+"%", from, to, optionalUUID(before), limit)
		if e != nil {
			return e
		}
		items := []Message{}
		for rows.Next() {
			var m Message
			if e = scanMessage(rows, &m); e != nil {
				rows.Close()
				return e
			}
			items = append(items, m)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e != nil {
			return e
		}
		next := ""
		if len(items) == int(limit) {
			next = items[len(items)-1].ID
		}
		writeJSON(w, 200, map[string]any{"items": items, "next_before": next})
		return nil
	}))
}

func escapeLike(s string) string {
	return strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(s)
}
