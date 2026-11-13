CREATE TABLE pulse.legacy_mobile_bindings (
 legacy_id bigint PRIMARY KEY,
 user_id uuid NOT NULL UNIQUE REFERENCES pulse.users(id),
 device_hash text NOT NULL,
 platform text NOT NULL,
 device_name text NOT NULL,
 bound_at timestamptz NOT NULL,
 last_login_at timestamptz NOT NULL
);
CREATE TABLE pulse.legacy_runtime_state (
 source text NOT NULL,
 legacy_id bigint NOT NULL,
 payload jsonb NOT NULL,
 PRIMARY KEY(source,legacy_id)
);

CREATE TABLE pulse.legacy_session_tokens (
 legacy_id bigint PRIMARY KEY,
 session_id uuid NOT NULL UNIQUE REFERENCES pulse.login_sessions(id),
 token_hash_hex char(64) NOT NULL
);
