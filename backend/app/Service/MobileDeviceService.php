<?php
declare(strict_types=1);
namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** Persistent per-account phone binding. Callers lock policy before locking users. */
final class MobileDeviceService
{
    public const LOCKED = '该账号已绑定其他手机，请联系管理员解除设备绑定后再登录。';
    public const UPDATE_REQUIRED = '请更新手机端后重新登录，以完成设备验证。';
    public static function mobile(string $platform): bool { return in_array(strtolower(trim($platform)), ['android', 'ios'], true); }

    public function lockPolicy(string $platform): ?array
    {
        if (!self::mobile($platform)) return null;
        $row = Db::name('mobile_device_policy')->where('id', 1)->lock('LOCK IN SHARE MODE')->find();
        if (!$row) throw new RuntimeException('设备验证服务暂不可用，请联系管理员。');
        return $row;
    }

    /** AuthService owns the current user-row lock and surrounding transaction. */
    public function bindLogin(int $userId, string $platform, string $deviceId, string $deviceName, ?array $policy): bool
    {
        if (!self::mobile($platform) || empty($policy['enabled'])) return false;
        if ((int) Db::name('user_permissions')->where('user_id', $userId)->value('internal_staff') === 1) return false;
        $platform = strtolower(trim($platform));
        if (!preg_match('/^' . $platform . '_[a-f0-9]{64}$/D', $deviceId)) throw new RuntimeException(self::UPDATE_REQUIRED);
        $hash = hash('sha256', $deviceId);
        $binding = Db::name('mobile_device_bindings')->where('user_id', $userId)->lock(true)->find();
        if ($binding && !hash_equals($binding['device_hash'], $hash)) throw new RuntimeException(self::LOCKED);
        $name = mb_substr(trim(preg_replace('/[\p{Cc}\p{Cf}]/u', '', $deviceName) ?? ''), 0, 128);
        $now = date('Y-m-d H:i:s');
        if ($binding) Db::name('mobile_device_bindings')->where('id', $binding['id'])->update(['last_login_at' => $now, 'device_name' => $name]);
        else Db::name('mobile_device_bindings')->insert(['user_id' => $userId, 'device_hash' => $hash, 'platform' => $platform, 'device_name' => $name, 'bound_at' => $now, 'last_login_at' => $now]);
        $this->revokeMobile([$userId]);
        return true;
    }

    private function revokeMobile(array $userIds): array
    {
        if (!$userIds) return ['revoked_sessions' => 0, 'disabled_push_devices' => 0];
        $sessions = (int) Db::name('auth_tokens')->whereIn('user_id', $userIds)->whereIn('device_type', ['android', 'ios'])->delete();
        $push = (int) Db::name('notification_devices')->whereIn('user_id', $userIds)->whereIn('platform', ['android', 'ios'])->where('enabled', 1)->update(['enabled' => 0, 'updated_at' => date('Y-m-d H:i:s')]);
        return ['revoked_sessions' => $sessions, 'disabled_push_devices' => $push];
    }

    public function changeStaffStatus(int $userId, bool $staff): void
    {
        Db::transaction(function () use ($userId, $staff): void {
            $policy = $this->lockPolicy('android');
            if (!Db::name('users')->where('id', $userId)->lock(true)->find()) throw new RuntimeException('用户不存在。');
            $row = Db::name('user_permissions')->where('user_id', $userId)->find();
            $values = ['internal_staff' => (int) $staff, 'updated_at' => date('Y-m-d H:i:s')];
            if ($row) Db::name('user_permissions')->where('user_id', $userId)->update($values);
            else Db::name('user_permissions')->insert(['user_id' => $userId] + $values);
            if (!$staff && !empty($row['internal_staff']) && !empty($policy['enabled'])) $this->revokeMobile([$userId]);
        });
    }

    public function listing(string $keyword = '', int $page = 1, int $size = 30): array
    {
        $keyword = trim($keyword);
        if (mb_strlen($keyword) > 128) throw new RuntimeException('搜索内容不能超过128个字符。');
        $size = max(1, min(100, $size));
        $query = Db::name('mobile_device_bindings')->alias('b')->join('users u', 'u.id=b.user_id')->order('b.id', 'desc');
        if ($keyword !== '') $query->where(function ($q) use ($keyword): void {
            $pattern = '%' . strtr($keyword, ['!' => '!!', '%' => '!%', '_' => '!_']) . '%';
            $q->whereRaw("u.username LIKE :device_username ESCAPE '!' OR u.nickname LIKE :device_nickname ESCAPE '!'", ['device_username' => $pattern, 'device_nickname' => $pattern]);
            $q->whereOr('u.public_id', $keyword);
            if (ctype_digit($keyword)) $q->whereOr('u.id', (int) $keyword);
        });
        $rows = $query->field('b.id,b.user_id,b.device_hash,b.platform,b.device_name,b.bound_at,b.last_login_at,u.username,u.nickname,u.public_id,u.status')->paginate(['list_rows' => $size, 'page' => max(1, $page)]);
        $items = array_map(static function (array $row): array {
            $row['device_id'] = $row['platform'] . '_' . substr($row['device_hash'], 0, 24);
            unset($row['device_hash']);
            return $row;
        }, $rows->items());
        $policy = Db::name('mobile_device_policy')->where('id', 1)->find();
        if (!$policy) throw new RuntimeException('设备锁配置尚未就绪。');
        return ['items' => $items, 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size,
            'locked_total' => (int) Db::name('mobile_device_bindings')->count(), 'enabled' => (bool) $policy['enabled']];
    }

    private function replay(int $adminId, string $action, string $requestId, ?int $userId = null): ?array
    {
        if (!preg_match('/^[A-Za-z0-9_-]{16,80}$/D', $requestId)) throw new RuntimeException('操作标识无效，请刷新后重试。');
        $query = Db::name('admin_audit_logs')->where('admin_id', $adminId)->where('action', $action)->where('request_id', $requestId);
        if ($userId !== null) $query->where('target_id', $userId);
        // The exclusive policy lock serializes admin mutations. A fresh normal
        // read avoids range-locking unrelated audit writers.
        $row = $query->find();
        return $row ? json_decode($row['detail_json'], true, 512, JSON_THROW_ON_ERROR) + ['already_applied' => true] : null;
    }

    private function audit(int $adminId, string $action, ?int $userId, string $requestId, string $ip, array $result): array
    {
        (new AuditService())->log($adminId, $action, 'mobile_device', $userId, $requestId, $ip, $result);
        return $result;
    }

    public function unbind(int $userId, int $bindingId, int $adminId, string $requestId, string $ip): array
    {
        if ($userId <= 0 || $bindingId <= 0) throw new RuntimeException('请选择需要解绑的设备。');
        return Db::transaction(function () use ($userId, $bindingId, $adminId, $requestId, $ip): array {
            if (!Db::name('mobile_device_policy')->where('id', 1)->lock(true)->find()) throw new RuntimeException('设备锁配置尚未就绪。');
            if (!Db::name('users')->where('id', $userId)->lock(true)->find()) throw new RuntimeException('用户不存在。');
            if ($previous = $this->replay($adminId, 'mobile_device.unbind', $requestId, $userId)) return $previous;
            $binding = Db::name('mobile_device_bindings')->where('user_id', $userId)->lock(true)->find();
            if (!$binding || (int) $binding['id'] !== $bindingId) throw new RuntimeException('设备绑定已更新，请刷新后重试。');
            // Release only the binding. Existing tokens and push registrations
            // remain valid until a later successful login replaces the session.
            $result = ['user_id' => $userId, 'unbound_count' => 1, 'revoked_sessions' => 0, 'disabled_push_devices' => 0];
            Db::name('mobile_device_bindings')->where('id', $bindingId)->delete();
            return $this->audit($adminId, 'mobile_device.unbind', $userId, $requestId, $ip, $result);
        });
    }

    public function unbindAll(int $adminId, string $requestId, string $ip): array
    {
        return Db::transaction(function () use ($adminId, $requestId, $ip): array {
            // Exclusive policy lock waits for in-flight logins, then blocks new binds until commit.
            if (!Db::name('mobile_device_policy')->where('id', 1)->lock(true)->find()) throw new RuntimeException('设备锁配置尚未就绪。');
            if ($previous = $this->replay($adminId, 'mobile_device.unbind_all', $requestId)) return $previous;
            $result = ['unbound_count' => 0, 'revoked_sessions' => 0, 'disabled_push_devices' => 0];
            do {
                $ids = array_map('intval', Db::name('mobile_device_bindings')->order('id')->limit(500)->column('user_id'));
                if (!$ids) break;
                $result['unbound_count'] += (int) Db::name('mobile_device_bindings')->whereIn('user_id', $ids)->delete();
            } while (true);
            return $this->audit($adminId, 'mobile_device.unbind_all', null, $requestId, $ip, $result);
        });
    }

    public function setEnabled(bool $enabled, int $adminId, string $requestId, string $ip): array
    {
        return Db::transaction(function () use ($enabled, $adminId, $requestId, $ip): array {
            $row = Db::name('mobile_device_policy')->where('id', 1)->lock(true)->find();
            if (!$row) throw new RuntimeException('设备锁配置尚未就绪。');
            if ($previous = $this->replay($adminId, 'mobile_device.policy', $requestId)) return $previous;
            $result = ['enabled' => $enabled, 'revoked_sessions' => 0, 'disabled_push_devices' => 0];
            if ($enabled && !(bool) $row['enabled']) {
                // Existing mobile sessions predate binding. A fresh login establishes the first phone.
                $ordinary = static function ($q): void { $q->name('users')->alias('u')->leftJoin('user_permissions p', 'p.user_id=u.id')->whereRaw('COALESCE(p.internal_staff,0)=0')->field('u.id'); };
                $result['revoked_sessions'] = (int) Db::name('auth_tokens')->whereIn('user_id', $ordinary)->whereIn('device_type', ['android', 'ios'])->delete();
                $result['disabled_push_devices'] = (int) Db::name('notification_devices')->whereIn('user_id', $ordinary)->whereIn('platform', ['android', 'ios'])->where('enabled', 1)->update(['enabled' => 0, 'updated_at' => date('Y-m-d H:i:s')]);
            }
            Db::name('mobile_device_policy')->where('id', 1)->update(['enabled' => (int) $enabled, 'updated_at' => date('Y-m-d H:i:s')]);
            return $this->audit($adminId, 'mobile_device.policy', null, $requestId, $ip, $result);
        });
    }
}
