<?php
declare(strict_types=1);

namespace app\Service;

require_once __DIR__ . '/AdminBrowserSecurity.php';
require_once __DIR__ . '/AdminEntryService.php';

/** The admin host serves only this manifest, and checks the network on every request. */
final class AdminAssetGateway
{
    private const ASSETS = [
        '/' => ['index.html', 'text/html; charset=utf-8'],
        '/index.html' => ['index.html', 'text/html; charset=utf-8'],
        '/entry/' => ['entry.html', 'text/html; charset=utf-8'],
        '/entry.js' => ['src/entry.js', 'application/javascript; charset=utf-8'],
        '/src/style.css' => ['src/style.css', 'text/css; charset=utf-8'],
        '/src/components.css' => ['src/components.css', 'text/css; charset=utf-8'],
        '/src/dispatch-tasks.css' => ['src/dispatch-tasks.css', 'text/css; charset=utf-8'],
        '/src/app.js' => ['src/app.js', 'application/javascript; charset=utf-8'],
        '/src/dispatch-tasks.js' => ['src/dispatch-tasks.js', 'application/javascript; charset=utf-8'],
        '/src/registration-map.js' => ['src/registration-map.js', 'application/javascript; charset=utf-8'],
        '/src/work-records.js' => ['src/work-records.js', 'application/javascript; charset=utf-8'],
        '/src/work-records.css' => ['src/work-records.css', 'text/css; charset=utf-8'],
        '/src/maintenance.js' => ['src/maintenance.js', 'application/javascript; charset=utf-8'],
        '/src/maintenance.css' => ['src/maintenance.css', 'text/css; charset=utf-8'],
    ];

    public function __construct(private AdminIpAccessService $access, private ?string $assetRoot = null, private ?AdminEntryService $entries = null) {}

    /** @return array{status:int,headers:array,body:string,file?:string} */
    public function handle(array $server): array
    {
        try {
            if (!$this->access->allows($server)) return AdminIpAccessService::notFoundResponse();
            $method = strtoupper((string) ($server['REQUEST_METHOD'] ?? 'GET'));
            if (!in_array($method, ['GET', 'HEAD'], true)) return AdminIpAccessService::notFoundResponse();
            $uri = (string) ($server['REQUEST_URI'] ?? '/');
            if (!str_starts_with($uri, '/') || preg_match('/[\x00-\x20\x7f\\\\]/', $uri)) return AdminIpAccessService::notFoundResponse();
            // HTTP on the production admin host is also checked before redirecting to HTTPS.
            $httpsHost = (string) ($server['ADMIN_HTTPS_HOST'] ?? '');
            if ($httpsHost !== '') {
                if (!preg_match('/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/iD', $httpsHost)) return AdminIpAccessService::notFoundResponse();
                return ['status' => 308, 'body' => '', 'headers' => ['Location' => 'https://' . $httpsHost . $uri, 'Cache-Control' => 'no-store']];
            }
            // No SPA fallback for unknown paths: previews, tests, dotfiles and backups stay private.
            $path = (string) parse_url($uri, PHP_URL_PATH);
            $entries = $this->entries ?? new AdminEntryService();
            if (!in_array($path, ['/entry/', '/entry.js'], true) && $entries->enabled() && !$entries->resolveServer($server)) return AdminIpAccessService::notFoundResponse();
            $asset = self::ASSETS[$path] ?? null;
            if (!$asset) return AdminIpAccessService::notFoundResponse();
            $root = realpath($this->assetRoot ?? dirname(__DIR__, 3) . '/admin');
            $file = $root ? realpath($root . '/' . $asset[0]) : false;
            if (!$root || !$file || !is_file($file) || !str_starts_with($file, $root . DIRECTORY_SEPARATOR)) return AdminIpAccessService::notFoundResponse();
            return ['status' => 200, 'body' => '', 'file' => $file, 'headers' => AdminBrowserSecurity::headers() + [
                'Content-Type' => $asset[1], 'Content-Length' => (string) filesize($file),
                'Cache-Control' => 'private, no-store', 'Pragma' => 'no-cache',
                'X-Content-Type-Options' => 'nosniff', 'X-Frame-Options' => 'DENY',
                'Referrer-Policy' => 'no-referrer',
            ]];
        } catch (\Throwable) {
            return AdminIpAccessService::notFoundResponse();
        }
    }
}
