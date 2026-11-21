package core

import (
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type BroadcastTarget struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Name        string `json:"name"`
	Username    string `json:"username"`
	AvatarID    string `json:"avatar_id,omitempty"`
	Remark      string `json:"remark"`
	DisplayName string `json:"display_name"`
	PublicID    string `json:"public_id"`
}

const broadcastFriendTargetsSQL = `SELECT u.id::text AS id,COALESCE(NULLIF(u.nickname,''),CASE WHEN u.account_is_internal THEN '' ELSE u.account END) AS name,
 CASE WHEN u.account_is_internal THEN '' ELSE u.account END AS username,COALESCE(u.avatar_id::text,'') AS avatar_id,COALESCE(cm.remark,'') AS remark,
 COALESCE(NULLIF(cm.remark,''),NULLIF(u.nickname,''),CASE WHEN u.account_is_internal THEN '' ELSE u.account END) AS display_name,COALESCE(u.legacy_public_id,u.public_id) AS public_id
 FROM pulse.friendships f JOIN pulse.users u ON u.id=CASE WHEN f.user_low=$1 THEN f.user_high ELSE f.user_low END
 LEFT JOIN pulse.contact_metadata cm ON cm.user_id=$1 AND cm.peer_id=u.id
 WHERE (f.user_low=$1 OR f.user_high=$1) AND f.created_at<=$2 AND u.id>$3 AND u.active
 AND NOT EXISTS(SELECT 1 FROM pulse.blocks b WHERE(b.user_id=$1 AND b.peer_id=u.id) OR (b.user_id=u.id AND b.peer_id=$1))
 AND ($5='' OR cm.remark ILIKE $6 OR u.nickname ILIKE $6 OR (NOT u.account_is_internal AND u.account ILIKE $6) OR COALESCE(u.legacy_public_id,u.public_id) ILIKE $6)
 ORDER BY u.id LIMIT $4`

const broadcastGroupTargetsSQL = `SELECT c.id::text AS id,c.title AS name,c.title AS username,COALESCE(c.avatar_id::text,'') AS avatar_id,'' AS remark,c.title AS display_name,c.public_id
 FROM pulse.conversations c JOIN pulse.members m ON m.conversation_id=c.id AND m.user_id=$1 AND m.active
 JOIN pulse.user_states st ON st.conversation_id=c.id AND st.user_id=$1
 WHERE c.kind='group' AND c.active AND NOT st.hidden AND c.created_at<=$2 AND m.joined_at<=$2 AND c.id>$3
 AND ($5='' OR c.title ILIKE $6 OR c.public_id ILIKE $6)
 ORDER BY c.id LIMIT $4`

func (a *API) registerBroadcastTargets(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v2/broadcast-targets", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		kind := r.URL.Query().Get("kind")
		if kind != "friend" && kind != "group" {
			return ErrInvalid
		}
		after := r.URL.Query().Get("after")
		if after == "" {
			after = "00000000-0000-0000-0000-000000000000"
		}
		if !validID(after) {
			return ErrInvalid
		}
		query := strings.TrimSpace(r.URL.Query().Get("q"))
		if !validText(query, 0, 100) {
			return ErrInvalid
		}
		pattern := "%" + escapeLike(query) + "%"
		limit, err := parseSeq(r.URL.Query().Get("limit"), 100)
		if err != nil || limit < 1 || limit > 100 {
			return ErrInvalid
		}
		tx, err := a.Service.Store.Pool.Begin(r.Context())
		if err != nil {
			return err
		}
		defer tx.Rollback(r.Context())
		internal, err := lockIdentity(r.Context(), tx, who)
		if err != nil {
			return err
		}
		if !internal {
			return ErrForbidden
		}
		snapshot := r.URL.Query().Get("snapshot")
		var snapshotAt time.Time
		if snapshot == "" {
			if err = tx.QueryRow(r.Context(), "SELECT now()").Scan(&snapshotAt); err != nil {
				return err
			}
		} else {
			snapshotAt, err = time.Parse(time.RFC3339Nano, snapshot)
			if err != nil || snapshotAt.After(time.Now().Add(time.Minute)) {
				return ErrInvalid
			}
		}
		var rows pgx.Rows
		if kind == "friend" {
			rows, err = tx.Query(r.Context(), broadcastFriendTargetsSQL, who.UserID, snapshotAt, after, limit+1, query, pattern)
		} else {
			rows, err = tx.Query(r.Context(), broadcastGroupTargetsSQL, who.UserID, snapshotAt, after, limit+1, query, pattern)
		}
		if err != nil {
			return err
		}
		items := make([]BroadcastTarget, 0, limit+1)
		for rows.Next() {
			var item BroadcastTarget
			item.Type = kind
			if err = rows.Scan(&item.ID, &item.Name, &item.Username, &item.AvatarID, &item.Remark, &item.DisplayName, &item.PublicID); err != nil {
				rows.Close()
				return err
			}
			items = append(items, item)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if err = tx.Commit(r.Context()); err != nil {
			return err
		}
		hasMore := int64(len(items)) > limit
		next := ""
		if hasMore {
			items = items[:limit]
			next = items[len(items)-1].ID
		}
		writeJSON(w, 200, map[string]any{"query": query, "items": items, "total": len(items), "snapshot_max_id": snapshotAt.UTC().Format(time.RFC3339Nano), "next_after_id": next, "has_more": hasMore, "max_recipients": maxBroadcastRecipients})
		return nil
	}))
}
