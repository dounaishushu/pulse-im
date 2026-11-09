<?php
namespace app\Service;

use RuntimeException;
use think\facade\Db;

final class MessagePinService
{
    public const LIMIT = 20;

    public function snapshot(int $conversationId, int $viewerId): array
    {
        $member = $this->access($conversationId, $viewerId);
        $rows = Db::name('message_pins')->alias('p')->join('messages m', 'm.id=p.message_id AND m.conversation_id=p.conversation_id')
            ->whereNotIn('m.id', MessageDeletionService::hiddenQuery($viewerId))
            ->whereRaw(GroupInviteNoticeService::visibleSql($viewerId, 'm'))
            ->where('p.conversation_id', $conversationId)->where('m.id', '>', (int) $member['cleared_before_message_id'])->whereNull('m.recalled_at')->where('m.type', '<>', 'red_packet')
            ->field('m.*,p.pinned_by,p.pinned_at')->order('p.pinned_at', 'desc')->order('p.message_id', 'desc')->limit(self::LIMIT)->select()->toArray();
        $items = (new MessageService())->formatRows($rows, $viewerId);
        foreach ($items as $index => &$item) $item['pin'] = ['pinned_by' => (int) $rows[$index]['pinned_by'], 'pinned_at' => $rows[$index]['pinned_at']];
        unset($item);
        return ['conversation_id' => $conversationId, 'items' => $items, 'limit' => self::LIMIT];
    }

    public function change(int $conversationId, int $viewerId, int $messageId, bool $pin): array
    {
        if ($conversationId <= 0 || $messageId <= 0) throw new RuntimeException('置顶消息参数无效。');
        $result = Db::transaction(function () use ($conversationId, $viewerId, $messageId, $pin): array {
            $conversation = Db::name('conversations')->where('id', $conversationId)->where('status', 'active')->lock(true)->find();
            if (!$conversation) throw new RuntimeException('该会话已停用。');
            if (!Db::name('users')->where('id', $viewerId)->where('status', 'active')->lock(true)->find()) throw new RuntimeException('用户账号不可用。');
            $member = $this->access($conversationId, $viewerId, true);
            if ($conversation['type'] === 'group' && !in_array($member['role'], ['owner', 'admin'], true)) throw new RuntimeException('只有群主和管理员可以置顶或取消置顶消息。');
            if ($conversation['type'] === 'channel') (new MessageService())->assertCanSend($conversationId, $viewerId);
            $message = Db::name('messages')->where('id', $messageId)->where('conversation_id', $conversationId)->lock(true)->find();
            if (!$message || !GroupInviteNoticeService::allowsRole($message, $member['role']) || !empty($message['recalled_at']) || $message['type'] === 'red_packet' || $messageId <= (int) $member['cleared_before_message_id'] || MessageDeletionService::hidden($viewerId, $messageId)) throw new RuntimeException('消息已撤回、已删除、已清空或不属于当前会话。');
            $existing = Db::name('message_pins')->where('conversation_id', $conversationId)->where('message_id', $messageId)->find();
            if ($pin && !$existing) {
                // The conversation row serializes simultaneous distinct insertions;
                // the unique key handles retries.
                if (Db::name('message_pins')->where('conversation_id', $conversationId)->count() >= self::LIMIT) throw new RuntimeException('每个会话最多置顶 ' . self::LIMIT . ' 条消息，请先取消一条置顶。');
                Db::name('message_pins')->insert(['conversation_id' => $conversationId, 'message_id' => $messageId, 'pinned_by' => $viewerId, 'pinned_at' => date('Y-m-d H:i:s')]);
            } elseif (!$pin && $existing) Db::name('message_pins')->where('conversation_id', $conversationId)->where('message_id', $messageId)->delete();
            return $this->snapshot($conversationId, $viewerId);
        });
        (new RealtimePublisher())->publish(['conversation_id' => $conversationId], 'conversation.pins');
        return $result;
    }

    private function access(int $conversationId, int $viewerId, bool $lock = false): array
    {
        if ($conversationId <= 0 || $viewerId <= 0 || !Db::name('users')->where('id', $viewerId)->where('status', 'active')->find()) throw new RuntimeException('用户账号不可用。');
        if (!Db::name('conversations')->where('id', $conversationId)->where('status', 'active')->find()) throw new RuntimeException('该会话已停用。');
        $query = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $viewerId);
        if ($lock) $query->lock(true);
        $member = $query->find();
        if (!$member) throw new RuntimeException('你不是该会话成员。');
        return $member;
    }
}
