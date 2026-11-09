USE `pulse_im`;

CREATE TABLE IF NOT EXISTS `client_app_config` (
  `id` TINYINT UNSIGNED NOT NULL,
  `show_group_member_count` TINYINT(1) NOT NULL DEFAULT 1,
  `latest_version` VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  `android_download_url` VARCHAR(2048) NOT NULL DEFAULT '',
  `ios_download_url` VARCHAR(2048) NOT NULL DEFAULT '',
  `update_description` TEXT NOT NULL,
  `force_update` TINYINT(1) NOT NULL DEFAULT 0,
  `register_require_avatar` TINYINT(1) NOT NULL DEFAULT 0,
  `max_register_accounts_per_ip` INT UNSIGNED NOT NULL DEFAULT 0,
  `mall_links` JSON NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `client_app_config`
  (`id`, `show_group_member_count`, `latest_version`, `android_download_url`, `ios_download_url`, `update_description`, `force_update`, `register_require_avatar`, `max_register_accounts_per_ip`, `mall_links`, `updated_at`)
VALUES
  (1, 1, '1.0.0', '', '', '', 0, 0, 0, '[{"name":"值得买1","url":""},{"name":"值得买2","url":""},{"name":"值得买3","url":""}]', NOW());

CREATE TABLE IF NOT EXISTS `client_routes` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(64) NOT NULL,
  `url` VARCHAR(2048) NOT NULL,
  `sort` INT NOT NULL DEFAULT 0,
  `status` ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_client_routes_status_sort` (`status`, `sort`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
