<?php
declare(strict_types=1);
namespace app\controller;

require_once dirname(__DIR__) . '/Service/MobileDeviceService.php';
use app\Service\{AdminAuthService, MobileDeviceService};
use RuntimeException;
use think\Request;

final class AdminMobileDeviceController
{
    public function index(Request $request)
    {
        (new AdminAuthService())->authorize($request);
        return json(['ok' => true, 'data' => (new MobileDeviceService())->listing((string) $request->get('q', ''), (int) $request->get('page', 1), (int) $request->get('size', 30))])->header(['Cache-Control' => 'no-store']);
    }
    public function unbind(Request $request)
    {
        $admin = (new AdminAuthService())->authorize($request); $data = $this->payload($request);
        $userId = filter_var($data['user_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $bindingId = filter_var($data['binding_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($userId === false || $bindingId === false) throw new RuntimeException('请选择需要解绑的设备。');
        return json(['ok' => true, 'data' => (new MobileDeviceService())->unbind($userId, $bindingId, (int) $admin['id'], $this->requestId($data), (string) $request->ip())])->header(['Cache-Control' => 'no-store']);
    }
    public function unbindAll(Request $request)
    {
        $admin = (new AdminAuthService())->authorize($request); $data = $this->payload($request);
        if (($data['confirmation'] ?? null) !== 'UNBIND_ALL') throw new RuntimeException('请确认一键解绑全部手机设备。');
        return json(['ok' => true, 'data' => (new MobileDeviceService())->unbindAll((int) $admin['id'], $this->requestId($data), (string) $request->ip())])->header(['Cache-Control' => 'no-store']);
    }
    public function policy(Request $request)
    {
        $admin = (new AdminAuthService())->authorize($request); $data = $this->payload($request);
        if (!is_bool($data['enabled'] ?? null) || ($data['confirmation'] ?? null) !== 'CHANGE_DEVICE_POLICY') throw new RuntimeException('请确认设备锁启用状态。');
        return json(['ok' => true, 'data' => (new MobileDeviceService())->setEnabled($data['enabled'], (int) $admin['id'], $this->requestId($data), (string) $request->ip())])->header(['Cache-Control' => 'no-store']);
    }
    private function requestId(array $data): string { return is_string($data['request_id'] ?? null) ? $data['request_id'] : ''; }
    private function payload(Request $request): array
    {
        $data = $request->post();
        if ($data !== []) return $data;
        $decoded = json_decode($request->getContent(), true);
        return is_array($decoded) ? $decoded : [];
    }
}
