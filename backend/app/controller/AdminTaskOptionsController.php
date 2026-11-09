<?php
namespace app\controller;

use app\Service\AdminAuthService;
use think\Request;
use think\facade\Db;

/** Minimal dropdown data for the independently authorized records page. */
final class AdminTaskOptionsController
{
    public function index(Request $request)
    {
        (new AdminAuthService())->authorize($request);
        $rows = Db::name('work_tasks')->field('id,name,task_key')->order('sort_order')->order('id')->select()->toArray();
        return json(['ok' => true, 'data' => ['items' => array_map(static fn (array $row): array => ['id' => (int) $row['id'], 'name' => $row['name'], 'task_key' => $row['task_key']], $rows)]]);
    }
}
