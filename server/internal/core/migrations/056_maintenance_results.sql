ALTER TABLE pulse.maintenance_runs ADD COLUMN result jsonb NOT NULL DEFAULT '{}'::jsonb;
