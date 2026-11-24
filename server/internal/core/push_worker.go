package core

import (
	"context"
	"errors"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

const pushMaxAge = 7 * 24 * time.Hour

// Each worker leases one message and sends to a bounded page of devices.
// One page uses at most six waves of eight-second provider attempts.
type PushWorkerConfig struct {
	Workers     int
	BatchSize   int
	Parallelism int
}

func DefaultPushWorkerConfig() PushWorkerConfig {
	return PushWorkerConfig{Workers: 3, BatchSize: 96, Parallelism: 16}
}

func (s *Service) pushWorkerConfig() PushWorkerConfig {
	if s.PushWorkers == (PushWorkerConfig{}) {
		return DefaultPushWorkerConfig()
	}
	return s.PushWorkers
}

type pushCandidate struct {
	PushDevice
	attempts   int
	registered time.Time
	retryAt    *time.Time
	waiting    bool
}

type pushResult struct {
	status, code string
	retryAt      *time.Time
}

func (s *Service) ProcessPushOnce(ctx context.Context) (bool, error) {
	platforms := make([]string, 0, 2)
	for _, platform := range []string{"android", "ios"} {
		if s.Push.Available(platform) {
			platforms = append(platforms, platform)
		}
	}
	if len(platforms) == 0 {
		return false, nil
	}

	settings := s.pushWorkerConfig()
	lease := newID()
	var message pushMessage
	var discard bool
	err := s.Store.Pool.QueryRow(ctx, `WITH candidate AS (
 SELECT message_id FROM pulse.push_jobs WHERE available_at<=now() AND (lease_until IS NULL OR lease_until<now())
 ORDER BY available_at,message_id LIMIT 1 FOR UPDATE SKIP LOCKED
), claimed AS (
 UPDATE pulse.push_jobs j SET lease_token=$1,lease_until=now()+interval '65 seconds',attempts=j.attempts+1
 FROM candidate c WHERE j.message_id=c.message_id RETURNING j.message_id,j.attempts
)
SELECT m.id::text,m.conversation_id::text,c.kind,m.body,m.kind,m.seq,m.content ? 'mentions',
 m.revoked OR NOT c.active OR m.created_at<now()-make_interval(secs=>$2) OR j.attempts>20
 FROM claimed j JOIN pulse.messages m ON m.id=j.message_id JOIN pulse.conversations c ON c.id=m.conversation_id`,
		lease, int(pushMaxAge.Seconds())).Scan(&message.ID, &message.ConversationID, &message.ConversationType, &message.Body, &message.Kind, &message.Seq, &message.HasMentions, &discard)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if discard {
		_, err = s.Store.Pool.Exec(ctx, `DELETE FROM pulse.push_jobs WHERE message_id=$1 AND lease_token=$2`, message.ID, lease)
		return true, err
	}

	// Read, mute and membership are checked when selecting each batch, including
	// retries. Account-wide activity says nothing about whether a phone is in use.
	rows, err := s.Store.Pool.Query(ctx, `SELECT d.id::text,d.user_id::text,d.platform,d.token,d.environment,d.payload_version,
 COALESCE(p.preview,true),d.updated_at,COALESCE(pd.attempts,0),pd.retry_at,COALESCE(pd.retry_at>now(),false)
 FROM pulse.messages msg
 JOIN pulse.conversations c ON c.id=msg.conversation_id AND c.active
 JOIN pulse.members m ON m.conversation_id=msg.conversation_id AND m.active AND m.user_id<>msg.sender_id
 JOIN pulse.user_states st ON st.user_id=m.user_id AND st.conversation_id=m.conversation_id
 JOIN pulse.users u ON u.id=m.user_id AND u.active
 JOIN pulse.push_devices d ON d.user_id=m.user_id AND d.enabled AND d.platform=ANY($2::text[])
 JOIN pulse.login_sessions ls ON ls.id=d.session_id AND ls.user_id=d.user_id AND ls.revoked_at IS NULL AND ls.expires_at>now()
 LEFT JOIN pulse.notification_preferences p ON p.user_id=d.user_id
 LEFT JOIN pulse.push_deliveries pd ON pd.message_id=msg.id AND pd.device_id=d.id
 WHERE msg.id=$1 AND NOT msg.revoked AND (NOT msg.manager_only OR m.role IN('owner','admin'))
 AND NOT st.muted_notifications AND COALESCE(p.enabled,true)
 AND msg.seq>GREATEST(st.read_seq,st.clear_seq,m.visible_from_seq-1)
 AND NOT EXISTS(SELECT 1 FROM pulse.blocks bl WHERE (bl.user_id=m.user_id AND bl.peer_id=msg.sender_id) OR (bl.peer_id=m.user_id AND bl.user_id=msg.sender_id))
 AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions del WHERE del.message_id=msg.id AND del.user_id=m.user_id)
 AND (pd.status IS NULL OR pd.status='failed')
 ORDER BY pd.retry_at NULLS FIRST,d.id LIMIT $3`, message.ID, platforms, settings.BatchSize)
	if err != nil {
		return true, err
	}
	var next *time.Time
	devices := make([]pushCandidate, 0, settings.BatchSize)
	for rows.Next() {
		var d pushCandidate
		if err = rows.Scan(&d.ID, &d.UserID, &d.Platform, &d.Token, &d.Environment, &d.PayloadVersion, &d.Preview, &d.registered, &d.attempts, &d.retryAt, &d.waiting); err != nil {
			rows.Close()
			return true, err
		}
		if d.waiting {
			next = d.retryAt
			rows.Close()
			break
		}
		devices = append(devices, d)
	}
	if err = rows.Err(); err != nil {
		return true, err
	}

	results := s.sendPushBatch(ctx, message, devices, settings.Parallelism)
	for _, r := range results {
		if r.retryAt != nil && (next == nil || r.retryAt.Before(*next)) {
			next = r.retryAt
		}
	}
	if len(devices) == settings.BatchSize {
		// Rotate to the back of the ready queue so large groups don't starve other messages.
		now := time.Now()
		next = &now
	}
	return true, s.finishPushBatch(ctx, message.ID, lease, devices, results, next)
}

const genericPushPreview = "你有一条新消息"

func pushPreview(msg pushMessage) string {
	// Provider notifications cannot resolve each viewer's private name directory.
	if msg.Kind != "text" || msg.Body == "" || msg.HasMentions {
		return genericPushPreview
	}
	text := []rune(msg.Body)
	return string(text[:min(len(text), 120)])
}

func (s *Service) sendPushBatch(ctx context.Context, msg pushMessage, devices []pushCandidate, parallelism int) []pushResult {
	const generic = genericPushPreview
	preview := pushPreview(msg)
	results := make([]pushResult, len(devices))
	var group sync.WaitGroup
	for worker := range min(parallelism, len(devices)) {
		group.Go(func() {
			for i := worker; i < len(devices); i += parallelism {
				d := devices[i]
				body := generic
				if d.Preview {
					body = preview
				}
				attempt, cancel := context.WithTimeout(ctx, 8*time.Second)
				err := s.Push.Send(attempt, d.PushDevice, msg, "新消息", body)
				cancel()
				results[i] = pushOutcome(err, d.attempts+1)
			}
		})
	}
	group.Wait()
	return results
}

func pushOutcome(err error, attempt int) pushResult {
	if err == nil {
		return pushResult{status: "sent"}
	}
	code := "push_failed"
	var fault *Fault
	if errors.As(err, &fault) {
		code = fault.Code
		switch fault.Status {
		case 410:
			return pushResult{status: "expired", code: code}
		case 502:
			return pushResult{status: "rejected", code: code}
		}
	}
	if attempt >= 20 {
		return pushResult{status: "rejected", code: "push_retry_exhausted"}
	}
	delay := min(5*time.Second<<min(attempt-1, 10), time.Hour)
	var backoff *pushBackoff
	if errors.As(err, &backoff) {
		delay = max(delay, backoff.delay)
	}
	retryAt := time.Now().Add(delay + time.Duration(rand.IntN(3000))*time.Millisecond)
	return pushResult{status: "failed", code: code, retryAt: &retryAt}
}

func (s *Service) finishPushBatch(ctx context.Context, mid, lease string, devices []pushCandidate, results []pushResult, next *time.Time) error {
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var held bool
	if err = tx.QueryRow(ctx, `SELECT true FROM pulse.push_jobs WHERE message_id=$1 AND lease_token=$2 AND lease_until>now() FOR UPDATE`, mid, lease).Scan(&held); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if len(devices) > 0 {
		ids := make([]string, len(devices))
		statuses := make([]string, len(devices))
		codes := make([]string, len(devices))
		retries := make([]*time.Time, len(devices))
		registrations := make([]time.Time, len(devices))
		for i, d := range devices {
			ids[i], registrations[i] = d.ID, d.registered
			statuses[i], codes[i], retries[i] = results[i].status, results[i].code, results[i].retryAt
		}
		_, err = tx.Exec(ctx, `WITH batch AS (
 SELECT unnest($2::uuid[]) AS device_id,unnest($3::text[]) AS status,unnest($4::text[]) AS code,
 unnest($5::timestamptz[]) AS retry_at,unnest($6::timestamptz[]) AS registration
), recorded AS (
 INSERT INTO pulse.push_deliveries(message_id,device_id,status,error_code,attempts,retry_at)
 SELECT $1,device_id,status,code,1,retry_at FROM batch
 ON CONFLICT(message_id,device_id) DO UPDATE SET status=EXCLUDED.status,error_code=EXCLUDED.error_code,
 attempts=push_deliveries.attempts+1,retry_at=EXCLUDED.retry_at,updated_at=now() RETURNING device_id
)
UPDATE pulse.push_devices d SET enabled=false FROM batch b JOIN recorded r USING(device_id)
 WHERE d.id=b.device_id AND b.status='expired' AND d.updated_at=b.registration`, mid, ids, statuses, codes, retries, registrations)
		if err != nil {
			return err
		}
	}
	if next == nil {
		_, err = tx.Exec(ctx, `DELETE FROM pulse.push_jobs WHERE message_id=$1`, mid)
	} else {
		_, err = tx.Exec(ctx, `UPDATE pulse.push_jobs SET available_at=$2,lease_until=NULL,lease_token=NULL,attempts=0 WHERE message_id=$1`, mid, *next)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) RunPushWorker(ctx context.Context) {
	if !s.Push.Available("android") && !s.Push.Available("ios") {
		// Keep the disabled-provider queue bounded and retain recent work for reconfiguration.
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for ctx.Err() == nil {
			pass, cancel := context.WithTimeout(ctx, 5*time.Second)
			_ = s.ObserveWorker(pass, "push", func(c context.Context) error {
				_, err := s.Store.Pool.Exec(c, `DELETE FROM pulse.push_jobs WHERE message_id IN (
 SELECT j.message_id FROM pulse.push_jobs j JOIN pulse.messages m ON m.id=j.message_id
 WHERE m.created_at<now()-make_interval(secs=>$1) AND (j.lease_until IS NULL OR j.lease_until<now())
 ORDER BY j.available_at LIMIT 1000)`, int(pushMaxAge.Seconds()))
				return err
			})
			cancel()
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
		return
	}

	var workers sync.WaitGroup
	for range s.pushWorkerConfig().Workers {
		workers.Go(func() {
			for ctx.Err() == nil {
				var worked bool
				pass, cancel := context.WithTimeout(ctx, 56*time.Second)
				err := s.ObserveWorker(pass, "push", func(c context.Context) error {
					var err error
					worked, err = s.ProcessPushOnce(c)
					return err
				})
				cancel()
				if worked && err == nil {
					continue
				}
				timer := time.NewTimer(250 * time.Millisecond)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
		})
	}
	workers.Wait()
}
