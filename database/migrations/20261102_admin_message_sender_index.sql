-- Sender-first access for administrative history and descending ID pagination.
-- Existing installations use the idempotent CLI wrapper; no blocking fallback.
ALTER TABLE messages ADD INDEX idx_message_sender_id (sender_id, id), ALGORITHM=INPLACE, LOCK=NONE;
