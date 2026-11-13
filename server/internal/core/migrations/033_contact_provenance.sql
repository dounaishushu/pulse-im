-- Keep the source of an imported contact, including the old request number.
ALTER TABLE pulse.contact_metadata
 ADD COLUMN source_type varchar(32),
 ADD COLUMN legacy_source_request_id bigint,
 ADD COLUMN created_at timestamptz;
