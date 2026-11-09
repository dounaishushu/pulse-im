<?php
namespace app\controller;

use app\Service\{AdminAuthService, DispatchImageService, DispatchTaskService};
use RuntimeException;
use think\Request;

final class AdminDispatchTaskController
{
    public function index(Request $request) { (new AdminAuthService())->authorize($request); return json(['ok' => true, 'data' => (new DispatchTaskService())->listing($request->get())]); }
    public function detail(Request $request) { (new AdminAuthService())->authorize($request); return json(['ok' => true, 'data' => ['task' => (new DispatchTaskService())->detail($this->id($request->get('id')))]]); }
    public function options(Request $request) { (new AdminAuthService())->authorize($request); return json(['ok' => true, 'data' => (new DispatchTaskService())->options((string) $request->get('kind', ''), (string) $request->get('q', ''), (int) $request->get('sender_id', 0))]); }
    public function save(Request $request)
    {
        $actor = (new AdminAuthService())->authorize($request); $data = $this->payload($request);
        return json(['ok' => true, 'data' => ['task' => (new DispatchTaskService())->save($data, $actor['id'], (string) $request->ip(), (string) ($data['request_id'] ?? ''))]], empty($data['id']) ? 201 : 200);
    }
    public function upload(Request $request)
    {
        $actor = (new AdminAuthService())->authorize($request);
        $file = $request->file('file');
        if (!$file instanceof \think\file\UploadedFile) throw new RuntimeException('上传图片缺失或无效。');
        return json(['ok' => true, 'data' => (new DispatchImageService())->upload($file, $this->id($request->post('sender_id')), $actor, (string) $request->ip(), (string) $request->post('request_id', ''))], 201);
    }
    public function status(Request $request)
    {
        $actor = (new AdminAuthService())->authorize($request); $data = $this->payload($request);
        if (!is_string($data['status'] ?? null)) throw new RuntimeException('任务状态无效。');
        return json(['ok' => true, 'data' => ['task' => (new DispatchTaskService())->status($this->id($data['id'] ?? null), $data['status'], $actor['id'], (string) $request->ip(), (string) ($data['request_id'] ?? ''))]]);
    }
    public function delete(Request $request)
    {
        $actor = (new AdminAuthService())->authorize($request); $data = $this->payload($request);
        $id = $this->id($data['id'] ?? null); (new DispatchTaskService())->delete($id, $actor['id'], (string) $request->ip(), (string) ($data['request_id'] ?? ''));
        return json(['ok' => true, 'data' => ['id' => $id, 'status' => 'deleted']]);
    }
    private function id(mixed $value): int { $id = filter_var($value, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]); if ($id === false) throw new RuntimeException('任务编号无效。'); return $id; }
    private function payload(Request $request): array { $decoded = json_decode($request->getContent(), true); return is_array($decoded) ? $decoded : $request->post(); }
}
