ALTER TABLE pulse.admin_accounts ADD COLUMN legacy_permissions jsonb;
CREATE TABLE pulse.legacy_admin_entries (
 legacy_id bigint PRIMARY KEY,
 admin_id uuid NOT NULL REFERENCES pulse.admin_accounts(id),
 token_hash text NOT NULL,
 token_salt text NOT NULL,
 creation_request_key text,
 telegram_user_id bigint,
 created_at timestamptz NOT NULL,
 revoked_at timestamptz
);
