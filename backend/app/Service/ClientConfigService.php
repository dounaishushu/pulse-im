<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

final class ClientConfigService
{
    public const MAX_SHOPS = 10;

    public function get(): array
    {
        $row = Db::name('client_app_config')->where('id', 1)->find();
        if (!$row) throw new RuntimeException('请先执行客户端配置数据库迁移。');
        return $this->format($row);
    }

    /** Read current enforcement fields without transferring unrelated client settings. */
    public function upgradePolicy(): array
    {
        try { $row = Db::name('client_app_config')->where('id', 1)->field('force_update,latest_version,platform_updates_json')->find(); }
        catch (\Throwable $error) {
            // An old schema still permits login while the deployment migration
            // is pending. Do not hide a connection or any other database error.
            $message = strtolower($error->getMessage());
            if (!str_contains($message, 'platform_updates_json') || (!str_contains($message, 'unknown column') && !str_contains($message, 'no such column'))) throw $error;
            $row = Db::name('client_app_config')->where('id', 1)->field('force_update,latest_version')->find();
        }
        if (!$row) throw new RuntimeException('请先执行客户端配置数据库迁移。');
        return self::policyFromRow($row);
    }

    public static function policyFromRow(array $row): array
    {
        $updates = array_key_exists('platform_updates_json', $row) ? json_decode((string) $row['platform_updates_json'], true) : ($row['platform_updates'] ?? []);
        return ['force_update' => (bool) ($row['force_update'] ?? false), 'latest_version' => (string) ($row['latest_version'] ?? '1.0.0'),
            'platform_updates' => is_array($updates) ? $updates : []];
    }

    /** Legacy global policy belongs to PC only; mobile versions have their own scale. */
    public function platformPolicy(string $platform, ?array $config = null): array
    {
        $platform = strtolower(trim($platform));
        $config ??= $this->get();
        $fallbackVersions = ['android' => '0.2.58', 'ios' => '1.0', 'pc' => '1.0.0', 'web' => '2.4.103'];
        $updates = self::policyFromRow($config)['platform_updates'];
        $rule = is_array($updates[$platform] ?? null) ? $updates[$platform] : null;
        if ($rule === null) {
            $latest = $platform === 'pc' ? (string) ($config['latest_version'] ?? '1.0.0') : ($fallbackVersions[$platform] ?? '0.0.0');
            return ['latest_version' => $latest, 'minimum_version' => $platform === 'pc' && !empty($config['force_update']) ? $latest : '',
                'force_update' => $platform === 'pc' && !empty($config['force_update'])];
        }
        return ['latest_version' => (string) ($rule['latest_version'] ?? $fallbackVersions[$platform] ?? '0.0.0'),
            'minimum_version' => (string) ($rule['minimum_version'] ?? ''), 'force_update' => !empty($rule['force_update'])];
    }

    public function forClient(string $platform, string $version): array
    {
        $config = $this->get();
        $rule = $this->platformPolicy($platform, $config);
        // Old clients compare force_update against latest_version. Only set it
        // for clients below the actual minimum so optional updates stay optional.
        $force = $rule['force_update'] && $rule['minimum_version'] !== ''
            && (!preg_match('/^\d+(?:\.\d+){1,3}$/D', $version) || version_compare($version, $rule['minimum_version'], '<'));
        return array_merge($config, $rule, ['force_update' => $force, 'platform' => strtolower($platform)]);
    }

    public function save(array $payload, int $adminId, string $requestId, string $ip): array
    {
        $current = $this->get();
        $version = trim((string) ($payload['latest_version'] ?? $current['latest_version']));
        if (!preg_match('/^\d+(?:\.\d+){1,3}$/D', $version) || strlen($version) > 32) throw new RuntimeException('版本号应为数字和点，例如 1.2.0。');

        $android = $this->url($payload['android_download_url'] ?? $current['android_download_url'], 'Android下载地址');
        $ios = $this->url($payload['ios_download_url'] ?? $current['ios_download_url'], 'iOS下载地址');
        $pc = $this->url($payload['pc_download_url'] ?? $current['pc_download_url'], '电脑版下载地址');
        $description = trim(str_replace(["\r\n", "\r"], "\n", (string) ($payload['update_description'] ?? $current['update_description'])));
        if (mb_strlen($description) > 10000) throw new RuntimeException('更新说明最多10000个字符。');
        $maxIp = (int) ($payload['max_register_accounts_per_ip'] ?? $current['max_register_accounts_per_ip']);
        if ($maxIp < 0 || $maxIp > 100000) throw new RuntimeException('单个IP最大注册账号数必须在0到100000之间，0表示不限制。');

        $shops = $payload['mall_links'] ?? $current['mall_links'];
        if (is_string($shops)) $shops = json_decode($shops, true);
        if (!is_array($shops)) throw new RuntimeException('商城配置格式不正确。');
        if (count($shops) > self::MAX_SHOPS) throw new RuntimeException('商城入口最多配置10个。');
        $normalizedShops = [];
        foreach ($shops as $index => $shop) {
            if (!is_array($shop)) throw new RuntimeException('第' . ((int) $index + 1) . '个商城配置格式不正确。');
            $name = trim((string) ($shop['name'] ?? ''));
            $url = $this->url($shop['url'] ?? '', '商城链接');
            if ($name === '' && $url === '') continue;
            if ($name === '' || mb_strlen($name) > 32) throw new RuntimeException('商城名称不能为空且最多32个字符。');
            if ($url === '') throw new RuntimeException('商城链接不能为空。');
            $normalizedShops[] = ['name' => $name, 'url' => $url];
        }

        $data = [
            'show_group_member_count' => $this->bool($payload['show_group_member_count'] ?? $current['show_group_member_count']),
            'latest_version' => $version,
            'android_download_url' => $android,
            'ios_download_url' => $ios,
            'pc_download_url' => $pc,
            'update_description' => $description,
            'force_update' => $this->bool($payload['force_update'] ?? $current['force_update']),
            'register_require_avatar' => $this->bool($payload['register_require_avatar'] ?? $current['register_require_avatar']),
            'max_register_accounts_per_ip' => $maxIp,
            'mall_links' => json_encode($normalizedShops, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
            'updated_at' => date('Y-m-d H:i:s'),
        ];
        if (array_key_exists('platform_updates', $payload)) {
            if (!is_array($payload['platform_updates'])) throw new RuntimeException('各端更新配置格式无效。');
            $updates = [];
            foreach (['pc', 'android', 'ios', 'web'] as $platform) {
                $rule = $payload['platform_updates'][$platform] ?? $this->platformPolicy($platform, $current);
                if (!is_array($rule)) throw new RuntimeException($platform . ' 更新配置格式无效。');
                $latest = trim((string) ($rule['latest_version'] ?? ''));
                $minimum = trim((string) ($rule['minimum_version'] ?? ''));
                if (!preg_match('/^\d+(?:\.\d+){1,3}$/D', $latest) || strlen($latest) > 32) throw new RuntimeException($platform . ' 最新版本格式无效。');
                if ($minimum !== '' && (!preg_match('/^\d+(?:\.\d+){1,3}$/D', $minimum) || strlen($minimum) > 32 || version_compare($minimum, $latest, '>'))) throw new RuntimeException($platform . ' 最低兼容版本不得高于最新版本。');
                $force = (bool) $this->bool($rule['force_update'] ?? false);
                if ($force && $minimum === '') throw new RuntimeException($platform . ' 强制更新需要填写最低兼容版本。');
                $updates[$platform] = ['latest_version' => $latest, 'minimum_version' => $minimum, 'force_update' => $force];
            }
            $data['platform_updates_json'] = json_encode($updates, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
            // Preserve a useful compatibility view for old administration pages.
            $data['latest_version'] = $updates['pc']['latest_version'];
            $data['force_update'] = (int) $updates['pc']['force_update'];
        } elseif (!empty($current['platform_updates']['pc'])) {
            // An old admin can still update PC without erasing any mobile rule.
            $updates = $current['platform_updates'];
            $updates['pc'] = ['latest_version' => $version, 'minimum_version' => !empty($data['force_update']) ? $version : '', 'force_update' => (bool) $data['force_update']];
            $data['platform_updates_json'] = json_encode($updates, JSON_THROW_ON_ERROR);
        }
        Db::name('client_app_config')->where('id', 1)->update($data);
        (new AuditService())->log($adminId, 'client_config.update', 'client_config', 1, $requestId, $ip, [
            'version' => $version,
            'force_update' => (bool) $data['force_update'],
            'register_require_avatar' => (bool) $data['register_require_avatar'],
            'max_register_accounts_per_ip' => $maxIp,
        ]);
        return $this->format(array_merge($current, $data));
    }

    public function registrationPolicy(string $ip): array
    {
        $config = $this->get();
        $count = $ip === '' ? 0 : (int) Db::name('users')->where('register_ip', substr($ip, 0, 45))->count();
        return ['require_avatar' => $config['register_require_avatar'], 'max_accounts_per_ip' => $config['max_register_accounts_per_ip'], 'registered_accounts' => $count];
    }

    public function requiresUpgrade(string $platform, string $version, ?array $config = null): bool
    {
        if (!in_array(strtolower($platform), ['android', 'ios', 'pc'], true)) return false;
        $config ??= $this->upgradePolicy();
        $rule = $this->platformPolicy($platform, $config);
        return $rule['force_update'] && $rule['minimum_version'] !== ''
            && (!preg_match('/^\d+(?:\.\d+){1,3}$/D', $version) || version_compare($version, $rule['minimum_version'], '<'));
    }

    private function format(array $row): array
    {
        return [
            'show_group_member_count' => (bool) ($row['show_group_member_count'] ?? true),
            'latest_version' => (string) ($row['latest_version'] ?? '1.0.0'),
            'android_download_url' => (string) ($row['android_download_url'] ?? ''),
            'ios_download_url' => (string) ($row['ios_download_url'] ?? ''),
            'pc_download_url' => (string) ($row['pc_download_url'] ?? ''),
            'update_description' => (string) ($row['update_description'] ?? ''),
            'force_update' => (bool) ($row['force_update'] ?? false),
            'platform_updates' => self::policyFromRow($row)['platform_updates'],
            'register_require_avatar' => (bool) ($row['register_require_avatar'] ?? false),
            'max_register_accounts_per_ip' => (int) ($row['max_register_accounts_per_ip'] ?? 0),
            'mall_links' => $this->decodeShops($row['mall_links'] ?? '[]'),
            'updated_at' => (string) ($row['updated_at'] ?? ''),
        ];
    }

    private function decodeShops(mixed $value): array
    {
        $items = is_array($value) ? $value : json_decode((string) $value, true);
        if (!is_array($items)) return [];
        return array_values(array_filter(array_map(static function ($item): ?array {
            if (!is_array($item)) return null;
            $name = trim((string) ($item['name'] ?? ''));
            $url = trim((string) ($item['url'] ?? ''));
            return $name !== '' || $url !== '' ? ['name' => $name, 'url' => $url] : null;
        }, $items)));
    }

    private function url(mixed $value, string $label): string
    {
        $url = trim((string) $value);
        if ($url === '') return '';
        if (mb_strlen($url) > 2048 || !filter_var($url, FILTER_VALIDATE_URL) || !preg_match('~^https?://~i', $url)) {
            throw new RuntimeException($label . '必须是有效的HTTP或HTTPS地址。');
        }
        return $url;
    }

    private function bool(mixed $value): int
    {
        return in_array($value, [true, 1, '1', 'true', 'on'], true) ? 1 : 0;
    }
}
