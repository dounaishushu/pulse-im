<?php

// 只添加本次群菜单所需的列和表；可重复运行，不覆盖已有数据。
require dirname(__DIR__) . '/backend/vendor/autoload.php';
$app = new think\App(dirname(__DIR__) . '/backend/');
$app->initialize();
$sql = file_get_contents(dirname(__DIR__) . '/database/migrations/20261011_group_menu_and_polls.sql');
try {
    foreach (array_filter(array_map('trim', explode(';', $sql))) as $statement) {
        if (str_starts_with($statement, 'USE ')) continue;
        if (str_starts_with($statement, 'ALTER TABLE')) {
            if (think\facade\Db::query("SHOW COLUMNS FROM `conversation_members` LIKE 'cleared_before_message_id'")) continue;
            think\facade\Db::execute($statement);
            echo "已增加个人历史清空标记。\n";
        } elseif (str_starts_with($statement, 'CREATE TABLE')) {
            preg_match('/CREATE TABLE `([^`]+)`/', $statement, $match);
            if (think\facade\Db::query('SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [$match[1]])) continue;
            think\facade\Db::execute($statement);
            echo '已创建 ' . $match[1] . "。\n";
        }
    }
    echo "群菜单数据库升级完成。\n";
} catch (Throwable $error) {
    fwrite(STDERR, $error->getMessage() . PHP_EOL);
    exit(1);
}
