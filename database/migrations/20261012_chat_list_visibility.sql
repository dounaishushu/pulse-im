USE `pulse_im`;

ALTER TABLE `conversation_members`
  ADD COLUMN `hidden_at` DATETIME NULL AFTER `cleared_before_message_id`;
