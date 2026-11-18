package core

import (
	"context"
	"net/http"
	"strings"
	"time"
)

// Presence is lightweight display metadata. It never changes chat activity,
// reads message history, or grants permission to view another user's profile.
type ClientConversationPresence struct {
	ConversationID string     `json:"conversation_id"`
	PeerID         string     `json:"peer_id"`
	Online         bool       `json:"online"`
	LastSeen       *time.Time `json:"last_seen"`
	LastSeenHidden bool       `json:"last_seen_hidden"`
}

// Keep the same block, privacy exception, and friendship rules as profileVisible.
const clientConversationPresenceSQL = `SELECT c.id::text AS conversation_id,peer.id::text AS peer_id,
 CASE WHEN NOT EXISTS(SELECT 1 FROM pulse.blocks b WHERE (b.user_id=$1 AND b.peer_id=peer.id) OR (b.user_id=peer.id AND b.peer_id=$1))
 AND COALESCE(e.effect,'')<>'deny' AND (COALESCE(e.effect,'')='allow' OR COALESCE(p.last_seen,'everyone')='everyone'
 OR (p.last_seen='contacts' AND EXISTS(SELECT 1 FROM pulse.friendships f WHERE f.user_low=LEAST($1::uuid,peer.id) AND f.user_high=GREATEST($1::uuid,peer.id))))
 THEN peer.last_active_at END AS last_seen
 FROM pulse.members m JOIN pulse.conversations c ON c.id=m.conversation_id AND c.active AND c.kind='direct'
 JOIN pulse.user_states st USING(conversation_id,user_id)
 JOIN pulse.users peer ON peer.id=(CASE WHEN split_part(c.direct_key,':',1)::uuid=$1 THEN split_part(c.direct_key,':',2)::uuid ELSE split_part(c.direct_key,':',1)::uuid END) AND peer.active
 LEFT JOIN pulse.privacy_settings p ON p.user_id=peer.id
 LEFT JOIN pulse.privacy_exceptions e ON e.user_id=peer.id AND e.peer_id=$1 AND e.scope='last_seen'
 WHERE m.user_id=$1 AND m.active AND NOT st.hidden AND c.id=ANY($2::uuid[]) ORDER BY c.id`

func presenceConversationIDs(ids []string) ([]string, error) {
	if len(ids) < 1 || len(ids) > 100 {
		return nil, ErrInvalid
	}
	result := make([]string, len(ids))
	seen := make(map[string]bool, len(ids))
	for i, id := range ids {
		id = strings.ToLower(id)
		if !validID(id) || seen[id] {
			return nil, ErrInvalid
		}
		result[i], seen[id] = id, true
	}
	return result, nil
}

func (s *Service) ClientConversationPresence(ctx context.Context, who Identity, ids []string) ([]ClientConversationPresence, error) {
	ids, err := presenceConversationIDs(ids)
	if err != nil {
		return nil, err
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, clientConversationPresenceSQL, who.UserID, ids)
	if err != nil {
		return nil, err
	}
	result := make([]ClientConversationPresence, 0, len(ids))
	now := time.Now()
	for rows.Next() {
		var item ClientConversationPresence
		if err = rows.Scan(&item.ConversationID, &item.PeerID, &item.LastSeen); err != nil {
			rows.Close()
			return nil, err
		}
		item.LastSeenHidden = item.LastSeen == nil
		item.Online = item.LastSeen != nil && now.Sub(*item.LastSeen) < time.Minute
		result = append(result, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}

func (a *API) registerClientPresence(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v2/client/conversation-presence", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			IDs []string `json:"conversation_ids"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		ids, err := presenceConversationIDs(in.IDs)
		if err != nil {
			return err
		}
		items, err := a.Service.ClientConversationPresence(r.Context(), who, ids)
		if err != nil {
			return err
		}
		found := make(map[string]bool, len(items))
		for _, item := range items {
			found[item.ConversationID] = true
		}
		removed := make([]string, 0)
		for _, id := range ids {
			if !found[id] {
				removed = append(removed, id)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items, "removed_ids": removed})
		return nil
	}))
}
