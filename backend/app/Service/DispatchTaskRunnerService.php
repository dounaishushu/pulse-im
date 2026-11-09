<?php
namespace app\Service;

use DateTimeImmutable;
use DateTimeZone;
use RuntimeException;
use Throwable;
use think\facade\Db;

/** All message writes and their checkpoints commit together; no network I/O occurs under these locks. */
final class DispatchTaskRunnerService
{
    private ?\Closure $beforeCheckpoint;
    private DispatchScheduleService $schedule;

    public function __construct(private bool $publish = true, ?callable $beforeCheckpoint = null)
    {
        $this->beforeCheckpoint = $beforeCheckpoint === null ? null : \Closure::fromCallable($beforeCheckpoint);
        $this->schedule = new DispatchScheduleService();
    }

    /** $onlyTaskIds is a fixture scope for tests; the production worker processes all eligible tasks. */
    public function tick(?DateTimeImmutable $now = null, ?array $onlyTaskIds = null): array
    {
        $zone = new DateTimeZone('Asia/Shanghai');
        $clock = $now === null ? static fn (): DateTimeImmutable => new DateTimeImmutable('now', $zone)
            : static fn (): DateTimeImmutable => $now->setTimezone($zone);
        $result = ['claimed' => 0, 'sent' => 0, 'completed' => 0, 'failed' => 0, 'cancelled' => 0, 'retry' => 0];
        if ($onlyTaskIds !== null) {
            $onlyTaskIds = array_values(array_unique(array_filter(array_map('intval', $onlyTaskIds), static fn (int $id): bool => $id > 0)));
            if ($onlyTaskIds === []) return $result;
        }
        $due = Db::name('dispatch_tasks')->where('status', 'pending')->whereNotNull('next_run_at')->where('next_run_at', '<=', $this->stamp($clock()));
        if ($onlyTaskIds !== null) $due->whereIn('id', $onlyTaskIds);
        foreach ($due->order('next_run_at')->order('id')->limit(20)->column('id') as $id) {
            try {
                $claimed = $this->claim((int) $id, $clock());
                $result['claimed'] += $claimed['claimed']; $result['failed'] += $claimed['failed'];
            } catch (Throwable $error) {
                if (DispatchDatabaseFailure::connectionLost($error)) throw $error;
                if ($this->transient($error)) { $result['retry']++; continue; }
                throw $error;
            }
        }
        $ready = Db::name('dispatch_task_runs')->alias('r')->join('dispatch_tasks t', 't.id=r.task_id')
            ->where('t.status', 'running')->whereIn('r.status', ['pending', 'running'])->where('r.next_step_at', '<=', $this->stamp($clock()))
            ->where(function ($q) use ($clock): void { $q->whereNull('r.lease_until')->whereOr('r.lease_until', '<=', $this->stamp($clock())); });
        if ($onlyTaskIds !== null) $ready->whereIn('t.id', $onlyTaskIds);
        $budget = 200;
        foreach ($ready->order('r.updated_at')->order('r.id')->limit(20)->column('r.id') as $runId) {
            for ($batch = 0; $batch < 25 && $budget > 0; $batch++) {
                try {
                    $advance = $this->advance((int) $runId, $clock);
                    foreach ($advance['sent'] as $message) {
                        $result['sent']++; $budget--;
                        if ($this->publish) { try { (new RealtimePublisher())->publish($message); } catch (Throwable) { /* Database event outbox is authoritative. */ } }
                    }
                    $result['completed'] += $advance['completed']; $result['cancelled'] += $advance['cancelled'];
                    if (!$advance['continue']) break;
                } catch (Throwable $error) {
                    if (DispatchDatabaseFailure::connectionLost($error)) throw $error;
                    if ($this->transient($error)) { $result['retry']++; break; }
                    $result['failed'] += $this->failRun((int) $runId, $error, $clock());
                    break;
                }
            }
        }
        return $result;
    }

    private function claim(int $id, DateTimeImmutable $now): array
    {
        return Db::transaction(function () use ($id, $now): array {
            $task = Db::name('dispatch_tasks')->where('id', $id)->lock(true)->find();
            if (!$task || $task['status'] !== 'pending' || !$task['next_run_at'] || $task['next_run_at'] > $this->stamp($now)) return ['claimed' => 0, 'failed' => 0];
            try { $this->assertCreator($task); [, $steps] = $this->contents($task); $next = $this->nextCron($task, $now); }
            catch (Throwable $error) {
                if (DispatchDatabaseFailure::connectionLost($error)) throw $error;
                if ($this->transient($error)) throw $error;
                Db::name('dispatch_tasks')->where('id', $id)->update(['status' => 'failed', 'last_error' => $this->error($error), 'next_run_at' => null, 'updated_at' => $this->stamp($now)]);
                return ['claimed' => 0, 'failed' => 1];
            }
            $scheduled = (string) $task['next_run_at'];
            $firstStepAt = $this->stamp((new DateTimeImmutable($scheduled, new DateTimeZone('Asia/Shanghai')))->modify('+' . $steps[0]['delay_seconds'] . ' seconds'));
            $existing = Db::name('dispatch_task_runs')->where('task_id', $id)->where('task_version', (int) $task['version'])->where('scheduled_at', $scheduled)->lock(true)->find();
            if ($existing && !in_array($existing['status'], ['pending', 'running'], true)) {
                Db::name('dispatch_tasks')->where('id', $id)->update(['status' => $next !== null ? 'pending' : 'completed', 'next_run_at' => $next, 'updated_at' => $this->stamp($now)]);
                return ['claimed' => 0, 'failed' => 0];
            }
            if (!$existing) Db::name('dispatch_task_runs')->insertGetId([
                'task_id' => $id, 'task_version' => (int) $task['version'], 'scheduled_at' => $scheduled,
                'status' => 'pending', 'step_index' => 0, 'recipient_index' => 0, 'next_step_at' => $firstStepAt,
                'lease_until' => null, 'started_at' => null, 'finished_at' => null, 'last_error' => null,
                'created_at' => $this->stamp($now), 'updated_at' => $this->stamp($now),
            ]);
            Db::name('dispatch_tasks')->where('id', $id)->update(['status' => 'running', 'next_run_at' => $next, 'last_error' => null, 'updated_at' => $this->stamp($now)]);
            return ['claimed' => 1, 'failed' => 0];
        });
    }

    private function advance(int $runId, callable $clock): array
    {
        $taskId = (int) Db::name('dispatch_task_runs')->where('id', $runId)->value('task_id');
        if ($taskId <= 0) return $this->idle();
        return Db::transaction(function () use ($runId, $taskId, $clock): array {
            // Same order as task CRUD; stale workers cannot revive a cancelled task version.
            $task = Db::name('dispatch_tasks')->where('id', $taskId)->lock(true)->find();
            $run = Db::name('dispatch_task_runs')->where('id', $runId)->lock(true)->find();
            if (!$run || !in_array($run['status'], ['pending', 'running'], true)) return $this->idle();
            $now = $clock(); $stamp = $this->stamp($now);
            if (!$task || $task['status'] !== 'running' || (int) $task['version'] !== (int) $run['task_version']) {
                Db::name('dispatch_task_runs')->where('id', $runId)->update(['status' => 'cancelled', 'lease_until' => null, 'finished_at' => $stamp, 'updated_at' => $stamp]);
                return $this->idle(['cancelled' => 1]);
            }
            if ($run['next_step_at'] > $stamp || ($run['lease_until'] !== null && $run['lease_until'] > $stamp)) return $this->idle();
            $this->assertCreator($task);
            [$recipients, $steps] = $this->contents($task);
            $stepIndex = (int) $run['step_index']; $recipientIndex = (int) $run['recipient_index'];
            if (!isset($steps[$stepIndex], $recipients[$recipientIndex])) throw new RuntimeException('分发执行进度无效，任务已停止。');
            Db::name('dispatch_task_runs')->where('id', $runId)->update(['status' => 'running', 'lease_until' => $this->stamp($now->modify('+30 seconds')), 'started_at' => $run['started_at'] ?? $stamp, 'updated_at' => $stamp]);
            $sender = (int) $task['sender_id']; $recipient = (int) $recipients[$recipientIndex];
            if ($task['recipient_type'] === 'user') $conversationId = (int) (new ConversationService())->createDirect($sender, $recipient)['id'];
            else {
                if (!Db::name('conversations')->where('id', $recipient)->where('type', 'group')->where('status', 'active')->find()) throw new RuntimeException('分发目标群组已停用或不是群组。');
                $conversationId = $recipient;
            }
            // MessageService rechecks active sender, actual group membership, global/group mute and blocks.
            $requestId = 'dispatch-' . hash('sha256', implode('|', [$taskId, $runId, $run['task_version'], $stepIndex, $recipientIndex]));
            $step = $steps[$stepIndex]; $messages = []; $senderService = new MessageService();
            if (in_array($step['type'], ['text', 'text_image'], true)) {
                $textRequest = $step['type'] === 'text_image' ? $requestId . '-text' : $requestId;
                $messages[] = $senderService->send($conversationId, $sender, 'text', ['text' => $step['text']], $textRequest, false);
            }
            if ($step['type'] === 'image' || ($step['type'] === 'text_image' && trim($step['image_url'] ?? '') !== '')) {
                // A mixed step uses separate native messages so every client shows
                // the full text. Image failure also rolls back the preceding text.
                $imageBody = (new DispatchImageService())->imageBody($step['image_url'], $sender);
                $imageRequest = $step['type'] === 'text_image' ? $requestId . '-image' : $requestId;
                $messages[] = $senderService->send($conversationId, $sender, 'image', $imageBody, $imageRequest, false);
            }
            $message = $messages[count($messages) - 1];
            if ($this->beforeCheckpoint !== null) ($this->beforeCheckpoint)($task, $run, $message);
            $completedAt = $clock(); $completedStamp = $this->stamp($completedAt);
            $recipientIndex++;
            $finished = false; $nextStep = $run['next_step_at'];
            if ($recipientIndex >= count($recipients)) {
                $recipientIndex = 0; $stepIndex++;
                if ($stepIndex >= count($steps)) $finished = true;
                else $nextStep = $this->stamp($completedAt->modify('+' . $steps[$stepIndex]['delay_seconds'] . ' seconds'));
            }
            Db::name('dispatch_task_runs')->where('id', $runId)->update([
                'step_index' => $stepIndex, 'recipient_index' => $recipientIndex, 'next_step_at' => $nextStep,
                'status' => $finished ? 'completed' : 'running', 'lease_until' => null,
                'finished_at' => $finished ? $completedStamp : null, 'updated_at' => $completedStamp,
            ]);
            $update = ['last_executed_at' => $completedStamp, 'last_error' => null, 'updated_at' => $completedStamp];
            if ($finished) { $future = $this->nextCron($task, $completedAt); $update['status'] = $future !== null ? 'pending' : 'completed'; $update['next_run_at'] = $future; }
            Db::name('dispatch_tasks')->where('id', $taskId)->update($update);
            return ['sent' => $messages, 'completed' => $finished ? 1 : 0, 'cancelled' => 0, 'continue' => !$finished && $nextStep <= $completedStamp];
        });
    }

    private function failRun(int $runId, Throwable $error, DateTimeImmutable $now): int
    {
        if (DispatchDatabaseFailure::connectionLost($error)) throw $error;
        $taskId = (int) Db::name('dispatch_task_runs')->where('id', $runId)->value('task_id');
        if ($taskId <= 0) return 0;
        return Db::transaction(function () use ($runId, $taskId, $error, $now): int {
            $task = Db::name('dispatch_tasks')->where('id', $taskId)->lock(true)->find();
            $run = Db::name('dispatch_task_runs')->where('id', $runId)->lock(true)->find();
            if (!$task || !$run || $task['status'] !== 'running' || (int) $task['version'] !== (int) $run['task_version'] || !in_array($run['status'], ['pending', 'running'], true)) return 0;
            $stamp = $this->stamp($now); $message = $this->error($error);
            Db::name('dispatch_task_runs')->where('id', $runId)->update(['status' => 'failed', 'lease_until' => null, 'last_error' => $message, 'finished_at' => $stamp, 'updated_at' => $stamp]);
            Db::name('dispatch_tasks')->where('id', $taskId)->update(['status' => 'failed', 'last_error' => $message, 'next_run_at' => null, 'updated_at' => $stamp]);
            return 1;
        });
    }

    private function assertCreator(array $task): void
    {
        $creator = Db::name('admin_accounts')->where('id', (int) $task['creator_admin_id'])->lock(true)->find();
        if (!$creator || $creator['status'] !== 'active' || !AdminPermissionService::allows($creator, 'dispatch-tasks.manage')) throw new RuntimeException('分发任务管理员已停用或已失去分发管理权限。');
    }

    private function contents(array $task): array
    {
        $recipients = json_decode((string) $task['recipient_ids_json'], true, 512, JSON_THROW_ON_ERROR);
        $steps = json_decode((string) $task['steps_json'], true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($recipients) || !array_is_list($recipients) || count($recipients) < 1 || count($recipients) > 100 || !in_array($task['recipient_type'], ['user', 'group'], true)) throw new RuntimeException('分发接收者配置无效。');
        foreach ($recipients as $id) if (!is_int($id) || $id <= 0) throw new RuntimeException('分发接收者编号无效。');
        if (!is_array($steps) || !array_is_list($steps) || count($steps) < 1 || count($steps) > 100) throw new RuntimeException('分发步骤配置无效。');
        foreach ($steps as $index => $step) {
            if (!is_array($step) || !in_array($step['type'] ?? '', ['text', 'image', 'text_image'], true)
                || !is_int($step['delay_seconds'] ?? null) || $step['delay_seconds'] < 0 || $step['delay_seconds'] > 86400) throw new RuntimeException('分发内容类型或延迟配置无效。');
            if (in_array($step['type'], ['text', 'text_image'], true) && (!is_string($step['text'] ?? null) || trim($step['text']) === '' || mb_strlen($step['text']) > 2000)) throw new RuntimeException('分发文字内容需为1至2000个字符。');
            if (in_array($step['type'], ['image', 'text_image'], true)) {
                $url = $step['image_url'] ?? '';
                if (!is_string($url) || strlen($url) > 2048 || ($step['type'] === 'image' && trim($url) === '')) throw new RuntimeException('分发图片地址配置无效。');
            }
        }
        return [$recipients, $steps];
    }

    private function nextCron(array $task, DateTimeImmutable $now): ?string
    {
        if ($task['trigger_type'] === 'once') return null;
        if ($task['trigger_type'] !== 'cron') throw new RuntimeException('分发触发类型无效。');
        $this->schedule->validate((string) $task['cron_expression']);
        try { return $this->stamp($this->schedule->next((string) $task['cron_expression'], $now)); }
        catch (RuntimeException $error) { if (str_contains($error->getMessage(), '没有未来执行时间')) return null; throw $error; }
    }
    private function stamp(DateTimeImmutable $time): string { return $time->setTimezone(new DateTimeZone('Asia/Shanghai'))->format('Y-m-d H:i:s'); }
    private function error(Throwable $error): string { return mb_substr($error->getMessage() ?: '分发执行失败。', 0, 500); }
    private function idle(array $extra = []): array { return array_replace(['sent' => [], 'completed' => 0, 'cancelled' => 0, 'continue' => false], $extra); }
    private function transient(Throwable $error): bool
    {
        do {
            if (in_array((int) $error->getCode(), [1205, 1213], true) || preg_match('/SQLSTATE\[40001\]|Deadlock found|Lock wait timeout|\b(?:1205|1213)\b/i', $error->getMessage())) return true;
            $error = $error->getPrevious();
        } while ($error !== null);
        return false;
    }
}
