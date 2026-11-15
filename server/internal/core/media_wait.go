package core

import (
	"context"
	"encoding/hex"
	"net/http"
	"strconv"
	"time"
)

// Completion notifications remove network polling without doing media decoding
// inside HTTP handlers. The existing two workers and pixel budget still apply.
type mediaCompletion struct {
	done chan struct{}
	refs int
}

func (m *MediaStore) wakeWorker() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *MediaStore) watch(id string) (<-chan struct{}, func()) {
	m.mu.Lock()
	entry := m.completion[id]
	if entry == nil {
		entry = &mediaCompletion{done: make(chan struct{})}
		m.completion[id] = entry
	}
	entry.refs++
	m.mu.Unlock()
	return entry.done, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.completion[id] == entry {
			entry.refs--
			if entry.refs == 0 {
				delete(m.completion, id)
			}
		}
	}
}

func (m *MediaStore) completed(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if entry := m.completion[id]; entry != nil {
		delete(m.completion, id)
		close(entry.done)
	}
}

func mediaWaitDuration(r *http.Request) (time.Duration, error) {
	values, present := r.URL.Query()["wait_ms"]
	if !present {
		return 0, nil
	}
	if len(values) != 1 {
		return 0, ErrInvalid
	}
	n, err := strconv.Atoi(values[0])
	if err != nil || n < 0 || n > 1500 {
		return 0, ErrInvalid
	}
	return time.Duration(n) * time.Millisecond, nil
}

func (s *Service) waitForMedia(ctx context.Context, who Identity, initial Media, duration time.Duration) (Media, error) {
	terminal := func(status string) bool { return status == "ready" || status == "failed" || status == "cancelled" }
	if s.Media == nil || duration <= 0 || terminal(initial.Status) {
		return initial, nil
	}
	select {
	case s.Media.waits <- struct{}{}:
		defer func() { <-s.Media.waits }()
	case <-ctx.Done():
		return initial, ctx.Err()
	default:
		return initial, nil
	}
	done, release := s.Media.watch(initial.ID)
	defer release()
	// Subscribe before reading status to cover completion between upload commit
	// and registration. A completed worker cannot be missed by the waiter.
	current, err := s.MediaStatus(ctx, who, initial.ID)
	if err != nil || terminal(current.Status) {
		return current, err
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
	case <-ctx.Done():
		return current, ctx.Err()
	}
	return s.MediaStatus(ctx, who, initial.ID)
}

type mediaGrant struct {
	Token       string `json:"token"`
	ExpiresIn   int    `json:"expires_in"`
	ContentPath string `json:"content_path"`
	PreviewPath string `json:"preview_path"`
}

func (s *Service) createMediaGrant(ctx context.Context, who Identity, id string) (mediaGrant, error) {
	var out mediaGrant
	if !validID(id) {
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
	if err = s.mediaVisible(ctx, tx, who, id); err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	token := opaqueToken()
	if err = s.Cache.Client.Set(ctx, s.Cache.Prefix+"media-grant:"+hex.EncodeToString(digest(token)), who.SessionID+":"+id, 2*time.Minute).Err(); err != nil {
		return out, ErrBusy
	}
	return mediaGrant{Token: token, ExpiresIn: 120, ContentPath: "/api/v2/media-grants/" + token + "/content", PreviewPath: "/api/v2/media-grants/" + token + "/preview"}, nil
}

func (a *API) writeMediaResult(w http.ResponseWriter, r *http.Request, who Identity, status int, media Media, includeAccess bool) error {
	var access *mediaGrant
	if includeAccess && media.Status == "ready" {
		grant, err := a.Service.createMediaGrant(r.Context(), who, media.ID)
		if err != nil {
			return err
		}
		access = &grant
	}
	writeJSON(w, status, struct {
		Media
		Access *mediaGrant `json:"access,omitempty"`
	}{Media: media, Access: access})
	return nil
}
