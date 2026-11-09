<?php
declare(strict_types=1);
namespace app\Service;

use think\facade\Db;
use think\exception\HttpResponseException;

/** Reserve attempts under database row locks before expensive password verification. */
final class AdminLoginThrottle
{
    private \Closure $clock;
    public function __construct(?callable $clock = null) { $this->clock = $clock === null ? static fn (): int => time() : \Closure::fromCallable($clock); }

    public function reserve(string $username, string $ip): void
    {
        $now = ($this->clock)();
        $buckets = [
            [hash('sha256', 'admin-login-ip:' . $ip), 30, 60],
            [self::accountKey($username), 10, 900],
        ];
        $retry = Db::transaction(function () use ($buckets, $now): int {
            $rows = []; $wait = 0;
            $table = Db::name('admin_security_rates')->getTable();
            $sqlite = Db::connect()->getConfig('type') === 'sqlite';
            foreach ($buckets as [$key, $limit, $seconds]) {
                $sql = "INSERT INTO {$table} (bucket_key,hits,expires_at) VALUES (?,0,?) " . ($sqlite
                    ? 'ON CONFLICT(bucket_key) DO NOTHING' : 'ON DUPLICATE KEY UPDATE bucket_key=VALUES(bucket_key)');
                Db::execute($sql, [$key, date('Y-m-d H:i:s', $now + $seconds)]);
                $row = Db::name('admin_security_rates')->where('bucket_key', $key)->lock(true)->find();
                if (!$row) throw new \RuntimeException('后台安全限流服务不可用。');
                $expired = strtotime($row['expires_at']) <= $now;
                $rows[] = [$key, $expired ? 0 : (int) $row['hits'], $expired ? date('Y-m-d H:i:s', $now + $seconds) : $row['expires_at']];
                if (!$expired && (int) $row['hits'] >= $limit) $wait = max($wait, strtotime($row['expires_at']) - $now);
            }
            if ($wait === 0) foreach ($rows as [$key, $hits, $expires]) Db::name('admin_security_rates')->where('bucket_key', $key)->update(['hits' => $hits + 1, 'expires_at' => $expires]);
            return $wait;
        });
        if ($retry > 0) throw new HttpResponseException(json(['ok' => false, 'error' => ['code' => 'RATE_LIMITED', 'message' => '后台登录尝试过于频繁，请稍后重试。']], 429)
            ->header(AdminBrowserSecurity::headers() + ['Retry-After' => (string) $retry]));
    }

    public function succeeded(string $username): void { Db::name('admin_security_rates')->where('bucket_key', self::accountKey($username))->delete(); }
    private static function accountKey(string $username): string { return hash('sha256', 'admin-login-account:' . strtolower(trim($username))); }
}
