ALTER TABLE pulse.users
 ADD COLUMN nickname varchar(32) NOT NULL DEFAULT '',
 ADD COLUMN public_id text GENERATED ALWAYS AS (upper(replace(id::text,'-',''))) STORED UNIQUE,
 ADD COLUMN phone varchar(24),
 ADD COLUMN birthday date,
 ADD COLUMN gender text NOT NULL DEFAULT 'unspecified' CHECK(gender IN ('unspecified','male','female')),
 ADD COLUMN bio varchar(70) NOT NULL DEFAULT '',
 ADD COLUMN avatar_id uuid,
 ADD COLUMN account_changes integer NOT NULL DEFAULT 0 CHECK(account_changes BETWEEN 0 AND 1),
 ADD COLUMN profile_version bigint NOT NULL DEFAULT 1,
 ADD COLUMN registration_ip inet,
 ADD COLUMN last_active_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN deleted_at timestamptz,
 ADD COLUMN can_add_friends boolean NOT NULL DEFAULT true,
 ADD COLUMN formal_employee boolean NOT NULL DEFAULT false,
 ADD COLUMN can_view_devices boolean NOT NULL DEFAULT false,
 ADD COLUMN inactivity_days integer NOT NULL DEFAULT 180 CHECK(inactivity_days IN (0,30,90,180,365));
CREATE UNIQUE INDEX users_phone ON pulse.users(phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX users_idle ON pulse.users(last_active_at,id) WHERE active AND inactivity_days>0;
UPDATE pulse.users SET nickname=left(account,32);
ALTER TABLE pulse.login_sessions
 ADD COLUMN platform text NOT NULL DEFAULT 'unknown' CHECK(platform IN ('unknown','pc','web','android','ios')),
 ADD COLUMN device_name varchar(128) NOT NULL DEFAULT '',
 ADD COLUMN ip inet,
 ADD COLUMN last_used_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE pulse.security (
 user_id uuid PRIMARY KEY REFERENCES pulse.users(id),
 password_hash text NOT NULL,
 recovery_hashes text[] NOT NULL,
 version bigint NOT NULL DEFAULT 1
);
CREATE TABLE pulse.mobile_bindings (
 user_id uuid PRIMARY KEY REFERENCES pulse.users(id),
 device_hash bytea NOT NULL CHECK(octet_length(device_hash)=32),
 platform text NOT NULL CHECK(platform IN ('android','ios')),
 device_name varchar(128) NOT NULL,
 bound_at timestamptz NOT NULL DEFAULT now(),
 last_login_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pulse.system_settings (
 key text PRIMARY KEY, value jsonb NOT NULL, version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pulse.system_settings(key,value) VALUES
 ('registration','{"enabled":true,"avatar_required":false,"per_ip_limit":0}'),
 ('mobile_binding','{"enabled":false}');
CREATE TABLE pulse.login_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id uuid REFERENCES pulse.users(id), account varchar(64) NOT NULL,
 ip inet, platform text NOT NULL, device_name varchar(128) NOT NULL,
 success boolean NOT NULL, reason varchar(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_events_recent ON pulse.login_events(created_at DESC,id DESC);
CREATE INDEX login_events_user ON pulse.login_events(user_id,id DESC);
ALTER TABLE pulse.privacy_settings
 ADD COLUMN phone text NOT NULL DEFAULT 'nobody' CHECK(phone IN ('everyone','contacts','nobody')),
 ADD COLUMN last_seen text NOT NULL DEFAULT 'everyone' CHECK(last_seen IN ('everyone','contacts','nobody'));
ALTER TABLE pulse.privacy_exceptions DROP CONSTRAINT privacy_exceptions_scope_check;
ALTER TABLE pulse.privacy_exceptions ADD CONSTRAINT privacy_exceptions_scope_check CHECK(scope IN ('temporary_chat','group_invites','phone','last_seen'));
CREATE TABLE pulse.contact_metadata (
 user_id uuid NOT NULL REFERENCES pulse.users(id), peer_id uuid NOT NULL REFERENCES pulse.users(id),
 remark varchar(64) NOT NULL DEFAULT '', group_name varchar(64) NOT NULL DEFAULT '', version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(user_id,peer_id), CHECK(user_id<>peer_id)
);
