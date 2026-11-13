CREATE TABLE pulse.legacy_dispatch_tasks (
 legacy_id bigint PRIMARY KEY,
 plan_id uuid NOT NULL REFERENCES pulse.dispatch_plans(id),
 source_payload jsonb NOT NULL
);
CREATE TABLE pulse.legacy_dispatch_runs (
 legacy_id bigint PRIMARY KEY,
 legacy_task_id bigint NOT NULL REFERENCES pulse.legacy_dispatch_tasks(legacy_id),
 source_payload jsonb NOT NULL
);
