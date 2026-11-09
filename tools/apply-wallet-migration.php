<?php
require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();
think\facade\Db::execute(file_get_contents(dirname(__DIR__) . '/database/migrations/20261012_wallet_requests.sql'));
echo "钱包申请表已就绪，原有余额和流水保持不变。\n";
