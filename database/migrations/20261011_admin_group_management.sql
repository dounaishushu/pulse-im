USE `pulse_im`;

ALTER TABLE `conversations`
  ADD COLUMN `max_members` INT UNSIGNED NOT NULL DEFAULT 500 AFTER `allow_member_add_friend`,
  ADD COLUMN `all_muted` TINYINT(1) NOT NULL DEFAULT 0 AFTER `max_members`,
  ADD COLUMN `join_method` ENUM('free','approval','invite') NOT NULL DEFAULT 'free' AFTER `all_muted`,
  ADD COLUMN `status` ENUM('active','disabled') NOT NULL DEFAULT 'active' AFTER `join_method`,
  ADD KEY `idx_conversation_status` (`status`);
