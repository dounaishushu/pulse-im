package core

import (
	"context"
	"time"
)

func (s *Service) noteActivity(who Identity) {
	select {
	case s.activity <- who:
	default:
	}
}
func (s *Service) RunActivity(ctx context.Context) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	pending := map[string]string{}
	for {
		select {
		case <-ctx.Done():
			return
		case who := <-s.activity:
			if len(pending) < 12000 {
				pending[who.SessionID] = who.UserID
			}
		case <-ticker.C:
			users, sessions := []string{}, []string{}
			for sid, uid := range pending {
				sessions = append(sessions, sid)
				users = append(users, uid)
			}
			pending = map[string]string{}
			pass, cancel := context.WithTimeout(ctx, 5*time.Second)
			for start := 0; start < len(users); start += 256 {
				end := min(start+256, len(users))
				_, _ = s.Store.Pool.Exec(pass, "UPDATE pulse.users SET last_active_at=now() WHERE id=ANY($1::uuid[]) AND active AND last_active_at<now()-interval '30 seconds'", users[start:end])
				_, _ = s.Store.Pool.Exec(pass, "UPDATE pulse.login_sessions SET last_used_at=now() WHERE id=ANY($1::uuid[]) AND revoked_at IS NULL AND last_used_at<now()-interval '30 seconds'", sessions[start:end])
			}
			cancel()
		}
	}
}
