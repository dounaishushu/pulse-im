<?php

namespace app\Service;

/** Public, bounded diagnostics. Never include upstream messages, URLs or credentials. */
final class IpLocationFailure
{
    public static function advice(string $code): string
    {
        return match ($code) {
            'provider_ip_not_allowed' => '在百度控制台的服务端AK白名单中加入服务器实际公网出口IP，然后重试。',
            'provider_signature_failed', 'provider_key_type_invalid' => '检查百度应用是否为服务端类型，并使IP白名单或SN签名校验方式与程序一致。',
            'provider_service_disabled', 'provider_ipv6_unavailable' => '在百度控制台检查普通IP定位服务权限；IPv6查询需另外开通权限。',
            'provider_auth_failed', 'provider_not_configured' => '检查服务器私有百度AK配置是否可读、有效且未被禁用。',
            'provider_dns_failed' => '检查服务器是否能解析api.map.baidu.com，以及服务器DNS配置。',
            'ca_bundle_unavailable', 'tls_verification_failed' => '检查PHP的CA证书配置、证书文件读取权限及服务器时间。',
            'curl_unavailable' => '在网站实际使用的PHP版本中启用cURL扩展。',
            'provider_timeout', 'provider_connection_failed' => '检查服务器到api.map.baidu.com的HTTPS出站连接、443端口及网络路由。',
            'provider_rate_limited' => '检查百度AK的配额及并发限制，等待限制解除后重试。',
            default => '稍后重新执行服务器自检；若持续失败，按错误编号排查百度服务状态。',
        };
    }

    public static function describe(string $code, array $details = []): array
    {
        $labels = [
            'provider_not_configured' => ['归属地服务未配置', 'GEO-CONFIG'],
            'curl_unavailable' => ['归属地服务缺少cURL扩展', 'GEO-CURL'],
            'ca_bundle_unavailable' => ['归属地服务证书配置异常', 'GEO-CA'],
            'tls_verification_failed' => ['归属地服务证书校验失败', 'GEO-TLS'],
            'provider_dns_failed' => ['百度接口域名解析失败', 'GEO-DNS'],
            'provider_timeout' => ['归属地查询超时，请稍后重试', 'GEO-TIMEOUT'],
            'provider_connection_failed' => ['无法连接百度归属地服务', 'GEO-CONNECT'],
            'provider_response_invalid' => ['百度归属地返回数据异常', 'GEO-RESPONSE'],
            'provider_auth_failed' => ['百度归属地服务认证失败', 'GEO-AUTH'],
            'provider_ip_not_allowed' => ['百度接口服务器IP未加入白名单', 'BD-210'],
            'provider_signature_failed' => ['百度接口签名校验失败', 'BD-211'],
            'provider_key_type_invalid' => ['百度Key类型或校验方式不匹配', 'GEO-KEY'],
            'provider_service_disabled' => ['百度IP定位权限未开通', 'BD-240'],
            'provider_ipv6_unavailable' => ['百度IPv6定位权限未开通', 'BD-1001'],
            'provider_rate_limited' => ['归属地服务查询受限，请稍后重试', 'GEO-LIMIT'],
            'provider_unavailable' => ['百度归属地服务暂时不可用', 'GEO-UPSTREAM'],
        ];
        if (!isset($labels[$code])) $code = 'provider_unavailable';
        [$label, $number] = $labels[$code];
        $safe = ['error_code' => $code];
        foreach (['provider_status' => [1, 9999], 'curl_code' => [0, 999], 'http_status' => [0, 599]] as $field => [$min, $max]) {
            $value = $details[$field] ?? null;
            if (is_int($value) && $value >= $min && $value <= $max) $safe[$field] = $value;
        }
        if (isset($safe['provider_status'])) $number = 'BD-' . $safe['provider_status'];
        elseif (($safe['curl_code'] ?? 0) > 0) $number = 'CURL-' . $safe['curl_code'];
        elseif (($safe['http_status'] ?? 0) >= 100 && $safe['http_status'] !== 200) $number = 'HTTP-' . $safe['http_status'];
        return ['location' => $label . '（错误编号：' . $number . '）', 'error_number' => $number] + $safe;
    }
}
