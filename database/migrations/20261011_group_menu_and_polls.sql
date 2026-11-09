USE `pulse_im`;

ALTER TABLE `conversation_members`
  ADD COLUMN `cleared_before_message_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `is_pinned`;

CREATE TABLE `group_polls` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `creator_id` BIGINT UNSIGNED NOT NULL,
  `message_id` BIGINT UNSIGNED NULL,
  `question` VARCHAR(200) NOT NULL,
  `multiple_choice` TINYINT(1) NOT NULL DEFAULT 0,
  `request_id` VARCHAR(80) NOT NULL,
  `expires_at` DATETIME NULL,
  `closed_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_poll_request` (`request_id`),
  KEY `idx_poll_conversation` (`conversation_id`, `id`),
  CONSTRAINT `fk_poll_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_poll_creator` FOREIGN KEY (`creator_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `group_poll_options` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `poll_id` BIGINT UNSIGNED NOT NULL,
  `label` VARCHAR(100) NOT NULL,
  `sort_order` TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_poll_option` (`poll_id`, `id`),
  CONSTRAINT `fk_poll_option` FOREIGN KEY (`poll_id`) REFERENCES `group_polls` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `group_poll_votes` (
  `poll_id` BIGINT UNSIGNED NOT NULL,
  `option_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`poll_id`, `user_id`, `option_id`), KEY `idx_vote_option` (`poll_id`, `option_id`),
  KEY `idx_vote_user` (`user_id`),
  CONSTRAINT `fk_vote_option` FOREIGN KEY (`poll_id`, `option_id`) REFERENCES `group_poll_options` (`poll_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `fk_vote_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
