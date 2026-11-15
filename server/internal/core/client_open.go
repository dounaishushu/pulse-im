package core

import (
	"context"
	"net/http"
)

// Opening a chat is idempotent. Concurrent windows must not race a read/PATCH
// of preference_version merely to make an existing conversation visible again.
func (s *Service) OpenConversation(ctx context.Context, who Identity, cid string) (ClientConversation, error) {
	var out ClientConversation
	if !validID(cid) {
		return out, ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return out, err
	}
	if _, err = authorize(ctx, tx, who, cid, false); err != nil {
		return out, err
	}
	changed, err := tx.Exec(ctx, `UPDATE pulse.user_states SET hidden=false,preference_version=preference_version+1 WHERE conversation_id=$1 AND user_id=$2 AND hidden`, cid, who.UserID)
	if err != nil {
		return out, err
	}
	if changed.RowsAffected() > 0 {
		if err = membershipHint(ctx, tx, cid, who.UserID); err != nil {
			return out, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	if changed.RowsAffected() > 0 {
		s.notify()
	}
	items, err := s.ClientConversations(ctx, who, "", cid)
	if err != nil {
		return out, err
	}
	if len(items) != 1 || items[0].ID != cid {
		return out, ErrMissing
	}
	return items[0], nil
}

func (a *API) registerClientOpen(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v2/conversations/{id}/open", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		item, err := a.Service.OpenConversation(r.Context(), who, r.PathValue("id"))
		if err == nil {
			writeJSON(w, 200, item)
		}
		return err
	}))
}
