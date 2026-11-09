<?php

namespace app\Service;

use DateTimeImmutable;
use DateTimeInterface;
use RuntimeException;
use think\facade\Db;

/**
 * Processes the server-side account retention policy.
 *
 * Removes personal data while retaining an anonymous user key for financial references.
 */
final class AccountRetentionService
{
    private const ALLOWED_DAYS = [0, 30, 90, 180, 365];

    public function process(?DateTimeInterface $now = null, ?array $onlyUserIds = null): array
    {
        $now = $now ? DateTimeImmutable::createFromInterface($now) : new DateTimeImmutable();
        $nowSql = $now->format('Y-m-d H:i:s');
        $checked = 0;
        $deleted = [];

        $query = Db::name('users')->where('status', 'active');
        if ($onlyUserIds !== null) { if ($onlyUserIds === []) return ['checked' => 0, 'deleted' => 0, 'users' => [], 'processed_at' => $nowSql]; $query->whereIn('id', array_map('intval', $onlyUserIds)); }
        $users = $query->field('id,created_at')->select()->toArray();
        foreach ($users as $user) {
            $checked++;
            $userId = (int) $user['id'];
            $days = $this->retentionDays($userId);
            if ($days <= 0) continue;

            $lastActive = $this->lastActivity($userId, (string) ($user['created_at'] ?? ''), $nowSql);
            if ($lastActive === null) continue;
            $cutoff = $now->modify(sprintf('-%d days', $days));
            if (new DateTimeImmutable($lastActive) >= $cutoff) continue;

            $changed = Db::transaction(function () use ($userId, $nowSql, $now): bool {
                // Match the wallet -> user ordering used by the financial services.
                $wallet = Db::name('wallets')->where('user_id', $userId)->lock(true)->find();
                // Historical funds are retained until an operator has completed settlement.
                if ($wallet && ((int) $wallet['available_fen'] !== 0 || (int) $wallet['frozen_fen'] !== 0)) return false;
                // Packets already deducted from the wallet and pending applications
                // still require manual settlement, even when the wallet reads zero.
                if (Db::name('red_packets')->where('sender_id', $userId)->where('remaining_fen', '>', 0)->lock(true)->find()) return false;
                if (Db::name('wallet_requests')->where('user_id', $userId)->where('status', 'pending')->lock(true)->find()) return false;
                $current = Db::name('users')->where('id', $userId)->where('status', 'active')->lock(true)->find();
                if (!$current) return false;
                $days = $this->retentionDays($userId);
                $activity = $this->lastActivity($userId, $current['created_at'], $nowSql);
                if ($days <= 0 || !$activity || new DateTimeImmutable($activity) >= $now->modify('-' . $days . ' days')) return false;
                $updated = Db::name('users')->where('id', $userId)->where('status', 'active')->update([
                    'status' => 'deleted',
                    'nickname' => '已注销用户', 'phone' => null, 'username' => null,
                    'birthday' => null, 'gender' => null, 'signature' => null, 'avatar_url' => null, 'register_ip' => null,
                    'password_hash' => password_hash(bin2hex(random_bytes(32)), PASSWORD_DEFAULT),
                    'updated_at' => $nowSql,
                ]);
                if (!$updated) return false;
                Db::name('auth_tokens')->where('user_id', $userId)->delete();
                Db::name('user_presence')->where('user_id', $userId)->delete();
                foreach (['user_settings', 'user_security', 'notification_devices', 'login_logs', 'user_password_vault'] as $table) Db::name($table)->where('user_id', $userId)->delete();
                Db::name('contacts')->where(function ($q) use ($userId): void { $q->where('user_id', $userId)->whereOr('contact_user_id', $userId); })->delete();
                Db::name('contact_requests')->where(function ($q) use ($userId): void { $q->where('from_user_id', $userId)->whereOr('to_user_id', $userId); })->delete();
                Db::name('user_blocks')->where(function ($q) use ($userId): void { $q->where('blocker_id', $userId)->whereOr('blocked_id', $userId); })->delete();
                Db::name('message_receipts')->where('user_id', $userId)->delete();
                Db::execute('DELETE r FROM message_receipts r JOIN messages m ON m.id = r.message_id WHERE m.sender_id = ?', [$userId]);
                Db::execute('DELETE e FROM realtime_events e JOIN messages m ON m.id = e.message_id WHERE m.sender_id = ?', [$userId]);
                if ((string) env('REALTIME_QUEUE_ROUTINE', '') !== '') Db::execute('DELETE e FROM realtime_outbox e JOIN messages m ON m.id = e.message_id WHERE m.sender_id = ?', [$userId]);
                Db::name('messages')->where('sender_id', $userId)->delete();
                Db::name('group_poll_votes')->where('user_id', $userId)->delete();
                Db::name('group_polls')->where('creator_id', $userId)->delete();
                Db::name('conversation_folder_items')->where('user_id', $userId)->delete();
                Db::name('conversation_folders')->where('user_id', $userId)->delete();
                foreach (Db::name('conversations')->where('owner_id', $userId)->select()->toArray() as $conversation) {
                    $id = (int) $conversation['id'];
                    $successor = Db::name('conversation_members')->alias('m')->join('users u', 'u.id = m.user_id')->where('m.conversation_id', $id)->where('m.user_id', '<>', $userId)->where('u.status', 'active')->orderRaw("FIELD(m.role, 'admin', 'member', 'owner')")->value('m.user_id');
                    if (in_array($conversation['type'], ['group', 'channel', 'customer_service'], true) && $successor) {
                        Db::name('conversation_members')->where('conversation_id', $id)->where('user_id', $successor)->update(['role' => 'owner']);
                        Db::name('conversations')->where('id', $id)->update(['owner_id' => $successor]);
                    } elseif (!$successor) Db::name('conversations')->where('id', $id)->update(['status' => 'disabled', 'name' => '已注销会话', 'avatar_url' => null, 'description' => null, 'announcement' => null, 'invite_code' => null]);
                }
                Db::name('conversation_members')->where('user_id', $userId)->delete();
                return true;
            });
            if ($changed) $deleted[] = ['user_id' => $userId, 'last_active_at' => $lastActive, 'retention_days' => $days];
        }

        return [
            'checked' => $checked,
            'deleted' => count($deleted),
            'users' => $deleted,
            'processed_at' => $nowSql,
        ];
    }

    private function retentionDays(int $userId): int
    {
        $json = Db::name('user_settings')->where('user_id', $userId)->value('settings_json');
        // UserSettingsService 的默认值是 6 个月；没有旧设置记录的账号也应遵循这个默认策略。
        if (!is_string($json) || $json === '') return 180;
        $settings = json_decode($json, true);
        $days = is_array($settings) ? (int) ($settings['account_auto_delete_days'] ?? 180) : 180;
        return in_array($days, self::ALLOWED_DAYS, true) ? $days : 0;
    }

    private function lastActivity(int $userId, string $createdAt, string $nowSql): ?string
    {
        $values = [];
        $presence = Db::name('user_presence')->where('user_id', $userId)->value('last_seen_at');
        if (is_string($presence) && $presence !== '') $values[] = $presence;
        $tokenActivity = Db::name('auth_tokens')->where('user_id', $userId)->where('expires_at', '>', $nowSql)->max('last_used_at');
        if (is_string($tokenActivity) && $tokenActivity !== '') $values[] = $tokenActivity;
        $loginActivity = Db::name('login_logs')->where('user_id', $userId)->where('success', 1)->max('created_at');
        if (is_string($loginActivity) && $loginActivity !== '') $values[] = $loginActivity;
        if ($createdAt !== '') $values[] = $createdAt;
        if ($values === []) return null;
        usort($values, static fn (string $a, string $b): int => strcmp($a, $b));
        return end($values) ?: null;
    }
}
