<?php
namespace app\Service;

use RuntimeException;

/** Shared public endpoint validation. No credentials, queries or TLS downgrade. */
final class ClientRoutePolicy
{
    public static function endpoint(string $value, string $kind = 'api', bool $development = false): string
    {
        $value = trim($value);
        $parts = parse_url($value);
        if (!$parts || strlen($value) > 2048 || preg_match('~[\x00-\x20\x7f]~', $value) || !filter_var($value, FILTER_VALIDATE_URL) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])) throw new RuntimeException('线路地址不能包含账号、空白、查询参数或片段。');
        $host = strtolower((string) ($parts['host'] ?? ''));
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        $loopback = in_array($host, ['localhost', '127.0.0.1', '[::1]', '10.0.2.2'], true);
        $protocol = $kind === 'ws' ? 'wss' : 'https';
        if ($host === '' || ($scheme !== $protocol && !($development && $loopback && $scheme === ($kind === 'ws' ? 'ws' : 'http')))) throw new RuntimeException('正式线路必须使用 HTTPS 域名，聊天地址使用 WSS。');
        if (!$development && (filter_var($host, FILTER_VALIDATE_IP) || !str_contains($host, '.') || preg_match('~(?:^|\.)(?:localhost|example\.(?:com|org|net)|invalid|test|local)$~i', $host))) throw new RuntimeException('请配置实际线路域名。');
        if (isset($parts['port']) && ($parts['port'] < 1 || $parts['port'] > 65535)) throw new RuntimeException('线路端口无效。');
        if ($kind === 'media' && !str_ends_with(rtrim((string) ($parts['path'] ?? ''), '/'), '/storage')) throw new RuntimeException('附件入口路径必须以 /storage 结尾。');
        return rtrim($value, '/');
    }

    public static function normalize(array $row, bool $development = false): array
    {
        $api = self::endpoint((string) ($row['url'] ?? $row['api_url'] ?? ''), 'api', $development);
        $p = parse_url($api);
        $origin = $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
        $ws = (string) ($row['ws_url'] ?? '');
        $media = (string) ($row['media_url'] ?? '');
        return array_merge($row, [
            'url' => $api,
            'api_url' => $api,
            'ws_url' => self::endpoint($ws !== '' ? $ws : preg_replace('~^http~', 'ws', $origin) . '/ws', 'ws', $development),
            'media_url' => self::endpoint($media !== '' ? $media : $origin . '/storage', 'media', $development),
        ]);
    }
}
