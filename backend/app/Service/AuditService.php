<?php

namespace app\Service;

use think\facade\Db;

final class AuditService
{
    public function log(int $adminId, string $action, string $targetType, ?int $targetId, string $requestId, string $ip, array $detail = []): void
    {
        Db::name('admin_audit_logs')->insert([
            'admin_id' => $adminId > 0 ? $adminId : 0,
            'action' => substr($action, 0, 64),
            'target_type' => substr($targetType, 0, 32),
            'target_id' => $targetId,
            'request_id' => substr($requestId ?: bin2hex(random_bytes(12)), 0, 80),
            'ip' => $ip !== '' ? inet_pton($ip) : null,
            'detail_json' => $detail ? json_encode($detail, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) : null,
            'created_at' => date('Y-m-d H:i:s'),
        ]);
    }

    public function list(int $page = 1, int $size = 30, string $action = '', string $targetType = ''): array
    {
        $size = min(100, max(1, $size));
        $query = Db::name('admin_audit_logs')->order('id', 'desc');
        if ($action !== '') $query->where('action', substr($action, 0, 64));
        if ($targetType !== '') $query->where('target_type', substr($targetType, 0, 32));
        $rows = $query->paginate(['list_rows' => $size, 'page' => max(1, $page)]);
        $items = array_map(static function (array $row): array {
            if (isset($row['ip']) && is_string($row['ip']) && in_array(strlen($row['ip']), [4, 16], true)) $row['ip'] = inet_ntop($row['ip']) ?: '';
            $row['detail'] = $row['detail_json'] ? (json_decode($row['detail_json'], true) ?: []) : [];
            unset($row['detail_json']);
            return $row;
        }, $rows->items());
        return ['items' => $items, 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }
}
