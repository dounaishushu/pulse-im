USE `pulse_im`;

ALTER TABLE `user_permissions`
  MODIFY COLUMN `allow_view_devices` TINYINT(1) NOT NULL DEFAULT 0;

UPDATE `user_permissions`
SET `allow_view_devices` = 0;
