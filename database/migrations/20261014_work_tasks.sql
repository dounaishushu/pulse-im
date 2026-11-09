USE `pulse_im`;
SET NAMES utf8mb4;

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

INSERT IGNORE INTO `work_tasks`
  (`task_key`, `name`, `open_time`, `estimated_minutes`, `description`, `intern_unit_price`, `formal_unit_price`, `question_count`, `sort_order`, `status`, `created_at`, `updated_at`)
VALUES
  ('work_demo', '线上批改题（测试）', '09:00:00', 20, '数学判断题示例任务', 0.401, 0.801, 20, 0, 'enabled', NOW(), NOW());
