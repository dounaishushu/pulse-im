-- Existing relationships intentionally remain unknown: discovery paths were not recorded.
ALTER TABLE contacts ADD COLUMN source_type VARCHAR(32) NULL AFTER group_name;
ALTER TABLE contacts ADD COLUMN source_request_id BIGINT UNSIGNED NULL AFTER source_type;
