-- Additive migration. The installer checks columns before applying each ALTER.
ALTER TABLE `client_routes` ADD COLUMN `ws_url` VARCHAR(2048) NOT NULL DEFAULT '' AFTER `url`;
ALTER TABLE `client_routes` ADD COLUMN `media_url` VARCHAR(2048) NOT NULL DEFAULT '' AFTER `ws_url`;
CREATE TABLE IF NOT EXISTS `client_route_state` (
  `id` TINYINT UNSIGNED NOT NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO `client_route_state` (`id`,`revision`,`updated_at`) VALUES (1,1,NOW());
