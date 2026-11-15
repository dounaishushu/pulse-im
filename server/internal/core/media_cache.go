package core

import (
	"context"
	"encoding/hex"
	"github.com/redis/go-redis/v9"
	"net/http"
	"time"
)

// Aliases only preserve URL identity. They are never authorization: the short
// lease is renewed after mediaVisible, and every GET rechecks session and media.
func (s *Service) renewMediaGrants(ctx context.Context, who Identity, ids []string) (map[string]mediaGrant, error) {
	out := make(map[string]mediaGrant, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	if !validID(who.SessionID) {
		return nil, ErrUnauthorized
	}
	aliasTTL := 24 * time.Hour
	if !who.ExpiresAt.IsZero() {
		aliasTTL = min(aliasTTL, time.Until(who.ExpiresAt))
	}
	if aliasTTL <= 0 {
		return nil, ErrUnauthorized
	}
	commands := make(map[string]*redis.StringCmd, len(ids))
	_, err := s.Cache.Client.Pipelined(ctx, func(pipe redis.Pipeliner) error {
		for _, id := range ids {
			key := s.Cache.Prefix + "media-alias:" + who.SessionID + ":" + id
			pipe.SetNX(ctx, key, opaqueToken(), aliasTTL)
			commands[id] = pipe.Get(ctx, key)
		}
		return nil
	})
	if err != nil {
		return nil, ErrBusy
	}
	for _, id := range ids {
		token, err := commands[id].Result()
		decoded, decodeErr := hex.DecodeString(token)
		if err != nil || decodeErr != nil || len(decoded) != 32 {
			return nil, ErrBusy
		}
		out[id] = mediaGrant{Token: token, ExpiresIn: 120, ContentPath: "/api/v2/media-grants/" + token + "/content", PreviewPath: "/api/v2/media-grants/" + token + "/preview"}
	}
	_, err = s.Cache.Client.Pipelined(ctx, func(pipe redis.Pipeliner) error {
		for _, id := range ids {
			pipe.Set(ctx, s.Cache.Prefix+"media-grant:"+hex.EncodeToString(digest(out[id].Token)), who.SessionID+":"+id, 2*time.Minute)
		}
		return nil
	})
	if err != nil {
		return nil, ErrBusy
	}
	return out, nil
}

// Revalidation happens after authorization, so cached bytes never bypass logout,
// membership, recall or administrative permissions. No shared/public caching.
func privateMediaCache(w http.ResponseWriter, id, variant, principal string) {
	w.Header().Set("Cache-Control", "private, no-cache, must-revalidate")
	w.Header().Set("ETag", `"`+hex.EncodeToString(digest(principal+":"+id+":"+variant))+`"`)
	w.Header().Add("Vary", "Authorization")
	w.Header().Add("Vary", "Cookie")
}
