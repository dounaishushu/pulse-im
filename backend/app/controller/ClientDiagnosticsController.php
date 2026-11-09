<?php

namespace app\controller;

use app\Service\AuthService;
use app\Service\AuditService;
use app\Service\ClientDiagnosticPayload;
use RuntimeException;
use think\Request;
use think\facade\Db;

final class ClientDiagnosticsController
{
    public function upload(Request $request)
    {
        $user = (new AuthService())->userByToken(preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', '')));
        $detail = ClientDiagnosticPayload::parse($request->getContent());
        $userId = (int) $user['id'];
        $report = Db::transaction(function () use ($userId, $request, $detail): string {
            if (!Db::name('users')->where('id', $userId)->where('status', 'active')->lock(true)->find()) throw new RuntimeException('用户账号不可用。');
            $report = isset($detail['diagnostic_id']) ? $detail['platform'] . '-' . str_replace('-', '', $detail['diagnostic_id']) : $detail['platform'] . '-' . bin2hex(random_bytes(12));
            // A lost acknowledgement must not create another audit record or consume another quota.
            if (isset($detail['diagnostic_id']) && Db::name('admin_audit_logs')->where('action', 'client.diagnostics')->where('target_type', 'user')->where('target_id', $userId)->where('request_id', $report)->find()) return $report;
            $recent = Db::name('admin_audit_logs')->where('action', 'client.diagnostics')->where('target_type', 'user')->where('target_id', $userId)->where('created_at', '>=', date('Y-m-d H:i:s', time() - 60))->count();
            if ($recent >= 5) throw new RuntimeException('日志上传过于频繁，请稍后再试。');
            (new AuditService())->log(0, 'client.diagnostics', 'user', $userId, $report, (string) $request->ip(), $detail);
            return $report;
        });
        return json(['ok' => true, 'data' => ['report_id' => $report, 'status' => 'uploaded', 'schema_version' => $detail['schema_version'] ?? 1, 'diagnostic_id' => $detail['diagnostic_id'] ?? null]], 201);
    }
}
