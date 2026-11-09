<?php
declare(strict_types=1);

// Offline recovery deliberately needs server filesystem access, never an admin UI session.
require dirname(__DIR__) . '/backend/vendor/autoload.php';
use app\Service\AdminIpAccessService;

$action = $argv[1] ?? '';
$ip = $argv[2] ?? '';
$service = new AdminIpAccessService();
try {
    if ($action === 'list') $data = ['items' => $service->listEntries()];
    elseif ($action === 'add') {
        $hours = $argv[3] ?? null;
        if ($hours !== null && (!ctype_digit($hours) || (int) $hours < 1 || (int) $hours > 8760)) throw new InvalidArgumentException('Hours must be 1..8760; omit for a permanent entry.');
        $data = ['entry' => $service->add($ip, $hours === null ? null : (int) $hours * 3600, 'server-cli')];
    } elseif ($action === 'remove') $data = ['removed' => $service->remove($ip, 'server-cli')];
    elseif ($action === 'check') $data = ['allowed' => $service->allows(['REMOTE_ADDR' => $ip])];
    else {
        fwrite(STDERR, "Usage: php tools/manage-admin-ips.php list|add IP [HOURS]|remove IP|check IP\n");
        exit(2);
    }
    echo json_encode(['ok' => true, 'data' => $data], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL;
} catch (Throwable $error) {
    fwrite(STDERR, 'Admin IP operation failed: ' . $error->getMessage() . PHP_EOL);
    exit(1);
}
