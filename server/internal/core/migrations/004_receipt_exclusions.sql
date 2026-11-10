-- Keep receipt facts separate from personal visibility. A later prefix receipt
-- must not retroactively mark an unread cleared/deleted message as read.
-- Pre-existing historical receipt facts cannot be reconstructed from cursors;
-- legacy imports must use their actual receipt records, not invented evidence.
CREATE TABLE pulse.receipt_exclusions (
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('read', 'delivered')),
    first_seq bigint NOT NULL CHECK (first_seq > 0),
    last_seq bigint NOT NULL CHECK (last_seq >= first_seq),
    PRIMARY KEY (conversation_id, user_id, kind, first_seq),
    FOREIGN KEY (conversation_id, user_id) REFERENCES pulse.user_states(conversation_id, user_id)
);
