CREATE TABLE IF NOT EXISTS `client_announcements` (
  `id` TINYINT UNSIGNED NOT NULL,
  `title` VARCHAR(32) NOT NULL,
  `content` TEXT NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `client_announcements` (`id`, `title`, `content`, `enabled`, `revision`, `updated_at`)
VALUES (1, '官方提示', '欢迎来到{app_name}！\n配置由后台系统管理 - 通知公告', 0, 1, NOW());
