CREATE TABLE pulse.legacy_ids (
 entity text NOT NULL CHECK(entity IN('user','conversation','message','media','task','question','record','admin','folder')),
 legacy_id bigint NOT NULL CHECK(legacy_id>0),
 new_id uuid NOT NULL,
 PRIMARY KEY(entity,legacy_id),
 UNIQUE(entity,new_id)
);
ALTER TABLE pulse.users ADD COLUMN legacy_public_id varchar(16) UNIQUE;
CREATE INDEX legacy_public_lookup ON pulse.users(legacy_public_id) WHERE legacy_public_id IS NOT NULL;
