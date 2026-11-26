-- A deployment may build this index CONCURRENTLY before the transactional
-- migration, avoiding a write-blocking index build on a large login history.
CREATE INDEX IF NOT EXISTS login_events_user_latest_success
    ON pulse.login_events (user_id, created_at DESC, id DESC)
    WHERE success;
