<?php
require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();
set_exception_handler(static function (Throwable $error): void { fwrite(STDERR, $error->getMessage() . PHP_EOL); exit(1); });
$columns = array_column(think\facade\Db::query('SHOW COLUMNS FROM contacts'), 'Field');
foreach (file(dirname(__DIR__) . '/database/migrations/20261017_contact_origin.sql') as $line) {
    if (!preg_match('/^ALTER TABLE contacts ADD COLUMN ([a-z_]+) /', $line, $match)) continue;
    if (!in_array($match[1], $columns, true)) think\facade\Db::execute(trim($line));
}
echo "联系人真实来源字段已就绪；旧好友未回填来源。\n";
