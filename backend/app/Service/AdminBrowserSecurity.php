<?php
declare(strict_types=1);
namespace app\Service;

use think\Request;
use think\exception\HttpResponseException;

/** Browser credentials never enter Web Storage; ordinary user auth is separate. */
final class AdminBrowserSecurity
{
    public static function path(string $path): string
    {
        return strtolower((string) preg_replace('~^(?:(?:index\.php|api)/)+~i', '', trim($path, '/')));
    }

    public static function headers(): array
    {
        return [
            'Cache-Control' => 'private, no-store', 'Pragma' => 'no-cache',
            'X-Content-Type-Options' => 'nosniff', 'X-Frame-Options' => 'DENY',
            'Referrer-Policy' => 'no-referrer',
            'Permissions-Policy' => 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
            // Existing layouts use computed inline styles; scripts and handlers do not.
            'Content-Security-Policy' => "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        ];
    }

    public static function secure(array $server): bool
    {
        return in_array(strtolower((string) ($server['HTTPS'] ?? '')), ['on', '1'], true)
            || strtolower((string) ($server['REQUEST_SCHEME'] ?? '')) === 'https';
    }

    public static function origin(array $server): string
    {
        $host = strtolower((string) ($server['HTTP_HOST'] ?? $server['SERVER_NAME'] ?? ''));
        if (!preg_match('~^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[::1\])(?::[0-9]{1,5})?$~D', $host)) return '';
        return (self::secure($server) ? 'https://' : 'http://') . $host;
    }

    public static function allowsOrigin(array $server): bool
    {
        if (strtolower((string) ($server['HTTP_SEC_FETCH_SITE'] ?? '')) === 'cross-site') return false;
        $origin = (string) ($server['HTTP_ORIGIN'] ?? '');
        if ($origin === '' || (self::origin($server) !== '' && hash_equals(self::origin($server), $origin))) return true;
        $local = in_array((string) ($server['REMOTE_ADDR'] ?? ''), ['127.0.0.1', '::1'], true)
            && in_array(parse_url(self::origin($server), PHP_URL_HOST), ['127.0.0.1', 'localhost'], true);
        return $local && in_array($origin, ['http://127.0.0.1:8100', 'http://localhost:8100'], true);
    }

    public static function assertRequest(Request $request): void
    {
        $server = $request->server();
        if (!self::allowsOrigin($server)) self::deny('ADMIN_ORIGIN_DENIED', '后台不接受其他网站发起的请求。', 403);
        // Local HTTP integration tests are allowed only from a local peer and Host.
        $local = in_array((string) ($server['REMOTE_ADDR'] ?? ''), ['127.0.0.1', '::1'], true)
            && in_array(parse_url(self::origin($server), PHP_URL_HOST), ['127.0.0.1', 'localhost', '[::1]'], true);
        if (!self::secure($server) && !$local) self::deny('ADMIN_HTTPS_REQUIRED', '请通过 HTTPS 打开管理后台。', 426);
    }

    public static function cookieName(Request $request): string
    {
        return self::secure($request->server()) ? '__Host-pulse_admin' : 'pulse_admin_local';
    }

    public static function cookieToken(Request $request): string
    {
        $value = $request->cookie(self::cookieName($request), '');
        return is_string($value) && preg_match('/^[a-f0-9]{64}$/D', $value) ? $value : '';
    }

    public static function token(Request $request): string
    {
        $authorization = (string) $request->header('authorization', '');
        if ($authorization !== '') return preg_match('/^Bearer\s+([A-Za-z0-9._~-]{1,512})$/iD', $authorization, $match) ? $match[1] : '';
        return self::cookieToken($request);
    }

    public static function csrf(string $token): string { return hash('sha256', "pulse-admin-csrf-v1\0" . $token); }

    public static function assertCsrf(Request $request): void
    {
        // Explicit bearer clients have no browser ambient credentials.
        if ((string) $request->header('authorization', '') !== '') return;
        $token = self::cookieToken($request);
        $proof = (string) $request->header('x-pulse-csrf', '');
        if ($token === '' || !hash_equals(self::csrf($token), $proof)) self::deny('ADMIN_CSRF_REQUIRED', '安全验证已过期，请刷新后台后重试。', 403);
    }

    public static function cookieHeader(Request $request, string $token = ''): string
    {
        return self::cookieName($request) . '=' . $token . '; Path=/; HttpOnly; SameSite=Strict'
            . (self::secure($request->server()) ? '; Secure' : '') . ($token === '' ? '; Max-Age=0' : '');
    }

    public static function deny(string $code, string $message, int $status): never
    {
        throw new HttpResponseException(json(['ok' => false, 'error' => ['code' => $code, 'message' => $message]], $status)->header(self::headers()));
    }
}
