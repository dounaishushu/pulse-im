CREATE TABLE IF NOT EXISTS `mobile_device_policy` (
  `id` TINYINT UNSIGNED NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO `mobile_device_policy` (`id`, `enabled`, `updated_at`) VALUES (1, 0, NOW());

CREATE TABLE IF NOT EXISTS `mobile_device_bindings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `device_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `platform` VARCHAR(8) NOT NULL,
  `device_name` VARCHAR(128) NOT NULL DEFAULT '',
  `bound_at` DATETIME NOT NULL,
  `last_login_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_mobile_device_user` (`user_id`),
  KEY `idx_mobile_device_login` (`last_login_at`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
