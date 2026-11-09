<?php

namespace app\controller;

require_once __DIR__ . '/../Service/ClientRouteManifest.php';
require_once __DIR__ . '/../Service/RouteNodeStatus.php';

use app\Service\ClientRouteService;

final class ClientRouteController
{
    public function manifest()
    {
        try { return json(['ok' => true, 'data' => (new \app\Service\ClientRouteManifest())->get()])->header(['Cache-Control' => 'no-store']); }
        catch (\Throwable) { return json(['ok' => false, 'error' => ['code' => 'ROUTES_UNAVAILABLE', 'message' => '线路清单暂不可用。']], 503)->header(['Cache-Control' => 'no-store']); }
    }

    public function probe(\think\Request $request)
    {
        $nonce = (string) $request->get('nonce', '');
        if (!preg_match('~^[a-f0-9]{16,64}$~D', $nonce)) return json(['ok' => false], 400)->header(['Cache-Control' => 'no-store']);
        $data = (new \app\Service\RouteNodeStatus())->report($nonce);
        return json(['ok' => $data['ready'], 'data' => $data], $data['ready'] ? 200 : 503)->header(['Cache-Control' => 'no-store']);
    }

    public function index()
    {
        return json(['ok' => true, 'data' => ['items' => (new ClientRouteService())->enabled()]])->header(['Cache-Control' => 'no-store']);
    }
}
