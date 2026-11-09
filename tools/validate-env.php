<?php
declare(strict_types=1);
$paths = array_values(array_filter(array_slice($argv, 1), static fn ($arg) => !str_starts_with($arg, '--')));
$path = $paths[0] ?? dirname(__DIR__) . '/backend/.env';
if (!is_file($path)) { fwrite(STDERR, "Missing env file: {$path}\n"); exit(2); }
$values = parse_ini_file($path, false, INI_SCANNER_RAW);
if ($values === false) { fwrite(STDERR, "Unable to parse env file\n"); exit(2); }
$value = static fn (string $key, string $default = ''): string => trim((string) ($values[$key] ?? $default));
$production = in_array('--production', $argv, true) || strtolower($value('APP_ENV')) === 'production';
$errors = []; $warnings = [];
foreach (['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'MEDIA_SIGNING_KEY', 'FILE_BASE_URL', 'CORS_ORIGIN'] as $key) if ($value($key) === '') $errors[] = "{$key} is empty";
$weak = static fn (string $secret): bool => strlen($secret) < 32 || preg_match('/change.?me|replace|example|your.secret/i', $secret) === 1;
if ($weak($value('MEDIA_SIGNING_KEY'))) $errors[] = 'MEDIA_SIGNING_KEY must be a unique random value of at least 32 characters';
foreach (['pdo_mysql', 'mbstring', 'fileinfo', 'openssl', 'curl'] as $extension) if (!extension_loaded($extension)) $errors[] = "PHP extension {$extension} is missing";
$driver = $value('REALTIME_DRIVER', 'database');
if (!in_array($driver, ['database', 'redis'], true)) $errors[] = 'REALTIME_DRIVER must be database or redis';
if ($driver === 'redis' && $value('REDIS_HOST') === '') $errors[] = 'REDIS_HOST is required';
if ((int) $value('WEBSOCKET_WORKERS', '1') < 1) $errors[] = 'WEBSOCKET_WORKERS must be positive';
if (!preg_match('/^[0-9]+$/D', $value('WEBSOCKET_POLL_INTERVAL_MS', '100')) || (int) $value('WEBSOCKET_POLL_INTERVAL_MS', '100') < 50 || (int) $value('WEBSOCKET_POLL_INTERVAL_MS', '100') > 1000) $errors[] = 'WEBSOCKET_POLL_INTERVAL_MS must be between 50 and 1000';
$dispatchWorkers = $value('DISPATCH_WORKERS', '1');
if (!ctype_digit($dispatchWorkers) || (int) $dispatchWorkers < 1 || (int) $dispatchWorkers > 64) $errors[] = 'DISPATCH_WORKERS must be an integer from 1 to 64';
// IP checks may be explicitly disabled; missing configuration retains the existing gate.
if (!in_array(strtolower($value('ADMIN_IP_CHECK_ENABLED', 'true')), ['true', 'false'], true)) $errors[] = 'ADMIN_IP_CHECK_ENABLED must be true or false';
$packAdminIp = static function (string $ip): string|false {
    if (!filter_var($ip, FILTER_VALIDATE_IP)) return false;
    $packed = inet_pton($ip);
    if (strlen($packed) === 16 && substr($packed, 0, 12) === str_repeat("\0", 10) . "\xff\xff") $packed = substr($packed, 12);
    return $packed;
};
foreach (preg_split('/[\s,;]+/', $value('ADMIN_IP_ALLOWLIST'), -1, PREG_SPLIT_NO_EMPTY) as $ip) {
    $packed = $packAdminIp($ip);
    if ($packed === false || in_array($packed, [str_repeat("\0", 4), str_repeat("\0", 16), str_repeat("\xff", 4)], true)
        || (strlen($packed) === 4 && ord($packed[0]) >= 224 && ord($packed[0]) <= 239)
        || (strlen($packed) === 16 && ord($packed[0]) === 255)) $errors[] = 'ADMIN_IP_ALLOWLIST must contain exact non-multicast IPv4/IPv6 addresses';
}
foreach (preg_split('/[\s,;]+/', $value('ADMIN_TRUSTED_PROXIES'), -1, PREG_SPLIT_NO_EMPTY) as $proxy) {
    [$network, $prefix] = array_pad(explode('/', $proxy, 2), 2, null);
    $packed = $packAdminIp($network);
    $mapped = $packed !== false && strlen(inet_pton($network)) === 16 && strlen($packed) === 4;
    if ($packed === false || ($prefix !== null && (!ctype_digit($prefix) || (int) $prefix < ($mapped ? 97 : 1) || (int) $prefix > (str_contains($network, ':') ? 128 : 32)))) $errors[] = 'ADMIN_TRUSTED_PROXIES must contain explicit proxy IPs or non-global CIDRs';
}
$controlKey = $value('ADMIN_IP_CONTROL_KEY');
if ($controlKey !== '' && ($weak($controlKey) || strlen($controlKey) > 256)) $errors[] = 'ADMIN_IP_CONTROL_KEY must be a separate random secret of 32..256 characters';
$controlWindow = $value('ADMIN_IP_CONTROL_WINDOW', '120');
if (!ctype_digit($controlWindow) || (int) $controlWindow < 60 || (int) $controlWindow > 300) $errors[] = 'ADMIN_IP_CONTROL_WINDOW must be 60..300 seconds';
if ($value('TELEGRAM_BOT_TOKEN') !== '' || $value('TELEGRAM_ADMIN_USER_IDS') !== '') {
    require_once dirname(__DIR__) . '/backend/vendor/autoload.php';
    foreach (\app\Service\AdminIpTelegramBot::configErrors($values + ['APP_ENV' => $production ? 'production' : 'development']) as $name) $errors[] = "Invalid Telegram IP bot setting: {$name}";
}
if ($production) {
    if (strtolower($value('APP_ENV')) !== 'production') $errors[] = 'APP_ENV must be production so strict operational health checks are enabled';
    foreach (['gd', 'zip'] as $extension) if (!extension_loaded($extension)) $errors[] = $extension === 'gd'
        ? 'PHP extension gd is required for registration captcha rendering and production image imports'
        : 'PHP extension zip is required for production workbook imports';
    if (strtolower($value('APP_DEBUG', 'true')) !== 'false') $errors[] = 'APP_DEBUG must be false in production';
    if (strtolower($value('DB_USER')) === 'root') $errors[] = 'DB_USER must be a dedicated least-privilege account';
    if (strlen($value('DB_PASSWORD')) < 16 || preg_match('/^(?:root|password|change-me)/i', $value('DB_PASSWORD'))) $errors[] = 'DB_PASSWORD must be unique and at least 16 characters';
    $secureUrl = static function (string $url): bool {
        $parts = parse_url($url); $host = strtolower((string) ($parts['host'] ?? ''));
        return filter_var($url, FILTER_VALIDATE_URL) && ($parts['scheme'] ?? '') === 'https' && !isset($parts['user']) && str_contains($host, '.') && !preg_match('/(?:^|\.)(?:localhost|local|test|invalid|example|example\.(?:com|net|org))$/D', $host) && !filter_var(trim($host, '[]'), FILTER_VALIDATE_IP);
    };
    if (!$secureUrl($value('FILE_BASE_URL'))) $errors[] = 'FILE_BASE_URL must use the real production HTTPS domain';
    if (rtrim((string) parse_url($value('FILE_BASE_URL'), PHP_URL_PATH), '/') !== '/storage') $errors[] = 'FILE_BASE_URL must end with /storage to use the protected media route';
    foreach (explode(',', $value('CORS_ORIGIN')) as $origin) if (!$secureUrl(trim($origin)) || (parse_url(trim($origin), PHP_URL_PATH) ?: '/') !== '/') $errors[] = 'CORS_ORIGIN must contain only trusted HTTPS origins';
    if ($driver === 'redis' && $value('REDIS_PASSWORD') === '') $errors[] = 'REDIS_PASSWORD is required for production Redis';
    $fcm = $value('FCM_SERVICE_ACCOUNT_FILE');
    if ($fcm === '' || !is_file($fcm)) $errors[] = 'FCM_SERVICE_ACCOUNT_FILE is missing (Android background push is not ready)';
    else {
        $account = json_decode(file_get_contents($fcm), true);
        if (!$account || empty($account['project_id']) || !filter_var($account['client_email'] ?? '', FILTER_VALIDATE_EMAIL) || !openssl_pkey_get_private($account['private_key'] ?? '')) $errors[] = 'FCM service account is invalid';
    }
    if ($value('APNS_KEY_FILE') === '' || !is_file($value('APNS_KEY_FILE'))) $errors[] = 'APNS_KEY_FILE is missing (iOS background push is not ready)';
    elseif (!openssl_pkey_get_private(file_get_contents($value('APNS_KEY_FILE')))) $errors[] = 'APNS key is invalid';
    foreach (['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC'] as $key) if ($value($key) === '') $errors[] = "{$key} is missing";
    if ($value('APNS_ENV', 'production') !== 'production') $errors[] = 'APNS_ENV must be production for a release';
    if (function_exists('curl_version') && !(curl_version()['features'] & CURL_VERSION_HTTP2)) $errors[] = 'Production APNs needs a PHP cURL build with HTTP/2';
    if ($value('FILE_DISK', 'local') !== 'local') $errors[] = 'Only FILE_DISK=local is currently implemented; mount shared storage at public/storage for multiple nodes';
    $warnings[] = 'Passing configuration validation does not certify TLS, delivery, backup restore, capacity or monitoring; run deployment acceptance checks.';
} elseif ($value('FCM_SERVICE_ACCOUNT_FILE') === '' || $value('APNS_KEY_FILE') === '') $warnings[] = 'Mobile push credentials are not configured; delivery is unverified';
if ($value('FILE_DISK', 'local') === 'local') $warnings[] = 'Uploads require the protected Nginx /storage route and a backup; multiple nodes require a shared volume';
if ($errors) { fwrite(STDERR, "Configuration invalid:\n- " . implode("\n- ", array_unique($errors)) . "\n"); exit(1); }
echo "Configuration valid (" . ($production ? 'production' : 'development') . ")\n";
foreach ($warnings as $warning) echo "Warning: {$warning}\n";
