<?php
declare(strict_types=1);
namespace app\Service;

require_once __DIR__ . '/AdminEntryService.php';

use RuntimeException;
use think\facade\Db;

/** Account creation is atomic with its entrance and never resets an existing account. */
final class AdminTelegramAccountService
{
    public function __construct(private ?AdminEntryService $entries = null) {}

    public function handle(array $payload): array
    {
        $entries = $this->entries ?? new AdminEntryService();
        if (!$entries->enabled()) throw new RuntimeException('后台专属入口尚未启用。');
        $telegramId = $entries->allowedTelegramUser($payload['actor'], $payload);
        if ($payload['action'] === 'admin_entries') return ['items' => $entries->owned($payload['actor'], $payload)];
        if ($payload['action'] !== 'admin_create' || !is_string($payload['username'] ?? null) || !preg_match('/^[A-Za-z][A-Za-z0-9_.-]{2,63}$/D', $payload['username']) || !is_string($payload['role'] ?? null)
            || !in_array($payload['role'], ['admin', 'operator', 'auditor'], true) || !is_array($payload['permissions'] ?? null)
            || !is_string($payload['request_key'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D', $payload['request_key'])) throw new RuntimeException('创建后台账号参数无效。');
        $permissions = AdminPermissionService::normalize($payload['permissions'], $payload['role']);
        $entries->initializeDatabase();
        return Db::transaction(function () use ($entries, $payload, $telegramId, $permissions): array {
            if (!Db::name('admin_account_guard')->where('id', 1)->lock(true)->find()) throw new RuntimeException('后台账号管理结构未就绪。');
            $existing = Db::name('admin_account_entries')->where('creation_request_key', $payload['request_key'])->find();
            if ($existing) {
                if ($existing['telegram_user_id'] !== $telegramId) throw new RuntimeException('无效的创建请求。');
                return ['created' => false, 'reason' => 'already_processed'];
            }
            if (Db::name('admin_accounts')->where('username', trim($payload['username']))->find()) return ['created' => false, 'reason' => 'username_exists'];
            $password = 'P9!' . rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
            $account = (new AdminAccountService())->createFromTelegram(['username' => $payload['username'], 'password' => $password,
                'role' => $payload['role'], 'status' => 'active', 'permissions' => $permissions], $telegramId, $payload['request_key']);
            $entry = $entries->issue($account['id'], $telegramId, $payload['request_key']);
            return ['created' => true, 'username' => $account['username'], 'role' => $account['role'], 'password' => $password, 'entry_url' => $entries->link($entry)];
        });
    }
}
