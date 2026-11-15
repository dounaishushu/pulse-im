package core

import (
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
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
	seen := map[string]bool{}
	items := make([]mediaGrantResult, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		item := mediaGrantResult{ID: id}
		if err = s.mediaVisible(ctx, tx, who, id); err != nil {
			var fault *Fault
			if !errors.As(err, &fault) || (fault.Status != 403 && fault.Status != 404) {
				return nil, err
			}
			item.Error = &struct {
				Status int    `json:"status"`
				Code   string `json:"code"`
			}{Status: fault.Status, Code: fault.Code}
		} else {
			token := opaqueToken()
			item.Access = &mediaGrant{Token: token, ExpiresIn: 120, ContentPath: "/api/v2/media-grants/" + token + "/content", PreviewPath: "/api/v2/media-grants/" + token + "/preview"}
		}
		items = append(items, item)
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	_, err = s.Cache.Client.Pipelined(ctx, func(pipe redis.Pipeliner) error {
		for _, item := range items {
			if item.Access != nil {
				pipe.Set(ctx, s.Cache.Prefix+"media-grant:"+hex.EncodeToString(digest(item.Access.Token)), who.SessionID+":"+item.ID, 2*time.Minute)
			}
		}
		return nil
	})
	if err != nil {
		return nil, ErrBusy
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
