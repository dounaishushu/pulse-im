package core

import (
	"context"
	"log/slog"
	"sort"
	"time"
)

func (s *Service) noteActivity(who Identity) {
	if who.UserID == "" || who.SessionID == "" {
		return
	}
	s.activityMu.Lock()
	defer s.activityMu.Unlock()
	if len(s.activity) < 24000 || s.activity[who.SessionID] != "" {
		s.activity[who.SessionID] = who.UserID
	}
}

func (s *Service) flushActivity(ctx context.Context) error {
	s.activityMu.Lock()
	pending := s.activity
	s.activity = make(map[string]string)
	s.activityMu.Unlock()
	users, sessions := make([]string, 0, len(pending)), make([]string, 0, len(pending))
	seen := make(map[string]bool, len(pending))
	for sid, uid := range pending {
		sessions = append(sessions, sid)
		if !seen[uid] {
			users = append(users, uid)
			seen[uid] = true
		}
	}
	sort.Strings(users)
	sort.Strings(sessions)
	// 活跃时间允许延后：跳过正在鉴权或修改的行，避免后台写入排队阻塞后续业务。
	for start := 0; start < len(users); start += 128 {
		if _, err := s.Store.Pool.Exec(ctx, `WITH available AS (
			SELECT id FROM pulse.users WHERE id=ANY($1::uuid[]) AND active
			AND last_active_at<now()-interval '30 seconds' ORDER BY id FOR UPDATE SKIP LOCKED)
			UPDATE pulse.users u SET last_active_at=now() FROM available a WHERE u.id=a.id`, users[start:min(start+128, len(users))]); err != nil {
			return err
		}
	}
	for start := 0; start < len(sessions); start += 128 {
		if _, err := s.Store.Pool.Exec(ctx, `WITH available AS (
			SELECT id FROM pulse.login_sessions WHERE id=ANY($1::uuid[]) AND revoked_at IS NULL
			AND expires_at>now() AND last_used_at<now()-interval '30 seconds' ORDER BY id FOR UPDATE SKIP LOCKED)
			UPDATE pulse.login_sessions s SET last_used_at=now() FROM available a WHERE s.id=a.id`, sessions[start:min(start+128, len(sessions))]); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) RunActivity(ctx context.Context) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pass, cancel := context.WithTimeout(ctx, 5*time.Second)
			if err := s.flushActivity(pass); err != nil && ctx.Err() == nil {
				slog.Warn("activity update deferred")
			}
			cancel()
		}
	}
}
