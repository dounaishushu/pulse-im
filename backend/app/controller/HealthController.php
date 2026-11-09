<?php

namespace app\controller;

use think\facade\Db;
use think\Response;
use app\Service\RedisTransport;
require_once dirname(__DIR__) . '/Service/UserPasswordVault.php';
require_once dirname(__DIR__) . '/Service/RequestTrace.php';

final class HealthController
{
    public function index(): Response
    {
        $startedAt = microtime(true);
        try {
            Db::query('SELECT 1');
            $database = ['status' => 'up', 'latency_ms' => round((microtime(true) - $startedAt) * 1000, 2)];
        } catch (\Throwable $exception) {
            return json([
                'ok' => false,
                'service' => 'pulse-im-api', 'build_id' => \app\Service\RequestTrace::BUILD_ID,
                'database' => ['status' => 'down', 'latency_ms' => round((microtime(true) - $startedAt) * 1000, 2)],
                'realtime' => ['status' => 'unknown'],
                'websocket' => ['status' => 'unknown'],
                'dispatch' => ['status' => 'unknown'],
                'registration' => ['status' => 'unknown', 'reason' => 'DATABASE_UNAVAILABLE', 'revision' => \app\Service\UserPasswordVault::REVISION],
                'time' => date(DATE_ATOM),
            ], 503);
        }
        $websocket = $this->websocketHealth();
        $realtime = $this->realtimeHealth();
        $push = $this->pushHealth();
        $dispatch = (new \app\Service\DispatchWorkerHealthService())->report();
        $production = strtolower((string) env('APP_ENV', 'development')) === 'production';
        $healthy = $websocket['status'] === 'up' && $realtime['status'] !== 'down' && (!$production || ($push['status'] === 'up' && $dispatch['status'] === 'up'));
        return json(['ok' => $healthy, 'service' => 'pulse-im-api', 'build_id' => \app\Service\RequestTrace::BUILD_ID, 'database' => $database,
            'realtime' => $realtime, 'websocket' => $websocket, 'push' => $push, 'dispatch' => $dispatch,
            'registration' => (new \app\Service\UserPasswordVault())->readiness(), 'time' => date(DATE_ATOM)], $healthy ? 200 : 503);
    }

    private function pushHealth(): array
    {
        $transport = new \app\Service\PushTransport();
        $providers = ['android' => $transport->configured('android'), 'ios' => $transport->configured('ios')];
        try {
            $row = Db::name('push_cursor')->where('id', 1)->find();
            $pending = Db::name('push_jobs')->whereIn('status', ['pending', 'retry', 'sending'])->count();
            $oldest = Db::name('push_jobs')->whereIn('status', ['pending', 'retry', 'sending'])->order('created_at')->value('created_at');
            $failed = Db::name('push_jobs')->where('status', 'failed')->where('updated_at', '>=', date('Y-m-d H:i:s', time() - 86400))->count();
            $heartbeat = $row['heartbeat_at'] ?? null;
            $status = !$providers['android'] || !$providers['ios'] ? 'unconfigured' : (!$heartbeat || strtotime($heartbeat) < time() - 60 || ($oldest && strtotime($oldest) < time() - 300) ? 'down' : 'up');
            return ['status' => $status, 'providers' => $providers, 'last_heartbeat' => $heartbeat, 'pending_jobs' => $pending, 'failed_jobs_24h' => $failed];
        } catch (\Throwable) { return ['status' => 'down', 'providers' => $providers, 'reason' => 'push_store_unavailable']; }
    }

    private function realtimeHealth(): array
    {
        $startedAt = microtime(true);
        $redis = (string) env('REALTIME_DRIVER', 'database') === 'redis';
        $available = !$redis || (new RedisTransport())->ping();
        $result = ['status' => $available ? ($redis ? 'up' : 'fallback') : 'down', 'driver' => $redis ? 'redis' : 'database', 'fallback' => 'durable_database_events'];
        if ((string) env('REALTIME_QUEUE_ROUTINE', '') !== '') {
            try {
                $rows = Db::query('SELECT h.heartbeat_at,TIMESTAMPDIFF(SECOND,h.heartbeat_at,NOW(6)) AS heartbeat_age,q.pending,q.oldest,q.oldest_age FROM realtime_sequencer_health h CROSS JOIN (SELECT COUNT(*) AS pending,MIN(created_at) AS oldest,TIMESTAMPDIFF(SECOND,MIN(created_at),NOW(6)) AS oldest_age FROM realtime_outbox) q WHERE h.id=1');
                $row = $rows[0] ?? [];
                $heartbeat = $row['heartbeat_at'] ?? null;
                $oldest = $row['oldest'] ?? null;
                $result['outbox_pending'] = (int) ($row['pending'] ?? 0);
                $result['sequencer_heartbeat'] = $heartbeat;
                $result['sequencer_heartbeat_age_seconds'] = isset($row['heartbeat_age']) ? (int) $row['heartbeat_age'] : null;
                // Both timestamps come from MySQL. Its UTC session need not use
                // PHP's Asia/Shanghai zone; never parse a DB heartbeat as local time.
                if (!$heartbeat || (int) $row['heartbeat_age'] > 10 || ($oldest && (int) $row['oldest_age'] > 10)) $result['status'] = 'down';
            } catch (\Throwable) { $result['status'] = 'down'; $result['reason'] = 'durable_outbox_unavailable'; }
        }
        $result['latency_ms'] = round((microtime(true) - $startedAt) * 1000, 2);
        return $result;
    }

    private function websocketHealth(): array
    {
        try {
            $expected = max(1, (int) env('WEBSOCKET_WORKERS', 1));
            $rows = Db::query('SELECT COUNT(*) AS workers, SUM(CASE WHEN build_id=? THEN 1 ELSE 0 END) AS current_build_workers, MIN(event_cursor) AS min_cursor, MAX(heartbeat_at) AS last_heartbeat FROM websocket_worker_health WHERE heartbeat_at >= DATE_SUB(NOW(), INTERVAL 15 SECOND)', [\app\Service\RequestTrace::BUILD_ID]);
            $workers = (int) ($rows[0]['workers'] ?? 0);
            $latest = (int) Db::name('realtime_sequence')->where('id', 1)->value('last_id');
            $backlog = $workers > 0 ? max(0, $latest - (int) $rows[0]['min_cursor']) : null;
            $currentWorkers = (int) ($rows[0]['current_build_workers'] ?? 0);
            return ['status' => $currentWorkers >= $expected && ($backlog ?? 0) <= 1000 ? 'up' : 'down',
                'build_id' => $currentWorkers >= $expected ? \app\Service\RequestTrace::BUILD_ID : 'mixed_or_old', 'current_build_workers' => $currentWorkers,
                'workers' => $workers, 'expected_workers' => $expected, 'pending_events' => $backlog,
                'last_heartbeat' => $rows[0]['last_heartbeat'] ?? null];
        } catch (\Throwable $error) { return ['status' => 'down', 'reason' => 'heartbeat_or_event_store_unavailable']; }
    }
}
