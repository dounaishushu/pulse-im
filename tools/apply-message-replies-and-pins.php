<?php
require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();
set_exception_handler(static function (Throwable $error): void { fwrite(STDERR, $error->getMessage() . PHP_EOL); exit(1); });
$sql = file_get_contents(dirname(__DIR__) . '/database/migrations/20261017_message_replies_and_pins.sql');
$delimiter = ';'; $statement = '';
foreach (preg_split('/\r?\n/', $sql) as $line) {
    if (preg_match('/^DELIMITER\s+(\S+)$/', trim($line), $match)) { $delimiter = $match[1]; continue; }
    if (str_starts_with(trim($line), '--')) continue;
    $statement .= $line . "\n";
    if (str_ends_with(rtrim($statement), $delimiter)) {
        $query = trim(substr(rtrim($statement), 0, -strlen($delimiter)));
        if ($query !== '') think\facade\Db::execute($query);
        $statement = '';
    }
}
if (trim($statement) !== '') throw new RuntimeException('Unterminated message pin migration.');
echo "消息引用、共享置顶表与可靠实时触发器已就绪。\n";
