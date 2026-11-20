ALTER TABLE pulse.push_devices ADD COLUMN payload_version smallint NOT NULL DEFAULT 1 CHECK(payload_version IN (1,2));
ALTER TABLE pulse.push_deliveries ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE pulse.push_deliveries ADD COLUMN retry_at timestamptz;
