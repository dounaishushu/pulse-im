<?php
require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();
think\facade\Db::execute(file_get_contents(dirname(__DIR__) . '/database/migrations/20261012_user_security.sql'));
echo "两步验证数据表已就绪。\n";
