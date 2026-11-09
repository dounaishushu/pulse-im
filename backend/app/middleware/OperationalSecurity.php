<?php
namespace app\middleware;
use app\Service\MediaAccessService;
use app\Service\AdminAuthService;
use think\Request;

final class OperationalSecurity
{
    public function handle(Request $request, \Closure $next)
    {
        $path = preg_replace('~^(?:index\.php/|api/)~', '', trim($request->pathinfo(), '/'));
        if (preg_match('~^(?:admin/)?(?:wallets|red-packets)(?:/|$)~i', $path)) return (new \app\controller\RetiredFinanceController())->unavailable();
        if (!preg_match('~^(?:admin/|client/|health(?:/|$)|media(?:/|$)|auth/logout(?:/|$)|notifications/devices/unregister(?:/|$))~', $path)) {
            $config = new \app\Service\ClientConfigService();
            if ($config->requiresUpgrade((string) $request->header('x-client-platform', ''), (string) $request->header('x-client-version', ''))) {
                return json(['ok' => false, 'error' => ['code' => 'UPGRADE_REQUIRED', 'message' => '当前版本已停止支持，请升级后继续使用。'], 'data' => $config->get()], 426);
            }
        }
        $media = new MediaAccessService();
        $decoded = json_decode($request->getContent(), true);
        if (is_array($decoded)) $request->withInput(json_encode($media->canonicalizePayload($decoded), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES))->withPost($media->canonicalizePayload($decoded));
        else $request->withPost($media->canonicalizePayload($request->post()));
        $response = $next($request);
        $isAdmin = str_starts_with(\app\Service\AdminBrowserSecurity::path($request->pathinfo()), 'admin/');
        $token = $isAdmin ? \app\Service\AdminBrowserSecurity::token($request) : preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', ''));
        if ($response instanceof \think\response\Json && $token !== '') {
            $hash = hash('sha256', $token);
            $kind = $isAdmin ? 'admin' : 'user';
            $response->data($media->transformPayload($response->getData(), $hash, $kind));
        }
        return $response->header(['Cache-Control' => 'no-store']);
    }
}
