<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

final class ClientNavigationService
{
    public const MAX_LINKS = 10;

    public function get(): array
    {
        $row = Db::name('client_navigation_config')->where('id', 1)->find();
        if (!$row) throw new RuntimeException('请先执行客户端导航数据库迁移。');
        return ['explore_links' => $this->decodeLinks($row['explore_links'] ?? '[]'), 'updated_at' => (string) ($row['updated_at'] ?? '')];
    }

    public function save(array $payload, int $adminId, string $requestId, string $ip): array
    {
        $links = $payload['explore_links'] ?? [];
        if (is_string($links)) $links = json_decode($links, true);
        if (!is_array($links)) throw new RuntimeException('探索入口配置格式不正确。');
        if (count($links) > self::MAX_LINKS) throw new RuntimeException('探索入口最多配置10个。');
        $normalized = [];
        foreach ($links as $index => $link) {
            if (!is_array($link)) throw new RuntimeException('第' . ((int) $index + 1) . '个探索入口格式不正确。');
            $name = trim((string) ($link['name'] ?? ''));
            $url = trim((string) ($link['url'] ?? ''));
            if ($name === '' || mb_strlen($name) > 32) throw new RuntimeException('探索入口名称不能为空且最多32个字。');
            if (mb_strlen($url) > 2048 || !filter_var($url, FILTER_VALIDATE_URL) || !preg_match('~^https?://~i', $url)) throw new RuntimeException('探索入口链接必须是有效的 http 或 https 地址。');
            $normalized[] = ['id' => (int) $index + 1, 'name' => $name, 'url' => $url];
        }
        return Db::transaction(function () use ($normalized, $adminId, $requestId, $ip): array {
            $data = ['explore_links' => json_encode($normalized, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 'updated_at' => date('Y-m-d H:i:s')];
            $row = Db::name('client_navigation_config')->where('id', 1)->find();
            if (!$row) {
                Db::name('client_navigation_config')->insert(['id' => 1] + $data);
            } else {
                Db::name('client_navigation_config')->where('id', 1)->update($data);
            }
            (new AuditService())->log($adminId, 'client_navigation.update', 'client_navigation', 1, $requestId, $ip, ['explore_links' => $normalized]);
            return ['explore_links' => $normalized, 'updated_at' => $data['updated_at']];
        });
    }

    private function decodeLinks(mixed $value): array
    {
        $decoded = is_array($value) ? $value : json_decode((string) $value, true);
        if (!is_array($decoded)) return [];
        return array_values(array_filter(array_map(static function ($link, $index): ?array {
            if (!is_array($link)) return null;
            $name = trim((string) ($link['name'] ?? ''));
            $url = trim((string) ($link['url'] ?? ''));
            if ($name === '' || $url === '' || !preg_match('~^https?://~i', $url)) return null;
            return ['id' => (int) ($link['id'] ?? $index + 1), 'name' => $name, 'url' => $url];
        }, $decoded, array_keys($decoded))));
    }
}
