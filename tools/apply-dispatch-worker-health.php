<?php
require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();
set_exception_handler(static function (Throwable $error): void { fwrite(STDERR, 'Dispatch health migration failed: ' . get_class($error) . PHP_EOL); exit(1); });
$sql = file_get_contents(dirname(__DIR__) . '/database/migrations/20261015_dispatch_worker_health.sql');
foreach (explode(';', $sql) as $statement) {
    $statement = trim($statement); if ($statement === '') continue;
    if (str_starts_with($statement, 'CREATE INDEX idx_dispatch_run_failures') && think\facade\Db::query("SHOW INDEX FROM dispatch_task_runs WHERE Key_name = 'idx_dispatch_run_failures'")) continue;
    think\facade\Db::execute($statement);
}
echo "分发多进程心跳表与失败统计索引已就绪。\n";
