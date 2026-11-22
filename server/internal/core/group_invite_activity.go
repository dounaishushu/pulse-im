package core

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Only enrich the already-authorized page. Keep UUID pagination independent of
// changing activity; the invitation dialog sorts after collecting every page.
func addGroupInviteActivity(ctx context.Context, tx pgx.Tx, viewer string, items []map[string]any) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]string, 0, len(items))
	people := make(map[string]map[string]any, len(items))
	for _, person := range items {
		id := person["id"].(string)
		ids = append(ids, id)
		people[id] = person
		person["last_activity"] = ""
		person["pinned"] = false
	}
	rows, err := tx.Query(ctx, `SELECT candidate.user_id::text,st.pinned,latest.created_at
 FROM unnest($2::uuid[]) candidate(user_id)
 JOIN pulse.conversations c ON c.direct_key=LEAST($1::uuid,candidate.user_id)::text||':'||GREATEST($1::uuid,candidate.user_id)::text
 JOIN pulse.members actor ON actor.conversation_id=c.id AND actor.user_id=$1 AND actor.active
 JOIN pulse.members peer ON peer.conversation_id=c.id AND peer.user_id=candidate.user_id AND peer.active
 JOIN pulse.user_states st ON st.conversation_id=c.id AND st.user_id=$1 AND NOT st.hidden
 LEFT JOIN LATERAL (SELECT msg.created_at FROM pulse.messages msg
   WHERE msg.conversation_id=c.id AND msg.seq>=actor.visible_from_seq AND msg.seq>st.clear_seq AND NOT msg.revoked
   AND (NOT msg.manager_only OR actor.role IN ('owner','admin'))
   AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.user_id=$1 AND d.message_id=msg.id)
   ORDER BY msg.seq DESC LIMIT 1) latest ON true
 WHERE c.kind='direct' AND c.active`, viewer, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var pinned bool
		var activity *time.Time
		if err = rows.Scan(&id, &pinned, &activity); err != nil {
			return err
		}
		people[id]["pinned"] = pinned
		if activity != nil {
			people[id]["last_activity"] = activity.UTC().Format(time.RFC3339Nano)
		}
	}
	return rows.Err()
}
