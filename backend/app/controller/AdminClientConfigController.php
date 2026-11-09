<?php

namespace app\controller;

use app\Service\ClientConfigService;
use app\Service\ClientNavigationService;
use think\Request;
use think\exception\HttpResponseException;

final class AdminClientConfigController
{
    public function index(Request $request)
    {
        $this->admin($request);
        $data = (new ClientConfigService())->get();
        $data['explore_links'] = (new ClientNavigationService())->get()['explore_links'];
        return json(['ok' => true, 'data' => $data])->header(['Cache-Control' => 'no-store']);
    }

    public function save(Request $request)
    {
        $this->admin($request);
        $data = json_decode($request->getContent(), true);
        if (!is_array($data)) $data = $request->post();
        $adminId = (new \app\Service\AdminAuthService())->id($request);
        $requestId = (string) ($data['request_id'] ?? '');
        $ip = (string) $request->ip();
        $result = (new ClientConfigService())->save($data, $adminId, $requestId, $ip);
        if (array_key_exists('explore_links', $data) || array_key_exists('mall_links', $data)) {
            $links = $data['explore_links'] ?? $data['mall_links'] ?? [];
            $navigation = (new ClientNavigationService())->save(['explore_links' => $links], $adminId, $requestId . '-navigation', $ip);
            $result['explore_links'] = $navigation['explore_links'];
        }
        return json(['ok' => true, 'data' => $result])->header(['Cache-Control' => 'no-store']);
    }

    private function admin(Request $request): void
    {
        (new \app\Service\AdminAuthService())->authorize($request);
    }
}
