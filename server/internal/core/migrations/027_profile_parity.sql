-- A username chosen at registration is fixed in the PHP system.
ALTER TABLE pulse.users ALTER COLUMN account_changes SET DEFAULT 1;
UPDATE pulse.users SET account_changes=1 WHERE account<>'' AND account_changes=0;
-- An already-set birthday may be changed once. Import preserves the old count.
ALTER TABLE pulse.users ADD COLUMN birthday_change_count integer NOT NULL DEFAULT 0
 CHECK (birthday_change_count BETWEEN 0 AND 1);
