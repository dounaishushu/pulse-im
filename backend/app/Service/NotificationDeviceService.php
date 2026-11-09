<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

final class NotificationDeviceService
{
    private const PLATFORMS = ['ios', 'android', 'web'];

    public function register(int $userId, string $platform, string $token, string $sessionHash = ''): array
    {
        $platform = strtolower(trim($platform));
        $token = trim($token);
        if ($userId <= 0 || !in_array($platform, self::PLATFORMS, true) || strlen($token) < 16 || strlen($token) > 512) {
            throw new RuntimeException('Invalid notification device parameters.');
        }
        $now = date('Y-m-d H:i:s');
        if (!preg_match('/^[a-f0-9]{64}$/D', $sessionHash) || !Db::name('auth_tokens')->where('user_id', $userId)->where('token_hash', $sessionHash)->where('expires_at', '>', $now)->find()) throw new RuntimeException('推送设备必须绑定有效登录会话。');
        // The unique token owns one current account/session even when token refreshes overlap.
        Db::execute('INSERT INTO notification_devices (user_id,auth_token_hash,platform,device_token,enabled,last_used_at,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),auth_token_hash=VALUES(auth_token_hash),platform=VALUES(platform),enabled=1,last_used_at=VALUES(last_used_at),updated_at=VALUES(updated_at)', [$userId, $sessionHash, $platform, $token, $now, $now, $now]);
        $id = Db::name('notification_devices')->where('device_token', $token)->value('id');
        return ['id' => (int) $id, 'platform' => $platform, 'status' => 'registered'];
    }

    public function unregister(int $userId, string $token): array
    {
        if ($userId <= 0 || trim($token) === '') throw new RuntimeException('Invalid notification device token.');
        $updated = Db::name('notification_devices')->where('user_id', $userId)->where('device_token', trim($token))->update(['enabled' => 0, 'updated_at' => date('Y-m-d H:i:s')]);
        return ['status' => $updated ? 'unregistered' : 'already_unregistered'];
    }

    public function list(int $userId): array
    {
        return ['items' => Db::name('notification_devices')->where('user_id', $userId)->where('enabled', 1)->field('id,platform,created_at,last_used_at')->order('id', 'desc')->select()->toArray()];
    }
}
