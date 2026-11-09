<?php

require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();

$sql = file_get_contents(dirname(__DIR__) . '/database/migrations/20261014_work_task_codes.sql');
$createTable = substr($sql, strpos($sql, 'CREATE TABLE'));
think\facade\Db::execute($createTable);
echo "每日任务验证码数据库迁移已完成。\n";
