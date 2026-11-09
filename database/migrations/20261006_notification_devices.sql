USE `pulse_im`;

CREATE TABLE IF NOT EXISTS `notification_devices` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `platform` ENUM('ios','android','web') NOT NULL,
  `device_token` VARCHAR(512) NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  `last_used_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_notification_device_token` (`device_token`),
  KEY `idx_notification_user_enabled` (`user_id`, `enabled`),
  CONSTRAINT `fk_notification_device_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;
