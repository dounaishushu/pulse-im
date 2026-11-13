CREATE TABLE pulse.legacy_media_paths (
 path varchar(255) PRIMARY KEY,
 media_id uuid NOT NULL UNIQUE REFERENCES pulse.media(id),
 source_bytes bigint NOT NULL CHECK(source_bytes>=0),
 source_sha256 char(64) NOT NULL CHECK(length(source_sha256)=64)
);
