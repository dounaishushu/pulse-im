CREATE TABLE IF NOT EXISTS `wallet_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `kind` VARCHAR(16) NOT NULL,
  `amount_fen` BIGINT NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `request_id` VARCHAR(80) NOT NULL,
  `remark` VARCHAR(255) NOT NULL DEFAULT '',
  `review_note` VARCHAR(255) NOT NULL DEFAULT '',
  `operator_id` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL,
  `reviewed_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_wallet_application` (`user_id`, `request_id`),
  KEY `idx_wallet_request_queue` (`status`, `id`),
  KEY `idx_wallet_request_user` (`user_id`, `id`),
  CONSTRAINT `fk_wallet_request_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;
