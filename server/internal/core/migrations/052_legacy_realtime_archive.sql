-- Preserve old realtime transport facts separately from the new outbox.
CREATE TABLE pulse.legacy_realtime_events (
 legacy_id bigint PRIMARY KEY,
 payload jsonb NOT NULL
);
