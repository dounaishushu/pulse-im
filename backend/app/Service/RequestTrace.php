<?php
namespace app\Service;

use think\Request;
use think\Response;

/** Request metadata contains no body, query string, authentication or secrets. */
final class RequestTrace
{
    public const BUILD_ID = '20261106-friendship-messages-v1';
    private static ?\WeakMap $contexts = null;
    private static ?\WeakMap $reported = null;

    public static function context(Request $request): array
    {
        self::$contexts ??= new \WeakMap();
        return self::$contexts[$request] ??= ['request_id' => bin2hex(random_bytes(12)), 'started' => microtime(true),
            'method' => strtoupper($request->method()), 'path' => '/' . substr(ltrim($request->pathinfo(), '/'), 0, 250)];
    }

    public static function failure(Request $request, \Throwable $error): void
    {
        if ($error instanceof \think\exception\HttpResponseException || $error instanceof \think\exception\HttpException) return;
        self::$reported ??= new \WeakMap();
        if (isset(self::$reported[$error])) return;
        self::$reported[$error] = true;
        $context = self::context($request);
        $business = $error instanceof \RuntimeException && !$error instanceof \PDOException && !$error instanceof \think\db\exception\PDOException;
        self::log('request.failed', $context, ['exception_class' => get_class($error)], $business ? 'warning' : 'error');
    }

    public static function decorate(Request $request, Response $response): Response
    {
        $context = self::context($request);
        $duration = round((microtime(true) - $context['started']) * 1000, 2);
        $response->header(['X-Pulse-Request-ID' => $context['request_id'], 'X-Pulse-Build' => self::BUILD_ID, 'Server-Timing' => 'app;dur=' . $duration]);
        if ($response instanceof \think\response\Json) {
            $data = $response->getData();
            if (is_array($data) && ($data['ok'] ?? null) === false && is_array($data['error'] ?? null)) {
                $data['error']['request_id'] = $context['request_id'];
                if ($response->getCode() >= 500 && !str_contains((string) ($data['error']['message'] ?? ''), $context['request_id'])) {
                    $data['error']['message'] = (string) ($data['error']['message'] ?? '服务暂时不可用。') . '（请求编号：' . $context['request_id'] . '）';
                }
                $response->data($data);
            }
        }
        if ($duration >= 1000 || $response->getCode() >= 500) self::log('request.completed', $context, ['duration_ms' => $duration, 'status' => $response->getCode()], $response->getCode() >= 500 ? 'error' : 'warning');
        return $response;
    }

    private static function log(string $event, array $context, array $extra, string $level): void
    {
        unset($context['started']);
        \think\facade\Log::record(json_encode(['event' => $event, 'build_id' => self::BUILD_ID] + $context + $extra, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE), $level);
    }
}
