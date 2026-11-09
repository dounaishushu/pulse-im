<?php
declare(strict_types=1);
namespace app\Service;

use DateTimeImmutable;
use DateTimeZone;
use RuntimeException;
use think\facade\Db;

/** Bounded, resumable cleanup. Account cleanup retains all business history. */
final class AdminMaintenanceService
{
    public function __construct(private ?MaintenanceFileService $files = null) { $this->files ??= new MaintenanceFileService(); }
    private function now(): DateTimeImmutable { return new DateTimeImmutable('now', new DateTimeZone('Asia/Shanghai')); }
    private function sqlNow(): string { return $this->now()->format('Y-m-d H:i:s'); }
    private function table(string $name): string
    {
        $name = Db::name($name)->getTable();
        if (!is_string($name) || !preg_match('/^[A-Za-z0-9_]+$/D', $name)) throw new RuntimeException('数据表配置无效。');
        return '`' . $name . '`';
    }
    private function number(mixed $value, int $min, int $max, string $label): int
    {
        $number = filter_var($value, FILTER_VALIDATE_INT, ['options' => ['min_range' => $min, 'max_range' => $max]]);
        if ($number === false || is_bool($value)) throw new RuntimeException($label . "需为{$min}到{$max}之间的整数。");
        return $number;
    }
    private function options(array $input): array
    {
        foreach (['clean_accounts', 'clean_cache'] as $field) if (!is_bool($input[$field] ?? null)) throw new RuntimeException('请选择要清理的数据类型。');
        if (!$input['clean_accounts'] && !$input['clean_cache']) throw new RuntimeException('至少选择一种清理内容。');
        return ['clean_accounts' => $input['clean_accounts'], 'clean_cache' => $input['clean_cache'],
            'inactive_days' => $this->number($input['inactive_days'] ?? null, 1, 3650, '未上线天数'),
            'cache_days' => $this->number($input['cache_days'] ?? null, 7, 365, '过期凭据和运行日志保留天数')];
    }
    public static function nextTime(string $time, int $interval, DateTimeImmutable $after): string
    {
        $after = $after->setTimezone(new DateTimeZone('Asia/Shanghai'));
        [$hour, $minute] = array_map('intval', explode(':', $time));
        $next = $after->setTime($hour, $minute);
        if ($next <= $after) $next = $next->modify('+' . $interval . ' days');
        return $next->format('Y-m-d H:i:s');
    }
    public function settings(): array
    {
        $row = Db::name('maintenance_config')->where('id', 1)->find();
        if (!$row) throw new RuntimeException('数据清理尚未安装。');
        foreach (['enabled', 'clean_accounts', 'clean_cache'] as $key) $row[$key] = (bool) $row[$key];
        foreach (['inactive_days', 'cache_days', 'interval_days', 'version'] as $key) $row[$key] = (int) $row[$key];
        $seen = Db::name('maintenance_state')->where('id', 1)->value('worker_seen_at');
        $row['worker_seen_at'] = $seen;
        $row['worker_online'] = $seen && strtotime($seen) >= time() - 100;
        $row['timezone'] = 'Asia/Shanghai';
        return $row;
    }
    public function save(array $input, int $adminId, string $ip): array
    {
        $options = $this->options($input);
        if (!is_bool($input['enabled'] ?? null) || !is_string($input['run_time'] ?? null) || !preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d$/D', $input['run_time'])) throw new RuntimeException('请输入有效的执行时间。');
        $interval = $this->number($input['interval_days'] ?? null, 1, 30, '执行间隔天数');
        $version = $this->number($input['version'] ?? null, 1, PHP_INT_MAX, '设置版本');
        return Db::transaction(function () use ($input, $adminId, $ip, $options, $interval, $version): array {
            $current = Db::name('maintenance_config')->where('id', 1)->lock(true)->find();
            if (!$current || (int) $current['version'] !== $version) throw new RuntimeException('设置已被其他管理员修改，请刷新后重试。');
            $next = $input['enabled'] ? self::nextTime($input['run_time'], $interval, $this->now()) : null;
            Db::name('maintenance_config')->where('id', 1)->update($options + ['enabled' => $input['enabled'] ? 1 : 0, 'run_time' => $input['run_time'], 'interval_days' => $interval, 'next_run_at' => $next, 'version' => $version + 1, 'updated_admin_id' => $adminId, 'updated_at' => $this->sqlNow()]);
            Db::name('maintenance_runs')->where('trigger_type', 'scheduled')->whereIn('status', ['queued', 'running'])->update(['status' => 'cancelled', 'finished_at' => $this->sqlNow(), 'error_code' => 'POLICY_CHANGED']);
            (new AuditService())->log($adminId, 'maintenance.settings', 'maintenance', 1, '', $ip, $options + ['enabled' => $input['enabled'], 'run_time' => $input['run_time'], 'interval_days' => $interval]);
            return $this->settings();
        });
    }
    private function activity(): string
    {
        $tokens = $this->table('auth_tokens'); $logins = $this->table('login_logs'); $presence = $this->table('user_presence');
        return "GREATEST(u.created_at,COALESCE((SELECT p.last_seen_at FROM {$presence} p WHERE p.user_id=u.id),u.created_at),COALESCE((SELECT MAX(COALESCE(t.last_used_at,t.created_at)) FROM {$tokens} t WHERE t.user_id=u.id),u.created_at),COALESCE((SELECT MAX(l.created_at) FROM {$logins} l WHERE l.user_id=u.id AND l.success=1),u.created_at))";
    }
    private function protection(): array
    {
        $permissions = $this->table('user_permissions'); $members = $this->table('conversation_members'); $conversations = $this->table('conversations');
        $wallets = $this->table('wallets'); $packets = $this->table('red_packets'); $requests = $this->table('wallet_requests');
        return [
            'INTERNAL_STAFF' => "EXISTS (SELECT 1 FROM {$permissions} p WHERE p.user_id=u.id AND p.internal_staff=1)",
            'GROUP_MANAGER' => "EXISTS (SELECT 1 FROM {$conversations} c WHERE c.owner_id=u.id AND c.type IN ('group','channel','customer_service') AND c.status='active') OR EXISTS (SELECT 1 FROM {$members} m WHERE m.user_id=u.id AND m.role IN ('owner','admin'))",
            'UNSETTLED_FUNDS' => "EXISTS (SELECT 1 FROM {$wallets} w WHERE w.user_id=u.id AND (w.available_fen<>0 OR w.frozen_fen<>0)) OR EXISTS (SELECT 1 FROM {$packets} r WHERE r.sender_id=u.id AND r.remaining_fen>0) OR EXISTS (SELECT 1 FROM {$requests} r WHERE r.user_id=u.id AND r.status='pending')",
        ];
    }
    private function candidates(string $cutoff)
    {
        // Compute activity once; this also allows the identical query to be tested
        // against MySQL temporary tables without reopening the same table twice.
        $source = Db::name('users')->alias('u')->where('u.status', 'active')->field('u.*,' . $this->activity() . ' AS maintenance_last_active_at')->buildSql();
        $query = Db::table($source)->alias('u')->where('u.maintenance_last_active_at', '<', $cutoff);
        foreach ($this->protection() as $condition) $query->whereRaw('NOT (' . $condition . ')');
        return $query;
    }
    public function preview(mixed $days, int $page = 1): array
    {
        $days = $this->number($days, 1, 3650, '未上线天数'); $page = max(1, $page);
        $cutoff = $this->now()->modify('-' . $days . ' days')->format('Y-m-d H:i:s');
        $total = (int) $this->candidates($cutoff)->count('u.id');
        $rows = $this->candidates($cutoff)->field('u.id,u.public_id,u.username,u.phone,u.nickname,u.created_at,u.maintenance_last_active_at AS last_active_at')->order('u.id')->page($page, 50)->select()->toArray();
        foreach ($rows as &$row) { $row['id'] = (int) $row['id']; $row['offline_days'] = max(0, (int) floor((time() - strtotime($row['last_active_at'])) / 86400)); unset($row['phone']); }
        return ['items' => $rows, 'total' => $total, 'page' => $page, 'size' => 50, 'inactive_days' => $days, 'cutoff_at' => $cutoff];
    }
    public function cachePreview(int $days = 7): array
    {
        $days = $this->number($days, 7, 365, '保留天数'); $cutoff = $this->now()->modify('-' . $days . ' days')->format('Y-m-d H:i:s'); $counts = [];
        foreach (['auth_tokens', 'admin_sessions', 'registration_captchas', 'registration_captcha_rates', 'admin_security_rates'] as $table) $counts[$table] = (int) Db::name($table)->where('expires_at', '<', $cutoff)->count();
        return ['database_rows' => $counts, 'files' => $this->files->process($days), 'cache_days' => $days];
    }
    public function queue(array $input, int $adminId, string $ip): array
    {
        $options = $this->options($input); $ids = $input['user_ids'] ?? [];
        if (!is_array($ids) || !array_is_list($ids) || count($ids) > 200) throw new RuntimeException('每次最多选择200个账号。');
        $ids = array_values(array_unique(array_map(fn ($id) => $this->number($id, 1, PHP_INT_MAX, '用户ID'), $ids))); sort($ids, SORT_NUMERIC);
        if ($options['clean_accounts'] && !$ids) throw new RuntimeException('请先预览并选择需要清理的账号。');
        if (!$options['clean_accounts'] && $ids) throw new RuntimeException('未选择账号清理。');
        if (($input['confirmation'] ?? '') !== 'CLEAN_SELECTED_DATA') throw new RuntimeException('请确认本次清理范围。');
        $requestId = $input['request_id'] ?? '';
        if (!is_string($requestId) || !preg_match('/^[A-Za-z0-9_-]{12,80}$/D', $requestId)) throw new RuntimeException('请求标识无效，请刷新重试。');
        $fingerprint = hash('sha256', json_encode([$adminId, $options, $ids], JSON_THROW_ON_ERROR));
        // Serialize submissions with the policy row; retries return the original run.
        return Db::transaction(function () use ($requestId, $fingerprint, $options, $ids, $adminId, $ip): array {
            Db::name('maintenance_config')->where('id', 1)->lock(true)->find();
            $existing = Db::name('maintenance_runs')->where('request_id', $requestId)->find();
            if ($existing) { if ($existing['fingerprint'] !== $fingerprint) throw new RuntimeException('同一请求不能更换清理内容。'); return $this->run((int) $existing['id']); }
            $id = $this->insertRun($requestId, $fingerprint, $options, $ids, $adminId, 'manual');
            (new AuditService())->log($adminId, 'maintenance.start', 'maintenance_run', $id, $requestId, $ip, ['options' => $options, 'selected_count' => count($ids)]);
            return $this->run($id);
        });
    }
    private function insertRun(string $requestId, string $fingerprint, array $options, ?array $ids, int $adminId, string $type, ?int $version = null): int
    {
        return (int) Db::name('maintenance_runs')->insertGetId(['request_id' => $requestId, 'fingerprint' => $fingerprint, 'trigger_type' => $type, 'admin_id' => $adminId, 'config_version' => $version,
            'options_json' => json_encode($options, JSON_THROW_ON_ERROR), 'selected_ids_json' => $ids === null ? null : json_encode($ids, JSON_THROW_ON_ERROR),
            'cutoff_at' => $this->now()->modify('-' . $options['inactive_days'] . ' days')->format('Y-m-d H:i:s'),
            'upper_user_id' => (int) Db::name('users')->max('id'), 'created_at' => $this->sqlNow()]);
    }
    public function runs(int $page = 1): array
    {
        $page = max(1, $page); $rows = Db::name('maintenance_runs')->order('id', 'desc')->page($page, 20)->select()->toArray();
        return ['items' => array_map(fn ($row) => $this->formatRun($row), $rows), 'total' => (int) Db::name('maintenance_runs')->count(), 'page' => $page, 'size' => 20];
    }
    public function run(int $id): array
    {
        $row = Db::name('maintenance_runs')->where('id', $id)->find();
        if (!$row) throw new RuntimeException('清理记录不存在。');
        $row = $this->formatRun($row);
        $row['users'] = Db::name('maintenance_run_users')->where('run_id', $id)->order('user_id')->limit(200)->select()->toArray();
        return $row;
    }
    private function formatRun(array $row): array
    {
        $row['options'] = json_decode($row['options_json'], true); $row['cache'] = $row['cache_json'] ? json_decode($row['cache_json'], true) : null;
        unset($row['options_json'], $row['cache_json'], $row['fingerprint'], $row['selected_ids_json']);
        return $row;
    }
    private function enqueueScheduled(): void
    {
        Db::transaction(function (): void {
            $config = Db::name('maintenance_config')->where('id', 1)->lock(true)->find();
            if (!$config || !$config['enabled'] || !$config['next_run_at'] || $config['next_run_at'] > $this->sqlNow()) return;
            $options = $this->options(array_replace($config, ['clean_accounts' => (bool) $config['clean_accounts'], 'clean_cache' => (bool) $config['clean_cache']]));
            $key = 'scheduled-' . $config['version'] . '-' . str_replace(['-', ':', ' '], '', $config['next_run_at']);
            if (!Db::name('maintenance_runs')->where('request_id', $key)->find()) $this->insertRun($key, hash('sha256', $key), $options, null, 0, 'scheduled', (int) $config['version']);
            Db::name('maintenance_config')->where('id', 1)->update(['next_run_at' => self::nextTime($config['run_time'], (int) $config['interval_days'], $this->now())]);
        });
    }
    public function tick(bool $heartbeat = true): array
    {
        if ($heartbeat) Db::name('maintenance_state')->where('id', 1)->update(['worker_seen_at' => $this->sqlNow()]);
        $token = bin2hex(random_bytes(32));
        $acquired = Db::transaction(function () use ($token): bool {
            $row = Db::name('maintenance_state')->where('id', 1)->lock(true)->find();
            if (!$row || ($row['lease_until'] && $row['lease_until'] > $this->sqlNow())) return false;
            Db::name('maintenance_state')->where('id', 1)->update(['lease_token' => $token, 'lease_until' => $this->now()->modify('+120 seconds')->format('Y-m-d H:i:s')]); return true;
        });
        if (!$acquired) return ['busy' => true];
        $runId = null;
        try {
            $this->enqueueScheduled();
            $run = Db::name('maintenance_runs')->whereIn('status', ['queued', 'running'])->order('id')->find();
            if (!$run) return ['idle' => true];
            $runId = (int) $run['id']; $options = json_decode($run['options_json'], true, 512, JSON_THROW_ON_ERROR);
            if ($run['trigger_type'] === 'manual') {
                $admin = Db::name('admin_accounts')->where('id', $run['admin_id'])->where('status', 'active')->find();
                if (!$admin || !AdminPermissionService::allows($admin, 'maintenance.manage')) { $this->finish($runId, 'cancelled', 'PERMISSION_REVOKED'); return $this->run($runId); }
            }
            Db::name('maintenance_runs')->where('id', $runId)->where('status', 'queued')->update(['status' => 'running', 'started_at' => $this->sqlNow()]);
            $ids = $run['selected_ids_json'] === null ? null : json_decode($run['selected_ids_json'], true, 512, JSON_THROW_ON_ERROR);
            $query = $ids === null ? $this->candidates($run['cutoff_at']) : Db::name('users')->alias('u')->whereIn('u.id', $ids ?: [0]);
            $batch = $options['clean_accounts'] ? $query->where('u.id', '>', $run['cursor_user_id'])->where('u.id', '<=', $run['upper_user_id'])->field('u.id')->order('u.id')->limit(50)->select()->toArray() : [];
            foreach ($batch as $user) {
                if (!$this->renew($token)) return ['busy' => true, 'lease_lost' => true];
                if (Db::name('maintenance_runs')->where('id', $runId)->value('status') !== 'running') return $this->run($runId);
                $this->cleanUser($run, (int) $user['id'], $token);
            }
            if (count($batch) === 50) return $this->run($runId);
            if ($options['clean_cache'] && !$run['cache_done']) {
                if (!$this->renew($token)) return ['busy' => true, 'lease_lost' => true];
                if (Db::name('maintenance_runs')->where('id', $runId)->value('status') !== 'running') return $this->run($runId);
                $cache = $this->cleanCache((int) $options['cache_days'], $token);
                Db::name('maintenance_runs')->where('id', $runId)->update(['cache_done' => 1, 'cache_json' => json_encode($cache, JSON_THROW_ON_ERROR)]);
            }
            $this->finish($runId, 'completed'); return $this->run($runId);
        } catch (\Throwable $error) {
            if ($error->getCode() === 409 && $error->getMessage() === 'LEASE_LOST') return ['busy' => true, 'lease_lost' => true];
            if ($runId) $this->finish($runId, 'failed', 'CLEANUP_ERROR');
            throw $error;
        } finally {
            Db::name('maintenance_state')->where('id', 1)->where('lease_token', $token)->update(['lease_token' => null, 'lease_until' => null]);
        }
    }
    private function finish(int $id, string $status, ?string $reason = null): void
    {
        Db::name('maintenance_runs')->where('id', $id)->whereIn('status', ['queued', 'running'])->update(['status' => $status, 'error_code' => $reason, 'finished_at' => $this->sqlNow()]);
    }
    private function renew(string $token): bool
    {
        // A paused/expired owner must not resume work after another worker takes over.
        return Db::transaction(function () use ($token): bool {
            $row = Db::name('maintenance_state')->where('id', 1)->lock(true)->find();
            if (!$row || $row['lease_token'] !== $token || $row['lease_until'] <= $this->sqlNow()) return false;
            Db::name('maintenance_state')->where('id', 1)->update(['lease_until' => $this->now()->modify('+120 seconds')->format('Y-m-d H:i:s')]); return true;
        });
    }
    private function cleanUser(array $run, int $id, string $token): void
    {
        Db::transaction(function () use ($run, $id, $token): void {
            // Hold the lease row throughout this atomic account operation; an expired
            // worker cannot resume a destructive transaction after another owner.
            if (!$this->renew($token)) throw new RuntimeException('LEASE_LOST', 409);
            if (Db::name('maintenance_runs')->where('id', $run['id'])->value('status') !== 'running') return;
            if (Db::name('maintenance_run_users')->where('run_id', $run['id'])->where('user_id', $id)->find()) return;
            // Same wallet -> user order as the existing financial/retention services.
            Db::name('wallets')->where('user_id', $id)->lock(true)->find();
            $current = Db::name('users')->where('id', $id)->lock(true)->find();
            $reason = 'NOT_ACTIVE'; $activity = null;
            if ($current && $current['status'] === 'active') {
                $activity = Db::name('users')->alias('u')->where('u.id', $id)->value($this->activity());
                $reason = $activity && $activity < $run['cutoff_at'] ? '' : 'RECENTLY_ACTIVE';
                if ($reason === '') foreach ($this->protection() as $code => $condition) if (Db::name('users')->alias('u')->where('u.id', $id)->whereRaw('(' . $condition . ')')->count()) { $reason = $code; break; }
            }
            if ($reason === '') {
                Db::name('users')->where('id', $id)->update(['status' => 'deleted', 'updated_at' => $this->sqlNow()]);
                Db::name('auth_tokens')->where('user_id', $id)->delete();
                Db::name('user_presence')->where('user_id', $id)->delete();
                Db::name('user_password_vault')->where('user_id', $id)->delete();
                Db::name('notification_devices')->where('user_id', $id)->update(['enabled' => 0, 'updated_at' => $this->sqlNow()]);
            }
            Db::name('maintenance_run_users')->insert(['run_id' => $run['id'], 'user_id' => $id, 'outcome' => $reason === '' ? 'deleted' : 'skipped', 'reason' => $reason ?: 'INACTIVE', 'last_active_at' => $activity, 'created_at' => $this->sqlNow()]);
            Db::name('maintenance_runs')->where('id', $run['id'])->inc($reason === '' ? 'deleted_count' : 'skipped_count')->update(['cursor_user_id' => $id]);
        });
    }
    private function cleanCache(int $days, string $token): array
    {
        $cutoff = $this->now()->modify('-' . $days . ' days')->format('Y-m-d H:i:s'); $counts = []; $limited = false;
        foreach (['auth_tokens', 'admin_sessions', 'registration_captchas', 'registration_captcha_rates', 'admin_security_rates'] as $table) {
            $key = match ($table) { 'registration_captchas' => 'challenge_id', 'registration_captcha_rates', 'admin_security_rates' => 'bucket_key', default => 'id' };
            $ids = Db::name($table)->where('expires_at', '<', $cutoff)->limit(1000)->column($key);
            $limited = $limited || count($ids) === 1000;
            if ($table === 'auth_tokens' && $ids) {
                // Expired tokens can contain the latest authentic activity; retain that
                // timestamp before removing the credential, so cleanup cannot age users.
                $rows = Db::name($table)->whereIn($key, $ids)->field('user_id,created_at,last_used_at')->select()->toArray();
                foreach ($rows as $row) { if (!$this->renew($token)) throw new RuntimeException('LEASE_LOST', 409); Db::transaction(function () use ($row): void {
                    $user = Db::name('users')->where('id', $row['user_id'])->lock(true)->find();
                    if (!$user || $user['status'] === 'deleted') return;
                    $time = max($row['created_at'], $row['last_used_at'] ?? '');
                    $presence = Db::name('user_presence')->where('user_id', $row['user_id'])->lock(true)->find();
                    if (!$presence) Db::name('user_presence')->insert(['user_id' => $row['user_id'], 'last_seen_at' => $time]);
                    elseif ($presence['last_seen_at'] < $time) Db::name('user_presence')->where('user_id', $row['user_id'])->where('last_seen_at', '<', $time)->update(['last_seen_at' => $time]);
                }); }
            }
            $counts[$table] = $ids ? (int) Db::name($table)->whereIn($key, $ids)->where('expires_at', '<', $cutoff)->delete() : 0;
        }
        return ['database_rows' => $counts, 'files' => $this->files->process($days, true, null, fn () => $this->renew($token)), 'database_limited' => $limited];
    }
}
