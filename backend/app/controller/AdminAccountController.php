<?php
namespace app\controller;

use app\Service\{AdminAccountService, AdminAuthService, AdminPermissionService};
use RuntimeException;
use think\Request;

final class AdminAccountController
{
    public function index(Request $request)
    {
        (new AdminAuthService())->authorize($request);
        return json(['ok' => true, 'data' => (new AdminAccountService())->listing((int) $request->get('page', 1), (int) $request->get('size', 30),
            (string) $request->get('q', ''), (string) $request->get('status', ''))]);
    }

    public function permissions(Request $request)
    {
        (new AdminAuthService())->authorize($request);
        return json(['ok' => true, 'data' => ['items' => AdminPermissionService::catalog(), 'roles' => [
            ['key' => 'operator', 'title' => '普通管理员'], ['key' => 'auditor', 'title' => '只读管理员'], ['key' => 'admin', 'title' => '超级管理员'],
        ]]]);
    }

    public function create(Request $request)
    {
        $actor = (new AdminAuthService())->authorize($request); $data = $this->payload($request);
        return json(['ok' => true, 'data' => ['account' => (new AdminAccountService())->create($data, $actor['id'], (string) $request->ip(), (string) ($data['request_id'] ?? ''))]], 201);
    }

    public function update(Request $request)
    {
        $actor = (new AdminAuthService())->authorize($request); $data = $this->payload($request);
        return json(['ok' => true, 'data' => ['account' => (new AdminAccountService())->update($this->id($data), $data, $actor['id'], (string) $request->ip(), (string) ($data['request_id'] ?? ''))]]);
    }

    public function status(Request $request)
    {
        $actor = (new AdminAuthService())->authorize($request); $data = $this->payload($request);
        if (!is_string($data['status'] ?? null)) throw new RuntimeException('管理员状态无效。');
        return json(['ok' => true, 'data' => ['account' => (new AdminAccountService())->status($this->id($data), $data['status'], $actor['id'], (string) $request->ip(), (string) ($data['request_id'] ?? ''))]]);
    }

    private function id(array $data): int
    {
        $id = filter_var($data['id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($id === false) throw new RuntimeException('后台账号编号无效。');
        return $id;
    }

    private function payload(Request $request): array
    {
        $decoded = json_decode($request->getContent(), true);
        return is_array($decoded) ? $decoded : $request->post();
    }
}
