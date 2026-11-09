<?php
declare(strict_types=1);
namespace app\middleware;

require_once dirname(__DIR__) . '/Service/AdminBrowserSecurity.php';
require_once dirname(__DIR__) . '/Service/AdminEntryService.php';

use app\Service\{AdminAuthService, AdminBrowserSecurity, AdminEntryService, AuditService};
use think\Request;
use think\exception\HttpResponseException;

/** Every management route is authenticated before any controller or body transformation. */
final class AdminSecurity
{
    public function __construct(private ?AdminEntryService $entries = null) {}
    public function handle(Request $request, \Closure $next)
    {
        $path = AdminBrowserSecurity::path($request->pathinfo());
        if ($path !== 'admin' && !str_starts_with($path, 'admin/')) return $next($request);
        try {
            AdminBrowserSecurity::assertRequest($request);
            $method = strtoupper($request->method());
            if ($path === 'admin/auth/entry' && $method === 'POST') return $next($request)->header(AdminBrowserSecurity::headers());
            ($this->entries ?? new AdminEntryService())->requireRequest($request);
            if (!($path === 'admin/auth/login' && $method === 'POST')) {
                $auth = new AdminAuthService($this->entries);
                $account = $auth->authenticate($request);
                if (!(($path === 'admin/auth/me' && in_array($method, ['GET', 'HEAD'], true)) || ($path === 'admin/auth/logout' && $method === 'POST'))) {
                    try { $auth->authorize($request); }
                    catch (HttpResponseException $error) {
                        if ($error->getResponse()->getCode() === 403) (new AuditService())->log((int) $account['id'], 'admin.access_denied', 'admin', (int) $account['id'], '', (string) $request->ip(), ['method' => $method, 'path' => substr($path, 0, 160)]);
                        throw $error;
                    }
                }
                if (!in_array($method, ['GET', 'HEAD', 'OPTIONS'], true)) AdminBrowserSecurity::assertCsrf($request);
            }
            return $next($request)->header(AdminBrowserSecurity::headers());
        } catch (HttpResponseException $error) {
            return $error->getResponse()->header(AdminBrowserSecurity::headers());
        }
    }
}
