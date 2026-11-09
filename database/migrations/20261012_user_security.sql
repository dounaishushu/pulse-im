CREATE TABLE IF NOT EXISTS `user_security` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `two_step_hash` VARCHAR(255) NOT NULL,
  `recovery_hashes` JSON NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_user_security_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
