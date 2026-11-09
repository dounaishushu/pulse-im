<?php
namespace app\Service;

/** ip-api Pro serialized PHP. The API key and upstream URL never leave the server. */
final class IpApiLocationProvider
{
    private const ENDPOINT = 'https://pro.ip-api.com/php/';
    private const MAX_RESPONSE_BYTES = 8192;
    private array $errors = [];

    /** Safe machine codes only: never expose cURL errors, URLs, credentials or upstream text. */
    public function errors(): array { return $this->errors; }

    public function lookup(array $ips): array
    {
        $this->errors = [];
        $normalized = [];
        foreach ($ips as $input) if (is_string($input) && filter_var($input, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false) $normalized[inet_ntop(inet_pton($input))] = true;
        $ips = array_keys($normalized);
        if ($ips === [] || count($ips) > AdminIpLocationService::BATCH_SIZE) return [];
        $key = trim((string) env('IP_API_KEY', ''));
        if ($key === '' || !function_exists('curl_multi_init')) {
            $this->errors = array_fill_keys($ips, $key === '' ? 'provider_not_configured' : 'curl_unavailable');
            return [];
        }
        $caBundle = $this->caBundle();
        if ($caBundle !== null && (preg_match('~^[a-z][a-z0-9+.-]*://~i', $caBundle) || !is_file($caBundle) || !is_readable($caBundle))) {
            $this->errors = array_fill_keys($ips, 'ca_bundle_unavailable');
            return [];
        }
        $multi = curl_multi_init(); $handles = $bodies = $locations = [];
        try {
            foreach ($ips as $input) {
                $ip = inet_ntop(inet_pton($input));
                $url = self::ENDPOINT . rawurlencode($ip) . '?' . http_build_query([
                    'key' => $key, 'lang' => 'zh-CN', 'fields' => 'status,message,query,country,countryCode,region,regionName,city',
                ], '', '&', PHP_QUERY_RFC3986);
                $handle = curl_init($url); $bodies[$ip] = '';
                curl_setopt_array($handle, [
                    CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT_MS => 2000, CURLOPT_TIMEOUT_MS => 4000,
                    CURLOPT_NOSIGNAL => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                    CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
                    CURLOPT_HTTPHEADER => ['Accept: text/plain'], CURLOPT_USERAGENT => 'PulseIM-IPLocation/2.0',
                    CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use ($ip, &$bodies): int {
                        if (strlen($bodies[$ip]) + strlen($chunk) > self::MAX_RESPONSE_BYTES) return 0;
                        $bodies[$ip] .= $chunk;
                        return strlen($chunk);
                    },
                ]);
                if ($caBundle !== null) curl_setopt($handle, CURLOPT_CAINFO, $caBundle);
                if (PHP_OS_FAMILY === 'Windows' && defined('CURLSSLOPT_NATIVE_CA')) curl_setopt($handle, CURLOPT_SSL_OPTIONS, CURLSSLOPT_NATIVE_CA);
                $handles[$ip] = $handle; curl_multi_add_handle($multi, $handle);
            }
            $deadline = microtime(true) + 4.2;
            do {
                $code = curl_multi_exec($multi, $running);
                if (!$running || $code !== CURLM_OK || microtime(true) >= $deadline) break;
                if (curl_multi_select($multi, 0.1) === -1) usleep(1000);
            } while (true);
            foreach ($handles as $ip => $handle) {
                $error = curl_errno($handle); $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
                if ($error !== 0 || $status !== 200 || $code !== CURLM_OK) {
                    $this->errors[$ip] = $this->transportError($error, $status);
                    continue;
                }
                $location = $this->decode($bodies[$ip], $ip);
                if ($location !== null) $locations[$ip] = $location;
                else $this->errors[$ip] = 'provider_response_invalid';
            }
            return $locations;
        } finally {
            foreach ($handles as $handle) { curl_multi_remove_handle($multi, $handle); curl_close($handle); }
            curl_multi_close($multi);
        }
    }

    private function caBundle(): ?string
    {
        $configured = trim((string) env('IP_API_CA_BUNDLE', ''));
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
        if ($error === CURLE_OPERATION_TIMEDOUT) return 'provider_timeout';
        if ($error !== 0) return 'provider_connection_failed';
        if ($status === 401 || $status === 403) return 'provider_auth_failed';
        if ($status === 429) return 'provider_rate_limited';
        return 'provider_unavailable';
    }

    /** Untrusted serialized input may contain only the documented scalar fields. */
    private function decode(string $raw, string $ip): ?array
    {
        if ($raw === '' || strlen($raw) > self::MAX_RESPONSE_BYTES || !str_starts_with($raw, 'a:')) return null;
        // Objects are never instantiated, including objects embedded in an otherwise valid array.
        $data = @unserialize($raw, ['allowed_classes' => false, 'max_depth' => 4]);
        if (!is_array($data) || ($data['status'] ?? '') !== 'success' || !is_string($data['query'] ?? null)
            || !filter_var($data['query'], FILTER_VALIDATE_IP) || inet_pton($data['query']) !== inet_pton($ip)) return null;
        foreach (['country','countryCode','region','regionName','city'] as $name) if (!is_string($data[$name] ?? null) || !mb_check_encoding($data[$name], 'UTF-8')) return null;
        $countryCode = strtoupper(trim($data['countryCode']));
        if (!preg_match('/^[A-Z]{2}$/D', $countryCode)) return null;
        $clean = static fn (string $text, int $limit): string => mb_substr(trim(preg_replace('/[\x00-\x1F\x7F]/u', ' ', $text)), 0, $limit);
        $country = $clean($data['country'], 100); $region = $clean($data['regionName'], 100); $city = $clean($data['city'], 100);
        $location = implode(' ', array_values(array_unique(array_filter([$country, $region, $city], static fn (string $value): bool => $value !== ''))));
        return $location === '' ? null : [
            'location' => mb_substr($location, 0, 160), 'country_code' => $countryCode,
            'region' => $region, 'region_code' => $clean($data['region'], 20), 'city' => $city,
        ];
    }
}
