<?php

namespace app\Service;

require_once __DIR__ . '/ClientRoutePolicy.php';

use RuntimeException;
use think\facade\Db;

final class ClientRouteService
{
    public function enabled(): array
    {
        $rows = Db::name('client_routes')->where('status', 'enabled')->order('sort', 'asc')->order('id', 'asc')->select()->toArray();
        return array_map(fn (array $row): array => $this->format($row), $rows);
    }

    public function page(int $page, int $size, string $name = '', string $status = ''): array
    {
        $size = min(100, max(1, $size));
        $query = Db::name('client_routes')->order('sort', 'asc')->order('id', 'desc');
        if ($name !== '') $query->whereLike('name', '%' . addcslashes($name, '%_') . '%');
        if (in_array($status, ['enabled', 'disabled'], true)) $query->where('status', $status);
        $rows = $query->paginate(['list_rows' => $size, 'page' => max(1, $page)]);
        return ['items' => array_map(fn (array $row): array => $this->format($row), $rows->items()), 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    public function save(array $payload, int $adminId, string $requestId, string $ip): array
    {
        $id = (int) ($payload['id'] ?? 0);
        $name = trim((string) ($payload['name'] ?? ''));
        $url = trim((string) ($payload['url'] ?? ''));
        $sort = (int) ($payload['sort'] ?? 0);
        $status = (string) ($payload['status'] ?? 'enabled');
        $isUpdate = $id > 0;
        if ($name === '' || mb_strlen($name) > 64) throw new RuntimeException('线路名称不能为空且最多64个字符。');
        $existing = $id > 0 ? Db::name('client_routes')->where('id', $id)->find() : null;
        if ($id > 0 && !$existing) throw new RuntimeException('线路不存在。');
        $endpoints = ClientRoutePolicy::normalize(['url' => $url, 'ws_url' => $payload['ws_url'] ?? $existing['ws_url'] ?? '', 'media_url' => $payload['media_url'] ?? $existing['media_url'] ?? '']);
        if ($sort < -999999 || $sort > 999999) throw new RuntimeException('排序值超出范围。');
        if (!in_array($status, ['enabled', 'disabled'], true)) throw new RuntimeException('线路状态不正确。');
        $now = date('Y-m-d H:i:s');
        $data = ['name' => $name, 'url' => $endpoints['url'], 'ws_url' => $endpoints['ws_url'], 'media_url' => $endpoints['media_url'], 'sort' => $sort, 'status' => $status, 'updated_at' => $now];
        $id = Db::transaction(function () use ($id, $data, $now): int {
            if (!Db::name('client_route_state')->where('id', 1)->lock(true)->find()) throw new RuntimeException('请先执行线路数据库迁移。');
            if (Db::name('client_routes')->where('url', $data['url'])->where('id', '<>', $id)->count()) throw new RuntimeException('该 API 地址已配置为其他线路。');
            $enabled = array_values(array_filter($this->enabled(), static fn ($r) => $r['valid_for_failover'] ?? false));
            $wasEnabled = array_filter($enabled, static fn ($r) => $r['id'] === $id);
            if ($data['status'] === 'enabled' && !$wasEnabled && count($enabled) >= 32) throw new RuntimeException('启用线路最多32条。');
            if ($data['status'] === 'disabled' && $wasEnabled && count($enabled) === 1) throw new RuntimeException('请先启用其他可用线路，再停用最后一条线路。');
            if ($id > 0) Db::name('client_routes')->where('id', $id)->update($data);
            else { $data['created_at'] = $now; $id = (int) Db::name('client_routes')->insertGetId($data); }
            Db::name('client_route_state')->where('id', 1)->inc('revision')->update(['updated_at' => $now]);
            return $id;
        });
        (new AuditService())->log($adminId, $isUpdate ? 'client_route.update' : 'client_route.create', 'client_route', $id, $requestId, $ip, ['name' => $name, 'url' => $url, 'status' => $status]);
        return $this->format(Db::name('client_routes')->where('id', $id)->find());
    }

    public function delete(array $ids, int $adminId, string $requestId, string $ip): array
    {
        $ids = array_values(array_unique(array_filter(array_map('intval', $ids), static fn (int $id): bool => $id > 0)));
        if (!$ids) throw new RuntimeException('请选择要删除的线路。');
        $deleted = Db::transaction(function () use ($ids): int {
            if (!Db::name('client_route_state')->where('id', 1)->lock(true)->find()) throw new RuntimeException('请先执行线路数据库迁移。');
            $enabled = array_values(array_filter($this->enabled(), static fn ($r) => $r['valid_for_failover'] ?? false));
            if ($enabled && !array_filter($enabled, static fn ($r) => !in_array($r['id'], $ids, true))) throw new RuntimeException('至少保留一条已启用线路。');
            $deleted = (int) Db::name('client_routes')->whereIn('id', $ids)->delete();
            if ($deleted) Db::name('client_route_state')->where('id', 1)->inc('revision')->update(['updated_at' => date('Y-m-d H:i:s')]);
            return $deleted;
        });
        (new AuditService())->log($adminId, 'client_route.delete', 'client_route', null, $requestId, $ip, ['ids' => $ids]);
        return ['deleted' => (int) $deleted, 'ids' => $ids];
    }

    private function format(array $row): array
    {
        $result = ['id' => (int) $row['id'], 'name' => (string) $row['name'], 'url' => (string) $row['url'], 'ws_url' => (string) ($row['ws_url'] ?? ''), 'media_url' => (string) ($row['media_url'] ?? ''), 'sort' => (int) $row['sort'], 'status' => (string) $row['status'], 'created_at' => (string) ($row['created_at'] ?? ''), 'updated_at' => (string) ($row['updated_at'] ?? '')];
        try { return array_merge(ClientRoutePolicy::normalize($result), ['valid_for_failover' => true]); }
        catch (RuntimeException) { return array_merge($result, ['valid_for_failover' => false]); }
    }
}
