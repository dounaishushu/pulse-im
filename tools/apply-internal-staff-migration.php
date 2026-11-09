<?php

require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();

$columns = think\facade\Db::query("SHOW COLUMNS FROM `messages` LIKE 'edited_at'");
if ($columns === []) {
    think\facade\Db::execute(file_get_contents(dirname(__DIR__) . '/database/migrations/20261013_internal_staff_features.sql'));
    echo "内部人员消息字段迁移已完成。\n";
} else {
    echo "内部人员消息字段已经存在，无需重复迁移。\n";
}
