<?php

namespace app\Service;

use RuntimeException;

class AdminIpLocationService
{
    public const BATCH_SIZE = 8;
    public const SUCCESS_TTL = 86400;
    public const FAILURE_TTL = 120;
    public const CACHE_PREFIX = 'admin_ip_location_baidu_json_v1_';
    private array $lookupErrors = [];
    private array $lookupDiagnostics = [];

    public function cached(string $ip): array
    {
        if (!filter_var($ip, FILTER_VALIDATE_IP)) return ['ip' => $ip, 'location' => '暂无记录', 'status' => 'ready'];
        $ip = inet_ntop(inet_pton($ip));
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) return ['ip' => $ip, 'location' => '本机或内网地址', 'status' => 'ready'];
        $stored = cache($this->key($ip));
        if (is_array($stored) && isset($stored['location'], $stored['status'])) {
            if ($stored['status'] === 'unavailable') $stored = IpLocationFailure::describe((string) ($stored['error_code'] ?? 'provider_unavailable'), $stored) + $stored;
            return ['ip' => $ip] + $stored;
        }
        // Provider/language/version are isolated from legacy free-provider caches.
        return ['ip' => $ip, 'location' => '查询中…', 'status' => 'pending'];
    }

    public function resolve(array $ips, bool $requireGeography = false): array
    {
        if (count($ips) > self::BATCH_SIZE) throw new RuntimeException('每次最多查询8个IP地址。');
        $this->lookupErrors = [];
        $this->lookupDiagnostics = [];
        $items = $pending = $locks = [];
        try {
            foreach ($ips as $input) {
                if (!is_string($input) || !filter_var($input, FILTER_VALIDATE_IP)) throw new RuntimeException('IP地址格式不正确。');
                $ip = inet_ntop(inet_pton($input));
                if (isset($items[$ip])) continue;
                $items[$ip] = $this->cached($ip);
                if ($requireGeography && $items[$ip]['status'] === 'ready' && !$this->hasGeography($items[$ip]) && $this->isPublic($ip)) $items[$ip]['status'] = 'pending';
                if ($items[$ip]['status'] !== 'pending') continue;
                // 非阻塞文件锁：同一IP的并发请求只允许一次外部查询，无需额外部署队列。
                $directory = app()->getRuntimePath() . 'ip-location-locks/';
                if (!is_dir($directory) && !@mkdir($directory, 0755, true) && !is_dir($directory)) continue;
                $lock = @fopen($directory . hash('sha256', $ip) . '.lock', 'c');
                if (!$lock) continue;
                if (!flock($lock, LOCK_EX | LOCK_NB)) { fclose($lock); continue; }
                $locks[$ip] = $lock;
                $items[$ip] = $this->cached($ip);
                if ($requireGeography && $items[$ip]['status'] === 'ready' && !$this->hasGeography($items[$ip]) && $this->isPublic($ip)) $items[$ip]['status'] = 'pending';
                if ($items[$ip]['status'] === 'pending') $pending[] = $ip;
            }
            $locations = $pending === [] ? [] : $this->fetchLocations($pending);
            foreach ($pending as $ip) {
                $result = $locations[$ip] ?? '';
                // 兼容旧的字符串查询结果，地图只使用接口返回的结构化地区。
                $location = is_array($result) ? (string) ($result['location'] ?? '') : (string) $result;
                $stored = ['location' => $location !== '' ? $location : '暂未查到归属地', 'status' => $location !== '' ? 'ready' : 'unavailable'];
                if ($location === '' && isset($this->lookupErrors[$ip])) {
                    $stored = IpLocationFailure::describe($this->lookupErrors[$ip], $this->lookupDiagnostics[$ip] ?? []) + $stored;
                }
                if (is_array($result)) $stored += array_intersect_key($result, array_flip(['country_code', 'region', 'region_code', 'city']));
                cache($this->key($ip), $stored, $location !== '' ? self::SUCCESS_TTL : self::FAILURE_TTL);
                $items[$ip] = ['ip' => $ip] + $stored;
            }
            return array_map(static fn (string $input): array => ['ip' => $input] + $items[inet_ntop(inet_pton($input))], array_values(array_unique($ips)));
        } finally {
            foreach ($locks as $lock) { flock($lock, LOCK_UN); fclose($lock); }
        }
    }

    protected function fetchLocations(array $ips): array
    {
        $provider = new BaiduIpLocationProvider();
        $locations = $provider->lookup($ips);
        $this->lookupErrors = $provider->errors();
        $this->lookupDiagnostics = $provider->diagnostics();
        return $locations;
    }

    private function key(string $ip): string { return self::CACHE_PREFIX . hash('sha256', $ip); }

    private function isPublic(string $ip): bool { return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false; }

    private function hasGeography(array $item): bool { return (bool) preg_match('/^[A-Z]{2}$/', (string) ($item['country_code'] ?? '')) && array_key_exists('region', $item) && array_key_exists('city', $item); }
}
