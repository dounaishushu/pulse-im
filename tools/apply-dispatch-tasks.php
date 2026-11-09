<?php
require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();
set_exception_handler(static function (Throwable $error): void { fwrite(STDERR, $error->getMessage() . PHP_EOL); exit(1); });
$sql = file_get_contents(dirname(__DIR__) . '/database/migrations/20261015_dispatch_tasks.sql');
foreach (explode(';', $sql) as $statement) {
    if (trim($statement) !== '') think\facade\Db::execute(trim($statement));
}
echo "分发任务与版本化定时执行数据表已就绪。\n";
