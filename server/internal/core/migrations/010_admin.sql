CREATE TABLE pulse.admin_accounts (
 id uuid PRIMARY KEY,account varchar(64) NOT NULL UNIQUE,password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN('superadmin','operator','auditor')),permissions text[] NOT NULL DEFAULT '{}',active boolean NOT NULL DEFAULT true,
 entry_hash bytea NOT NULL UNIQUE CHECK(octet_length(entry_hash)=32),version bigint NOT NULL DEFAULT 1,telegram_user_id bigint UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pulse.admin_sessions (
 id uuid PRIMARY KEY,admin_id uuid NOT NULL REFERENCES pulse.admin_accounts(id),token_hash bytea NOT NULL UNIQUE,csrf_hash bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,revoked_at timestamptz
);
CREATE INDEX admin_sessions_active ON pulse.admin_sessions(admin_id,created_at DESC) WHERE revoked_at IS NULL;
CREATE TABLE pulse.admin_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,admin_id uuid REFERENCES pulse.admin_accounts(id),action text NOT NULL,target_type text NOT NULL,target_id text NOT NULL DEFAULT '',
 request_id text NOT NULL,ip inet,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_recent ON pulse.admin_audit(id DESC);
CREATE TABLE pulse.client_diagnostics (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES pulse.users(id),platform text NOT NULL,version varchar(64) NOT NULL,report jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pulse.ip_locations (ip inet PRIMARY KEY,country text NOT NULL DEFAULT '',province text NOT NULL DEFAULT '',city text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'unknown',updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE pulse.sensitive_words(id uuid PRIMARY KEY,word varchar(128) NOT NULL UNIQUE,replacement varchar(128) NOT NULL,enabled boolean NOT NULL DEFAULT true,version bigint NOT NULL DEFAULT 1);
INSERT INTO pulse.system_settings(key,value) VALUES
 ('announcement','{"enabled":false,"title":"","body":""}'),
 ('releases','{}'),('navigation','[]'),('routes','[]'),
 ('display','{"show_group_count":true}'),
 ('maintenance','{"enabled":false,"retention_days":90,"hour":3,"minute":0}');
