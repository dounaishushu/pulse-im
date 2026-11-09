<?php
declare(strict_types=1);
namespace app\Service;

require_once __DIR__ . '/AdminBrowserSecurity.php';
require_once __DIR__ . '/TelegramGroupPinAccess.php';

use RuntimeException;
use think\Request;
use think\facade\Db;
use think\exception\HttpResponseException;

/** Per-account entrance capability, separate from administrator password/session authentication. */
final class AdminEntryService
{
    public function __construct(private ?array $config = null) {}

    public static function readConfig(): array
    {
        $values = @parse_ini_file(dirname(__DIR__, 2) . '/.env', false, INI_SCANNER_RAW);
        return is_array($values) ? $values : ['ADMIN_ENTRY_REQUIRED' => 'true'];
    }
    private function values(): array { return $this->config ?? self::readConfig(); }
    public function enabled(): bool { return in_array(strtolower((string) ($this->values()['ADMIN_ENTRY_REQUIRED'] ?? 'false')), ['true', '1'], true); }
    public function baseUrl(): string
    {
        $url = rtrim((string) ($this->values()['ADMIN_ENTRY_BASE_URL'] ?? ''), '/'); $parts = parse_url($url);
        if (!filter_var($url, FILTER_VALIDATE_URL) || !$parts || ($parts['scheme'] ?? '') !== 'https' || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment']) || !empty($parts['path'])) throw new RuntimeException('后台专属入口域名未正确配置。');
        return $url;
    }
    public function allowedTelegramUser(string $actor, ?array $operation = null): string
    {
        if (!preg_match('/^telegram:([1-9][0-9]{0,18})$/D', $actor, $match)) throw new RuntimeException('无效机器人操作人。');
        if ($operation !== null && array_key_exists('group_pin_proof', $operation)) {
            if (($operation['actor'] ?? null) !== $actor) throw new RuntimeException('机器人操作人不匹配。');
            return TelegramGroupPinAccess::verify($operation, $this->values());
        }
        $ids = preg_split('/[\s,]+/', trim((string) ($this->values()['TELEGRAM_ADMIN_USER_IDS'] ?? '')), -1, PREG_SPLIT_NO_EMPTY);
        if (!in_array($match[1], $ids, true)) throw new RuntimeException('此Telegram用户没有后台账号管理授权。');
        return $match[1];
    }
    public function initializeDatabase(): void
    {
        $application = \think\Container::getInstance();
        if (!$application instanceof \think\App) $application = new \think\App(dirname(__DIR__, 2) . DIRECTORY_SEPARATOR);
        if (!$application->initialized()) $application->initialize();
    }
    private function secret(): string
    {
        $key = trim((string) ($this->values()['ADMIN_IP_CONTROL_KEY'] ?? ''));
        if (strlen($key) < 32 || strlen($key) > 256) throw new RuntimeException('后台入口密钥未就绪。');
        return hash_hmac('sha256', 'pulse-admin-entry-key-v1', $key, true);
    }
    private function token(array $entry): string { return hash_hmac('sha256', 'account:' . $entry['admin_id'] . ':salt:' . $entry['token_salt'], $this->secret()); }
    public function link(array $entry): string
    {
        $token = $this->token($entry);
        if (!hash_equals((string) $entry['token_hash'], hash('sha256', $token))) throw new RuntimeException('后台入口密钥已变更，请重新生成入口。');
        // Fragments are never sent to Nginx, PHP, access logs or Referer headers.
        return $this->baseUrl() . '/entry/#' . $token;
    }
    public function issue(int $adminId, string $telegramId, ?string $requestKey = null): array
    {
        if ($adminId <= 0 || !preg_match('/^[1-9][0-9]{0,18}$/D', $telegramId) || ($requestKey !== null && !preg_match('/^[a-f0-9]{64}$/D', $requestKey))) throw new RuntimeException('无效后台入口参数。');
        $this->baseUrl(); $this->initializeDatabase();
        return Db::transaction(function () use ($adminId, $telegramId, $requestKey): array {
            $account = Db::name('admin_accounts')->where('id', $adminId)->lock(true)->find();
            if (!$account || $account['status'] !== 'active') throw new RuntimeException('后台账号未启用。');
            $existing = Db::name('admin_account_entries')->where('admin_id', $adminId)->lock(true)->find();
            if ($existing) {
                if ($existing['telegram_user_id'] !== $telegramId || $existing['revoked_at'] !== null) throw new RuntimeException('此账号已有其他归属或入口已停用。');
                return $existing;
            }
            $entry = ['admin_id' => $adminId, 'telegram_user_id' => $telegramId, 'token_salt' => bin2hex(random_bytes(32)), 'creation_request_key' => $requestKey,
                'revoked_at' => null, 'created_at' => date('Y-m-d H:i:s'), 'updated_at' => date('Y-m-d H:i:s')];
            $entry['token_hash'] = hash('sha256', $this->token($entry));
            $entry['id'] = (int) Db::name('admin_account_entries')->insertGetId($entry);
            return $entry;
        });
    }
    public function owned(string $actor, ?array $operation = null): array
    {
        $id = $this->allowedTelegramUser($actor, $operation); $this->initializeDatabase();
        $rows = Db::name('admin_account_entries')->alias('e')->join('admin_accounts a', 'a.id=e.admin_id')
            ->where('e.telegram_user_id', $id)->whereNull('e.revoked_at')->where('a.status', 'active')->order('e.id', 'asc')
            ->field('e.*,a.username,a.role')->select()->toArray();
        if (count($rows) > 100) throw new RuntimeException('后台入口数量较多，请使用后台账号管理核对。');
        return array_map(fn(array $row): array => ['username' => $row['username'], 'role' => $row['role'], 'entry_url' => $this->link($row)], $rows);
    }
    public function cookieName(array $server): string { return AdminBrowserSecurity::secure($server) ? '__Host-pulse_admin_entry' : 'pulse_admin_entry_local'; }
    private function sameHost(array $server): bool
    {
        $origin = AdminBrowserSecurity::origin($server);
        $local = in_array((string) ($server['REMOTE_ADDR'] ?? ''), ['127.0.0.1', '::1'], true) && in_array(parse_url($origin, PHP_URL_HOST), ['127.0.0.1', 'localhost'], true);
        return $local || (AdminBrowserSecurity::secure($server) && hash_equals(strtolower($this->baseUrl()), strtolower($origin)));
    }
    private function cookieToken(array $server, ?string $provided): string
    {
        $name = $this->cookieName($server); $matches = [];
        foreach (explode(';', (string) ($server['HTTP_COOKIE'] ?? '')) as $part) {
            $pair = explode('=', trim($part), 2); if (($pair[0] ?? '') === $name) $matches[] = $pair[1] ?? '';
        }
        if (count($matches) > 1) return '';
        $value = $provided ?? ($matches[0] ?? '');
        return preg_match('/^[a-f0-9]{64}$/D', $value) ? $value : '';
    }
    public function resolveToken(string $token): ?array
    {
        if (!preg_match('/^[a-f0-9]{64}$/D', $token)) return null;
        $this->initializeDatabase();
        $entry = Db::name('admin_account_entries')->alias('e')->join('admin_accounts a', 'a.id=e.admin_id')
            ->where('e.token_hash', hash('sha256', $token))->whereNull('e.revoked_at')->where('a.status', 'active')
            ->field('e.id,e.admin_id,e.token_salt,a.username')->find();
        if (!$entry || !hash_equals($this->token($entry),$token)) return null;
        unset($entry['token_salt']);
        return $entry;
    }
    public function resolveServer(array $server, ?string $provided = null): ?array
    {
        if (!$this->enabled()) return null;
        try { if (!$this->sameHost($server)) return null; return $this->resolveToken($this->cookieToken($server, $provided)); }
        catch (\Throwable) { return null; }
    }
    public function requireRequest(Request $request, ?int $adminId = null): ?array
    {
        if (!$this->enabled()) return null;
        $entry = $this->resolveServer($request->server(), (string) $request->cookie($this->cookieName($request->server()), ''));
        if (!$entry || ($adminId !== null && (int) $entry['admin_id'] !== $adminId)) $this->deny();
        return $entry;
    }
    public function requireServer(array $server, int $adminId): void
    {
        if (!$this->enabled()) return;
        $entry = $this->resolveServer($server);
        if (!$entry || (int) $entry['admin_id'] !== $adminId) $this->deny();
    }
    public function exchange(Request $request, string $token): string
    {
        AdminBrowserSecurity::assertRequest($request);
        if (!$this->enabled() || $request->method() !== 'POST' || $request->header('x-pulse-admin-request', '') !== '1' || !$this->sameHost($request->server()) || !$this->resolveToken($token)) $this->deny();
        return $this->cookieName($request->server()) . '=' . $token . '; Path=/; HttpOnly; SameSite=Strict' . (AdminBrowserSecurity::secure($request->server()) ? '; Secure' : '');
    }
    private function deny(): never { $response = AdminIpAccessService::notFoundResponse(); throw new HttpResponseException(response($response['body'], $response['status'])->header(AdminBrowserSecurity::headers())); }
}
