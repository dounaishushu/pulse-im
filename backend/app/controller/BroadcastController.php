<?php

namespace app\controller;

use app\Service\AuthService;
use app\Service\BroadcastService;
use RuntimeException;
use think\Request;

final class BroadcastController
{
    public function targets(Request $request)
    {
        $user = $this->user($request);
        $integer = static function (string $key, int $default) use ($request): int {
            $value = filter_var($request->get($key, $default), FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]);
            if ($value === false) throw new RuntimeException('群发目标参数无效。');
            return $value;
        };
        return json(['ok' => true, 'data' => (new BroadcastService())->targets((int) $user['id'], (string) $request->get('type', 'friend'),
            $integer('after_id', 0), $integer('limit', 100), $request->get('snapshot_max_id') === null ? null : $integer('snapshot_max_id', 0))])
            ->header(['Cache-Control' => 'no-store']);
    }

    public function send(Request $request)
    {
        $user = $this->user($request);
        $data = $request->post();
        if ($data === []) $data = json_decode(trim($request->getContent()), true);
        if (!is_array($data)) $data = [];
        return json(['ok' => true, 'data' => (new BroadcastService())->send((int) $user['id'],
            is_array($data['target'] ?? null) ? $data['target'] : [],
            is_array($data['messages'] ?? null) ? $data['messages'] : [],
            is_string($data['request_id'] ?? null) ? $data['request_id'] : '')])->header(['Cache-Control' => 'no-store']);
    }

    private function user(Request $request): array
    {
        $token = preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', ''));
        return (new AuthService())->userByToken($token);
    }
}
