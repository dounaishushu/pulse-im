<?php
namespace app\Service;

use RuntimeException;

/** Explicit schema: no arbitrary exception messages, URLs, credentials or message bodies. */
final class ClientDiagnosticPayload
{
    public static function parse(string $raw): array
    {
        if (strlen($raw) > 32768) throw new RuntimeException('日志内容过大。');
        $data = json_decode($raw, true);
        if (!is_array($data) || !in_array($data['platform'] ?? '', ['android', 'ios'], true)) throw new RuntimeException('日志格式无效。');
        $detail = [];
        foreach (['app_name', 'app_version', 'model'] as $field) {
            if (!is_string($data[$field] ?? null) || mb_strlen($data[$field]) > 80) throw new RuntimeException('日志设备信息无效。');
            $detail[$field] = $data[$field];
        }
        $detail['platform'] = $data['platform'];
        $sdk = filter_var($data['sdk'] ?? null, FILTER_VALIDATE_INT);
        if ($sdk === false || $sdk < 1 || $sdk > 100) throw new RuntimeException('日志版本信息无效。');
        $detail['sdk'] = $sdk;
        $events = $data['events'] ?? [];
        if (!is_array($events) || !array_is_list($events) || count($events) > 100) throw new RuntimeException('日志事件数量无效。');
        $detail['events'] = [];
        foreach ($events as $event) {
            if (!is_array($event) || !preg_match('/^[a-z][a-z0-9._]{0,63}$/D', (string) ($event['event'] ?? '')) || !in_array($event['status'] ?? '', ['success', 'failed'], true) || !is_int($event['at'] ?? null) || $event['at'] <= 0) throw new RuntimeException('日志事件无效。');
            $detail['events'][] = array_intersect_key($event, array_flip(['event', 'status', 'at']));
        }
        if (($data['schema_version'] ?? 1) === 1) return $detail;
        if (($data['schema_version'] ?? null) !== 2 || $data['platform'] !== 'android' || !is_string($data['diagnostic_id'] ?? null)
            || !preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D', $data['diagnostic_id'])
            || !in_array($data['upload_mode'] ?? '', ['automatic', 'manual'], true)) throw new RuntimeException('诊断报告编号无效。');
        $detail['schema_version'] = 2;
        $detail['diagnostic_id'] = $data['diagnostic_id'];
        $detail['upload_mode'] = $data['upload_mode'];
        $incidents = $data['incidents'] ?? null;
        if (!is_array($incidents) || !array_is_list($incidents) || count($incidents) < 1 || count($incidents) > 4) throw new RuntimeException('诊断异常数量无效。');
        $detail['incidents'] = [];
        $codes = ['ANDROID_JAVA_CRASH', 'ANDROID_MAIN_STALL', 'ANDROID_PROCESS_EXIT', 'ANDROID_MEMORY', 'ANDROID_SESSION_RESTORE', 'ANDROID_SOCKET_LOST', 'ANDROID_SOCKET_TIMEOUT', 'ANDROID_SOCKET_PACKET'];
        foreach ($incidents as $incident) {
            if (!is_array($incident) || !in_array($incident['code'] ?? '', $codes, true) || !is_int($incident['at'] ?? null) || $incident['at'] <= 0
                || !is_bool($incident['foreground'] ?? null) || !is_string($incident['exception_class'] ?? null)
                || !preg_match('/^[A-Za-z0-9_.$]{0,160}$/D', $incident['exception_class'])) throw new RuntimeException('诊断异常格式无效。');
            $safe = array_intersect_key($incident, array_flip(['code', 'at', 'foreground', 'exception_class']));
            foreach (['duration_ms' => 86400000, 'heap_used_kb' => 16777216, 'heap_limit_kb' => 16777216, 'exit_reason' => 30] as $key => $maximum) {
                if (!array_key_exists($key, $incident)) continue;
                if (!is_int($incident[$key]) || $incident[$key] < 0 || $incident[$key] > $maximum) throw new RuntimeException('诊断数值无效。');
                $safe[$key] = $incident[$key];
            }
            $frames = $incident['frames'] ?? [];
            if (!is_array($frames) || !array_is_list($frames) || count($frames) > 20) throw new RuntimeException('诊断调用栈过大。');
            foreach ($frames as $frame) if (!is_string($frame) || !preg_match('/^[A-Za-z0-9_.$<>():-]{1,220}$/D', $frame)) throw new RuntimeException('诊断调用栈格式无效。');
            $safe['frames'] = $frames;
            $detail['incidents'][] = $safe;
        }
        return $detail;
    }
}
