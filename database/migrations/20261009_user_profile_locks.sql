USE `pulse_im`;

ALTER TABLE `users`
  ADD COLUMN `birthday_change_count` TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER `birthday`;
