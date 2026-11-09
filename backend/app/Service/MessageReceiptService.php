<?php
namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** Aggregate receipts for the sender; never expose a group's reader identities. */
final class MessageReceiptService
{
    public function snapshot(int $viewerId, int $conversationId, array $messageIds): array
    {
        if ($viewerId <= 0 || $conversationId <= 0 || !array_is_list($messageIds) || count($messageIds) < 1 || count($messageIds) > 100) throw new RuntimeException('请选择 1 至 100 条消息。');
        foreach ($messageIds as $id) if (!is_int($id) || $id <= 0) throw new RuntimeException('消息编号必须为正整数。');
        $conversation = Db::name('conversations')->where('id', $conversationId)->where('status', 'active')->find();
        $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $viewerId)->find();
        if (!$conversation || !$member) throw new RuntimeException('会话不存在或无权访问。');
        if (!in_array($conversation['type'], ['direct', 'group'], true)) throw new RuntimeException('该会话不支持消息回执。');
        $ids = Db::name('messages')->where('conversation_id', $conversationId)->where('sender_id', $viewerId)
            ->whereIn('id', array_values(array_unique($messageIds)))->where('id', '>', (int) $member['cleared_before_message_id'])
            ->whereNull('recalled_at')->whereIn('type', ['text', 'image', 'video', 'file', 'voice', 'contact_card', 'shake'])
            ->whereNotIn('id', MessageDeletionService::hiddenQuery($viewerId))->column('id');
        $counts = [];
        if ($ids !== []) {
            $rows = Db::name('message_receipts')->whereIn('message_id', $ids)->where('user_id', '<>', $viewerId)->where('status', 'read')
                ->field('message_id,COUNT(*) AS read_count')->group('message_id')->select()->toArray();
            foreach ($rows as $row) $counts[(int) $row['message_id']] = (int) $row['read_count'];
        }
        return ['conversation_id' => $conversationId, 'conversation_type' => $conversation['type'], 'items' => array_map(static function ($id) use ($counts): array {
            $count = $counts[(int) $id] ?? 0;
            return ['message_id' => (int) $id, 'read_count' => $count, 'status' => $count > 0 ? 'read' : 'unread'];
        }, $ids)];
    }
}
