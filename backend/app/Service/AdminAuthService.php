<?php
namespace app\Service;

require_once __DIR__ . '/AdminBrowserSecurity.php';
require_once __DIR__ . '/AdminLoginThrottle.php';
require_once __DIR__ . '/AdminEntryService.php';

use think\Request;
use think\facade\Db;
use think\exception\HttpResponseException;
use RuntimeException;

final class AdminAuthService
{
    public function __construct(private ?AdminEntryService $entries = null) {}
    public function login(string $username, string $password, string $ip, ?Request $request = null): array
    {
        $entryService = $this->entries ?? new AdminEntryService();
        $entry = null;
        if ($entryService->enabled()) {
            if ($request === null) $entryService->requireServer([], 0);
            $entry = $entryService->requireRequest($request);
        }
        $username = trim($username);
        $throttle = new AdminLoginThrottle();
        $throttle->reserve($username, $ip);
        if (strlen($username) > 64 || strlen($password) > 128 || $username === '' || $password === '') $this->fail('管理员账号或密码错误。', 401);
        $since = date('Y-m-d H:i:s', time() - 900);
        $failures = Db::name('admin_login_attempts')->where('success', 0)->where('created_at', '>=', $since)
            ->where(function ($q) use ($username, $ip): void { $q->where('username', $username)->whereOr('ip', $ip); })->count();
        if ($failures >= 10) $this->fail('尝试过于频繁，请15分钟后重试。', 429);
        $account = Db::name('admin_accounts')->where('username', $username)->find();
        // A missing or disabled account still performs password verification.
        $dummyHash = '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.';
        $verified = password_verify($password, $account['password_hash'] ?? $dummyHash);
        $valid = $account && $account['status'] === 'active' && $verified && ($entry === null || (int) $entry['admin_id'] === (int) $account['id']);
        Db::name('admin_login_attempts')->insert(['username' => substr($username, 0, 64), 'ip' => substr($ip, 0, 45), 'success' => $valid ? 1 : 0, 'created_at' => date('Y-m-d H:i:s')]);
        if (!$valid) {
            (new AuditService())->log(0, 'admin.login_failed', 'admin', null, '', $ip, ['username' => substr($username, 0, 64)]);
            $this->fail('管理员账号或密码错误。', 401);
        }
        $result = Db::transaction(function () use ($account, $ip): array {
            $current = Db::name('admin_accounts')->where('id', $account['id'])->lock(true)->find();
            if (!$current || $current['status'] !== 'active' || $current['password_hash'] !== $account['password_hash']) $this->fail('管理员资料已变更，请重新登录。', 401);
            $token = bin2hex(random_bytes(32));
            $expires = date('Y-m-d H:i:s', time() + 8 * 3600);
            Db::name('admin_sessions')->insert(['admin_id' => $current['id'], 'token_hash' => hash('sha256', $token), 'expires_at' => $expires, 'created_at' => date('Y-m-d H:i:s')]);
            $keep = Db::name('admin_sessions')->where('admin_id', $current['id'])->where('expires_at', '>', date('Y-m-d H:i:s'))->order('id', 'desc')->limit(5)->column('id');
            Db::name('admin_sessions')->where('admin_id', $current['id'])->whereNotIn('id', $keep)->delete();
            (new AuditService())->log((int) $current['id'], 'admin.login', 'admin', (int) $current['id'], '', $ip, []);
            return ['access_token' => $token, 'expires_at' => $expires, 'admin' => $this->publicAccount($current)];
        });
        $throttle->succeeded($username);
        return $result;
    }

    public function byHash(string $hash): ?array
    {
        if (!preg_match('/^[a-f0-9]{64}$/D', $hash)) return null;
        return Db::name('admin_sessions')->alias('s')->join('admin_accounts a', 'a.id=s.admin_id')
            ->where('s.token_hash', $hash)->where('s.expires_at', '>', date('Y-m-d H:i:s'))->where('a.status', 'active')
            ->field('a.id,a.username,a.role,a.status,a.permissions_json')->find() ?: null;
    }

    public function authenticate(Request $request): array
    {
        $token = AdminBrowserSecurity::token($request);
        $account = $token !== '' ? $this->byHash(hash('sha256', $token)) : null;
        if (!$account) $this->fail('管理员登录已过期，请重新登录。', 401);
        ($this->entries ?? new AdminEntryService())->requireRequest($request, (int) $account['id']);
        return $this->publicAccount($account);
    }

    public function authorize(Request $request): array
    {
        $account = $this->authenticate($request);
        if (!AdminPermissionService::allowsRoute($account, $request->method(), $request->pathinfo())) $this->fail('当前账号无权访问此页面或执行此操作。', 403);
        return $account;
    }

    public function id(Request $request): int { return (int) $this->authenticate($request)['id']; }

    public function logout(Request $request): void
    {
        $account = $this->authenticate($request);
        $token = AdminBrowserSecurity::token($request);
        Db::name('admin_sessions')->where('token_hash', hash('sha256', $token))->delete();
        (new AuditService())->log((int) $account['id'], 'admin.logout', 'admin', (int) $account['id'], '', (string) $request->ip());
    }

    public function saveAccount(string $username, string $password, string $role = 'operator', string $status = 'active', ?array $permissions = null): array
    {
        return (new AdminAccountService())->saveFromCli($username, $password, $role, $status, $permissions);
    }

    private function publicAccount(array $row): array
    {
        return ['id' => (int) $row['id'], 'username' => $row['username'], 'role' => $row['role'], 'status' => $row['status'],
            'permissions' => AdminPermissionService::permissions($row), 'is_super_admin' => $row['role'] === 'admin'];
    }
    private function fail(string $message, int $status): never { throw new HttpResponseException(json(['ok' => false, 'error' => ['code' => $status === 429 ? 'RATE_LIMITED' : ($status === 403 ? 'FORBIDDEN' : 'ADMIN_AUTH_REQUIRED'), 'message' => $message]], $status)); }
}
