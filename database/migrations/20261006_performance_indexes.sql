USE `pulse_im`;

ALTER TABLE `login_logs`
  ADD INDEX `idx_login_phone_failure_time` (`phone`, `success`, `created_at`),
  ADD INDEX `idx_login_ip_failure_time` (`ip`, `success`, `created_at`);

ALTER TABLE `auth_tokens`
  ADD INDEX `idx_token_last_used_user` (`last_used_at`, `user_id`);

ALTER TABLE `messages`
  ADD INDEX `idx_message_created_at` (`created_at`);

ALTER TABLE `red_packets`
  ADD INDEX `idx_packet_created_at` (`created_at`);
