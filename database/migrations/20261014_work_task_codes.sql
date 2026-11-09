USE `pulse_im`;
SET NAMES utf8mb4;

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
