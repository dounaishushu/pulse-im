-- Apply before the receipt CPU fix. This creates an empty auxiliary table only.
-- No backfill, receipt deletion, or alteration of the existing large tables.
CREATE TABLE IF NOT EXISTS `conversation_read_progress` (
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `through_message_id` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `member_role` ENUM('owner','admin','member') NOT NULL,
  `cleared_before_message_id` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `joined_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`conversation_id`, `user_id`),
  KEY `idx_read_progress_user` (`user_id`),
  CONSTRAINT `fk_read_progress_member` FOREIGN KEY (`conversation_id`, `user_id`)
    REFERENCES `conversation_members` (`conversation_id`, `user_id`) ON DELETE CASCADE
) ENGINE=InnoDB;
