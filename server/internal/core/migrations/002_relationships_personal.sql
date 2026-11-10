-- Account and conversation controls used by the first relationship APIs.
ALTER TABLE pulse.users ADD COLUMN can_create_group boolean NOT NULL DEFAULT true;
ALTER TABLE pulse.conversations ADD COLUMN member_limit integer NOT NULL DEFAULT 500 CHECK (member_limit BETWEEN 2 AND 5000);
ALTER TABLE pulse.members ADD COLUMN visible_from_event_seq bigint NOT NULL DEFAULT 1 CHECK (visible_from_event_seq > 0);
ALTER TABLE pulse.user_states ADD COLUMN personal_seq bigint NOT NULL DEFAULT 0 CHECK (personal_seq >= 0);
ALTER TABLE pulse.user_states ADD COLUMN reminder boolean NOT NULL DEFAULT false;

CREATE TABLE pulse.personal_events (
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    seq bigint NOT NULL CHECK (seq > 0),
    kind text NOT NULL CHECK (kind IN ('message.deleted', 'history.cleared', 'reminder.changed')),
    message_id uuid REFERENCES pulse.messages(id),
    boundary_seq bigint,
    reminder boolean,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, user_id, seq),
    FOREIGN KEY (conversation_id, user_id) REFERENCES pulse.user_states(conversation_id, user_id),
    CHECK ((kind = 'message.deleted' AND message_id IS NOT NULL AND boundary_seq IS NULL AND reminder IS NULL)
        OR (kind = 'history.cleared' AND message_id IS NULL AND boundary_seq IS NOT NULL AND reminder IS NULL)
        OR (kind = 'reminder.changed' AND message_id IS NULL AND boundary_seq IS NULL AND reminder IS NOT NULL))
);

ALTER TABLE pulse.outbox DROP CONSTRAINT outbox_kind_check;
ALTER TABLE pulse.outbox ADD CONSTRAINT outbox_kind_check
    CHECK (kind IN ('conversation.changed', 'state.changed', 'personal.changed', 'membership.changed'));

CREATE INDEX messages_unread_visible ON pulse.messages(conversation_id, seq)
    INCLUDE (sender_id, revoked, id);
CREATE INDEX message_deletions_by_message ON pulse.message_deletions(message_id, user_id);
CREATE INDEX login_sessions_active_device ON pulse.login_sessions(user_id, device_id)
    WHERE revoked_at IS NULL;
