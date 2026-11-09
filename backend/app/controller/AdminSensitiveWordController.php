<?php

namespace app\controller;

use RuntimeException;
use think\Request;
use think\facade\Db;
use app\Service\AuditService;
use app\Service\SensitiveWordService;

final class AdminSensitiveWordController
{
    public function index(Request $request)
    {
        $this->admin($request);
        $page = max(1, (int) $request->get('page', 1));
        $size = min(100, max(1, (int) $request->get('size', 20)));
        $query = Db::name('sensitive_words')->order('id', 'desc');
        $keyword = trim((string) $request->get('q', ''));
        if ($keyword !== '') $query->whereLike('word', '%' . addcslashes($keyword, '%_') . '%');
        $rows = $query->paginate(['list_rows' => $size, 'page' => $page]);
        return json(['ok' => true, 'data' => ['items' => $rows->items(), 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size]]);
    }

    public function create(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $result = (new SensitiveWordService())->create((string) ($data['word'] ?? ''), (string) ($data['replacement'] ?? ''));
        $this->audit($request, 'sensitive_word.create', (int) $result['id'], ['word' => $result['word']]);
        return json(['ok' => true, 'data' => $result], 201);
    }

    public function edit(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $result = (new SensitiveWordService())->update((int) ($data['id'] ?? 0), (string) ($data['word'] ?? ''), (string) ($data['replacement'] ?? ''));
        $this->audit($request, 'sensitive_word.edit', (int) $result['id'], ['word' => $result['word']]);
        return json(['ok' => true, 'data' => $result]);
    }

    public function delete(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $id = (int) ($data['id'] ?? 0);
        (new SensitiveWordService())->delete($id);
        $this->audit($request, 'sensitive_word.delete', $id);
        return json(['ok' => true, 'data' => ['id' => $id, 'deleted' => true]]);
    }

    public function batchDelete(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $deleted = (new SensitiveWordService())->deleteMany(is_array($data['ids'] ?? null) ? $data['ids'] : []);
        $this->audit($request, 'sensitive_word.batch_delete', null, ['deleted' => $deleted]);
        return json(['ok' => true, 'data' => ['deleted' => $deleted]]);
    }

    private function admin(Request $request): void
    {
        (new \app\Service\AdminAuthService())->authorize($request);
    }

    private function audit(Request $request, string $action, ?int $targetId, array $detail = []): void
    {
        $payload = $this->payload($request);
        (new AuditService())->log((new \app\Service\AdminAuthService())->id($request), 'user.' . $action, 'sensitive_word', $targetId, (string) ($payload['request_id'] ?? ''), (string) $request->ip(), $detail);
    }

    private function payload(Request $request): array
    {
        $payload = $request->post();
        if ($payload !== []) return $payload;
        $decoded = json_decode(trim($request->getContent()), true);
        return is_array($decoded) ? $decoded : [];
    }
}
