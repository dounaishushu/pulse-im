<?php
namespace app\Service;

/** Baidu IP location over HTTPS. Credentials and upstream responses stay on the server. */
final class BaiduIpLocationProvider
{
    private const ENDPOINT = 'https://api.map.baidu.com/location/ip';
    private const MAX_RESPONSE_BYTES = 8192;
    private array $errors = [];
    private array $diagnostics = [];

    /** Safe machine codes only: never expose cURL errors, URLs, credentials or upstream text. */
    public function errors(): array { return $this->errors; }
    public function diagnostics(): array { return $this->diagnostics; }

    public static function configured(): bool { return self::apiKey() !== ''; }

    private static function apiKey(): string
    {
        // The updater installs this private file outside backend/public. An
        // environment key remains available for installations managed by hand.
        $file = dirname(__DIR__, 2) . '/.baidu-map-ak';
        if (file_exists($file) || is_link($file)) {
            if (is_link($file) || !is_file($file) || !is_readable($file) || filesize($file) > 256) return '';
            $raw = file_get_contents($file);
            return is_string($raw) ? trim($raw) : '';
        }
        return trim((string) env('BAIDU_MAP_AK', ''));
    }

    public function lookup(array $ips): array
    {
        $this->errors = [];
        $this->diagnostics = [];
        $normalized = [];
        foreach ($ips as $input) if (is_string($input) && filter_var($input, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false) $normalized[inet_ntop(inet_pton($input))] = true;
        $ips = array_keys($normalized);
        if ($ips === [] || count($ips) > AdminIpLocationService::BATCH_SIZE) return [];
        $key = self::apiKey();
        if ($key === '' || !function_exists('curl_multi_init')) {
            foreach ($ips as $ip) $this->fail($ip, $key === '' ? 'provider_not_configured' : 'curl_unavailable');
            return [];
        }
        $caBundle = $this->caBundle();
        if ($caBundle !== null && (preg_match('~^[a-z][a-z0-9+.-]*://~i', $caBundle) || !is_file($caBundle) || !is_readable($caBundle))) {
            foreach ($ips as $ip) $this->fail($ip, 'ca_bundle_unavailable');
            return [];
        }
        // Retry transient failures once, within a total six-second request budget.
        // IPv4 fallback changes only the Baidu connection, never the queried IP.
        $locations = []; $pending = $ips; $deadline = microtime(true) + 6.2;
        for ($attempt = 0; $attempt < 2 && $pending !== []; $attempt++) {
            $timeout = min($attempt === 0 ? 4000 : 2000, (int) floor(($deadline - microtime(true)) * 1000));
            if ($timeout < 250) break;
            $responses = $this->requestBatch($pending, $key, $caBundle, $attempt > 0, $timeout);
            $retry = [];
            foreach ($responses as $ip => $response) {
                unset($this->errors[$ip], $this->diagnostics[$ip]);
                $error = $response['curl_code']; $status = $response['http_status'];
                if ($error !== 0 || $status !== 200) $this->fail($ip, $this->transportError($error, $status), $response);
                else {
                    $location = $this->decode($response['body'], $ip);
                    if ($location !== null) { $locations[$ip] = $location; continue; }
                    if (!isset($this->errors[$ip])) $this->fail($ip, 'provider_response_invalid', $response);
                }
                if ($this->retryable($ip)) $retry[] = $ip;
            }
            $pending = $retry;
        }
        return $locations;
    }

    private function requestBatch(array $ips, string $key, ?string $caBundle, bool $ipv4, int $timeout): array
    {
        $multi = curl_multi_init(); $handles = $bodies = $locations = [];
        try {
            foreach ($ips as $input) {
                $ip = inet_ntop(inet_pton($input));
                // Always send the requested user IP. An omitted IP would locate
                // the API server instead of the account being inspected.
                $url = self::ENDPOINT . '?' . http_build_query([
                    'ak' => $key, 'ip' => $ip, 'coor' => 'bd09ll',
                ], '', '&', PHP_QUERY_RFC3986);
                $handle = curl_init($url); $bodies[$ip] = '';
                curl_setopt_array($handle, [
                    CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT_MS => min(2000, $timeout), CURLOPT_TIMEOUT_MS => $timeout,
                    CURLOPT_NOSIGNAL => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                    CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
                    CURLOPT_HTTPHEADER => ['Accept: application/json'], CURLOPT_USERAGENT => 'PulseIM-BaiduIPLocation/1.0',
                    CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use ($ip, &$bodies): int {
                        if (strlen($bodies[$ip]) + strlen($chunk) > self::MAX_RESPONSE_BYTES) return 0;
                        $bodies[$ip] .= $chunk;
                        return strlen($chunk);
                    },
                ]);
                if ($caBundle !== null) curl_setopt($handle, CURLOPT_CAINFO, $caBundle);
                if ($ipv4) curl_setopt($handle, CURLOPT_IPRESOLVE, CURL_IPRESOLVE_V4);
                if (PHP_OS_FAMILY === 'Windows' && defined('CURLSSLOPT_NATIVE_CA')) curl_setopt($handle, CURLOPT_SSL_OPTIONS, CURLSSLOPT_NATIVE_CA);
                $handles[$ip] = $handle; curl_multi_add_handle($multi, $handle);
            }
            $deadline = microtime(true) + $timeout / 1000 + 0.1;
            do {
                $code = curl_multi_exec($multi, $running);
                if (!$running || $code !== CURLM_OK || microtime(true) >= $deadline) break;
                if (curl_multi_select($multi, 0.1) === -1) usleep(1000);
            } while (true);
            // A multi handle can report errno=0 and HTTP=200 before it finishes.
            // Read completion results so partial/time-limited bodies cannot pass.
            $completed = [];
            while (($message = curl_multi_info_read($multi)) !== false) {
                if (($message['msg'] ?? null) === CURLMSG_DONE) $completed[spl_object_id($message['handle'])] = (int) $message['result'];
            }
            foreach ($handles as $ip => $handle) {
                $error = $completed[spl_object_id($handle)] ?? CURLE_OPERATION_TIMEDOUT;
                if ($code !== CURLM_OK && $error === 0) $error = CURLE_RECV_ERROR;
                $locations[$ip] = ['curl_code' => $error, 'http_status' => (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE), 'body' => $bodies[$ip]];
            }
            return $locations;
        } finally {
            foreach ($handles as $handle) { curl_multi_remove_handle($multi, $handle); curl_close($handle); }
            curl_multi_close($multi);
        }
    }

    private function fail(string $ip, string $code, array $details = []): void
    {
        $this->errors[$ip] = $code;
        $this->diagnostics[$ip] = IpLocationFailure::describe($code, $details);
    }

    private function retryable(string $ip): bool
    {
        $details = $this->diagnostics[$ip] ?? [];
        if (isset($details['provider_status'])) return $details['provider_status'] === 1;
        if (($details['curl_code'] ?? 0) !== 0) return in_array($details['curl_code'], [CURLE_COULDNT_RESOLVE_HOST, CURLE_COULDNT_CONNECT, CURLE_OPERATION_TIMEDOUT, CURLE_SSL_CONNECT_ERROR, CURLE_GOT_NOTHING, CURLE_SEND_ERROR, CURLE_RECV_ERROR, 16, 92], true);
        return in_array($details['http_status'] ?? 0, [500, 502, 503, 504], true);
    }

    private function caBundle(): ?string
    {
        $configured = trim((string) env('BAIDU_MAP_CA_BUNDLE', env('IP_API_CA_BUNDLE', '')));
        if ($configured !== '') return $configured;
        // Honour the operator's PHP trust store. Older Windows cURL/OpenSSL builds
        // define CURLSSLOPT_NATIVE_CA but cannot actually read the Windows store.
        if (trim((string) ini_get('curl.cainfo')) !== '') return null;
        $opensslBundle = trim((string) ini_get('openssl.cafile'));
        return $opensslBundle !== '' ? $opensslBundle : dirname(__DIR__, 2) . '/config/certs/mozilla-ca-bundle.crt';
    }

    private function transportError(int $error, int $status): string
    {
        if (in_array($error, [CURLE_SSL_CACERT, CURLE_SSL_CACERT_BADFILE], true)) return 'tls_verification_failed';
        if ($error === CURLE_WRITE_ERROR) return 'provider_response_invalid';
        if ($error === CURLE_OPERATION_TIMEDOUT) return 'provider_timeout';
        if ($error === CURLE_COULDNT_RESOLVE_HOST) return 'provider_dns_failed';
        if ($error !== 0) return 'provider_connection_failed';
        if ($status === 401 || $status === 403) return 'provider_auth_failed';
        if ($status === 429) return 'provider_rate_limited';
        return 'provider_unavailable';
    }

    /** Only documented JSON scalars are mapped; never persist raw upstream text. */
    private function decode(string $raw, string $ip): ?array
    {
        if ($raw === '' || strlen($raw) > self::MAX_RESPONSE_BYTES) return null;
        try { $data = json_decode($raw, true, 8, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { return null; }
        if (!is_array($data) || !in_array($data['status'] ?? null, [0, '0'], true)) {
            if (is_array($data) && (is_int($data['status'] ?? null) || is_string($data['status'] ?? null))) {
                $error = match ((string) $data['status']) {
                    '210' => 'provider_ip_not_allowed',
                    '211' => 'provider_signature_failed',
                    '203', '220', '230', '102' => 'provider_key_type_invalid',
                    '240' => 'provider_service_disabled',
                    '1001' => 'provider_ipv6_unavailable',
                    '302', '401' => 'provider_rate_limited',
                    '101', '200', '201', '202', '250', '251', '252' => 'provider_auth_failed',
                    default => 'provider_unavailable',
                };
                $value = (string) $data['status'];
                $this->fail($ip, $error, preg_match('/^[1-9][0-9]{0,3}$/D', $value) ? ['provider_status' => (int) $value] : []);
            }
            return null;
        }
        if (!is_string($data['address'] ?? null) || !is_array($data['content'] ?? null)
            || !is_array($data['content']['address_detail'] ?? null)) return null;
        $countryCode = strtoupper(trim(explode('|', $data['address'])[0]));
        if (!preg_match('/^[A-Z]{2}$/D', $countryCode)) return null;
        $detail = $data['content']['address_detail'];
        foreach (['province', 'city'] as $name) if (!is_string($detail[$name] ?? null) || !mb_check_encoding($detail[$name], 'UTF-8')) return null;
        $clean = static fn (string $text, int $limit): string => mb_substr(trim(preg_replace('/[\x00-\x1F\x7F]/u', ' ', $text)), 0, $limit);
        $region = $clean($detail['province'], 100); $city = $clean($detail['city'], 100);
        // Do not invent an address from a country code alone or use coordinates
        // of a city centre as the person's precise physical location.
        if ($region === '' && $city === '') return null;
        $country = ['CN' => '中国', 'HK' => '中国香港', 'MO' => '中国澳门', 'TW' => '中国台湾',
            'US' => '美国', 'CA' => '加拿大', 'GB' => '英国', 'AU' => '澳大利亚', 'JP' => '日本',
            'KR' => '韩国', 'SG' => '新加坡', 'DE' => '德国', 'FR' => '法国', 'RU' => '俄罗斯'][$countryCode] ?? $countryCode;
        $adcode = $detail['adcode'] ?? '';
        $regionCode = (is_string($adcode) || is_int($adcode)) && preg_match('/^[1-9][0-9]{5}$/D', (string) $adcode)
            ? substr((string) $adcode, 0, 2) . '0000' : '';
        return [
            'location' => mb_substr(implode(' ', array_unique(array_filter([$country, $region, $city]))), 0, 160),
            'country_code' => $countryCode, 'region' => $region, 'region_code' => $regionCode, 'city' => $city,
        ];
    }
}
