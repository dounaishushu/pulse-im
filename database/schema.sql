CREATE DATABASE IF NOT EXISTS `pulse_im` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `pulse_im`;

CREATE TABLE `users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  `nickname` VARCHAR(64) NOT NULL,
  `phone` VARCHAR(32) NULL,
  `username` VARCHAR(64) NULL,
  `birthday` DATE NULL,
  `birthday_change_count` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `gender` VARCHAR(16) NULL,
  `signature` VARCHAR(70) NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `avatar_url` VARCHAR(512) NULL,
  `register_ip` VARCHAR(45) NULL,
  `status` ENUM('active','frozen','deleted') NOT NULL DEFAULT 'active',
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_users_public_id` (`public_id`), UNIQUE KEY `uk_user_username` (`username`), KEY `idx_phone` (`phone`), KEY `idx_nickname` (`nickname`), KEY `idx_status` (`status`), KEY `idx_users_register_ip` (`register_ip`)
) ENGINE=InnoDB;

CREATE TABLE `ip_region_locations` (
  `ip` VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `country_code` CHAR(2) CHARACTER SET ascii NULL,
  `province_code` CHAR(6) CHARACTER SET ascii NULL,
  `region_name` VARCHAR(100) NULL,
  `region_code` VARCHAR(20) NULL,
  `city_name` VARCHAR(100) NULL,
  `location` VARCHAR(160) NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `checked_at` DATETIME NULL,
  `next_retry_at` DATETIME NOT NULL,
  PRIMARY KEY (`ip`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `user_settings` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `settings_json` JSON NOT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_user_settings_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `user_security` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `two_step_hash` VARCHAR(255) NOT NULL,
  `recovery_hashes` JSON NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_user_security_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `user_permissions` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `muted` TINYINT(1) NOT NULL DEFAULT 0,
  `allow_add_friend` TINYINT(1) NOT NULL DEFAULT 1,
  `allow_create_group` TINYINT(1) NOT NULL DEFAULT 0,
  `internal_staff` TINYINT(1) NOT NULL DEFAULT 0,
  `formal_employee` TINYINT(1) NOT NULL DEFAULT 0,
  `allow_view_devices` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_user_permissions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

CREATE TABLE `sensitive_words` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `word` VARCHAR(128) NOT NULL,
  `replacement` VARCHAR(128) NOT NULL DEFAULT '*',
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sensitive_word` (`word`),
  KEY `idx_sensitive_status` (`status`),
  CONSTRAINT `chk_sensitive_word_not_empty` CHECK (CHAR_LENGTH(`word`) > 0)
) ENGINE=InnoDB;

CREATE TABLE `auth_tokens` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `device_type` VARCHAR(20) NOT NULL DEFAULT 'unknown',
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL,
  `last_used_at` DATETIME NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_token_hash` (`token_hash`), KEY `idx_token_user` (`user_id`),
  KEY `idx_admin_token_user_expiry_activity` (`user_id`, `expires_at`, `last_used_at`),
  CONSTRAINT `fk_token_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

CREATE TABLE `login_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NULL,
  `phone` VARCHAR(32) NULL,
  `device_type` VARCHAR(20) NOT NULL DEFAULT 'unknown',
  `ip` VARCHAR(45) NULL,
  `success` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), KEY `idx_login_user_time` (`user_id`, `created_at`), KEY `idx_login_ip` (`ip`),
  KEY `idx_admin_login_user_success_id` (`user_id`, `success`, `id`),
  CONSTRAINT `fk_login_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

CREATE TABLE `contact_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `from_user_id` BIGINT UNSIGNED NOT NULL,
  `to_user_id` BIGINT UNSIGNED NOT NULL,
  `message` VARCHAR(255) NULL,
  `status` ENUM('pending','accepted','rejected','blocked') NOT NULL DEFAULT 'pending',
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), KEY `idx_contact_to_status` (`to_user_id`, `status`), KEY `idx_contact_from_status` (`from_user_id`, `status`),
  UNIQUE KEY `uk_contact_pair` (`from_user_id`, `to_user_id`),
  CONSTRAINT `fk_contact_from` FOREIGN KEY (`from_user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_contact_to` FOREIGN KEY (`to_user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

CREATE TABLE `contacts` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `contact_user_id` BIGINT UNSIGNED NOT NULL,
  `remark` VARCHAR(64) NULL,
  `group_name` VARCHAR(64) NULL,
  `source_type` VARCHAR(32) NULL,
  `source_request_id` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`user_id`, `contact_user_id`), KEY `idx_contacts_user` (`user_id`),
  CONSTRAINT `fk_contacts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_contacts_contact` FOREIGN KEY (`contact_user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

CREATE TABLE `user_blocks` (
  `blocker_id` BIGINT UNSIGNED NOT NULL,
  `blocked_id` BIGINT UNSIGNED NOT NULL,
  `reason` VARCHAR(255) NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`blocker_id`, `blocked_id`),
  KEY `idx_blocked_user` (`blocked_id`),
  CONSTRAINT `fk_blocker_user` FOREIGN KEY (`blocker_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_blocked_user` FOREIGN KEY (`blocked_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

CREATE TABLE `wallets` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `available_fen` BIGINT NOT NULL DEFAULT 0,
  `frozen_fen` BIGINT NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_wallet_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

CREATE TABLE `wallet_ledgers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `change_fen` BIGINT NOT NULL,
  `balance_after_fen` BIGINT NOT NULL,
  `type` VARCHAR(32) NOT NULL,
  `request_id` VARCHAR(80) NOT NULL,
  `operator_id` BIGINT UNSIGNED NULL,
  `remark` VARCHAR(255) NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_wallet_request` (`request_id`),
  KEY `idx_wallet_user_time` (`user_id`, `created_at`),
  CONSTRAINT `fk_ledger_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

CREATE TABLE `wallet_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `kind` VARCHAR(16) NOT NULL,
  `amount_fen` BIGINT NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `request_id` VARCHAR(80) NOT NULL,
  `remark` VARCHAR(255) NOT NULL DEFAULT '',
  `review_note` VARCHAR(255) NOT NULL DEFAULT '',
  `operator_id` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL,
  `reviewed_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_wallet_application` (`user_id`, `request_id`),
  KEY `idx_wallet_request_queue` (`status`, `id`),
  KEY `idx_wallet_request_user` (`user_id`, `id`),
  CONSTRAINT `fk_wallet_request_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

CREATE TABLE `red_packets` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sender_id` BIGINT UNSIGNED NOT NULL,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `total_fen` BIGINT NOT NULL,
  `remaining_fen` BIGINT NOT NULL,
  `packet_count` INT UNSIGNED NOT NULL,
  `claimed_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `status` ENUM('active','completed','expired','refunded') NOT NULL DEFAULT 'active',
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), KEY `idx_packet_sender` (`sender_id`), KEY `idx_packet_status` (`status`)
) ENGINE=InnoDB;

CREATE TABLE `red_packet_claims` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `packet_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `amount_fen` BIGINT NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_packet_user` (`packet_id`, `user_id`),
  CONSTRAINT `fk_claim_packet` FOREIGN KEY (`packet_id`) REFERENCES `red_packets` (`id`)
) ENGINE=InnoDB;

CREATE TABLE `conversations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `type` ENUM('direct','group','channel','customer_service','favorites') NOT NULL,
  `name` VARCHAR(128) NULL,
  `owner_id` BIGINT UNSIGNED NULL,
  `avatar_url` VARCHAR(512) NULL,
  `description` VARCHAR(500) NULL,
  `announcement` TEXT NULL,
  `invite_code` VARCHAR(64) NULL,
  `allow_member_add_friend` TINYINT(1) NOT NULL DEFAULT 1,
  `max_members` INT UNSIGNED NOT NULL DEFAULT 500,
  `member_count_offset` INT NOT NULL DEFAULT 0,
  `all_muted` TINYINT(1) NOT NULL DEFAULT 0,
  `join_method` ENUM('free','approval','invite') NOT NULL DEFAULT 'free',
  `status` ENUM('active','disabled','deleted') NOT NULL DEFAULT 'active',
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), KEY `idx_conversation_type` (`type`), KEY `idx_conversation_status` (`status`), UNIQUE KEY `uk_conversation_invite_code` (`invite_code`)
) ENGINE=InnoDB;

CREATE TABLE `conversation_members` (
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `role` ENUM('owner','admin','member') NOT NULL DEFAULT 'member',
  `muted_until` DATETIME NULL,
  `notifications_muted` TINYINT(1) NOT NULL DEFAULT 0,
  `is_pinned` TINYINT(1) NOT NULL DEFAULT 0,
  `is_archived` TINYINT(1) NOT NULL DEFAULT 0,
  `cleared_before_message_id` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `hidden_at` DATETIME NULL,
  `joined_at` DATETIME NOT NULL,
  PRIMARY KEY (`conversation_id`, `user_id`),
  KEY `idx_member_user` (`user_id`),
  KEY `idx_member_hidden` (`conversation_id`, `hidden_at`),
  CONSTRAINT `fk_member_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`),
  CONSTRAINT `fk_member_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

-- A committed contiguous read prefix, invalidated with membership removal.
CREATE TABLE `conversation_read_progress` (
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `through_message_id` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `member_role` ENUM('owner','admin','member') NOT NULL,
  `cleared_before_message_id` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `joined_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`conversation_id`, `user_id`),
  KEY `idx_read_progress_user` (`user_id`),
  CONSTRAINT `fk_read_progress_member` FOREIGN KEY (`conversation_id`, `user_id`)
    REFERENCES `conversation_members` (`conversation_id`, `user_id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `conversation_folders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(64) NOT NULL,
  `scope` VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'direct',
  `sort_order` INT NOT NULL DEFAULT 0,
  `collapsed` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_folder_user_scope_name` (`user_id`, `scope`, `name`), KEY `idx_folder_user_scope_order` (`user_id`, `scope`, `sort_order`, `id`),
  CONSTRAINT `fk_folder_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

CREATE TABLE `conversation_folder_items` (
  `folder_id` BIGINT UNSIGNED NOT NULL,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`folder_id`, `conversation_id`), UNIQUE KEY `uk_folder_item_user_conversation` (`user_id`, `conversation_id`),
  CONSTRAINT `fk_folder_item_folder` FOREIGN KEY (`folder_id`) REFERENCES `conversation_folders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_folder_item_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_folder_item_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

ALTER TABLE `red_packets`
  ADD CONSTRAINT `fk_packet_sender` FOREIGN KEY (`sender_id`) REFERENCES `users` (`id`),
  ADD CONSTRAINT `fk_packet_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`);

ALTER TABLE `red_packet_claims`
  ADD CONSTRAINT `fk_claim_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`);

CREATE TABLE `messages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `sender_id` BIGINT UNSIGNED NOT NULL,
  `type` ENUM('text','image','video','file','voice','contact_card','shake','red_packet','system') NOT NULL,
  `request_id` VARCHAR(80) NOT NULL,
  `body_json` JSON NOT NULL,
  `is_group_invite` TINYINT GENERATED ALWAYS AS (IF(`type` = 'system' AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`body_json`, '$.kind')), '') = 'group_invite', 1, 0)) STORED,
  `created_at` DATETIME NOT NULL,
  `recalled_at` DATETIME NULL,
  `edited_at` DATETIME NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_message_request` (`request_id`), KEY `idx_conversation_time` (`conversation_id`, `created_at`), KEY `idx_message_conversation_id` (`conversation_id`, `id`), KEY `idx_message_sender_id` (`sender_id`, `id`), KEY `idx_message_visibility_count` (`conversation_id`, `recalled_at`, `id`, `sender_id`, `type`, `is_group_invite`)
) ENGINE=InnoDB;

CREATE TABLE `message_receipts` (
  `message_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `status` ENUM('delivered','read') NOT NULL DEFAULT 'delivered',
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`message_id`, `user_id`),
  CONSTRAINT `fk_receipt_message` FOREIGN KEY (`message_id`) REFERENCES `messages` (`id`),
  CONSTRAINT `fk_receipt_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

-- Sparse index: user_id=0 represents @all, without one write per group member.
CREATE TABLE `message_mentions` (
  `message_id` BIGINT UNSIGNED NOT NULL,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`message_id`, `user_id`),
  KEY `idx_mention_conversation_user_message` (`conversation_id`, `user_id`, `message_id`),
  CONSTRAINT `fk_mention_message` FOREIGN KEY (`message_id`) REFERENCES `messages` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `group_polls` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `creator_id` BIGINT UNSIGNED NOT NULL,
  `message_id` BIGINT UNSIGNED NULL,
  `question` VARCHAR(200) NOT NULL,
  `multiple_choice` TINYINT(1) NOT NULL DEFAULT 0,
  `request_id` VARCHAR(80) NOT NULL,
  `expires_at` DATETIME NULL,
  `closed_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_poll_request` (`request_id`),
  KEY `idx_poll_conversation` (`conversation_id`, `id`),
  CONSTRAINT `fk_poll_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_poll_creator` FOREIGN KEY (`creator_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `group_poll_options` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `poll_id` BIGINT UNSIGNED NOT NULL,
  `label` VARCHAR(100) NOT NULL,
  `sort_order` TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_poll_option` (`poll_id`, `id`),
  CONSTRAINT `fk_poll_option` FOREIGN KEY (`poll_id`) REFERENCES `group_polls` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `group_poll_votes` (
  `poll_id` BIGINT UNSIGNED NOT NULL,
  `option_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`poll_id`, `user_id`, `option_id`), KEY `idx_vote_option` (`poll_id`, `option_id`),
  KEY `idx_vote_user` (`user_id`),
  CONSTRAINT `fk_vote_option` FOREIGN KEY (`poll_id`, `option_id`) REFERENCES `group_poll_options` (`poll_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `fk_vote_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `admin_audit_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `admin_id` BIGINT UNSIGNED NOT NULL,
  `action` VARCHAR(64) NOT NULL,
  `target_type` VARCHAR(32) NOT NULL,
  `target_id` BIGINT UNSIGNED NULL,
  `request_id` VARCHAR(80) NOT NULL,
  `ip` VARBINARY(16) NULL,
  `detail_json` JSON NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), KEY `idx_audit_time` (`created_at`)
) ENGINE=InnoDB;

CREATE TABLE `notification_devices` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `platform` ENUM('ios','android','web') NOT NULL,
  `device_token` VARCHAR(512) NOT NULL,
  `auth_token_hash` CHAR(64) NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  `last_used_at` DATETIME NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_notification_device_token` (`device_token`), KEY `idx_notification_user_enabled` (`user_id`, `enabled`),
  CONSTRAINT `fk_notification_device_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

CREATE TABLE `client_announcements` (
  `id` TINYINT UNSIGNED NOT NULL,
  `title` VARCHAR(32) NOT NULL,
  `content` TEXT NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `client_announcements` (`id`, `title`, `content`, `enabled`, `revision`, `updated_at`)
VALUES (1, '官方提示', '欢迎来到{app_name}！\n配置由后台系统管理 - 通知公告', 0, 1, NOW());

CREATE TABLE `client_navigation_config` (
  `id` TINYINT UNSIGNED NOT NULL,
  `explore_links` JSON NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `client_navigation_config` (`id`, `explore_links`, `updated_at`)
VALUES (1, '[]', NOW());

CREATE TABLE `client_app_config` (
  `id` TINYINT UNSIGNED NOT NULL,
  `show_group_member_count` TINYINT(1) NOT NULL DEFAULT 1,
  `latest_version` VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  `android_download_url` VARCHAR(2048) NOT NULL DEFAULT '',
  `ios_download_url` VARCHAR(2048) NOT NULL DEFAULT '',
  `pc_download_url` VARCHAR(2048) NOT NULL DEFAULT '',
  `update_description` TEXT NOT NULL,
  `force_update` TINYINT(1) NOT NULL DEFAULT 0,
  `platform_updates_json` JSON NULL,
  `register_require_avatar` TINYINT(1) NOT NULL DEFAULT 0,
  `max_register_accounts_per_ip` INT UNSIGNED NOT NULL DEFAULT 0,
  `mall_links` JSON NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `client_app_config` (`id`, `show_group_member_count`, `latest_version`, `update_description`, `mall_links`, `updated_at`)
VALUES (1, 1, '1.0.0', '', '[{"name":"值得买1","url":""},{"name":"值得买2","url":""},{"name":"值得买3","url":""}]', NOW());

CREATE TABLE `client_routes` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(64) NOT NULL,
  `url` VARCHAR(2048) NOT NULL,
  `ws_url` VARCHAR(2048) NOT NULL DEFAULT '',
  `media_url` VARCHAR(2048) NOT NULL DEFAULT '',
  `sort` INT NOT NULL DEFAULT 0,
  `status` ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_client_routes_status_sort` (`status`, `sort`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `client_route_state` (
  `id` TINYINT UNSIGNED NOT NULL,
  `revision` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO `client_route_state` (`id`,`revision`,`updated_at`) VALUES (1,1,NOW());

CREATE TABLE `user_presence` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `last_seen_at` DATETIME NOT NULL,
  PRIMARY KEY (`user_id`),
  KEY `idx_presence_last_seen` (`last_seen_at`),
  CONSTRAINT `fk_presence_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `work_tasks` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `task_key` VARCHAR(64) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `open_time` TIME NOT NULL DEFAULT '09:00:00',
  `estimated_minutes` SMALLINT UNSIGNED NOT NULL DEFAULT 20,
  `description` TEXT NULL,
  `intern_unit_price` DECIMAL(10,3) NOT NULL DEFAULT 0.000,
  `formal_unit_price` DECIMAL(10,3) NOT NULL DEFAULT 0.000,
  `question_count` INT UNSIGNED NOT NULL DEFAULT 20,
  `sort_order` INT NOT NULL DEFAULT 0,
  `status` ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_work_task_key` (`task_key`),
  KEY `idx_work_task_status_sort` (`status`, `sort_order`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `work_questions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `question_uuid` CHAR(36) NOT NULL,
  `image_url` VARCHAR(2048) NOT NULL,
  `correct_answer` TINYINT(1) NOT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_work_question_uuid` (`question_uuid`),
  KEY `idx_work_question_answer` (`correct_answer`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `work_task_records` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `task_id` BIGINT UNSIGNED NOT NULL,
  `task_date` DATE NOT NULL,
  `employee_type` ENUM('intern','formal') NOT NULL DEFAULT 'intern',
  `status` ENUM('in_progress','pending_review','reviewed') NOT NULL DEFAULT 'in_progress',
  `start_at` DATETIME NOT NULL,
  `submitted_at` DATETIME NULL,
  `reviewed_at` DATETIME NULL,
  `reviewer_id` BIGINT UNSIGNED NULL,
  `reviewer_admin_id` BIGINT UNSIGNED NULL,
  `duration_seconds` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_questions` INT UNSIGNED NOT NULL DEFAULT 0,
  `correct_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `wrong_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `unit_price` DECIMAL(10,3) NOT NULL DEFAULT 0.000,
  `wage` DECIMAL(10,3) NOT NULL DEFAULT 0.000,
  `answers_json` JSON NOT NULL,
  `question_snapshot_json` JSON NOT NULL,
  `review_results_json` JSON NOT NULL,
  `review_note` VARCHAR(500) NOT NULL DEFAULT '',
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_work_record_user_task_date` (`user_id`, `task_id`, `task_date`),
  KEY `idx_work_record_task_status` (`task_id`, `status`, `id`),
  KEY `idx_work_record_user_date` (`user_id`, `task_date`, `id`),
  CONSTRAINT `fk_work_record_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_work_record_task` FOREIGN KEY (`task_id`) REFERENCES `work_tasks` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_work_record_reviewer` FOREIGN KEY (`reviewer_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `work_task_codes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `task_id` BIGINT UNSIGNED NOT NULL,
  `task_date` DATE NOT NULL,
  `code` CHAR(6) NOT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_work_task_code_date` (`task_id`, `task_date`),
  KEY `idx_work_task_code_date` (`task_date`, `id`),
  CONSTRAINT `fk_work_task_code_task` FOREIGN KEY (`task_id`) REFERENCES `work_tasks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `work_task_daily_questions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `task_id` BIGINT UNSIGNED NOT NULL,
  `task_date` DATE NOT NULL,
  `question_ids_json` JSON NOT NULL,
  `questions_snapshot_json` JSON NULL,
  `total_count` INT UNSIGNED NOT NULL,
  `correct_count` INT UNSIGNED NOT NULL,
  `wrong_count` INT UNSIGNED NOT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_work_task_daily_question_date` (`task_id`, `task_date`),
  KEY `idx_work_task_daily_question_date` (`task_date`, `id`),
  CONSTRAINT `fk_work_task_daily_question_task` FOREIGN KEY (`task_id`) REFERENCES `work_tasks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS admin_accounts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'operator',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  permissions_json JSON NULL,
  created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
  UNIQUE KEY uk_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS admin_account_guard (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY
) ENGINE=InnoDB;
INSERT IGNORE INTO admin_account_guard (id) VALUES (1);
CREATE TABLE IF NOT EXISTS admin_account_entries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_id BIGINT UNSIGNED NOT NULL,
  telegram_user_id VARCHAR(20) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_salt CHAR(64) NOT NULL,
  creation_request_key CHAR(64) NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
  UNIQUE KEY uk_admin_entry_account (admin_id),
  UNIQUE KEY uk_admin_entry_token (token_hash),
  UNIQUE KEY uk_admin_entry_creation (creation_request_key),
  KEY idx_admin_entry_telegram (telegram_user_id),
  CONSTRAINT fk_admin_entry_account FOREIGN KEY (admin_id) REFERENCES admin_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS media_references (
  path VARCHAR(255) NOT NULL, message_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (path,message_id), KEY idx_media_message (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS admin_sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, admin_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL, expires_at DATETIME NOT NULL, created_at DATETIME NOT NULL,
  UNIQUE KEY uk_admin_token (token_hash), KEY idx_admin_session (admin_id),
  CONSTRAINT fk_admin_session_account FOREIGN KEY (admin_id) REFERENCES admin_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, username VARCHAR(64) NOT NULL,
  ip VARCHAR(45) NOT NULL, success TINYINT NOT NULL, created_at DATETIME NOT NULL,
  KEY idx_admin_attempt_ip (ip,success,created_at), KEY idx_admin_attempt_user (username,success,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS media_uploads (
  path VARCHAR(255) NOT NULL PRIMARY KEY, user_id BIGINT UNSIGNED NULL,
  admin_id BIGINT UNSIGNED NULL, kind VARCHAR(16) NOT NULL, created_at DATETIME NOT NULL,
  KEY idx_media_owner (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS push_jobs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, message_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL, device_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NOT NULL, lease_until DATETIME NULL,
  last_error VARCHAR(255) NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
  UNIQUE KEY uk_push_message_device (message_id,device_id), KEY idx_push_due (status,next_attempt_at,lease_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS push_cursor (
  id TINYINT PRIMARY KEY, last_event_id BIGINT UNSIGNED NOT NULL DEFAULT 0, heartbeat_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO push_cursor (id,last_event_id) VALUES (1,0);

CREATE TABLE IF NOT EXISTS realtime_sequence (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  last_id BIGINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;
INSERT IGNORE INTO realtime_sequence (id, last_id) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS realtime_events (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  message_id BIGINT UNSIGNED NOT NULL,
  conversation_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  KEY idx_realtime_events_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS websocket_worker_health (
  node_id VARCHAR(64) NOT NULL PRIMARY KEY,
  build_id VARCHAR(64) NOT NULL DEFAULT '',
  process_id INT UNSIGNED NOT NULL,
  event_cursor BIGINT UNSIGNED NOT NULL DEFAULT 0,
  heartbeat_at DATETIME(6) NOT NULL,
  started_at DATETIME(6) NOT NULL,
  KEY idx_websocket_heartbeat (heartbeat_at)
) ENGINE=InnoDB;

-- The singleton sequence lock is retained until the message transaction commits.
-- Unlike AUTO_INCREMENT, this prevents a later transaction from becoming visible
-- before an earlier numbered event and being skipped by a consumer cursor.
DELIMITER $$
DROP TRIGGER IF EXISTS pulse_message_insert_event$$
CREATE TRIGGER pulse_message_insert_event AFTER INSERT ON messages FOR EACH ROW
BEGIN
  IF NEW.type <> 'red_packet' THEN
    UPDATE realtime_sequence SET last_id = last_id + 1 WHERE id = 1;
    INSERT INTO realtime_events (id, message_id, conversation_id, event_type, payload_json, created_at)
    SELECT last_id, NEW.id, NEW.conversation_id, 'message.new',
      JSON_OBJECT('id', NEW.id, 'conversation_id', NEW.conversation_id, 'sender_id', NEW.sender_id,
        'type', NEW.type, 'body', JSON_EXTRACT(NEW.body_json, '$'), 'created_at', NEW.created_at,
        'edited_at', NEW.edited_at, 'recalled_at', NEW.recalled_at, 'status', 'sent'), NOW(6)
    FROM realtime_sequence WHERE id = 1;
  END IF;
END$$

DROP TRIGGER IF EXISTS pulse_message_update_event$$
CREATE TRIGGER pulse_message_update_event AFTER UPDATE ON messages FOR EACH ROW
BEGIN
  IF NEW.type <> 'red_packet' AND
    (NOT (NEW.recalled_at <=> OLD.recalled_at) OR NOT (NEW.edited_at <=> OLD.edited_at) OR NOT (NEW.body_json <=> OLD.body_json)) THEN
    UPDATE realtime_sequence SET last_id = last_id + 1 WHERE id = 1;
    INSERT INTO realtime_events (id, message_id, conversation_id, event_type, payload_json, created_at)
    SELECT last_id, NEW.id, NEW.conversation_id,
      IF(NEW.recalled_at IS NOT NULL, 'message.recalled', 'message.updated'),
      JSON_OBJECT('id', NEW.id, 'conversation_id', NEW.conversation_id, 'sender_id', NEW.sender_id,
        'type', NEW.type, 'body', IF(NEW.recalled_at IS NULL, JSON_EXTRACT(NEW.body_json, '$'), JSON_OBJECT()),
        'created_at', NEW.created_at, 'edited_at', NEW.edited_at, 'recalled_at', NEW.recalled_at,
        'status', IF(NEW.recalled_at IS NULL, 'edited', 'recalled')), NOW(6)
    FROM realtime_sequence WHERE id = 1;
  END IF;
END$$
DELIMITER ;

CREATE TABLE IF NOT EXISTS dispatch_tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  creator_admin_id BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  recipient_type ENUM('user','group') NOT NULL,
  recipient_ids_json JSON NOT NULL,
  trigger_type ENUM('once','cron') NOT NULL,
  execute_at DATETIME NULL,
  cron_expression VARCHAR(255) NULL,
  steps_json JSON NOT NULL,
  status ENUM('pending','running','paused','completed','failed','deleted') NOT NULL DEFAULT 'pending',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  next_run_at DATETIME NULL,
  last_executed_at DATETIME NULL,
  last_error VARCHAR(500) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  KEY idx_dispatch_due (status,next_run_at,id),
  KEY idx_dispatch_creator (creator_admin_id,id),
  CONSTRAINT fk_dispatch_creator FOREIGN KEY (creator_admin_id) REFERENCES admin_accounts(id),
  CONSTRAINT fk_dispatch_sender FOREIGN KEY (sender_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dispatch_task_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT UNSIGNED NOT NULL,
  task_version INT UNSIGNED NOT NULL,
  scheduled_at DATETIME NOT NULL,
  status ENUM('pending','running','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
  step_index INT UNSIGNED NOT NULL DEFAULT 0,
  recipient_index INT UNSIGNED NOT NULL DEFAULT 0,
  next_step_at DATETIME NOT NULL,
  lease_until DATETIME NULL,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  last_error VARCHAR(500) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uk_dispatch_occurrence (task_id,task_version,scheduled_at),
  KEY idx_dispatch_run_due (status,next_step_at,lease_until,id),
  KEY idx_dispatch_run_failures (status,finished_at),
  KEY idx_dispatch_run_task (task_id,status,id),
  CONSTRAINT fk_dispatch_run_task FOREIGN KEY (task_id) REFERENCES dispatch_tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS work_record_reviews (
  request_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  record_id BIGINT UNSIGNED NOT NULL,
  reviewer_admin_id BIGINT UNSIGNED NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json JSON NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uk_work_review_record (record_id),
  CONSTRAINT fk_work_review_record FOREIGN KEY (record_id) REFERENCES work_task_records(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS dispatch_worker_health (
  worker_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  started_at DATETIME NOT NULL,
  heartbeat_at DATETIME NOT NULL,
  last_tick_at DATETIME NULL,
  last_tick_json JSON NULL,
  KEY idx_dispatch_worker_heartbeat (heartbeat_at),
  KEY idx_dispatch_worker_tick (last_tick_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS registration_captchas (
  challenge_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  scene VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  answer_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME NULL,
  KEY idx_registration_captcha_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS registration_captcha_rates (
  bucket_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  hits INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  KEY idx_registration_captcha_rate_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Quotes store only body.reply_to_id; summaries are resolved per viewer at read time.
CREATE TABLE IF NOT EXISTS message_pins (
  conversation_id BIGINT UNSIGNED NOT NULL,
  message_id BIGINT UNSIGNED NOT NULL,
  pinned_by BIGINT UNSIGNED NOT NULL,
  pinned_at DATETIME(6) NOT NULL,
  PRIMARY KEY (conversation_id, message_id),
  KEY idx_message_pin_message (message_id),
  CONSTRAINT fk_message_pin_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_message_pin_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- These controls use the same commit-ordered sequence as ordinary message events.
-- Only IDs are persisted here; the worker resolves the latest safe snapshot.
DELIMITER $$
DROP TRIGGER IF EXISTS pulse_message_pin_insert_event$$
CREATE TRIGGER pulse_message_pin_insert_event AFTER INSERT ON message_pins FOR EACH ROW
BEGIN
  UPDATE realtime_sequence SET last_id = last_id + 1 WHERE id = 1;
  INSERT INTO realtime_events (id, message_id, conversation_id, event_type, payload_json, created_at)
  SELECT last_id, NEW.message_id, NEW.conversation_id, 'conversation.pins', JSON_OBJECT('conversation_id', NEW.conversation_id), NOW(6)
  FROM realtime_sequence WHERE id = 1;
END$$

DROP TRIGGER IF EXISTS pulse_message_pin_delete_event$$
CREATE TRIGGER pulse_message_pin_delete_event AFTER DELETE ON message_pins FOR EACH ROW
BEGIN
  UPDATE realtime_sequence SET last_id = last_id + 1 WHERE id = 1;
  INSERT INTO realtime_events (id, message_id, conversation_id, event_type, payload_json, created_at)
  SELECT last_id, OLD.message_id, OLD.conversation_id, 'conversation.pins', JSON_OBJECT('conversation_id', OLD.conversation_id), NOW(6)
  FROM realtime_sequence WHERE id = 1;
END$$

DROP TRIGGER IF EXISTS pulse_message_recall_remove_pin$$
CREATE TRIGGER pulse_message_recall_remove_pin BEFORE UPDATE ON messages FOR EACH ROW
BEGIN
  IF NEW.recalled_at IS NOT NULL AND OLD.recalled_at IS NULL THEN
    DELETE FROM message_pins WHERE conversation_id = OLD.conversation_id AND message_id = OLD.id;
  END IF;
END$$

-- Explicit deletion runs the pin outbox trigger (FK cascades alone do not).
DROP TRIGGER IF EXISTS pulse_message_delete_remove_pin$$
CREATE TRIGGER pulse_message_delete_remove_pin BEFORE DELETE ON messages FOR EACH ROW
BEGIN
  DELETE FROM message_pins WHERE conversation_id = OLD.conversation_id AND message_id = OLD.id;
END$$

DROP TRIGGER IF EXISTS pulse_message_pin_clear_event$$
CREATE TRIGGER pulse_message_pin_clear_event AFTER UPDATE ON conversation_members FOR EACH ROW
BEGIN
  IF NEW.cleared_before_message_id <> OLD.cleared_before_message_id AND
    EXISTS (SELECT 1 FROM message_pins WHERE conversation_id = NEW.conversation_id) THEN
    UPDATE realtime_sequence SET last_id = last_id + 1 WHERE id = 1;
    INSERT INTO realtime_events (id, message_id, conversation_id, event_type, payload_json, created_at)
    SELECT last_id, NEW.cleared_before_message_id, NEW.conversation_id, 'conversation.pins', JSON_OBJECT('conversation_id', NEW.conversation_id), NOW(6)
    FROM realtime_sequence WHERE id = 1;
  END IF;
END$$
DELIMITER ;

-- Apply once to the shared database before deploying the personal-deletion API.
-- This adds a per-user visibility table; existing messages remain intact.
CREATE TABLE IF NOT EXISTS message_deletions (
  user_id BIGINT UNSIGNED NOT NULL,
  message_id BIGINT UNSIGNED NOT NULL,
  conversation_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (user_id, message_id),
  KEY idx_message_deletions_conversation (user_id, conversation_id, message_id),
  KEY idx_message_deletions_message (message_id),
  CONSTRAINT fk_message_deletions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_message_deletions_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_notifications (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(32) NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  conversation_id BIGINT UNSIGNED NULL,
  request_id BIGINT UNSIGNED NULL,
  pending_request_id BIGINT UNSIGNED NULL,
  request_status VARCHAR(16) NULL,
  body_json JSON NOT NULL,
  read_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uk_notification_pending_request (pending_request_id),
  KEY idx_notification_user_unread (user_id,read_at,id),
  KEY idx_notification_user_cursor (user_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mobile device lock; staged OFF for old-client compatibility.
CREATE TABLE IF NOT EXISTS `mobile_device_policy` (
  `id` TINYINT UNSIGNED NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO `mobile_device_policy` (`id`, `enabled`, `updated_at`) VALUES (1, 0, NOW());

CREATE TABLE IF NOT EXISTS `mobile_device_bindings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `device_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `platform` VARCHAR(8) NOT NULL,
  `device_name` VARCHAR(128) NOT NULL DEFAULT '',
  `bound_at` DATETIME NOT NULL,
  `last_login_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uk_mobile_device_user` (`user_id`),
  KEY `idx_mobile_device_login` (`last_login_at`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `user_password_vault` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `password_digest` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `encrypted_password` TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Admin-controlled inactive account and expired cache cleanup; disabled by default.
CREATE TABLE IF NOT EXISTS maintenance_config (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled TINYINT UNSIGNED NOT NULL DEFAULT 0,
  clean_accounts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  clean_cache TINYINT UNSIGNED NOT NULL DEFAULT 1,
  inactive_days SMALLINT UNSIGNED NOT NULL DEFAULT 90,
  cache_days SMALLINT UNSIGNED NOT NULL DEFAULT 7,
  interval_days SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  run_time CHAR(5) NOT NULL DEFAULT '03:00',
  next_run_at DATETIME NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  updated_admin_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO maintenance_config (id,updated_at) VALUES (1,NOW());

CREATE TABLE IF NOT EXISTS maintenance_state (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  lease_token CHAR(64) NULL,
  lease_until DATETIME NULL,
  worker_seen_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO maintenance_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS maintenance_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  trigger_type VARCHAR(16) NOT NULL,
  admin_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  config_version INT UNSIGNED NULL,
  options_json TEXT NOT NULL,
  selected_ids_json TEXT NULL,
  cutoff_at DATETIME NOT NULL,
  upper_user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  cursor_user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'queued',
  deleted_count INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count INT UNSIGNED NOT NULL DEFAULT 0,
  cache_done TINYINT UNSIGNED NOT NULL DEFAULT 0,
  cache_json TEXT NULL,
  error_code VARCHAR(40) NULL,
  created_at DATETIME NOT NULL,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  UNIQUE KEY uk_maintenance_request (request_id),
  KEY idx_maintenance_queue (status,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS maintenance_run_users (
  run_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  outcome VARCHAR(16) NOT NULL,
  reason VARCHAR(40) NOT NULL,
  last_active_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (run_id,user_id),
  KEY idx_maintenance_user (user_id,run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Additive only. Existing accounts, credentials and business records are preserved.
CREATE TABLE IF NOT EXISTS admin_security_rates (
  bucket_key CHAR(64) NOT NULL PRIMARY KEY,
  hits INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  KEY idx_admin_security_rate_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
