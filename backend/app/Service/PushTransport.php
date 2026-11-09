<?php
namespace app\Service;

use RuntimeException;

/** APNs HTTP/2 and Firebase HTTP v1. Provider secrets never enter notification payloads. */
final class PushTransport
{
    private array $accessTokens = [];

    public function configured(string $platform): bool
    {
        if ($platform === 'android') return is_file((string) env('FCM_SERVICE_ACCOUNT_FILE', ''));
        if ($platform === 'ios') return is_file((string) env('APNS_KEY_FILE', '')) && env('APNS_KEY_ID', '') !== '' && env('APNS_TEAM_ID', '') !== '' && env('APNS_TOPIC', '') !== '';
        return false;
    }

    public function send(array $device, array $data): array
    {
        if (!$this->configured($device['platform'])) return ['ok' => false, 'permanent' => false, 'error' => 'PROVIDER_NOT_CONFIGURED'];
        return $device['platform'] === 'ios' ? $this->apns($device['device_token'], $data) : $this->fcm($device['device_token'], $data);
    }

    private function fcm(string $deviceToken, array $data): array
    {
        $credentials = json_decode((string) file_get_contents((string) env('FCM_SERVICE_ACCOUNT_FILE', '')), true);
        if (!is_array($credentials) || empty($credentials['project_id']) || empty($credentials['private_key']) || empty($credentials['client_email'])) throw new RuntimeException('FCM_SERVICE_ACCOUNT_INVALID');
        if (($this->accessTokens['fcm']['expires'] ?? 0) <= time() + 60) {
            $jwt = $this->jwt(['alg' => 'RS256', 'typ' => 'JWT'], ['iss' => $credentials['client_email'], 'scope' => 'https://www.googleapis.com/auth/firebase.messaging', 'aud' => 'https://oauth2.googleapis.com/token', 'iat' => time(), 'exp' => time() + 3600], $credentials['private_key'], false);
            $auth = $this->request('https://oauth2.googleapis.com/token', ['Content-Type: application/x-www-form-urlencoded'], http_build_query(['grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'assertion' => $jwt]));
            if ($auth['status'] !== 200 || empty($auth['json']['access_token'])) throw new RuntimeException('FCM_AUTH_FAILED');
            $this->accessTokens['fcm'] = ['token' => $auth['json']['access_token'], 'expires' => time() + (int) ($auth['json']['expires_in'] ?? 3600)];
        }
        $result = $this->request('https://fcm.googleapis.com/v1/projects/' . rawurlencode($credentials['project_id']) . '/messages:send', ['Authorization: Bearer ' . $this->accessTokens['fcm']['token'], 'Content-Type: application/json'], json_encode(['message' => ['token' => $deviceToken, 'data' => array_map('strval', $data), 'android' => ['priority' => 'high', 'ttl' => '86400s']]], JSON_THROW_ON_ERROR));
        $unregistered = false;
        foreach (($result['json']['error']['details'] ?? []) as $detail) if (($detail['errorCode'] ?? '') === 'UNREGISTERED') $unregistered = true;
        if ($result['status'] === 401) unset($this->accessTokens['fcm']);
        return ['ok' => $result['status'] === 200, 'permanent' => $unregistered, 'error' => $unregistered ? 'UNREGISTERED' : 'FCM_HTTP_' . $result['status']];
    }

    private function apns(string $deviceToken, array $data): array
    {
        if (!preg_match('/^[a-fA-F0-9]{64,200}$/D', $deviceToken)) return ['ok' => false, 'permanent' => true, 'error' => 'BAD_DEVICE_TOKEN'];
        if (($this->accessTokens['apns']['expires'] ?? 0) <= time()) {
            $key = file_get_contents((string) env('APNS_KEY_FILE', ''));
            $jwt = $this->jwt(['alg' => 'ES256', 'kid' => (string) env('APNS_KEY_ID')], ['iss' => (string) env('APNS_TEAM_ID'), 'iat' => time()], $key, true);
            $this->accessTokens['apns'] = ['token' => $jwt, 'expires' => time() + 2400];
        }
        $host = (string) env('APNS_ENV', 'production') === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
        $payload = ['aps' => ['alert' => ['title' => $data['title'], 'body' => $data['body']], 'sound' => 'default', 'thread-id' => 'conversation-' . $data['conversation_id']]] + $data;
        $result = $this->request('https://' . $host . '/3/device/' . $deviceToken, ['authorization: bearer ' . $this->accessTokens['apns']['token'], 'apns-topic: ' . (string) env('APNS_TOPIC'), 'apns-push-type: alert', 'apns-priority: 10', 'apns-expiration: ' . (time() + 86400), 'apns-collapse-id: message-' . $data['message_id'], 'content-type: application/json'], json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), true);
        $reason = (string) ($result['json']['reason'] ?? '');
        if ($result['status'] === 403) unset($this->accessTokens['apns']);
        $permanent = in_array($reason, ['Unregistered', 'BadDeviceToken'], true);
        return ['ok' => $result['status'] === 200, 'permanent' => $permanent, 'error' => $permanent ? strtoupper($reason) : 'APNS_HTTP_' . $result['status']];
    }

    private function jwt(array $header, array $claims, string $key, bool $ec): string
    {
        $input = $this->b64(json_encode($header, JSON_THROW_ON_ERROR)) . '.' . $this->b64(json_encode($claims, JSON_THROW_ON_ERROR));
        if (!openssl_sign($input, $signature, $key, OPENSSL_ALGO_SHA256)) throw new RuntimeException('PUSH_SIGNING_FAILED');
        if ($ec) $signature = $this->ecdsaRaw($signature);
        return $input . '.' . $this->b64($signature);
    }

    private function ecdsaRaw(string $der): string
    {
        $offset = 0;
        $length = static function (string $data, int &$position): int { $value = ord($data[$position++]); if (($value & 0x80) === 0) return $value; $bytes = $value & 0x7f; if ($bytes < 1 || $bytes > 2) throw new RuntimeException('PUSH_EC_SIGNATURE_INVALID'); $value = 0; while ($bytes--) $value = ($value << 8) | ord($data[$position++]); return $value; };
        if (ord($der[$offset++]) !== 0x30) throw new RuntimeException('PUSH_EC_SIGNATURE_INVALID');
        $length($der, $offset); $output = '';
        for ($i = 0; $i < 2; $i++) { if (ord($der[$offset++]) !== 0x02) throw new RuntimeException('PUSH_EC_SIGNATURE_INVALID'); $size = $length($der, $offset); $part = ltrim(substr($der, $offset, $size), "\0"); $offset += $size; if (strlen($part) > 32) throw new RuntimeException('PUSH_EC_SIGNATURE_INVALID'); $output .= str_pad($part, 32, "\0", STR_PAD_LEFT); }
        return $output;
    }
    private function b64(string $value): string { return rtrim(strtr(base64_encode($value), '+/', '-_'), '='); }

    private function request(string $url, array $headers, string $body, bool $http2 = false): array
    {
        $curl = curl_init($url);
        curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_HTTPHEADER => $headers, CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 12, CURLOPT_FOLLOWLOCATION => false, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
        if ($http2) curl_setopt($curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2_0);
        try { $raw = curl_exec($curl); return ['status' => $raw === false ? 0 : (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE), 'json' => $raw === false ? [] : (json_decode($raw, true) ?: [])]; }
        finally { curl_close($curl); }
    }
}
