<?php

namespace app\controller;

use app\Service\AuditService;
use RuntimeException;
use think\Request;

final class AdminAuditController
{
    public function index(Request $request)
    {
        $this->admin($request);
        return json(['ok' => true, 'data' => (new AuditService())->list((int) $request->get('page', 1), (int) $request->get('size', 30), (string) $request->get('action', ''), (string) $request->get('target_type', ''))]);
    }

    private function admin(Request $request): void
    {
        (new \app\Service\AdminAuthService())->authorize($request);
    }
}
