USE `pulse_im`;

ALTER TABLE `users` ADD COLUMN `register_ip` VARCHAR(45) NULL AFTER `avatar_url`;

CREATE TABLE IF NOT EXISTS `user_permissions` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `muted` TINYINT(1) NOT NULL DEFAULT 0,
  `allow_add_friend` TINYINT(1) NOT NULL DEFAULT 1,
  `allow_create_group` TINYINT(1) NOT NULL DEFAULT 1,
  `internal_staff` TINYINT(1) NOT NULL DEFAULT 0,
  `allow_view_devices` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_user_permissions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

INSERT INTO `user_permissions` (`user_id`, `updated_at`)
SELECT `id`, NOW() FROM `users`
WHERE NOT EXISTS (SELECT 1 FROM `user_permissions` p WHERE p.`user_id` = `users`.`id`);
