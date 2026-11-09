-- Add before enabling the mention-aware MessageService and conversation list.
-- A single user_id=0 index row represents @all; existing messages are untouched.
CREATE TABLE IF NOT EXISTS `message_mentions` (
  `message_id` BIGINT UNSIGNED NOT NULL,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`message_id`, `user_id`),
  KEY `idx_mention_conversation_user_message` (`conversation_id`, `user_id`, `message_id`),
  CONSTRAINT `fk_mention_message` FOREIGN KEY (`message_id`) REFERENCES `messages` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;
