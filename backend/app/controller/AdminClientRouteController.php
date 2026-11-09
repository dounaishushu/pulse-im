<?php

namespace app\controller;

use app\Service\ClientRouteService;
use think\Request;
use think\exception\HttpResponseException;

final class AdminClientRouteController
{
    public function index(Request $request)
    {
        $this->admin($request);
        return json(['ok' => true, 'data' => (new ClientRouteService())->page((int) $request->get('page', 1), (int) $request->get('size', 20), trim((string) $request->get('name', '')), trim((string) $request->get('status', '')))])->header(['Cache-Control' => 'no-store']);
    }

    public function save(Request $request)
    {
        $this->admin($request);
        $data = json_decode($request->getContent(), true);
        if (!is_array($data)) $data = $request->post();
        return json(['ok' => true, 'data' => (new ClientRouteService())->save($data, (new \app\Service\AdminAuthService())->id($request), (string) ($data['request_id'] ?? ''), (string) $request->ip())]);
    }

    public function delete(Request $request)
    {
        $this->admin($request);
        $data = json_decode($request->getContent(), true);
        if (!is_array($data)) $data = $request->post();
        $ids = $data['ids'] ?? ($data['id'] ?? []);
        if (!is_array($ids)) $ids = [$ids];
        return json(['ok' => true, 'data' => (new ClientRouteService())->delete($ids, (new \app\Service\AdminAuthService())->id($request), (string) ($data['request_id'] ?? ''), (string) $request->ip())]);
    }

    private function admin(Request $request): void
    {
        (new \app\Service\AdminAuthService())->authorize($request);
    }
}
