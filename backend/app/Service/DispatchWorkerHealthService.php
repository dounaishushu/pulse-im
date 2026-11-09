<?php
namespace app\Service;

use DateTimeImmutable;
use DateTimeZone;
use think\facade\Db;

final class DispatchWorkerHealthService
{
    public const HEARTBEAT_TTL_SECONDS = 60;
    public const OVERDUE_SECONDS = 300;
    private int $beats = 0;

    public function heartbeat(string $workerId, ?array $result = null, ?DateTimeImmutable $now = null): void
    {
        if (!preg_match('/^[A-Za-z0-9_.:-]{8,64}$/D', $workerId)) throw new \InvalidArgumentException('Invalid dispatch worker id.');
        $stamp = $this->clock($now)->format('Y-m-d H:i:s');
        $counters = [];
        if ($result !== null) foreach (['claimed', 'sent', 'completed', 'failed', 'cancelled', 'retry'] as $key) $counters[$key] = max(0, (int) ($result[$key] ?? 0));
        $table = Db::name('dispatch_worker_health')->getTable();
        Db::execute("INSERT INTO {$table} (worker_id,started_at,heartbeat_at,last_tick_at,last_tick_json) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE heartbeat_at=VALUES(heartbeat_at),last_tick_at=COALESCE(VALUES(last_tick_at),last_tick_at),last_tick_json=COALESCE(VALUES(last_tick_json),last_tick_json)",
            [$workerId, $stamp, $stamp, $result === null ? null : $stamp, $result === null ? null : json_encode($counters, JSON_THROW_ON_ERROR)]);
        if (++$this->beats % 60 === 0) Db::name('dispatch_worker_health')->where('heartbeat_at', '<', $this->clock($now)->modify('-7 days')->format('Y-m-d H:i:s'))->limit(1000)->delete();
    }

    public function stop(string $workerId): void { Db::name('dispatch_worker_health')->where('worker_id', $workerId)->delete(); }

    public function report(?DateTimeImmutable $now = null, ?int $expected = null): array
    {
        $clock = $this->clock($now); $stamp = $clock->format('Y-m-d H:i:s');
        $expected ??= (int) env('DISPATCH_WORKERS', 1); $expected = min(64, max(1, $expected));
        try {
            $fresh = $clock->modify('-' . self::HEARTBEAT_TTL_SECONDS . ' seconds')->format('Y-m-d H:i:s');
            $late = $clock->modify('-' . self::OVERDUE_SECONDS . ' seconds')->format('Y-m-d H:i:s');
            $workers = (int) Db::name('dispatch_worker_health')->where('heartbeat_at', '>=', $fresh)->where('last_tick_at', '>=', $fresh)->count();
            $lastHeartbeat = Db::name('dispatch_worker_health')->order('heartbeat_at', 'desc')->value('heartbeat_at');
            $pending = (int) Db::name('dispatch_tasks')->where('status', 'pending')->count();
            $running = (int) Db::name('dispatch_tasks')->where('status', 'running')->count();
            $lateTasks = (int) Db::name('dispatch_tasks')->where('status', 'pending')->where('next_run_at', '<=', $late)->count();
            $lateRuns = (int) $this->dueRuns($late, $stamp)->count();
            $oldestTask = Db::name('dispatch_tasks')->where('status', 'pending')->where('next_run_at', '<=', $stamp)->order('next_run_at')->value('next_run_at');
            $oldestRun = $this->dueRuns($stamp, $stamp)->order('r.next_step_at')->value('r.next_step_at');
            $oldest = array_values(array_filter([$oldestTask, $oldestRun])); sort($oldest, SORT_STRING);
            $failedTasks = (int) Db::name('dispatch_tasks')->where('status', 'failed')->count();
            $failedRuns = (int) Db::name('dispatch_task_runs')->where('status', 'failed')->where('finished_at', '>=', $clock->modify('-1 day')->format('Y-m-d H:i:s'))->count();
            return ['status' => $workers >= $expected && $lateTasks === 0 && $lateRuns === 0 ? 'up' : 'down',
                'workers' => $workers, 'expected_workers' => $expected, 'last_heartbeat' => $lastHeartbeat ?: null,
                'pending_tasks' => $pending, 'running_tasks' => $running, 'overdue_tasks' => $lateTasks, 'overdue_runs' => $lateRuns,
                'failed_tasks' => $failedTasks, 'failed_runs_24h' => $failedRuns, 'oldest_due_at' => $oldest[0] ?? null];
        } catch (\Throwable) { return ['status' => 'down', 'workers' => 0, 'expected_workers' => $expected, 'reason' => 'dispatch_store_unavailable']; }
    }

    private function dueRuns(string $before, string $now): \think\db\Query
    {
        return Db::name('dispatch_task_runs')->alias('r')->join('dispatch_tasks t', 't.id=r.task_id')
            ->where('t.status', 'running')->whereIn('r.status', ['pending', 'running'])->whereRaw('r.task_version = t.version')
            ->where('r.next_step_at', '<=', $before)->where(function ($query) use ($now): void { $query->whereNull('r.lease_until')->whereOr('r.lease_until', '<=', $now); });
    }
    private function clock(?DateTimeImmutable $now): DateTimeImmutable { return ($now ?? new DateTimeImmutable('now', new DateTimeZone('Asia/Shanghai')))->setTimezone(new DateTimeZone('Asia/Shanghai')); }
}
