<?php
require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();
set_exception_handler(static function (Throwable $error): void { fwrite(STDERR, $error->getMessage() . PHP_EOL); exit(1); });
$exists = think\facade\Db::query("SHOW INDEX FROM messages WHERE Key_name = 'idx_message_conversation_id'");
if (!$exists) think\facade\Db::execute(file_get_contents(dirname(__DIR__) . '/database/migrations/20261015_message_sync.sql'));
echo "消息同步分页索引已就绪。\n";
