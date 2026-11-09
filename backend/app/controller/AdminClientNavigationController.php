<?php

namespace app\controller;

use app\Service\ClientNavigationService;
use think\Request;
use think\exception\HttpResponseException;

final class AdminClientNavigationController
{
    public function index(Request $request)
    {
        $this->admin($request);
        return json(['ok' => true, 'data' => (new ClientNavigationService())->get()])->header(['Cache-Control' => 'no-store']);
    }

    public function save(Request $request)
    {
        $this->admin($request);
        $data = json_decode($request->getContent(), true);
        if (!is_array($data)) $data = $request->post();
        $result = (new ClientNavigationService())->save($data, (new \app\Service\AdminAuthService())->id($request), (string) ($data['request_id'] ?? ''), (string) $request->ip());
        return json(['ok' => true, 'data' => $result])->header(['Cache-Control' => 'no-store']);
    }

    private function admin(Request $request): void
    {
        (new \app\Service\AdminAuthService())->authorize($request);
    }
}
