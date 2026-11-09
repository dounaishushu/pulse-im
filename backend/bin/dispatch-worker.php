<?php
require dirname(__DIR__) . '/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/'))->initialize();
$once = in_array('--once', $argv, true);
$runner = new app\Service\DispatchTaskRunnerService();
$health = new app\Service\DispatchWorkerHealthService();
$workerId = substr(hash('sha256', gethostname() ?: 'local'), 0, 12) . ':' . getmypid() . ':' . bin2hex(random_bytes(12));
do {
    try {
        $health->heartbeat($workerId);
        $result = $runner->tick();
        $health->heartbeat($workerId, $result);
        if ($once || array_sum($result)) echo json_encode(['time' => (new DateTimeImmutable('now', new DateTimeZone('Asia/Shanghai')))->format(DATE_ATOM), 'dispatch' => $result], JSON_UNESCAPED_UNICODE) . PHP_EOL;
    } catch (Throwable $error) {
        $databaseFailure = app\Service\DispatchDatabaseFailure::connectionLost($error);
        // Messages and SQL may contain private content. Log only an operational reason.
        fwrite(STDERR, $databaseFailure ? "Dispatch database connection lost; process will restart safely.\n" : "Dispatch worker stopped after an unexpected error; inspect service health.\n");
        try { app\Service\DispatchDatabaseFailure::invalidateConnection(); } catch (Throwable) {}
        // A new process starts with no stale PDO or ORM transaction state. Persisted
        // request IDs/checkpoints resolve uncertain commits without duplicating sends.
        if (!$once) sleep($databaseFailure ? random_int(5, 7) : 5);
        exit($databaseFailure ? 75 : 1);
    }
    if (!$once) usleep(1000000);
} while (!$once);
if ($once) $health->stop($workerId);
