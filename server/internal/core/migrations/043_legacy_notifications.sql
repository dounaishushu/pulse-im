ALTER TABLE pulse.notifications
 ADD COLUMN legacy_id bigint UNIQUE,
 ADD COLUMN legacy_type text,
 ADD COLUMN legacy_body jsonb,
 ADD COLUMN legacy_request_status text,
 ADD COLUMN legacy_pending_request_id bigint;
CREATE TABLE pulse.legacy_push_devices (
 legacy_id bigint PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES pulse.users(id),
 platform text NOT NULL,
 token text NOT NULL,
 token_hash bytea NOT NULL UNIQUE,
 enabled boolean NOT NULL,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 last_used_at timestamptz
);
