<?php
require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();
set_exception_handler(static function (Throwable $error): void { fwrite(STDERR, $error->getMessage() . PHP_EOL); exit(1); });
use think\facade\Db;

$exists = Db::query('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', ['admin_accounts', 'permissions_json']);
$sql = file_get_contents(dirname(__DIR__) . '/database/migrations/20261015_admin_permissions.sql');
$sql = preg_replace('/^\s*--.*$/m', '', $sql);
foreach (explode(';', $sql) as $statement) {
    $statement = trim($statement); if ($statement === '') continue;
    if ($exists && str_starts_with($statement, 'ALTER TABLE admin_accounts')) continue;
    Db::execute($statement);
}
echo "后台页面权限字段与账号管理事务锁已就绪；现有账号权限及状态保持不变。\n";
