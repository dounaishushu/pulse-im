USE `pulse_im`;
SET NAMES utf8mb4;

-- 每个任务每天只生成一套题目组合，所有用户在当天共用这套组合。
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
