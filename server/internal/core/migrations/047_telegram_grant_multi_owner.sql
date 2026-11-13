ALTER TABLE pulse.telegram_grants ADD COLUMN admin_ids uuid[] NOT NULL DEFAULT '{}';
