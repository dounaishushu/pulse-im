-- Administrative entry tokens are rotated and returned only once; keep only their digest.
ALTER TABLE pulse.admin_accounts DROP COLUMN entry_token;
