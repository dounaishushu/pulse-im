<?php
namespace app\Service;

require_once __DIR__ . '/ClientRoutePolicy.php';

use RuntimeException;

/** The exact base64 payload bytes are signed, independent of client JSON encoders. */
final class ClientRouteManifest
{
    public static function sign(array $payload, string $privatePem): array
    {
        $key = openssl_pkey_get_private($privatePem);
        $details = $key ? openssl_pkey_get_details($key) : false;
        if (!$details || ($details['type'] ?? null) !== OPENSSL_KEYTYPE_EC || ($details['ec']['curve_name'] ?? '') !== 'prime256v1') throw new RuntimeException('线路签名需要 P-256 私钥。');
        $bytes = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        if (strlen($bytes) > 262144) throw new RuntimeException('线路清单超过允许大小。');
        if (!openssl_sign($bytes, $signature, $key, OPENSSL_ALGO_SHA256)) throw new RuntimeException('无法签名线路清单。');
        $der = base64_decode(preg_replace('~-----[^-]+-----|\s~', '', $details['key']), true);
        return ['algorithm' => 'ES256-DER', 'key_id' => substr(hash('sha256', $der), 0, 24), 'payload' => base64_encode($bytes), 'signature' => base64_encode($signature)];
    }

    public function get(): array
    {
        $file = (string) env('ROUTE_MANIFEST_FILE', '');
        $keyFile = (string) env('ROUTE_MANIFEST_PRIVATE_KEY_FILE', '');
        if ($keyFile === '') {
            if ($file === '' || !is_file($file) || filesize($file) > 393216) throw new RuntimeException('线路签名服务尚未配置。');
            $envelope = json_decode(file_get_contents($file), true, 32, JSON_THROW_ON_ERROR);
            if (!is_array($envelope) || !isset($envelope['key_id'], $envelope['payload'], $envelope['signature'])) throw new RuntimeException('线路清单文件无效。');
            return $envelope;
        }
        if (!is_file($keyFile) || !is_readable($keyFile) || filesize($keyFile) > 16384) throw new RuntimeException('线路签名密钥不可用。');
        $cluster = (string) env('ROUTE_CLUSTER_ID', '');
        if (!preg_match('~^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$~D', $cluster)) throw new RuntimeException('请配置线路所属业务标识。');
        [$revision, $routes] = \think\facade\Db::transaction(function (): array {
            $state = \think\facade\Db::name('client_route_state')->where('id', 1)->lock(true)->find();
            if (!$state) throw new RuntimeException('线路版本状态不可用。');
            return [(int) $state['revision'], array_values(array_filter((new ClientRouteService())->enabled(), static fn ($r) => $r['valid_for_failover'] ?? false))];
        });
        if (!$routes) {
            $routes[] = ClientRoutePolicy::normalize(['id' => 0, 'name' => '主线路', 'url' => (string) env('ROUTE_DEFAULT_API_URL', ''), 'sort' => 0]);
        }
        if (count($routes) > 32) throw new RuntimeException('启用线路最多32条。');
        $issued = time();
        $discovery = array_values(array_unique(array_map(fn ($route) => $route['url'] . '/client/route-manifest', $routes)));
        $extra = json_decode((string) env('ROUTE_DISCOVERY_URLS', '[]'), true, 16, JSON_THROW_ON_ERROR);
        if (!is_array($extra) || !array_is_list($extra)) throw new RuntimeException('独立配置入口必须为 JSON 数组。');
        foreach ($extra as $url) $discovery[] = ClientRoutePolicy::endpoint((string) $url, 'discovery');
        $discovery = array_values(array_unique($discovery));
        if (count($discovery) > 32) throw new RuntimeException('配置入口最多32个。');
        return self::sign(['version' => 1, 'cluster_id' => $cluster, 'revision' => $revision, 'issued_at' => $issued, 'expires_at' => $issued + 604800, 'routes' => array_map(static fn ($r) => array_intersect_key($r, array_flip(['id', 'name', 'url', 'api_url', 'ws_url', 'media_url', 'sort'])), $routes), 'discovery_urls' => $discovery], file_get_contents($keyFile));
    }
}
