<?php

namespace app\controller;

use app\Service\AuthService;
use app\Service\WorkTaskService;
use RuntimeException;
use think\Request;

final class WorkTaskController
{
    public function index(Request $request)
    {
        $user = $this->user($request); return json(['ok' => true, 'data' => (new WorkTaskService())->userTasks($user)])->header(['Cache-Control' => 'no-store']);
    }

    public function start(Request $request)
    {
        $user = $this->user($request); $payload = $this->payload($request);
        return json(['ok' => true, 'data' => (new WorkTaskService())->startTask((int) $user['id'], (int) ($payload['task_id'] ?? 0), (string) ($payload['verification_code'] ?? ''))], 201)->header(['Cache-Control' => 'no-store']);
    }

    public function record(Request $request)
    {
        $user = $this->user($request); return json(['ok' => true, 'data' => (new WorkTaskService())->taskRecord((int) $user['id'], (int) $request->get('id', 0))])->header(['Cache-Control' => 'no-store']);
    }

    public function submit(Request $request)
    {
        $user = $this->user($request); $payload = $this->payload($request); return json(['ok' => true, 'data' => (new WorkTaskService())->submitTask((int) $user['id'], (int) ($payload['record_id'] ?? 0), is_array($payload['answers'] ?? null) ? $payload['answers'] : [])])->header(['Cache-Control' => 'no-store']);
    }

    public function saveAnswers(Request $request)
    {
        $user = $this->user($request); $payload = $this->payload($request);
        return json(['ok' => true, 'data' => (new WorkTaskService())->saveAnswers((int) $user['id'], (int) ($payload['record_id'] ?? 0), is_array($payload['answers'] ?? null) ? $payload['answers'] : [])]);
    }

    private function user(Request $request): array { return (new AuthService())->userByToken(preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', ''))); }
    private function payload(Request $request): array { $payload = $request->post(); if ($payload !== []) return $payload; $decoded = json_decode(trim($request->getContent()), true); return is_array($decoded) ? $decoded : []; }
}
