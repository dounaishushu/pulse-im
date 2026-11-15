package core

import (
	"context"
	"net/http"
)

type mediaGrantResult struct {
	ID     string      `json:"id"`
	Access *mediaGrant `json:"access,omitempty"`
	Error  *struct {
		Status int    `json:"status"`
		Code   string `json:"code"`
	} `json:"error,omitempty"`
}

func (s *Service) batchMediaGrants(ctx context.Context, who Identity, ids []string) ([]mediaGrantResult, error) {
	if len(ids) == 0 || len(ids) > 128 {
		return nil, ErrInvalid
	}
	for _, id := range ids {
		if !validID(id) {
			return nil, ErrInvalid
		}
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return nil, err
	}
	visible := map[string]bool{}
	rows, err := tx.Query(ctx, `SELECT a.id::text FROM pulse.media a WHERE a.id=ANY($1::uuid[]) AND a.status='ready' AND `+visibleMediaPredicate, ids, who.UserID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		visible[id] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	items := make([]mediaGrantResult, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		item := mediaGrantResult{ID: id}
		if !visible[id] {
			item.Error = &struct {
				Status int    `json:"status"`
				Code   string `json:"code"`
			}{Status: 403, Code: "forbidden"}
		} else {
			item.Access = &mediaGrant{}
		}
		items = append(items, item)
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	allowed := make([]string, 0, len(items))
	for _, item := range items {
		if item.Access != nil {
			allowed = append(allowed, item.ID)
		}
	}
	grants, err := s.renewMediaGrants(ctx, who, allowed)
	if err != nil {
		return nil, err
	}
	for i := range items {
		if items[i].Access != nil {
			grant := grants[items[i].ID]
			items[i].Access = &grant
		}
	}
	return items, nil
}

func (a *API) registerBatchMediaGrants(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v2/media/grants", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			IDs []string `json:"media_ids"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		items, err := a.Service.batchMediaGrants(r.Context(), who, in.IDs)
		if err == nil {
			writeJSON(w, 200, map[string]any{"items": items})
		}
		return err
	}))
}
