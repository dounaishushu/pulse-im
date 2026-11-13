CREATE TABLE pulse.legacy_work_snapshots (
 entity text NOT NULL CHECK(entity IN ('daily','record','review')),
 legacy_id bigint NOT NULL,
 target_id uuid,
 payload jsonb NOT NULL,
 PRIMARY KEY(entity,legacy_id)
);
