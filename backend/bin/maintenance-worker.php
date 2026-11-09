<?php
declare(strict_types=1);
require dirname(__DIR__) . '/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/'))->initialize();
require_once dirname(__DIR__) . '/app/Service/MaintenanceFileService.php';
require_once dirname(__DIR__) . '/app/Service/AdminMaintenanceService.php';
$once = in_array('--once', $argv, true);
do {
    try {
        $result = (new app\Service\AdminMaintenanceService())->tick();
        if ($once || isset($result['id'])) echo json_encode(['time' => date(DATE_ATOM), 'run_id' => $result['id'] ?? null, 'status' => $result['status'] ?? 'idle'], JSON_UNESCAPED_UNICODE) . PHP_EOL;
    } catch (Throwable $error) {
        fwrite(STDERR, 'Maintenance worker failed; inspect application logs and cleanup records.' . PHP_EOL);
        exit(1);
    }
    if (!$once) sleep(15);
} while (!$once);
