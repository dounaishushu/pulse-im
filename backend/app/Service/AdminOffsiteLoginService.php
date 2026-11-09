<?php

namespace app\Service;

use think\facade\Db;

/** 只列出归属地已确认不同的正常账户，未知地点不作为异地登录证据。 */
class AdminOffsiteLoginService
{
    public function __construct(private ?AdminRegionStatsService $geography = null)
    {
        $this->geography ??= new AdminRegionStatsService();
    }

    public static function compare(array $registered, array $login): array
    {
        $left = strtoupper((string) ($registered['country_code'] ?? ''));
        $right = strtoupper((string) ($login['country_code'] ?? ''));
        if (!preg_match('/^[A-Z]{2}$/', $left) || !preg_match('/^[A-Z]{2}$/', $right)) return ['status' => 'unknown'];
        $chinese = ['CN', 'HK', 'MO', 'TW'];
        $leftCountry = in_array($left, $chinese, true) ? 'CN' : $left;
        $rightCountry = in_array($right, $chinese, true) ? 'CN' : $right;
        if ($leftCountry !== $rightCountry) return ['status' => 'different', 'level' => 'country'];
        if ($leftCountry === 'CN') {
            $leftRegion = $registered['province_code'] ?? AdminRegionStatsService::province($left, (string) ($registered['region_name'] ?? ''), (string) ($registered['region_code'] ?? ''));
            $rightRegion = $login['province_code'] ?? AdminRegionStatsService::province($right, (string) ($login['region_name'] ?? ''), (string) ($login['region_code'] ?? ''));
        } else {
            $leftRegion = self::place((string) (($registered['region_code'] ?? '') ?: ($registered['region_name'] ?? '')));
            $rightRegion = self::place((string) (($login['region_code'] ?? '') ?: ($login['region_name'] ?? '')));
        }
        if (!$leftRegion || !$rightRegion) return ['status' => 'unknown'];
        if ($leftRegion !== $rightRegion) return ['status' => 'different', 'level' => 'province'];
        $leftCity = self::place((string) ($registered['city_name'] ?? ''));
        $rightCity = self::place((string) ($login['city_name'] ?? ''));
        if ($leftCity === '' || $rightCity === '') return ['status' => 'unknown'];
        return $leftCity === $rightCity ? ['status' => 'same'] : ['status' => 'different', 'level' => 'city'];
    }

    private static function place(string $name): string
    {
        // 接口固定使用中文；兼容空白、大小写和常见行政后缀差异。
        return preg_replace('/\s+/u', '', mb_strtolower(preg_replace('/市$/u', '', trim($name))));
    }

    public function snapshot(int $page = 1, int $size = 30): array
    {
        $size = max(1, min(50, $size));
        // 使用已有(user_id,success,id)索引取最新成功记录，避免逐用户执行PHP查询。
        $latest = Db::name('login_logs')->field('id')->whereRaw('user_id = u.id')->where('success', 1)->order('id', 'desc')->limit(1)->buildSql();
        $users = Db::name('users')->alias('u')->leftJoin('login_logs l', 'l.id = ' . $latest)->where('u.status', 'active')
            ->field('u.id,u.username,u.phone,u.nickname,u.avatar_url,u.register_ip,l.ip AS login_ip,l.id AS login_id,l.created_at AS login_at,l.device_type AS login_device')
            ->order('l.id', 'desc')->order('u.id', 'desc')->select()->toArray();
        $ips = [];
        foreach ($users as $user) {
            if (!$user['login_id']) continue;
            $registered = AdminRegionStatsService::publicIp($user['register_ip']);
            $login = AdminRegionStatsService::publicIp($user['login_ip']);
            if ($registered && $login && $registered !== $login) { $ips[$registered] = true; $ips[$login] = true; }
        }
        $stored = $this->geography->geographies(array_keys($ips));
        $next = [];
        $pending = 0;
        $now = date('Y-m-d H:i:s');
        foreach (array_keys($ips) as $ip) {
            $row = $stored[$ip] ?? null;
            $legacy = $row && $row['status'] === 'ready' && $row['city_name'] === null;
            $due = !$row || $row['next_retry_at'] <= $now || $legacy;
            if ($due || $row['status'] === 'pending') $pending++;
            if ($due && count($next) < AdminIpLocationService::BATCH_SIZE) $next[] = $ip;
        }
        $items = [];
        $same = $unknown = $noLogin = 0;
        foreach ($users as $user) {
            if (!$user['login_id']) { $noLogin++; continue; }
            $registeredIp = AdminRegionStatsService::publicIp($user['register_ip']);
            $loginIp = AdminRegionStatsService::publicIp($user['login_ip']);
            if (!$registeredIp || !$loginIp) { $unknown++; continue; }
            if ($registeredIp === $loginIp) { $same++; continue; }
            $registered = $stored[$registeredIp] ?? [];
            $login = $stored[$loginIp] ?? [];
            // Expired or refreshing rows may belong to an earlier provider. Keep
            // them for map continuity, but do not use mixed sources as evidence.
            if (($registered['status'] ?? '') !== 'ready' || ($login['status'] ?? '') !== 'ready'
                || (string) ($registered['next_retry_at'] ?? '') <= $now || (string) ($login['next_retry_at'] ?? '') <= $now) { $unknown++; continue; }
            $result = self::compare($registered, $login);
            if ($result['status'] === 'same') { $same++; continue; }
            if ($result['status'] === 'unknown') { $unknown++; continue; }
            $items[] = [
                'id' => (int) $user['id'], 'nickname' => $user['nickname'], 'account' => $user['username'] ?: ($user['phone'] ?: (string) $user['id']), 'avatar_url' => $user['avatar_url'],
                'register_ip' => $user['register_ip'], 'register_location' => $registered['location'],
                'login_ip' => $user['login_ip'], 'login_location' => $login['location'], 'login_at' => $user['login_at'], 'login_device' => $user['login_device'],
                'difference_level' => $result['level'],
            ];
        }
        $total = count($items);
        $page = max(1, min(max(1, (int) ceil($total / $size)), $page));
        return [
            'items' => array_slice($items, ($page - 1) * $size, $size), 'total' => $total, 'page' => $page, 'size' => $size,
            'active_users' => count($users), 'checked_users' => count($users) - $noLogin, 'compared_users' => $same + $total,
            'same_region_users' => $same, 'unknown_users' => $unknown, 'no_login_users' => $noLogin,
            'pending_ip_count' => $pending, 'next_ips' => $next, 'generated_at' => date('c'),
        ];
    }

    public function refreshBatch(int $page = 1, int $size = 30): array
    {
        $before = $this->snapshot($page, $size);
        return ['processed_ips' => $this->geography->resolveIps($before['next_ips'])] + $this->snapshot($page, $size);
    }
}
