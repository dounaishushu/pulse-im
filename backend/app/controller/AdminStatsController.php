<?php

namespace app\controller;

use RuntimeException;
use think\Request;
use think\facade\Db;
use app\Service\AdminRegionStatsService;
use app\Service\AdminOffsiteLoginService;

final class AdminStatsController
{
    public function index(Request $request)
    {
        $this->admin($request);
        $today = date('Y-m-d 00:00:00');
        $activeSince = date('Y-m-d H:i:s', time() - 60);
        $healthStartedAt = microtime(true);
        Db::query('SELECT 1');
        return json(['ok' => true, 'data' => [
            'users' => ['total' => (int) Db::name('users')->count(), 'active' => (int) Db::name('users')->where('status', 'active')->count(), 'online' => (int) Db::name('users')->alias('u')->leftJoin('user_presence p', 'p.user_id = u.id')->leftJoin('auth_tokens t', 't.user_id = u.id')->where('u.status', 'active')->where(function ($query) use ($activeSince): void { $query->where('p.last_seen_at', '>=', $activeSince)->whereOr('t.last_used_at', '>=', $activeSince); })->distinct(true)->count('u.id'), 'frozen' => (int) Db::name('users')->where('status', 'frozen')->count(), 'deleted' => (int) Db::name('users')->where('status', 'deleted')->count()],
            'conversations' => (int) Db::name('conversations')->count(),
            'messages' => (int) Db::name('messages')->count(),
            'today_messages' => (int) Db::name('messages')->where('created_at', '>=', $today)->count(),
            'today_logins' => (int) Db::name('login_logs')->where('created_at', '>=', $today)->where('success', 1)->count(),
            'health' => ['database' => 'up', 'database_latency_ms' => round((microtime(true) - $healthStartedAt) * 1000, 2)],
            'generated_at' => date('c'),
        ]]);
    }

    public function regions(Request $request)
    {
        $this->admin($request);
        return json(['ok' => true, 'data' => (new AdminRegionStatsService())->snapshot()]);
    }

    public function resolveRegions(Request $request)
    {
        $this->admin($request);
        return json(['ok' => true, 'data' => (new AdminRegionStatsService())->refreshBatch()]);
    }

    public function offsiteLogins(Request $request)
    {
        $this->admin($request);
        return json(['ok' => true, 'data' => (new AdminOffsiteLoginService())->snapshot((int) $request->get('page', 1), (int) $request->get('size', 30))]);
    }

    public function resolveOffsiteLogins(Request $request)
    {
        $this->admin($request);
        return json(['ok' => true, 'data' => (new AdminOffsiteLoginService())->refreshBatch((int) $request->get('page', 1), (int) $request->get('size', 30))]);
    }

    private function admin(Request $request): void
    {
        (new \app\Service\AdminAuthService())->authorize($request);
    }
}
