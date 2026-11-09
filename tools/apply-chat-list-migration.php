<?php

require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();

if (think\facade\Db::query("SHOW COLUMNS FROM `conversation_members` LIKE 'hidden_at'")) {
    echo "聊天窗口隐藏字段已存在。\n";
    exit(0);
}
think\facade\Db::execute("ALTER TABLE `conversation_members` ADD COLUMN `hidden_at` DATETIME NULL AFTER `cleared_before_message_id`");
echo "聊天窗口隐藏字段已增加。\n";
