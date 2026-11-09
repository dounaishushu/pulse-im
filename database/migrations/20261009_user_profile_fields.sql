USE `pulse_im`;

ALTER TABLE `users`
  ADD COLUMN `username` VARCHAR(64) NULL AFTER `phone`,
  ADD COLUMN `birthday` DATE NULL AFTER `username`,
  ADD COLUMN `gender` VARCHAR(16) NULL AFTER `birthday`,
  ADD COLUMN `signature` VARCHAR(70) NULL AFTER `gender`,
  ADD UNIQUE KEY `uk_user_username` (`username`);

UPDATE `users`
SET `username` = CONCAT('a', `id`)
WHERE `username` IS NULL OR `username` = '';
