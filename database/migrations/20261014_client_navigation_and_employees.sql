USE `pulse_im`;

ALTER TABLE `user_permissions`
  ADD COLUMN `formal_employee` TINYINT(1) NOT NULL DEFAULT 0 AFTER `internal_staff`;

CREATE TABLE IF NOT EXISTS `client_navigation_config` (
  `id` TINYINT UNSIGNED NOT NULL,
  `explore_links` JSON NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `client_navigation_config` (`id`, `explore_links`, `updated_at`)
VALUES (1, '[]', NOW());
