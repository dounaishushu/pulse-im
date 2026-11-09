USE `pulse_im`;

ALTER TABLE `conversations`
  MODIFY COLUMN `type` ENUM('direct','group','channel','customer_service','favorites') NOT NULL;

CREATE TABLE IF NOT EXISTS `conversation_folders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(64) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `collapsed` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_folder_user_name` (`user_id`, `name`), KEY `idx_folder_user_order` (`user_id`, `sort_order`, `id`),
  CONSTRAINT `fk_folder_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `conversation_folder_items` (
  `folder_id` BIGINT UNSIGNED NOT NULL,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`folder_id`, `conversation_id`), KEY `idx_folder_item_user` (`user_id`, `conversation_id`),
  CONSTRAINT `fk_folder_item_folder` FOREIGN KEY (`folder_id`) REFERENCES `conversation_folders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_folder_item_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_folder_item_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;
