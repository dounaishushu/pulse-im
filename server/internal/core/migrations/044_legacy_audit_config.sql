CREATE TABLE pulse.legacy_audit_events (
 source text NOT NULL,
 legacy_id bigint NOT NULL,
 payload jsonb NOT NULL,
 PRIMARY KEY(source,legacy_id)
);
CREATE TABLE pulse.legacy_client_config (
 source text NOT NULL,
 legacy_id bigint NOT NULL,
 payload jsonb NOT NULL,
 PRIMARY KEY(source,legacy_id)
);
ALTER TABLE pulse.ip_locations ADD COLUMN legacy_payload jsonb;
