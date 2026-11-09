<?php
namespace app\Service;

require_once __DIR__ . '/AdminEntryService.php';

use RuntimeException;
use think\facade\Db;

final class AdminAccountService
{
    public function __construct(private ?AdminEntryService $entries = null) {}
    public function listing(int $page = 1, int $size = 30, string $keyword = '', string $status = ''): array
    {
        $page = max(1, $page); $size = min(100, max(1, $size)); $keyword = trim($keyword);
        if (mb_strlen($keyword) > 64) throw new RuntimeException('账号搜索最多64个字符。');
        if ($status !== '' && !in_array($status, ['active', 'disabled'], true)) throw new RuntimeException('账号状态无效。');
        $query = Db::name('admin_accounts')->field('id,username,role,status,permissions_json,created_at,updated_at');
        if ($keyword !== '') $query->whereLike('username', '%' . addcslashes($keyword, '\\%_') . '%');
        if ($status !== '') $query->where('status', $status);
        $rows = $query->order('id', 'desc')->paginate(['page' => $page, 'list_rows' => $size]);
        return ['items' => array_map(fn (array $row): array => $this->format($row), $rows->items()),
            'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    public function create(array $payload, int $actorId, string $ip = '', string $requestId = ''): array
    {
        return Db::transaction(function () use ($payload,$actorId,$ip,$requestId): array {
            $account = $this->persist(null, $payload, $actorId, false, 'admin.account.create', $ip, $requestId);
            $entries = $this->entries ?? new AdminEntryService();
            if ($entries->enabled()) {
                $owner = Db::name('admin_account_entries')->where('admin_id',$actorId)->whereNull('revoked_at')->value('telegram_user_id');
                if (!$owner) throw new RuntimeException('当前管理员的专属入口归属未就绪。');
                $entries->issue($account['id'],(string)$owner);
            }
            return $account;
        });
    }

    public function update(int $id, array $payload, int $actorId, string $ip = '', string $requestId = ''): array
    {
        if ($id <= 0) throw new RuntimeException('后台账号编号无效。');
        return $this->persist($id, $payload, $actorId, false, 'admin.account.update', $ip, $requestId);
    }

    public function status(int $id, string $status, int $actorId, string $ip = '', string $requestId = ''): array
    {
        if ($id <= 0) throw new RuntimeException('后台账号编号无效。');
        return $this->persist($id, ['status' => $status], $actorId, false, 'admin.account.status', $ip, $requestId);
    }

    /** Trusted local CLI compatibility; NULL preserves legacy role defaults. */
    public function saveFromCli(string $username, string $password, string $role, string $status, ?array $permissions = null): array
    {
        $payload = ['username' => $username, 'password' => $password, 'role' => $role, 'status' => $status];
        if ($permissions !== null) $payload['permissions'] = $permissions;
        return $this->persist(null, $payload, null, true, 'admin.account.cli_save', '', '');
    }

    /** Called only after the signed Telegram operation authenticates its configured owner. */
    public function createFromTelegram(array $payload, string $telegramId, string $requestKey): array
    {
        if (!preg_match('/^[1-9][0-9]{0,18}$/D', $telegramId) || !preg_match('/^[a-f0-9]{64}$/D', $requestKey)) throw new RuntimeException('机器人操作人无效。');
        return $this->persist(null, $payload, null, true, 'admin.account.telegram_create', '', 'tg:' . $telegramId . ':' . substr($requestKey, 0, 32));
    }

    private function persist(?int $id, array $payload, ?int $actorId, bool $cli, string $action, string $ip, string $requestId): array
    {
        $password = $payload['password'] ?? '';
        if (!is_string($password) || ($password !== '' && (strlen($password) < 14 || strlen($password) > 128))) throw new RuntimeException('管理员密码须为14至128位。');
        $passwordHash = $password !== '' ? password_hash($password, PASSWORD_DEFAULT) : null;
        return Db::transaction(function () use ($id, $payload, $actorId, $cli, $action, $ip, $requestId, $passwordHash): array {
            // One transaction lock serializes account writes, including concurrent
            // demotions of the final two super administrators.
            if (!Db::name('admin_account_guard')->where('id', 1)->lock(true)->find()) throw new RuntimeException('请先执行后台页面权限迁移。');
            if (!$cli) {
                $actor = Db::name('admin_accounts')->where('id', $actorId)->where('role', 'admin')->where('status', 'active')->lock(true)->find();
                if (!$actor) throw new RuntimeException('此操作需要超级管理员权限。');
            }
            $existing = $id !== null ? Db::name('admin_accounts')->where('id', $id)->lock(true)->find() : null;
            if ($id !== null && !$existing) throw new RuntimeException('后台账号不存在。');
            if ($action === 'admin.account.cli_save' && $id === null && isset($payload['username']) && is_string($payload['username'])) $existing = Db::name('admin_accounts')->where('username', trim($payload['username']))->lock(true)->find();
            $username = $payload['username'] ?? ($existing['username'] ?? '');
            $role = $payload['role'] ?? ($existing['role'] ?? 'operator');
            $status = $payload['status'] ?? ($existing['status'] ?? 'active');
            if (!is_string($username)) throw new RuntimeException('管理员账号格式无效。');
            $username = trim($username);
            if (!preg_match('/^[A-Za-z][A-Za-z0-9_.-]{2,63}$/D', $username)) throw new RuntimeException('管理员账号须为3至64位字母、数字、点、横线或下划线。');
            if (!is_string($role) || !in_array($role, ['admin', 'operator', 'auditor'], true)) throw new RuntimeException('管理员角色无效。');
            if (!is_string($status) || !in_array($status, ['active', 'disabled'], true)) throw new RuntimeException('管理员状态无效。');
            if (!$existing && $passwordHash === null) throw new RuntimeException('新管理员必须设置密码。');
            $targetId = $existing ? (int) $existing['id'] : null;
            $activeSuperCount = $existing && $existing['role'] === 'admin' && $existing['status'] === 'active' && ($role !== 'admin' || $status !== 'active')
                ? (int) Db::name('admin_accounts')->where('role', 'admin')->where('status', 'active')->count() : 0;
            $this->assertMutationAllowed($existing, $role, $status, $actorId, $cli, $activeSuperCount);
            $duplicate = Db::name('admin_accounts')->where('username', $username);
            if ($targetId !== null) $duplicate->where('id', '<>', $targetId);
            if ($duplicate->find()) throw new RuntimeException('管理员账号已存在。');
            if (array_key_exists('permissions', $payload)) {
                if (!is_array($payload['permissions'])) throw new RuntimeException('页面权限必须为数组。');
                $permissions = AdminPermissionService::normalize($payload['permissions'], $role);
                $permissionsJson = json_encode($permissions, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
            } else $permissionsJson = $existing !== null ? ($existing['permissions_json'] ?? null) : ($cli ? null : '[]');
            if ($role === 'auditor' && $permissionsJson !== null) {
                // Role changes cannot leave a legacy manage grant on a read-only account.
                $permissionsJson = json_encode(AdminPermissionService::permissions(['role' => $role, 'permissions_json' => $permissionsJson]), JSON_THROW_ON_ERROR);
            }
            $now = date('Y-m-d H:i:s');
            $data = ['username' => $username, 'role' => $role, 'status' => $status, 'permissions_json' => $permissionsJson, 'updated_at' => $now];
            if ($passwordHash !== null) $data['password_hash'] = $passwordHash;
            $beforePermissions = $existing['permissions_json'] ?? null;
            $permissionChange = ($beforePermissions === null) !== ($permissionsJson === null)
                || ($beforePermissions !== null && json_decode($beforePermissions, true) !== json_decode($permissionsJson ?? 'null', true));
            $revoke = $existing && ($passwordHash !== null || $username !== $existing['username'] || $role !== $existing['role'] || $status !== $existing['status'] || $permissionChange);
            if ($existing) {
                Db::name('admin_accounts')->where('id', $targetId)->update($data);
                if ($revoke) Db::name('admin_sessions')->where('admin_id', $targetId)->delete();
            } else $targetId = (int) Db::name('admin_accounts')->insertGetId($data + ['created_at' => $now]);
            $account = $this->format(Db::name('admin_accounts')->where('id', $targetId)->find());
            (new AuditService())->log($actorId ?? 0, $action, 'admin', $targetId, $requestId, $ip,
                ['username' => $username, 'role' => $role, 'status' => $status, 'permissions' => $account['permissions'],
                    'password_reset' => $passwordHash !== null, 'sessions_revoked' => (bool) $revoke]);
            return $account;
        });
    }

    public function format(array $row): array
    {
        return ['id' => (int) $row['id'], 'username' => (string) $row['username'], 'role' => (string) $row['role'],
            'status' => (string) $row['status'], 'permissions' => AdminPermissionService::permissions($row),
            'is_super_admin' => $row['role'] === 'admin', 'created_at' => $row['created_at'] ?? null, 'updated_at' => $row['updated_at'] ?? null];
    }

    private function assertMutationAllowed(?array $existing, string $role, string $status, ?int $actorId, bool $cli, int $activeSuperCount): void
    {
        if (!$existing) return;
        if (!$cli && (int) $existing['id'] === $actorId && ($role !== 'admin' || $status !== 'active')) throw new RuntimeException('不能在网页中降级或停用当前登录的账号。');
        if ($existing['role'] === 'admin' && $existing['status'] === 'active' && ($role !== 'admin' || $status !== 'active') && $activeSuperCount <= 1) throw new RuntimeException('不能停用或降级最后一个超级管理员。');
    }
}
