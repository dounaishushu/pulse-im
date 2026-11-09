<?php

require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();

$base = file_get_contents(dirname(__DIR__) . '/database/migrations/20261014_work_task_daily_questions.sql');
$createTable = substr($base, strpos($base, 'CREATE TABLE'));
think\facade\Db::execute($createTable);

$column = think\facade\Db::query("SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'work_task_daily_questions' AND COLUMN_NAME = 'questions_snapshot_json'");
if ((int) ($column[0]['total'] ?? 0) === 0) think\facade\Db::execute('ALTER TABLE `work_task_daily_questions` ADD COLUMN `questions_snapshot_json` JSON NULL AFTER `question_ids_json`');

echo "每日任务题目批次数据库迁移已完成。\n";
