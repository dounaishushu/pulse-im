-- Preserve the old per-message receipt facts independently from Go watermarks.
-- A legacy read-progress cursor does not prove that every older message has a receipt.
ALTER TABLE pulse.messages ADD COLUMN imported_legacy boolean NOT NULL DEFAULT false;
ALTER TABLE pulse.user_states
 ADD COLUMN legacy_read_override_seq bigint NOT NULL DEFAULT 0 CHECK (legacy_read_override_seq >= 0),
 ADD COLUMN legacy_delivered_override_seq bigint NOT NULL DEFAULT 0 CHECK (legacy_delivered_override_seq >= legacy_read_override_seq);
CREATE TABLE pulse.receipt_facts (
 message_id uuid NOT NULL REFERENCES pulse.messages(id),
 user_id uuid NOT NULL REFERENCES pulse.users(id),
 status text NOT NULL CHECK (status IN ('delivered','read')),
 updated_at timestamptz NOT NULL,
 PRIMARY KEY (message_id,user_id)
);
