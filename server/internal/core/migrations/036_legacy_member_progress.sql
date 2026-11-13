ALTER TABLE pulse.members ADD COLUMN joined_at timestamptz;
CREATE TABLE pulse.legacy_read_progress (
 conversation_id uuid NOT NULL,
 user_id uuid NOT NULL,
 through_seq bigint NOT NULL DEFAULT 0,
 source_clear_seq bigint NOT NULL DEFAULT 0,
 source_member_role text NOT NULL,
 source_joined_at timestamptz NOT NULL,
 source_updated_at timestamptz NOT NULL,
 PRIMARY KEY(conversation_id,user_id),
 FOREIGN KEY(conversation_id,user_id) REFERENCES pulse.members(conversation_id,user_id)
);
