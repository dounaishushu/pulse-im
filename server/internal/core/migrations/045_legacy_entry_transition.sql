-- Accept the existing PHP entry token during the transition only when it can
-- be re-derived from the old per-account salt and the operator-held secret.
ALTER TABLE pulse.admin_accounts
 ADD COLUMN legacy_numeric_id bigint,
 ADD COLUMN legacy_entry_salt text,
 ADD COLUMN legacy_entry_hash text;
