<?php
namespace app\controller;
use app\Service\AdminAuthService;
use app\Service\AdminBrowserSecurity;
use app\Service\AdminEntryService;
use think\Request;

final class AdminAuthController
{
    public function __construct(private ?AdminEntryService $entries = null) {}
    public function entry(Request $request)
    {
        if (strlen($request->getContent()) > 256) AdminBrowserSecurity::deny('NOT_FOUND', 'Not Found', 404);
        $data = json_decode($request->getContent(), true);
        if (!is_array($data) || array_keys($data) !== ['token'] || !is_string($data['token'])) AdminBrowserSecurity::deny('NOT_FOUND', 'Not Found', 404);
        $entries = $this->entries ?? new AdminEntryService();
        $cookie = $entries->exchange($request, $data['token']);
        $response = json(['ok' => true, 'data' => ['accepted' => true]])->header(AdminBrowserSecurity::headers() + ['Set-Cookie' => $cookie]);
        $session = AdminBrowserSecurity::cookieToken($request);
        if ($session !== '') {
            $account = (new AdminAuthService($entries))->byHash(hash('sha256', $session));
            $entry = $entries->resolveToken($data['token']);
            // A new entrance must not inherit another account's browser session.
            // Keep a valid session when reopening the same account's entrance.
            if (!$account || !$entry || (int) $account['id'] !== (int) $entry['admin_id']) {
                // ThinkPHP's header() accepts one value; its cookie API appends
                // the separate expiry header after the new entrance cookie.
                $response->cookie(AdminBrowserSecurity::cookieName($request), '', [
                    'expire' => -3600, 'path' => '/', 'domain' => '',
                    'secure' => AdminBrowserSecurity::secure($request->server()),
                    'httponly' => true, 'samesite' => 'Strict',
                ]);
            }
        }
        return $response;
    }
    public function login(Request $request)
    {
        $data = json_decode($request->getContent(), true) ?: $request->post();
        if (!is_array($data) || !is_string($data['username'] ?? null) || !is_string($data['password'] ?? null)) AdminBrowserSecurity::deny('ADMIN_AUTH_REQUIRED', '管理员账号或密码错误。', 401);
        $cookie = ($data['session_mode'] ?? '') === 'cookie';
        if ($cookie) {
            AdminBrowserSecurity::assertRequest($request);
            if ($request->header('x-pulse-admin-request', '') !== '1') AdminBrowserSecurity::deny('ADMIN_ORIGIN_DENIED', '请从管理后台登录页面提交。', 403);
        }
        $result = (new AdminAuthService($this->entries))->login($data['username'], $data['password'], (string) $request->ip(), $request);
        $headers = AdminBrowserSecurity::headers();
        if ($cookie) {
            $token = $result['access_token']; unset($result['access_token']);
            $headers['Set-Cookie'] = AdminBrowserSecurity::cookieHeader($request, $token);
            $result['csrf_token'] = AdminBrowserSecurity::csrf($token); $result['session_mode'] = 'cookie';
        }
        return json(['ok' => true, 'data' => $result])->header($headers);
    }
    public function me(Request $request) {
        $data = ['admin' => (new AdminAuthService($this->entries))->authenticate($request)];
        if ($request->header('authorization', '') === '' && ($token = AdminBrowserSecurity::cookieToken($request)) !== '') $data['csrf_token'] = AdminBrowserSecurity::csrf($token);
        return json(['ok' => true, 'data' => $data])->header(AdminBrowserSecurity::headers());
    }
    public function logout(Request $request) {
        (new AdminAuthService($this->entries))->logout($request);
        return json(['ok' => true, 'data' => ['status' => 'logged_out']])->header(AdminBrowserSecurity::headers() + ['Set-Cookie' => AdminBrowserSecurity::cookieHeader($request)]);
    }
}
