CREATE TABLE pulse.media (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES pulse.users(id),
 request_id varchar(64) NOT NULL, request_hash bytea NOT NULL,
 kind text NOT NULL CHECK(kind IN ('image','video','audio','file','avatar','question')),
 filename varchar(255) NOT NULL, expected_bytes bigint NOT NULL CHECK(expected_bytes>0 AND expected_bytes<=104857600),
 expected_sha256 text NOT NULL CHECK(length(expected_sha256)=64),
 original boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','receiving','queued','processing','ready','failed','cancelled')),
 mime text NOT NULL DEFAULT '', bytes bigint NOT NULL DEFAULT 0, width integer NOT NULL DEFAULT 0, height integer NOT NULL DEFAULT 0,
 duration_ms bigint NOT NULL DEFAULT 0, compression_applied boolean NOT NULL DEFAULT false,
 source_path text NOT NULL DEFAULT '', content_path text NOT NULL DEFAULT '', preview_path text NOT NULL DEFAULT '',
 lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 error_code varchar(64) NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,request_id)
);
CREATE INDEX media_pending ON pulse.media(created_at,id) WHERE status IN ('pending','receiving','queued','processing');
CREATE INDEX media_owner ON pulse.media(owner_id,created_at DESC);
ALTER TABLE pulse.users ADD CONSTRAINT users_avatar_id_fkey FOREIGN KEY(avatar_id) REFERENCES pulse.media(id);
ALTER TABLE pulse.conversations ADD COLUMN avatar_id uuid REFERENCES pulse.media(id);
ALTER TABLE pulse.messages ADD COLUMN kind text NOT NULL DEFAULT 'text' CHECK(kind IN ('text','image','video','audio','file','contact','shake','system'));
ALTER TABLE pulse.messages ADD COLUMN content jsonb NOT NULL DEFAULT '{}';
ALTER TABLE pulse.messages ADD COLUMN reply_to uuid REFERENCES pulse.messages(id);
CREATE TABLE pulse.message_media (message_id uuid NOT NULL REFERENCES pulse.messages(id),media_id uuid NOT NULL REFERENCES pulse.media(id),PRIMARY KEY(message_id,media_id));
CREATE INDEX message_media_media ON pulse.message_media(media_id,message_id);
CREATE TABLE pulse.message_mentions (message_id uuid NOT NULL REFERENCES pulse.messages(id), user_id uuid NOT NULL REFERENCES pulse.users(id),PRIMARY KEY(message_id,user_id));
CREATE INDEX message_mentions_user ON pulse.message_mentions(user_id,message_id);
CREATE TABLE pulse.message_pins (conversation_id uuid NOT NULL REFERENCES pulse.conversations(id),message_id uuid NOT NULL REFERENCES pulse.messages(id),actor_id uuid NOT NULL REFERENCES pulse.users(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(conversation_id,message_id));
CREATE INDEX messages_search_time ON pulse.messages(conversation_id,created_at,seq);
