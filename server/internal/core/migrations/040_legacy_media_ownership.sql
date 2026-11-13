ALTER TABLE pulse.legacy_media_paths
 ADD COLUMN legacy_user_id bigint,
 ADD COLUMN legacy_admin_id bigint,
 ADD COLUMN legacy_kind varchar(32) NOT NULL DEFAULT '';
