<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

final class UserSettingsService
{
    private const MANAGED_PRIVACY_KEYS = [
        'phone_visibility', 'phone_search_visibility', 'last_seen_visibility',
        'voice_call_visibility', 'voice_call_peer_to_peer', 'invite_visibility', 'privacy_exceptions',
    ];

    private const DEFAULTS = [
        'phone_visibility' => 'nobody',
        'phone_search_visibility' => 'everyone',
        'last_seen_visibility' => 'everyone',
        'voice_call_visibility' => 'everyone',
        'voice_call_peer_to_peer' => 'everyone',
        'invite_visibility' => 'everyone',
        'show_active_sessions' => true,
        // 0 表示关闭；其它值是离线多少天后自动注销账号。
        'account_auto_delete_days' => 180,
        'privacy_exceptions' => [
            'phone_visibility_always' => [],
            'phone_search_always' => [],
            'last_seen_never' => [],
            'voice_call_never' => [],
            'invite_never' => [],
        ],
    ];

    public function get(int $userId): array
    {
        // One fresh query also covers staff accounts that have not saved settings yet.
        $row = Db::name('users')->alias('u')
            ->leftJoin('user_settings s', 's.user_id = u.id')
            ->leftJoin('user_permissions p', 'p.user_id = u.id')
            ->where('u.id', $userId)->field('s.settings_json,p.internal_staff,u.status')->find();
        $result = $this->fromStorage($row['settings_json'] ?? null);
        $result['can_manage_privacy'] = ($row['status'] ?? '') === 'active' && (int) ($row['internal_staff'] ?? 0) === 1;
        return $result;
    }

    /** Normalize an already fetched settings row without another database read. */
    public function fromStorage(?string $json): array
    {
        $settings = json_decode((string) $json, true);
        $result = array_merge(self::DEFAULTS, is_array($settings) ? $settings : []);
        $result['privacy_exceptions'] = $this->normalizeExceptions($result['privacy_exceptions'] ?? []);
        $days = (int) ($result['account_auto_delete_days'] ?? self::DEFAULTS['account_auto_delete_days']);
        $result['account_auto_delete_days'] = in_array($days, [0, 30, 90, 180, 365], true) ? $days : self::DEFAULTS['account_auto_delete_days'];
        return $result;
    }

    public function update(int $userId, array $patch): array
    {
        return Db::transaction(function () use ($userId, $patch): array {
            if (!Db::name('users')->where('id', $userId)->where('status', 'active')->lock(true)->find()) throw new RuntimeException('用户账号不可用。');
            $permission = Db::name('user_permissions')->where('user_id', $userId)->lock(true)->find();
            $canManage = (int) ($permission['internal_staff'] ?? 0) === 1;
            // Never trust posted roles, platform headers, payroll status or an old token snapshot.
            if (!$canManage && array_intersect(self::MANAGED_PRIVACY_KEYS, array_keys($patch))) {
                throw new RuntimeException('普通用户无权修改这些隐私设置。', 403);
            }
            $settings = array_merge($this->get($userId), $this->validated($patch));
            unset($settings['can_manage_privacy']);
            $now = date('Y-m-d H:i:s');
            $payload = ['settings_json' => json_encode($settings, JSON_UNESCAPED_UNICODE), 'updated_at' => $now];
            if (Db::name('user_settings')->where('user_id', $userId)->find()) Db::name('user_settings')->where('user_id', $userId)->update($payload);
            else Db::name('user_settings')->insert($payload + ['user_id' => $userId, 'created_at' => $now]);
            return $settings + ['can_manage_privacy' => $canManage];
        });
    }

    public function canView(array $settings, string $key, int $viewerId, bool $isContact = false): bool
    {
        $exceptionMap = [
            'phone_visibility' => ['always' => 'phone_visibility_always'],
            'phone_search_visibility' => ['always' => 'phone_search_always'],
            'last_seen_visibility' => ['never' => 'last_seen_never'],
            'voice_call_visibility' => ['never' => 'voice_call_never'],
            'invite_visibility' => ['never' => 'invite_never'],
        ];
        $exceptions = $settings['privacy_exceptions'] ?? [];
        $map = $exceptionMap[$key] ?? [];
        if ($viewerId > 0 && isset($map['never']) && in_array($viewerId, $exceptions[$map['never']] ?? [], true)) return false;
        if ($viewerId > 0 && isset($map['always']) && in_array($viewerId, $exceptions[$map['always']] ?? [], true)) return true;
        $visibility = (string) ($settings[$key] ?? 'everyone');
        if ($visibility === 'nobody') return false;
        return $visibility === 'everyone' || ($visibility === 'contacts' && $isContact);
    }

    private function validated(array $patch): array
    {
        $result = [];
        foreach (['phone_visibility', 'last_seen_visibility', 'voice_call_visibility', 'invite_visibility', 'voice_call_peer_to_peer'] as $key) {
            if (array_key_exists($key, $patch)) {
                $value = (string) $patch[$key];
                if (!in_array($value, ['everyone', 'contacts', 'nobody'], true)) throw new RuntimeException('隐私设置值无效。');
                $result[$key] = $value;
            }
        }
        if (array_key_exists('phone_search_visibility', $patch)) {
            $value = (string) $patch['phone_search_visibility'];
            if (!in_array($value, ['everyone', 'contacts'], true)) throw new RuntimeException('手机号搜索设置值无效。');
            $result['phone_search_visibility'] = $value;
        }
        if (array_key_exists('show_active_sessions', $patch)) $result['show_active_sessions'] = (bool) $patch['show_active_sessions'];
        if (array_key_exists('account_auto_delete_days', $patch)) {
            $value = filter_var($patch['account_auto_delete_days'], FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]);
            if ($value === false || !in_array((int) $value, [0, 30, 90, 180, 365], true)) {
                throw new RuntimeException('自动删除账号的时间范围无效。');
            }
            $result['account_auto_delete_days'] = (int) $value;
        }
        if (array_key_exists('privacy_exceptions', $patch)) $result['privacy_exceptions'] = $this->normalizeExceptions($patch['privacy_exceptions']);
        return $result;
    }

    private function normalizeExceptions(mixed $value): array
    {
        $keys = array_keys(self::DEFAULTS['privacy_exceptions']);
        if (!is_array($value)) throw new RuntimeException('隐私例外设置格式无效。');
        $result = [];
        foreach ($keys as $key) {
            $items = $value[$key] ?? [];
            if (!is_array($items) || count($items) > 100) throw new RuntimeException('隐私例外用户数量无效。');
            $ids = [];
            foreach ($items as $id) {
                $id = filter_var($id, FILTER_VALIDATE_INT);
                if ($id === false || $id <= 0) throw new RuntimeException('隐私例外用户无效。');
                $ids[] = (int) $id;
            }
            $result[$key] = array_values(array_unique($ids));
        }
        return $result;
    }
}
