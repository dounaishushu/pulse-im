USE `pulse_im`;

ALTER TABLE `conversations`
  ADD COLUMN `avatar_url` VARCHAR(512) NULL AFTER `owner_id`,
  ADD COLUMN `description` VARCHAR(500) NULL AFTER `avatar_url`,
  ADD COLUMN `announcement` TEXT NULL AFTER `description`,
  ADD COLUMN `invite_code` VARCHAR(64) NULL AFTER `announcement`,
  ADD UNIQUE KEY `uk_conversation_invite_code` (`invite_code`);

ALTER TABLE `conversation_members`
  ADD COLUMN `notifications_muted` TINYINT(1) NOT NULL DEFAULT 0 AFTER `muted_until`,
  ADD COLUMN `is_pinned` TINYINT(1) NOT NULL DEFAULT 0 AFTER `notifications_muted`;

UPDATE `conversations`
SET `invite_code` = CONCAT('G', `id`, SUBSTRING(REPLACE(UUID(), '-', ''), 1, 8))
WHERE `type` = 'group' AND (`invite_code` IS NULL OR `invite_code` = '');
