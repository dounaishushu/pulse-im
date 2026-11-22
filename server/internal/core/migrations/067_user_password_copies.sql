-- Optional, encrypted copies used only by the reauthenticated superadmin API.
-- Login continues to use users.password_hash. This table is never projected in profiles.
CREATE TABLE pulse.user_password_copies (
    user_id uuid PRIMARY KEY REFERENCES pulse.users(id) ON DELETE CASCADE,
    verifier text NOT NULL CHECK (octet_length(verifier) <= 512),
    key_id varchar(64) NOT NULL,
    ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 36 AND 284),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Also invalidate copies on password writes outside the normal application paths.
CREATE FUNCTION pulse.invalidate_user_password_copy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM pulse.user_password_copies WHERE user_id = NEW.id;
    RETURN NEW;
END;
$$;
CREATE TRIGGER invalidate_user_password_copy AFTER UPDATE OF password_hash, deleted_at ON pulse.users
FOR EACH ROW WHEN (OLD.password_hash IS DISTINCT FROM NEW.password_hash
    OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL))
EXECUTE FUNCTION pulse.invalidate_user_password_copy();
