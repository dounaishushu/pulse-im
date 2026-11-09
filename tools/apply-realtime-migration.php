<?php
require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();

$sql = file_get_contents(dirname(__DIR__) . '/database/migrations/20261015_realtime_outbox.sql');
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
if (trim($statement) !== '') throw new RuntimeException('Unterminated realtime migration statement.');
echo "实时事件与 WebSocket 心跳数据表及消息触发器已就绪。\n";
