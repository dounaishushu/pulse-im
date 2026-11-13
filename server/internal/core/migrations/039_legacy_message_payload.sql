CREATE TABLE pulse.legacy_message_bodies (
 message_id uuid PRIMARY KEY REFERENCES pulse.messages(id),
 body_json jsonb NOT NULL
);
