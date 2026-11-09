<?php
declare(strict_types=1);
namespace app\controller;

require_once dirname(__DIR__) . '/Service/MaintenanceFileService.php';
require_once dirname(__DIR__) . '/Service/AdminMaintenanceService.php';
use app\Service\{AdminAuthService, AdminMaintenanceService};
use think\Request;

final class AdminMaintenanceController
{
    public function settings(Request $request)
    {
        (new AdminAuthService())->authorize($request);
        return json(['ok' => true, 'data' => (new AdminMaintenanceService())->settings()]);
    }
    public function save(Request $request)
    {
        $admin = (new AdminAuthService())->authorize($request);
        return json(['ok' => true, 'data' => (new AdminMaintenanceService())->save($this->payload($request), (int) $admin['id'], (string) $request->ip())]);
    }
    public function preview(Request $request)
    {
        (new AdminAuthService())->authorize($request);
        return json(['ok' => true, 'data' => (new AdminMaintenanceService())->preview($request->get('days', 90), (int) $request->get('page', 1))]);
    }
    public function cachePreview(Request $request)
    {
        (new AdminAuthService())->authorize($request);
        return json(['ok' => true, 'data' => (new AdminMaintenanceService())->cachePreview((int) $request->get('days', 7))]);
    }
    public function runs(Request $request)
    {
        (new AdminAuthService())->authorize($request);
        return json(['ok' => true, 'data' => (new AdminMaintenanceService())->runs((int) $request->get('page', 1))]);
    }
    public function run(Request $request)
    {
        (new AdminAuthService())->authorize($request);
        return json(['ok' => true, 'data' => (new AdminMaintenanceService())->run((int) $request->get('id', 0))]);
    }
    public function start(Request $request)
    {
        $admin = (new AdminAuthService())->authorize($request); $service = new AdminMaintenanceService();
        $run = $service->queue($this->payload($request), (int) $admin['id'], (string) $request->ip());
        if (in_array($run['status'], ['queued', 'running'], true)) $service->tick(false);
        return json(['ok' => true, 'data' => $service->run((int) $run['id'])], 202);
    }
    private function payload(Request $request): array
    {
        $data = $request->post();
        return $data ?: (json_decode($request->getContent(), true) ?: []);
    }
}
