<?php
namespace app\Service;

use Closure;
use RuntimeException;
use think\facade\Db;

/** Personal deletion never changes the message or another member's history. */
final class MessageDeletionService
{
    public static function hiddenQuery(int $viewerId): Closure
    {
        return static function ($query) use ($viewerId): void {
            $query->name('message_deletions')->field('message_id')->where('user_id', $viewerId);
        };
    }

    public static function hidden(int $viewerId, int $messageId): bool
    {
        return (bool) Db::name('message_deletions')->where('user_id', $viewerId)->where('message_id', $messageId)->find();
    }

    public function deleteForUser(int $viewerId, int $conversationId, array $messageIds): array
    {
        if ($viewerId <= 0 || $conversationId <= 0 || !array_is_list($messageIds) || count($messageIds) < 1 || count($messageIds) > 100) throw new RuntimeException('请选择 1 至 100 条消息。');
        foreach ($messageIds as $id) if (!is_int($id) || $id <= 0) throw new RuntimeException('消息编号必须为正整数。');
        $messageIds = array_values(array_unique($messageIds)); sort($messageIds, SORT_NUMERIC);
        $result = Db::transaction(function () use ($viewerId, $conversationId, $messageIds): array {
            if (!Db::name('conversations')->where('id', $conversationId)->where('status', 'active')->lock(true)->find()) throw new RuntimeException('该会话已停用。');
            if (!Db::name('users')->where('id', $viewerId)->where('status', 'active')->lock(true)->find()) throw new RuntimeException('用户账号不可用。');
            $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $viewerId)->lock(true)->find();
            if (!$member) throw new RuntimeException('你不是该会话成员。');
            $rows = Db::name('messages')->where('conversation_id', $conversationId)->whereIn('id', $messageIds)->order('id')->lock(true)->select()->toArray();
            if (count($rows) !== count($messageIds)) throw new RuntimeException('所选消息不存在或不属于当前会话，请重新选择。');
            foreach ($rows as $row) if (!GroupInviteNoticeService::allowsRole($row, $member['role'])) throw new RuntimeException('所选消息不存在或不可见，请重新选择。');
            $existing = array_map('intval', Db::name('message_deletions')->where('user_id', $viewerId)->whereIn('message_id', $messageIds)->column('message_id'));
            $new = array_values(array_diff($messageIds, $existing));
            if ($new !== []) {
                $now = date('Y-m-d H:i:s');
                Db::name('message_deletions')->insertAll(array_map(static fn (int $id): array => ['user_id' => $viewerId, 'message_id' => $id, 'conversation_id' => $conversationId, 'created_at' => $now], $new));
                // Reserve the durable event while holding the same sequence lock
                // as the message triggers. Cursor order therefore follows commit order.
                $sequence = Db::name('realtime_sequence')->where('id', 1)->lock(true)->find();
                if (!$sequence) throw new RuntimeException('消息事件序列尚未初始化。');
                $eventId = (int) $sequence['last_id'] + 1;
                Db::name('realtime_sequence')->where('id', 1)->update(['last_id' => $eventId]);
                Db::name('realtime_events')->insert(['id' => $eventId, 'message_id' => $new[0], 'conversation_id' => $conversationId, 'event_type' => 'message.deleted',
                    'payload_json' => json_encode(['conversation_id' => $conversationId, 'user_id' => $viewerId, 'message_ids' => $new], JSON_THROW_ON_ERROR), 'created_at' => $now]);
            }
            return ['conversation_id' => $conversationId, 'user_id' => $viewerId, 'message_ids' => $messageIds, 'scope' => 'self'];
        });
        (new RealtimePublisher())->publish($result, 'message.deleted');
        return $result;
    }
}
