<?php

require dirname(__DIR__) . '/vendor/autoload.php';

require_once dirname(__DIR__) . '/app/Service/AdminBrowserSecurity.php';

// The hidden control endpoint and network gate run before CORS, OPTIONS, static
// dispatch or ThinkPHP. A session never bypasses this per-request IP check.
$adminAccess = new \app\Service\AdminIpAccessService();
$adminAccessBody = '';
if (\app\Service\AdminIpAccessService::isControlRequest($_SERVER, $_GET)) {
    $adminAccessBody = file_get_contents('php://input', false, null, 0, 8193);
}
$adminAccessResponse = (new \app\Service\AdminIpRequestGuard($adminAccess))->handle($_SERVER, $adminAccessBody === false ? '' : $adminAccessBody, $_GET);
if ($adminAccessResponse !== null) {
    http_response_code($adminAccessResponse['status']);
    foreach ($adminAccessResponse['headers'] as $adminAccessHeader => $adminAccessValue) header($adminAccessHeader . ': ' . $adminAccessValue);
    echo $adminAccessResponse['body'];
    exit;
}

function pulseEnvValue(string $key, string $default = ''): string
{
    static $values;
    if ($values === null) {
        $values = parse_ini_file(dirname(__DIR__) . '/.env', false, INI_SCANNER_RAW) ?: [];
    }
    return trim((string) ($values[$key] ?? $default));
}

$origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
$allowedOrigin = pulseEnvValue('CORS_ORIGIN', '*');
$adminBrowserRequest = \app\Service\AdminIpAccessService::isAdminRequest($_SERVER, $_GET);
if ($adminBrowserRequest) {
    foreach (\app\Service\AdminBrowserSecurity::headers() as $name => $value) header($name . ': ' . $value);
    header('Vary: Origin');
    if (!\app\Service\AdminBrowserSecurity::allowsOrigin($_SERVER)) {
        http_response_code(403);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['ok' => false, 'error' => ['code' => 'ADMIN_ORIGIN_DENIED', 'message' => '后台不接受其他网站发起的请求。']], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $allowedOrigin = $origin !== '' ? $origin : \app\Service\AdminBrowserSecurity::origin($_SERVER);
    header('Access-Control-Allow-Credentials: true');
}
if ($allowedOrigin === '*' || ($origin !== '' && in_array($origin, array_map('trim', explode(',', $allowedOrigin)), true))) {
    header('Access-Control-Allow-Origin: ' . ($allowedOrigin === '*' ? '*' : $origin));
}
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Client-Version, X-Client-Platform, X-Pulse-CSRF, X-Pulse-Admin-Request');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Expose-Headers: X-Pulse-Request-ID, X-Pulse-Build, Server-Timing');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');

// Uploaded media always passes through authorization, including legacy URLs.
$requestPath = rawurldecode((string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH));
$resolvedPath = realpath(__DIR__ . $requestPath);
$storageRoot = realpath(__DIR__ . '/storage');
if ($storageRoot && $resolvedPath && str_starts_with($resolvedPath, $storageRoot . DIRECTORY_SEPARATOR)) {
    $requestPath = '/storage/' . str_replace(DIRECTORY_SEPARATOR, '/', substr($resolvedPath, strlen($storageRoot) + 1));
}
if (str_starts_with($requestPath, '/storage/')) {
    $_GET['path'] = substr($requestPath, strlen('/storage/'));
    $_SERVER['PATH_INFO'] = '/media';
    $_SERVER['REQUEST_URI'] = '/index.php/media?' . http_build_query($_GET);
    $_SERVER['PHP_SELF'] = '/index.php';
    $_SERVER['SCRIPT_NAME'] = '/index.php';
    $requestPath = '/index.php/media';
}
$publicRoot = realpath(__DIR__);
$staticFile = realpath(__DIR__ . $requestPath);
if ($requestPath !== '/index.php' && !str_starts_with($requestPath, '/index.php/') && !str_starts_with($requestPath, '/storage/') && $publicRoot && $staticFile && is_file($staticFile) && str_starts_with($staticFile, $publicRoot . DIRECTORY_SEPARATOR)) {
    return false;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$app = new \think\App(dirname(__DIR__) . DIRECTORY_SEPARATOR);
$http = $app->http;
$response = $http->run();
$response->send();
$http->end($response);
