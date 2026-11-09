-- Apply once after checking SHOW INDEX; keep this additive index on source rollback.
-- Limits the message-send restoration scan to members who actually hid the chat.
ALTER TABLE conversation_members
  ADD INDEX idx_member_hidden (conversation_id, hidden_at),
  ALGORITHM=INPLACE, LOCK=NONE;
