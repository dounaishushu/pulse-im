CREATE TABLE pulse.client_network_observations (
    session_id uuid PRIMARY KEY REFERENCES pulse.login_sessions(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES pulse.users(id) ON DELETE CASCADE,
    observed_ip inet NOT NULL,
    exit_ip inet,
    risk_score double precision CHECK (risk_score >= 0 AND risk_score <= 100),
    is_residential boolean,
    is_broadcast boolean,
    client_version varchar(64) NOT NULL DEFAULT '',
    checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_network_observations_user_latest
    ON pulse.client_network_observations(user_id, checked_at DESC, session_id DESC);
