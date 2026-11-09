-- Apply once to the shared database before deploying the personal-deletion API.
-- This adds a per-user visibility table; existing messages remain intact.
CREATE TABLE IF NOT EXISTS message_deletions (
  user_id BIGINT UNSIGNED NOT NULL,
  message_id BIGINT UNSIGNED NOT NULL,
  conversation_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (user_id, message_id),
  KEY idx_message_deletions_conversation (user_id, conversation_id, message_id),
  KEY idx_message_deletions_message (message_id),
  CONSTRAINT fk_message_deletions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_message_deletions_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
