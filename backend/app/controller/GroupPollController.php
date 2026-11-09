<?php

namespace app\controller;

use app\Service\AuthService;
use app\Service\GroupPollService;
use think\Request;

final class GroupPollController
{
    public function index(Request $request)
    {
        return json(['ok' => true, 'data' => (new GroupPollService())->list($this->userId($request), (int) $request->get('conversation_id', 0), explode(',', (string) $request->get('ids', '')))]);
    }

    public function create(Request $request)
    {
        $data = $this->payload($request);
        return json(['ok' => true, 'data' => (new GroupPollService())->create($this->userId($request), (int) ($data['conversation_id'] ?? 0), $data)], 201);
    }

    public function vote(Request $request)
    {
        $data = $this->payload($request);
        return json(['ok' => true, 'data' => (new GroupPollService())->vote($this->userId($request), (int) ($data['poll_id'] ?? 0), is_array($data['option_ids'] ?? null) ? $data['option_ids'] : [])]);
    }

    public function close(Request $request)
    {
        $data = $this->payload($request);
        return json(['ok' => true, 'data' => (new GroupPollService())->close($this->userId($request), (int) ($data['poll_id'] ?? 0))]);
    }

    private function userId(Request $request): int
    {
        return (int) (new AuthService())->userByToken(preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', '')))['id'];
    }

    private function payload(Request $request): array
    {
        $posted = $request->post();
        if ($posted !== []) return $posted;
        $decoded = json_decode(trim($request->getContent()), true);
        return is_array($decoded) ? $decoded : [];
    }
}
