CREATE TABLE IF NOT EXISTS `user_password_vault` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `password_digest` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `encrypted_password` TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
