<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** Personal activity is durable and independent of conversation visibility. */
final class UserNotificationService
{
    public function summary(int $userId): array
    {
        return ['unread_count' => (int) Db::name('user_notifications')->where('user_id', $userId)->whereNull('read_at')->count()];
    }

    public function list(int $userId, int $beforeId = 0, int $limit = 30): array
    {
        $limit = min(50, max(1, $limit));
        // Keep the notification snapshot intact, but use the author's current
        // avatar so an old event follows later uploads, changes and removals.
        $query = Db::name('user_notifications')->alias('n')
            ->leftJoin('users a', 'a.id=n.actor_id')->where('n.user_id', $userId)
            ->field('n.*,a.avatar_url AS current_actor_avatar_url');
        if ($beforeId > 0) $query->where('n.id', '<', $beforeId);
        $rows = $query->order('n.id', 'desc')->limit($limit + 1)->select()->toArray();
        $hasMore = count($rows) > $limit;
        $rows = array_slice($rows, 0, $limit);
        $groupIds = array_values(array_unique(array_filter(array_column($rows, 'conversation_id'))));
        $readable = $groupIds === [] ? [] : Db::name('conversation_members')->alias('m')->join('conversations c', 'c.id=m.conversation_id')
            ->where('m.user_id', $userId)->whereIn('m.conversation_id', $groupIds)->where('c.status', 'active')->column('m.conversation_id');
        $readable = array_fill_keys(array_map('intval', $readable), true);
        $items = array_map(static function (array $row) use ($readable): array {
            $body = json_decode((string) $row['body_json'], true, 512, JSON_THROW_ON_ERROR);
            return [
                'id' => (int) $row['id'], 'type' => $row['type'], 'actor_id' => (int) $row['actor_id'],
                'actor_name' => (string) ($body['actor_name'] ?? '用户'), 'actor_avatar_url' => $row['current_actor_avatar_url'] ?? null,
                'conversation_id' => $row['conversation_id'] === null ? null : (int) $row['conversation_id'],
                'group_name' => (string) ($body['group_name'] ?? ''), 'message' => (string) ($body['message'] ?? ''),
                'request_id' => $row['request_id'] === null ? null : (int) $row['request_id'],
                'request_status' => $row['request_status'], 'unread' => $row['read_at'] === null,
                'can_open_group' => $row['type'] === 'group.invited' && isset($readable[(int) $row['conversation_id']]),
                'created_at' => $row['created_at'],
            ];
        }, $rows);
        return ['items' => $items, 'has_more' => $hasMore, 'next_before_id' => $hasMore ? (int) end($rows)['id'] : null] + $this->summary($userId);
    }

    /** Only explicitly displayed IDs may be acknowledged, always for this user. */
    public function read(int $userId, mixed $ids): array
    {
        if (!is_array($ids) || count($ids) > 100) throw new RuntimeException('通知参数无效。');
        foreach ($ids as $id) if (!is_int($id) || $id <= 0) throw new RuntimeException('通知编号无效。');
        $ids = array_values(array_unique($ids));
        return Db::transaction(function () use ($userId, $ids): array {
            $changed = $ids === [] ? 0 : Db::name('user_notifications')->where('user_id', $userId)->whereIn('id', $ids)->whereNull('read_at')->update(['read_at' => date('Y-m-d H:i:s')]);
            if ($changed) $this->signal($userId);
            return ['read_count' => (int) $changed] + $this->summary($userId);
        });
    }

    public function friendRequest(int $userId, int $actorId, int $requestId, string $message): int
    {
        return $this->record($userId, 'friend.request', $actorId, null, ['message' => $message], $requestId);
    }

    /** A device cursor is independent of the notification centre's read state. */
    public function friendChats(int $userId, int $afterId = 0): array
    {
        $rows = Db::name('user_notifications')->alias('n')
            ->join('conversations c', 'c.id=n.conversation_id')
            ->join('conversation_members m', 'm.conversation_id=c.id AND m.user_id=n.user_id')
            ->join('contacts f', 'f.user_id=n.user_id AND f.contact_user_id=n.actor_id')
            ->where('n.user_id', $userId)->where('n.id', '>', max(0, $afterId))
            ->whereIn('n.type', ['friend.accepted', 'friend.added'])
            ->where('c.type', 'direct')->where('c.status', 'active')
            // A later manual hide/archive must not be undone by an old offer.
            ->whereNull('m.hidden_at')->where('m.is_archived', 0)
            ->whereExists(function ($query): void {
                $query->name('conversation_members')->alias('peer')->field('peer.user_id')
                    ->whereRaw('peer.conversation_id=c.id AND peer.user_id=n.actor_id');
            })
            ->field('n.id,n.conversation_id,n.actor_id')->order('n.id', 'desc')->limit(1)->select()->toArray();
        return ['items' => array_map(static fn (array $row): array => [
            'id' => (int) $row['id'], 'conversation_id' => (int) $row['conversation_id'], 'peer_user_id' => (int) $row['actor_id'],
        ], $rows)];
    }

    public function friendAccepted(int $userId, int $actorId, ?int $conversationId = null, bool $signal = true): int
    {
        return $this->record($userId, 'friend.accepted', $actorId, $conversationId, [], null, $signal);
    }

    public function friendAdded(int $userId, int $actorId, ?int $conversationId = null, bool $signal = true): int
    {
        return $this->record($userId, 'friend.added', $actorId, $conversationId, [], null, $signal);
    }

    public function group(int $userId, int $actorId, array $group, bool $removed = false): int
    {
        return $this->record($userId, $removed ? 'group.removed' : 'group.invited', $actorId, (int) $group['id'], ['group_name' => (string) $group['name']]);
    }

    /** Caller holds the membership transaction; no per-recipient reads or commits. */
    public function groupBatch(array $userIds, array $actor, array $group, string $now): void
    {
        if (!$userIds) return;
        $rows = []; $selects = []; $bind = []; $count = count($userIds);
        $body = json_encode(['group_name' => (string) $group['name'], 'actor_name' => $actor['nickname'] ?? '用户',
            'actor_avatar_url' => $actor['avatar_url'] ?? null], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        foreach (array_values($userIds) as $offset => $id) {
            $rows[] = ['user_id' => $id, 'type' => 'group.invited', 'actor_id' => (int) $actor['id'], 'conversation_id' => (int) $group['id'],
                'request_id' => null, 'pending_request_id' => null, 'request_status' => null, 'body_json' => $body, 'created_at' => $now];
            $selects[] = "SELECT last_id - $count + " . ($offset + 1) . ",0,0,'notification.updated',?,? FROM realtime_sequence WHERE id=1";
            $bind[] = json_encode(['user_id' => (int) $id], JSON_THROW_ON_ERROR); $bind[] = $now;
        }
        Db::name('user_notifications')->insertAll($rows);
        if (Db::execute('UPDATE realtime_sequence SET last_id=last_id+? WHERE id=1', [$count]) !== 1) throw new RuntimeException('通知事件队列未初始化。');
        Db::execute('INSERT INTO realtime_events(id,message_id,conversation_id,event_type,payload_json,created_at) ' . implode(' UNION ALL ', $selects), $bind);
    }

    public function resolveRequest(int $requestId, string $status, bool $signal = true): void
    {
        if (!in_array($status, ['accepted', 'rejected'], true)) throw new RuntimeException('通知状态无效。');
        $row = Db::name('user_notifications')->where('pending_request_id', $requestId)->lock(true)->find();
        if (!$row) return;
        Db::name('user_notifications')->where('id', $row['id'])->update([
            'pending_request_id' => null, 'request_status' => $status, 'read_at' => $row['read_at'] ?? date('Y-m-d H:i:s'),
        ]);
        if ($signal) $this->signal((int) $row['user_id']);
    }

    public function assertPendingRequest(int $userId, int $notificationId, int $requestId): void
    {
        $row = Db::name('user_notifications')->where('id', $notificationId)->where('user_id', $userId)->lock(true)->find();
        if (!$row || (int) $row['pending_request_id'] !== $requestId || $row['request_status'] !== 'pending') {
            throw new RuntimeException('这条好友申请已经处理，请刷新通知。');
        }
    }

    private function record(int $userId, string $type, int $actorId, ?int $conversationId = null, array $body = [], ?int $requestId = null, bool $signal = true): int
    {
        return Db::transaction(function () use ($userId, $type, $actorId, $conversationId, $body, $requestId, $signal): int {
            $actor = Db::name('users')->where('id', $actorId)->field('nickname,avatar_url')->find();
            $body += ['actor_name' => $actor['nickname'] ?? '用户', 'actor_avatar_url' => $actor['avatar_url'] ?? null];
            $id = (int) Db::name('user_notifications')->insertGetId([
                'user_id' => $userId, 'type' => $type, 'actor_id' => $actorId, 'conversation_id' => $conversationId,
                'request_id' => $requestId, 'pending_request_id' => $requestId, 'request_status' => $requestId === null ? null : 'pending',
                'body_json' => json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), 'created_at' => date('Y-m-d H:i:s'),
            ]);
            if ($signal) $this->signal($userId);
            return $id;
        });
    }

    /** Flush deduplicated hints at the end of the caller's open transaction. */
    public function signalUsers(array $userIds): void
    {
        $ids = array_values(array_unique(array_map('intval', $userIds)));
        if ($ids === []) return;
        if (count($ids) > 100 || min($ids) <= 0 || !Db::connect()->getPdo()->inTransaction()) throw new RuntimeException('通知批量事件需要有效用户和事务。');
        sort($ids, SORT_NUMERIC);
        $count = count($ids);
        if (Db::execute('UPDATE realtime_sequence SET last_id=last_id+:count WHERE id=1', ['count' => $count]) !== 1) throw new RuntimeException('通知事件队列未初始化。');
        $selects = []; $bind = [];
        foreach ($ids as $index => $id) {
            $selects[] = "SELECT last_id-:offset$index,0,0,'notification.updated',:payload$index,NOW(6) FROM realtime_sequence WHERE id=1";
            $bind['offset' . $index] = $count - $index - 1;
            $bind['payload' . $index] = json_encode(['user_id' => $id], JSON_THROW_ON_ERROR);
        }
        if (Db::execute('INSERT INTO realtime_events (id,message_id,conversation_id,event_type,payload_json,created_at) ' . implode(' UNION ALL ', $selects), $bind) !== $count) throw new RuntimeException('通知事件保存失败。');
    }

    private function signal(int $userId): void
    {
        // Share the ordered transactional outbox with message events. No personal
        // content is published, and a removal does not require group membership.
        if (Db::execute('UPDATE realtime_sequence SET last_id = last_id + 1 WHERE id = 1') !== 1) throw new RuntimeException('通知事件队列未初始化。');
        Db::execute("INSERT INTO realtime_events (id,message_id,conversation_id,event_type,payload_json,created_at) SELECT last_id,0,0,'notification.updated',?,NOW(6) FROM realtime_sequence WHERE id=1", [json_encode(['user_id' => $userId], JSON_THROW_ON_ERROR)]);
    }
}
