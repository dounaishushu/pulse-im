<?php

namespace app\controller;

use RuntimeException;
use think\Request;
use think\facade\Db;

final class AdminLoginLogController
{
    public function index(Request $request)
    {
        $this->admin($request);
        $page = max(1, (int) $request->get('page', 1));
        $size = min(100, max(1, (int) $request->get('size', 30)));
        $query = Db::name('login_logs')->order('id', 'desc');
        if ((int) $request->get('user_id', 0) > 0) $query->where('user_id', (int) $request->get('user_id'));
        if ((string) $request->get('ip', '') !== '') $query->where('ip', (string) $request->get('ip'));
        $rows = $query->paginate(['list_rows' => $size, 'page' => $page]);
        return json(['ok' => true, 'data' => ['items' => $rows->items(), 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size]]);
    }

    private function admin(Request $request): void
    {
        (new \app\Service\AdminAuthService())->authorize($request);
    }
}
