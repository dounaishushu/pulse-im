USE `pulse_im`;

ALTER TABLE `conversations`
  ADD COLUMN `allow_member_add_friend` TINYINT(1) NOT NULL DEFAULT 1 AFTER `invite_code`;
