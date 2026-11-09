<?php

namespace app\Service;

use think\facade\Db;
use RuntimeException;

/** 注册地区统计：只统计注册IP，不把登录IP或文本猜测当作省份。 */
class AdminRegionStatsService
{
    public const REGIONS = [
        '110000' => ['北京市', 'BJ', 'Beijing', '北京'],
        '120000' => ['天津市', 'TJ', 'Tianjin', '天津'],
        '130000' => ['河北省', 'HE', 'Hebei', '河北'],
        '140000' => ['山西省', 'SX', 'Shanxi', '山西'],
        '150000' => ['内蒙古自治区', 'NM', 'Inner Mongolia', '内蒙古', '內蒙古自治區'],
        '210000' => ['辽宁省', 'LN', 'Liaoning', '辽宁', '遼寧省'],
        '220000' => ['吉林省', 'JL', 'Jilin', '吉林'],
        '230000' => ['黑龙江省', 'HL', 'Heilongjiang', '黑龙江', '黑龍江省'],
        '310000' => ['上海市', 'SH', 'Shanghai', '上海'],
        '320000' => ['江苏省', 'JS', 'Jiangsu', '江苏', '江蘇省'],
        '330000' => ['浙江省', 'ZJ', 'Zhejiang', '浙江'],
        '340000' => ['安徽省', 'AH', 'Anhui', '安徽'],
        '350000' => ['福建省', 'FJ', 'Fujian', '福建'],
        '360000' => ['江西省', 'JX', 'Jiangxi', '江西'],
        '370000' => ['山东省', 'SD', 'Shandong', '山东', '山東省'],
        '410000' => ['河南省', 'HA', 'Henan', '河南'],
        '420000' => ['湖北省', 'HB', 'Hubei', '湖北'],
        '430000' => ['湖南省', 'HN', 'Hunan', '湖南'],
        '440000' => ['广东省', 'GD', 'Guangdong', '广东', '廣東省'],
        '450000' => ['广西壮族自治区', 'GX', 'Guangxi', '广西', '廣西壯族自治區'],
        '460000' => ['海南省', 'HI', 'Hainan', '海南'],
        '500000' => ['重庆市', 'CQ', 'Chongqing', '重庆', '重慶市'],
        '510000' => ['四川省', 'SC', 'Sichuan', '四川'],
        '520000' => ['贵州省', 'GZ', 'Guizhou', '贵州', '貴州省'],
        '530000' => ['云南省', 'YN', 'Yunnan', '云南', '雲南省'],
        '540000' => ['西藏自治区', 'XZ', 'Tibet', '西藏', '西藏自治區'],
        '610000' => ['陕西省', 'SN', 'Shaanxi', '陕西', '陝西省'],
        '620000' => ['甘肃省', 'GS', 'Gansu', '甘肃', '甘肅省'],
        '630000' => ['青海省', 'QH', 'Qinghai', '青海'],
        '640000' => ['宁夏回族自治区', 'NX', 'Ningxia', '宁夏', '寧夏回族自治區'],
        '650000' => ['新疆维吾尔自治区', 'XJ', 'Xinjiang', '新疆', '新疆維吾爾自治區'],
        '710000' => ['台湾省', 'TW', 'Taiwan', '台湾', '臺灣省', '台灣省'],
        '810000' => ['香港特别行政区', 'HK', 'Hong Kong', '香港', '香港特別行政區'],
        '820000' => ['澳门特别行政区', 'MO', 'Macao', '澳门', 'Macau', '澳門特別行政區'],
    ];

    public function __construct(private ?AdminIpLocationService $locations = null)
    {
        $this->locations ??= new AdminIpLocationService();
    }

    public static function province(string $country, string $region, string $regionCode = ''): ?string
    {
        $country = strtoupper(trim($country));
        if (isset(['HK' => 1, 'MO' => 1, 'TW' => 1][$country])) return ['HK' => '810000', 'MO' => '820000', 'TW' => '710000'][$country];
        if ($country !== 'CN') return null;
        $region = mb_strtolower(trim($region));
        foreach (self::REGIONS as $code => $aliases) {
            foreach ($aliases as $alias) if ($region !== '' && $region === mb_strtolower($alias)) return (string) $code;
        }
        $regionCode = strtoupper(preg_replace('/^CN-/i', '', trim($regionCode)));
        foreach (self::REGIONS as $code => $aliases) {
            if (in_array($regionCode, [$aliases[1], (string) $code, substr((string) $code, 0, 2)], true)) return (string) $code;
        }
        return null;
    }

    public function snapshot(): array
    {
        // 覆盖全库而不是当前用户列表页；同一IP的多个用户仍按人数计数。
        $groups = Db::name('users')->field('register_ip, COUNT(*) AS people')->group('register_ip')->select()->toArray();
        $public = [];
        $total = $noIp = $private = 0;
        foreach ($groups as $group) {
            $count = (int) $group['people'];
            $total += $count;
            $input = trim((string) ($group['register_ip'] ?? ''));
            if (!filter_var($input, FILTER_VALIDATE_IP)) { $noIp += $count; continue; }
            if (!filter_var($input, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) { $private += $count; continue; }
            $ip = inet_ntop(inet_pton($input));
            $public[$ip] = ($public[$ip] ?? 0) + $count;
        }
        $stored = $this->geographies(array_keys($public));
        $provinces = [];
        foreach (self::REGIONS as $code => $names) $provinces[(string) $code] = ['code' => (string) $code, 'name' => $names[0], 'count' => 0];
        $domestic = $overseas = $unmapped = $unavailable = $pendingUsers = $pendingCount = 0;
        $next = [];
        $now = date('Y-m-d H:i:s');
        foreach ($public as $ip => $people) {
            $row = $stored[$ip] ?? null;
            if (!$row || $row['next_retry_at'] <= $now || $row['status'] === 'pending') {
                $pendingCount++;
                if ((!$row || $row['next_retry_at'] <= $now) && count($next) < AdminIpLocationService::BATCH_SIZE) $next[] = $ip;
            }
            $country = $row['country_code'] ?? '';
            $code = $row['province_code'] ?? '';
            if (isset($provinces[$code])) { $provinces[$code]['count'] += $people; $domestic += $people; }
            elseif (preg_match('/^[A-Z]{2}$/', $country) && !in_array($country, ['CN', 'HK', 'MO', 'TW'], true)) $overseas += $people;
            elseif ($country !== '') $unmapped += $people;
            elseif (!$row || $row['status'] === 'pending') $pendingUsers += $people;
            else $unavailable += $people;
        }
        return [
            'total' => $total, 'identified' => $domestic + $overseas, 'domestic' => $domestic, 'overseas' => $overseas,
            'unknown' => $total - $domestic - $overseas, 'provinces' => array_values($provinces),
            'pending_ip_count' => $pendingCount, 'next_ips' => $next,
            'unknown_reasons' => ['missing_or_invalid' => $noIp, 'private' => $private, 'pending' => $pendingUsers, 'unavailable' => $unavailable, 'unmapped' => $unmapped],
            'source' => 'register_ip', 'generated_at' => date('c'),
        ];
    }

    public function refreshBatch(): array
    {
        $snapshot = $this->snapshot();
        return ['processed_ips' => $this->resolveIps($snapshot['next_ips'])] + $this->snapshot();
    }

    public static function publicIp(?string $input): ?string
    {
        $ip = trim((string) $input);
        return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) ? inet_ntop(inet_pton($ip)) : null;
    }

    public function geographies(array $ips): array
    {
        $stored = [];
        foreach (array_chunk(array_values(array_unique($ips)), 1000) as $chunk) {
            foreach (Db::name('ip_region_locations')->whereIn('ip', $chunk)->select()->toArray() as $row) $stored[$row['ip']] = $row;
        }
        return $stored;
    }

    /** 地图与异地核查共享持久化缓存和并发租约，每批只处理8个公网IP。 */
    public function resolveIps(array $ips): int
    {
        if (count($ips) > AdminIpLocationService::BATCH_SIZE) throw new RuntimeException('每批最多补全8个IP地址。');
        $claimed = [];
        $now = date('Y-m-d H:i:s');
        $lease = date('Y-m-d H:i:s', time() + 30);
        foreach (array_unique($ips) as $input) {
            $ip = self::publicIp($input);
            if ($ip === null) throw new RuntimeException('只能补全有效公网IP地址。');
            Db::name('ip_region_locations')->extra('IGNORE')->insert(['ip' => $ip, 'status' => 'pending', 'next_retry_at' => $now]);
            // 数据库租约防止多个管理员/定时任务同时查询同一IP。
            if (Db::name('ip_region_locations')->where('ip', $ip)->where(function ($query) use ($now): void {
                $query->where('next_retry_at', '<=', $now)->whereOr(function ($legacy): void { $legacy->where('status', 'ready')->whereNull('city_name'); });
            })->update(['next_retry_at' => $lease, 'status' => 'pending'])) $claimed[] = $ip;
        }
        if ($claimed) {
            foreach ($this->locations->resolve($claimed, true) as $item) {
                if ($item['status'] === 'pending') continue;
                $country = strtoupper((string) ($item['country_code'] ?? ''));
                $ready = $item['status'] === 'ready' && (bool) preg_match('/^[A-Z]{2}$/', $country);
                $update = ['checked_at' => $now, 'next_retry_at' => date('Y-m-d H:i:s', time() + ($ready ? AdminIpLocationService::SUCCESS_TTL : AdminIpLocationService::FAILURE_TTL))];
                if ($ready) $update += [
                    'country_code' => $country, 'province_code' => self::province($country, (string) ($item['region'] ?? ''), (string) ($item['region_code'] ?? '')),
                    'region_name' => (string) ($item['region'] ?? ''), 'region_code' => (string) ($item['region_code'] ?? ''),
                    'city_name' => (string) ($item['city'] ?? ''), 'location' => $item['location'], 'status' => 'ready',
                ];
                else {
                    // 接口临时失败保留此前可信的地区，首次失败则继续计入未识别。
                    $update['status'] = 'unavailable';
                }
                Db::name('ip_region_locations')->where('ip', $item['ip'])->where('next_retry_at', $lease)->update($update);
            }
        }
        return count($claimed);
    }
}
