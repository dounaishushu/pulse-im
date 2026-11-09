USE `pulse_im`;

CREATE TABLE IF NOT EXISTS `user_presence` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `last_seen_at` DATETIME NOT NULL,
  PRIMARY KEY (`user_id`),
  KEY `idx_presence_last_seen` (`last_seen_at`),
  CONSTRAINT `fk_presence_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;
