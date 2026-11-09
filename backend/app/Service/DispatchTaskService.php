<?php
namespace app\Service;

use DateTimeImmutable;
use DateTimeZone;
use RuntimeException;
use think\facade\Db;

/** CRUD writes and the delivery worker share task->run lock order and versions. */
final class DispatchTaskService
{
    private const VISIBLE_STATUSES = ['pending', 'running', 'paused', 'completed', 'failed'];

    public function listing(array $filter): array
    {
        $page = max(1, (int) ($filter['page'] ?? 1)); $size = min(100, max(1, (int) ($filter['size'] ?? 20)));
        $query = Db::name('dispatch_tasks')->where('status', '<>', 'deleted');
        if (isset($filter['task_id']) && $filter['task_id'] !== '') $query->where('id', $this->positiveId($filter['task_id'], '任务编号'));
        if (!empty($filter['trigger_type'])) {
            if (!in_array($filter['trigger_type'], ['once', 'cron'], true)) throw new RuntimeException('触发类型无效。');
            $query->where('trigger_type', $filter['trigger_type']);
        }
        if (!empty($filter['status'])) {
            if (!in_array($filter['status'], self::VISIBLE_STATUSES, true)) throw new RuntimeException('任务状态无效。');
            $query->where('status', $filter['status']);
        }
        $rows = $query->order('id', 'desc')->paginate(['page' => $page, 'list_rows' => $size]);
        return ['items' => $this->formatRows($rows->items()), 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    public function detail(int $id): array
    {
        $row = $this->task($id);
        $detail = $this->formatRows([$row])[0];
        $zone = new DateTimeZone('Asia/Shanghai'); $base = null; $source = 'unavailable';
        try {
            $raw = null;
            if ($row['trigger_type'] === 'once') { $raw = $row['execute_at']; $source = 'once'; }
            elseif ($row['trigger_type'] === 'cron') {
                if ($row['status'] === 'running') {
                    $raw = Db::name('dispatch_task_runs')->where('task_id', $id)->where('task_version', (int) $row['version'])
                        ->whereIn('status', ['pending', 'running'])->order('id', 'desc')->value('scheduled_at');
                    $source = 'current_run';
                } elseif ($row['status'] === 'pending' && !empty($row['next_run_at'])) { $raw = $row['next_run_at']; $source = 'next_run'; }
                elseif (in_array($row['status'], ['pending', 'paused', 'failed', 'completed'], true)) {
                    $raw = Db::name('dispatch_task_runs')->where('task_id', $id)->where('task_version', (int) $row['version'])
                        ->order('id', 'desc')->value('scheduled_at');
                    $source = 'recent_run';
                    if ($raw === null) { $raw = (new DispatchScheduleService())->next((string) $row['cron_expression'], $this->now())->format('Y-m-d H:i:s'); $source = 'preview'; }
                }
            }
            if (is_string($raw)) {
                $candidate = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', $raw, $zone);
                if ($candidate && $candidate->format('Y-m-d H:i:s') === $raw) $base = $candidate;
            }
        } catch (\Throwable) { /* Optional plan preview must not prevent reading the task. */ }
        if ($base === null) $source = 'unavailable';
        $detail['step_time_base_at'] = $base?->format('Y-m-d H:i:s');
        $detail['step_time_source'] = $source;
        $detail['step_times'] = []; $cursor = $base;
        // These are nominal plan times. Delivery latency and retries can shift
        // actual sends; the run table does not contain a per-step execution log.
        foreach ($detail['steps'] as $step) {
            try {
                $delay = is_array($step) ? ($step['delay_seconds'] ?? null) : null;
                if ($cursor === null || !is_int($delay) || $delay < 0 || $delay > 86400) $cursor = null;
                else {
                    $cursor = $cursor->modify('+' . $delay . ' seconds');
                    if (strlen($cursor->format('Y-m-d H:i:s')) !== 19) $cursor = null;
                }
            } catch (\Throwable) { $cursor = null; }
            $detail['step_times'][] = $cursor?->format('Y-m-d H:i:s');
        }
        return $detail;
    }

    public function options(string $kind, string $keyword = '', int $senderId = 0): array
    {
        $keyword = trim($keyword);
        if (mb_strlen($keyword) > 64) throw new RuntimeException('搜索内容最多64个字符。');
        if (!in_array($kind, ['sender', 'user', 'group'], true)) throw new RuntimeException('选项类型无效。');
        if ($kind === 'group') {
            if ($senderId <= 0) return ['items' => []];
            $query = Db::name('conversations')->alias('c')->join('conversation_members m', 'm.conversation_id=c.id')
                ->where('m.user_id', $senderId)->where('c.type', 'group')->where('c.status', 'active');
            if ($keyword !== '') $query->where(function ($q) use ($keyword): void { $q->whereLike('c.name', '%' . addcslashes($keyword, '\\%_') . '%'); if (ctype_digit($keyword)) $q->whereOr('c.id', (int) $keyword); });
            $rows = $query->field('c.id,c.name')->order('c.id', 'desc')->limit(100)->select()->toArray();
            return ['items' => array_map(static fn (array $row): array => ['id' => (int) $row['id'], 'name' => (string) $row['name']], $rows)];
        }
        $query = Db::name('users')->where('status', 'active');
        if ($kind === 'user' && $senderId > 0) $query->where('id', '<>', $senderId);
        if ($keyword !== '') $query->where(function ($q) use ($keyword): void {
            $pattern = '%' . addcslashes($keyword, '\\%_') . '%'; $q->whereLike('nickname', $pattern)->whereLike('username', $pattern, 'OR');
            if (ctype_digit($keyword)) $q->whereOr('id', (int) $keyword);
        });
        $rows = $query->field('id,nickname,username')->order('id', 'desc')->limit(100)->select()->toArray();
        return ['items' => array_map(static fn (array $row): array => ['id' => (int) $row['id'], 'nickname' => (string) $row['nickname'], 'username' => $row['username'], 'name' => (string) $row['nickname']], $rows)];
    }

    public function save(array $payload, int $actorId, string $ip = '', string $requestId = ''): array
    {
        $id = isset($payload['id']) && $payload['id'] !== '' ? $this->positiveId($payload['id'], '任务编号') : null;
        $senderId = $this->positiveId($payload['sender_id'] ?? null, '发送账号');
        $recipientType = $payload['recipient_type'] ?? '';
        if (!in_array($recipientType, ['user', 'group'], true)) throw new RuntimeException('接收方类型无效。');
        $recipientIds = $this->recipientIds($payload['recipient_ids'] ?? null);
        $steps = $this->steps($payload['steps'] ?? null);
        $enabled = $payload['enabled'] ?? true;
        if (!is_bool($enabled)) throw new RuntimeException('启用状态必须为布尔值。');
        [$trigger, $executeAt, $cron, $next] = $this->schedule($payload, $enabled);
        return Db::transaction(function () use ($id, $senderId, $recipientType, $recipientIds, $steps, $enabled, $trigger, $executeAt, $cron, $next, $actorId, $ip, $requestId): array {
            $existing = $id === null ? null : $this->task($id, true);
            $actor = $this->assertActor($actorId);
            if ($existing) $this->cancelRuns($id);
            $this->assertRecipients($senderId, $recipientType, $recipientIds);
            $steps = $this->authorizeImages($steps, $senderId, $actor);
            $now = $this->now()->format('Y-m-d H:i:s');
            $data = ['creator_admin_id' => $actorId, 'sender_id' => $senderId, 'recipient_type' => $recipientType, 'recipient_ids_json' => json_encode($recipientIds, JSON_THROW_ON_ERROR),
                'trigger_type' => $trigger, 'execute_at' => $executeAt, 'cron_expression' => $cron,
                'steps_json' => json_encode($steps, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), 'status' => $enabled ? 'pending' : 'paused',
                'version' => $existing ? (int) $existing['version'] + 1 : 1, 'next_run_at' => $next, 'last_error' => null, 'updated_at' => $now];
            if ($existing) Db::name('dispatch_tasks')->where('id', $id)->update($data);
            else $id = (int) Db::name('dispatch_tasks')->insertGetId($data + ['created_at' => $now]);
            (new AuditService())->log($actorId, $existing ? 'dispatch.task.update' : 'dispatch.task.create', 'dispatch_task', $id, $requestId, $ip,
                ['sender_id' => $senderId, 'recipient_type' => $recipientType, 'recipient_count' => count($recipientIds), 'step_count' => count($steps), 'step_types' => array_column($steps, 'type'), 'trigger_type' => $trigger, 'version' => $data['version'], 'status' => $data['status'], 'creator_admin_id' => $actorId, 'previous_creator_admin_id' => $existing['creator_admin_id'] ?? null]);
            return $this->detail($id);
        });
    }

    public function status(int $id, string $status, int $actorId, string $ip = '', string $requestId = ''): array
    {
        if (!in_array($status, ['paused', 'pending'], true)) throw new RuntimeException('只能启用或暂停任务。');
        return Db::transaction(function () use ($id, $status, $actorId, $ip, $requestId): array {
            $row = $this->task($id, true); $actor = $this->assertActor($actorId); $this->cancelRuns($id);
            $enabled = $status === 'pending';
            $next = null;
            if ($enabled) {
                $this->assertRecipients((int) $row['sender_id'], $row['recipient_type'], json_decode($row['recipient_ids_json'], true, 512, JSON_THROW_ON_ERROR));
                $this->authorizeImages($this->steps(json_decode($row['steps_json'], true, 512, JSON_THROW_ON_ERROR)), (int) $row['sender_id'], $actor);
                [, , , $next] = $this->schedule($row, true);
            }
            $version = (int) $row['version'] + 1;
            $changes = ['status' => $status, 'version' => $version, 'next_run_at' => $next, 'last_error' => null, 'updated_at' => $this->now()->format('Y-m-d H:i:s')];
            if ($enabled) $changes['creator_admin_id'] = $actorId;
            Db::name('dispatch_tasks')->where('id', $id)->update($changes);
            (new AuditService())->log($actorId, 'dispatch.task.status', 'dispatch_task', $id, $requestId, $ip, ['status' => $status, 'version' => $version, 'creator_admin_id' => $enabled ? $actorId : $row['creator_admin_id'], 'previous_creator_admin_id' => $row['creator_admin_id']]);
            return $this->detail($id);
        });
    }

    public function delete(int $id, int $actorId, string $ip = '', string $requestId = ''): void
    {
        Db::transaction(function () use ($id, $actorId, $ip, $requestId): void {
            $row = $this->task($id, true); $this->assertActor($actorId); $this->cancelRuns($id);
            Db::name('dispatch_tasks')->where('id', $id)->update(['status' => 'deleted', 'version' => (int) $row['version'] + 1, 'next_run_at' => null, 'updated_at' => $this->now()->format('Y-m-d H:i:s')]);
            (new AuditService())->log($actorId, 'dispatch.task.delete', 'dispatch_task', $id, $requestId, $ip, ['version' => (int) $row['version'] + 1]);
        });
    }

    private function task(int $id, bool $lock = false): array
    {
        if ($id <= 0) throw new RuntimeException('任务编号无效。');
        $query = Db::name('dispatch_tasks')->where('id', $id)->where('status', '<>', 'deleted');
        if ($lock) $query->lock(true); $row = $query->find();
        if (!$row) throw new RuntimeException('分发任务不存在。');
        return $row;
    }

    private function assertActor(int $id): array
    {
        $actor = Db::name('admin_accounts')->where('id', $id)->where('status', 'active')->lock(true)->find();
        if (!$actor || !AdminPermissionService::allows($actor, 'dispatch-tasks.manage')) throw new RuntimeException('当前管理员无权管理分发任务。');
        return $actor;
    }

    private function cancelRuns(int $taskId): void
    {
        $runs = Db::name('dispatch_task_runs')->where('task_id', $taskId)->whereIn('status', ['pending', 'running'])->lock(true)->select()->toArray();
        foreach ($runs as $run) {
            if ($run['status'] === 'running' && !empty($run['lease_until']) && new DateTimeImmutable($run['lease_until'], new DateTimeZone('Asia/Shanghai')) > $this->now()) throw new RuntimeException('任务正在发送，请等待当前执行结束后再修改。');
        }
        if ($runs !== []) Db::name('dispatch_task_runs')->whereIn('id', array_column($runs, 'id'))->update(['status' => 'cancelled', 'lease_until' => null, 'finished_at' => $this->now()->format('Y-m-d H:i:s'), 'updated_at' => $this->now()->format('Y-m-d H:i:s')]);
    }

    private function assertRecipients(int $senderId, string $type, array $ids): void
    {
        if (!Db::name('users')->where('id', $senderId)->where('status', 'active')->find()) throw new RuntimeException('发送账号不存在或已停用。');
        if ((int) Db::name('user_permissions')->where('user_id', $senderId)->value('muted') === 1) throw new RuntimeException('发送账号已被禁言。');
        if ($type === 'user') {
            if (in_array($senderId, $ids, true)) throw new RuntimeException('发送账号不能是接收方。');
            if ((int) Db::name('users')->whereIn('id', $ids)->where('status', 'active')->count() !== count($ids)) throw new RuntimeException('接收账号不存在或已停用。');
            $blocks = new BlockService();
            foreach ($ids as $recipient) if ($blocks->isBlocked($senderId, $recipient) || $blocks->isBlocked($recipient, $senderId)) throw new RuntimeException('发送账号与接收方存在屏蔽关系。');
        } else {
            if ((int) Db::name('conversations')->whereIn('id', $ids)->where('type', 'group')->where('status', 'active')->count() !== count($ids)) throw new RuntimeException('接收群组不存在或已停用。');
            foreach ($ids as $group) (new MessageService())->assertCanSend($group, $senderId);
        }
    }

    private function recipientIds(mixed $values): array
    {
        if (!is_array($values) || !array_is_list($values) || count($values) < 1 || count($values) > 100) throw new RuntimeException('请设置1至100个接收方。');
        return array_values(array_unique(array_map(fn ($id): int => $this->positiveId($id, '接收方编号'), $values)));
    }

    private function steps(mixed $values): array
    {
        if (!is_array($values) || !array_is_list($values) || count($values) < 1 || count($values) > 100) throw new RuntimeException('请设置1至100条发送内容。');
        $steps = [];
        foreach ($values as $index => $value) {
            if (!is_array($value) || !in_array($value['type'] ?? '', ['text', 'image', 'text_image'], true)) throw new RuntimeException('分发内容类型须为文字、图片或文字加图片。');
            $type = $value['type']; $text = $value['text'] ?? ''; $image = $value['image_url'] ?? ''; $delay = $value['delay_seconds'] ?? 0;
            if (!is_string($text) || !is_string($image)) throw new RuntimeException('文字和图片地址格式无效。');
            $text = trim($text); $image = trim($image);
            if ($type !== 'image' && ($text === '' || mb_strlen($text) > 2000)) throw new RuntimeException('每条文字内容需填写1至2000个字符。');
            if ($type === 'image' && $image === '') throw new RuntimeException('图片内容必须填写图片地址。');
            if (!is_int($delay) || $delay < 0 || $delay > 86400) throw new RuntimeException('发送延迟须为0至86400的整数秒。');
            $step = ['type' => $type, 'text' => $type === 'image' ? '' : $text, 'delay_seconds' => $delay];
            if ($type !== 'text') $step['image_url'] = $image;
            $steps[] = $step;
        }
        return $steps;
    }

    private function authorizeImages(array $steps, int $senderId, array $account): array
    {
        $images = new DispatchImageService();
        foreach ($steps as &$step) if (isset($step['image_url']) && $step['image_url'] !== '') $step['image_url'] = $images->validate($step['image_url'], $senderId, $account);
        unset($step);
        return $steps;
    }

    private function schedule(array $payload, bool $enabled): array
    {
        $trigger = $payload['trigger_type'] ?? '';
        if (!in_array($trigger, ['once', 'cron'], true)) throw new RuntimeException('触发类型无效。');
        if ($trigger === 'once') {
            $raw = $payload['execute_at'] ?? '';
            if (!is_string($raw)) throw new RuntimeException('单次执行时间格式无效。');
            $raw = str_replace('T', ' ', trim($raw)); $date = null;
            foreach (['Y-m-d H:i:s', 'Y-m-d H:i'] as $format) { $candidate = DateTimeImmutable::createFromFormat('!' . $format, $raw, new DateTimeZone('Asia/Shanghai')); if ($candidate && $candidate->format($format) === $raw) { $date = $candidate; break; } }
            if (!$date || $date <= $this->now()) throw new RuntimeException('单次执行时间必须晚于当前时间。');
            $execute = $date->format('Y-m-d H:i:s'); return [$trigger, $execute, null, $enabled ? $execute : null];
        }
        $cron = $payload['cron_expression'] ?? '';
        if (!is_string($cron) || mb_strlen($cron) > 255) throw new RuntimeException('Cron表达式无效。');
        $cron = trim($cron); $scheduler = new DispatchScheduleService(); $scheduler->validate($cron);
        $next = $scheduler->next($cron, $this->now())->format('Y-m-d H:i:s');
        return [$trigger, null, $cron, $enabled ? $next : null];
    }

    private function positiveId(mixed $value, string $label): int
    {
        $id = filter_var($value, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($id === false) throw new RuntimeException($label . '无效。');
        return $id;
    }

    private function now(): DateTimeImmutable { return new DateTimeImmutable('now', new DateTimeZone('Asia/Shanghai')); }

    private function formatRows(array $rows): array
    {
        if ($rows === []) return [];
        $userIds = array_column($rows, 'sender_id'); $groupIds = [];
        foreach ($rows as $row) { $ids = json_decode($row['recipient_ids_json'], true, 512, JSON_THROW_ON_ERROR); if ($row['recipient_type'] === 'user') $userIds = array_merge($userIds, $ids); else $groupIds = array_merge($groupIds, $ids); }
        $users = array_column(Db::name('users')->whereIn('id', array_unique($userIds))->field('id,nickname,username')->select()->toArray(), null, 'id');
        $groups = $groupIds === [] ? [] : array_column(Db::name('conversations')->whereIn('id', array_unique($groupIds))->field('id,name')->select()->toArray(), null, 'id');
        return array_map(static function (array $row) use ($users, $groups): array {
            $ids = array_map('intval', json_decode($row['recipient_ids_json'], true, 512, JSON_THROW_ON_ERROR));
            $sender = $users[(int) $row['sender_id']] ?? ['id' => (int) $row['sender_id'], 'nickname' => '已注销用户', 'username' => null];
            $sender['id'] = (int) $sender['id']; $recipients = [];
            foreach ($ids as $id) {
                if ($row['recipient_type'] === 'user') { $user = $users[$id] ?? ['nickname' => '已注销用户', 'username' => null]; $recipients[] = ['id' => $id, 'name' => $user['nickname'], 'nickname' => $user['nickname'], 'username' => $user['username']]; }
                else $recipients[] = ['id' => $id, 'name' => $groups[$id]['name'] ?? '已删除群组'];
            }
            $steps = json_decode($row['steps_json'], true, 512, JSON_THROW_ON_ERROR);
            return ['id' => (int) $row['id'], 'sender' => $sender, 'sender_id' => (int) $row['sender_id'], 'recipient_type' => $row['recipient_type'],
                'recipients' => $recipients, 'recipient_ids' => $ids, 'trigger_type' => $row['trigger_type'], 'execute_at' => $row['execute_at'],
                'cron_expression' => $row['cron_expression'], 'steps' => $steps, 'step_count' => count($steps), 'status' => $row['status'],
                'version' => (int) $row['version'], 'last_executed_at' => $row['last_executed_at'], 'next_run_at' => $row['next_run_at'], 'last_error' => $row['last_error'],
                'created_at' => $row['created_at'], 'updated_at' => $row['updated_at']];
        }, $rows);
    }
}
