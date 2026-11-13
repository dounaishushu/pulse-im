ALTER TABLE pulse.maintenance_runs ADD COLUMN schedule_key text;
CREATE UNIQUE INDEX maintenance_schedule_key_unique ON pulse.maintenance_runs(schedule_key) WHERE schedule_key IS NOT NULL;
