<?php
require dirname(__DIR__) . '/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/'))->initialize();
$transport = new app\Service\PushTransport();
$queue = new app\Service\PushQueueService();
$once = in_array('--once', $argv, true);
$configured = ['android' => $transport->configured('android'), 'ios' => $transport->configured('ios')];
if (!$configured['android'] && !$configured['ios']) { echo json_encode(['status' => 'unconfigured', 'providers' => $configured]) . PHP_EOL; exit($once ? 0 : 2); }
$heartbeat = static function (): void { think\facade\Db::name('push_cursor')->where('id', 1)->update(['heartbeat_at' => date('Y-m-d H:i:s')]); };
$sender = static function (array $device, array $payload) use ($transport, $heartbeat): array { $heartbeat(); return $transport->send($device, $payload); };
do {
    try { $heartbeat(); $queued = $queue->enqueue(); $delivered = $queue->deliver($sender); $heartbeat(); if ($once || $queued || array_sum($delivered)) echo json_encode(['queued' => $queued, 'delivered' => $delivered]) . PHP_EOL; }
    catch (Throwable $error) { fwrite(STDERR, 'Push worker failed: ' . get_class($error) . PHP_EOL); if ($once) exit(1); }
    if (!$once) usleep(500000);
} while (!$once);
