USE `pulse_im`;
SET NAMES utf8mb4;

-- 已部署每日批次表的升级：固定保存当天题目内容，避免管理员修改题库影响当天任务。
SET @daily_question_snapshot_column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'work_task_daily_questions'
    AND COLUMN_NAME = 'questions_snapshot_json'
);
SET @daily_question_snapshot_sql := IF(
  @daily_question_snapshot_column_exists = 0,
  'ALTER TABLE `work_task_daily_questions` ADD COLUMN `questions_snapshot_json` JSON NULL AFTER `question_ids_json`',
  'SELECT 1'
);
PREPARE daily_question_snapshot_statement FROM @daily_question_snapshot_sql;
EXECUTE daily_question_snapshot_statement;
DEALLOCATE PREPARE daily_question_snapshot_statement;
