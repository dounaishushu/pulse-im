<?php
namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** Quotes contain an ID at rest; readable summaries are derived for each viewer. */
final class MessageReplyService
{
    public function inputId(array $body): ?int
    {
        if (!array_key_exists('reply_to_id', $body)) return null;
        $id = $body['reply_to_id'];
        if (!is_int($id) || $id <= 0) throw new RuntimeException('引用消息编号必须为正整数。');
        return $id;
    }

    public function assertVisible(int $conversationId, int $viewerId, int $messageId): void
    {
        $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $viewerId)->lock(true)->find();
        $target = Db::name('messages')->where('id', $messageId)->where('conversation_id', $conversationId)->lock(true)->find();
        if (!$member || !$target || !GroupInviteNoticeService::allowsRole($target, $member['role']) || $target['type'] === 'red_packet' || !empty($target['recalled_at']) || $messageId <= (int) $member['cleared_before_message_id'] || MessageDeletionService::hidden($viewerId, $messageId)) {
            throw new RuntimeException('引用消息已撤回、已清空或不属于当前会话。');
        }
    }

    /** One membership query and one target query for a whole history/sync page. */
    public function enrich(array $messages, int $viewerId): array
    {
        $ids = []; $conversations = [];
        foreach ($messages as $message) {
            $id = $message['body']['reply_to_id'] ?? null;
            if (is_int($id) && $id > 0) { $ids[$id] = $id; $conversations[(int) $message['conversation_id']] = (int) $message['conversation_id']; }
        }
        if ($ids === []) return array_map(fn (array $message): array => $this->apply($message, null, PHP_INT_MAX), $messages);
        $cutoffs = []; $targets = [];
        if ($viewerId > 0) {
            $members = Db::name('conversation_members')->alias('cm')->join('conversations c', 'c.id=cm.conversation_id')->join('users u', 'u.id=cm.user_id')
                ->where('cm.user_id', $viewerId)->whereIn('cm.conversation_id', array_values($conversations))->where('c.status', 'active')->where('u.status', 'active')
                ->field('cm.conversation_id,cm.cleared_before_message_id')->select()->toArray();
            foreach ($members as $member) $cutoffs[(int) $member['conversation_id']] = (int) $member['cleared_before_message_id'];
            $rows = Db::name('messages')->alias('m')->leftJoin('users u', 'u.id=m.sender_id')->whereIn('m.id', array_values($ids))
                ->whereNotIn('m.id', MessageDeletionService::hiddenQuery($viewerId))
                ->whereRaw(GroupInviteNoticeService::visibleSql($viewerId, 'm'))
                ->field('m.*,u.nickname AS reply_sender_name')->select()->toArray();
            foreach ($rows as $row) $targets[(int) $row['id']] = $row;
        }
        return array_map(function (array $message) use ($cutoffs, $targets): array {
            $id = $message['body']['reply_to_id'] ?? null;
            return $this->apply($message, is_int($id) ? ($targets[$id] ?? null) : null, $cutoffs[(int) $message['conversation_id']] ?? PHP_INT_MAX);
        }, $messages);
    }

    /** The worker supplies a freshly read target and its known recipient cutoff. */
    public function apply(array $message, ?array $target, int $clearedBefore): array
    {
        $body = is_array($message['body'] ?? null) ? $message['body'] : [];
        unset($body['reply_to']);
        $id = $body['reply_to_id'] ?? null;
        if (!is_int($id) || $id <= 0) { unset($body['reply_to_id']); $message['body'] = $body; return $message; }
        $summary = ['id' => $id, 'unavailable' => true];
        if ($target && (int) $target['id'] === $id && (int) $target['conversation_id'] === (int) $message['conversation_id'] && $id > $clearedBefore && empty($target['recalled_at']) && $target['type'] !== 'red_packet') {
            $targetBody = json_decode((string) $target['body_json'], true) ?: [];
            unset($targetBody['reply_to'], $targetBody['reply_to_id']);
            $targetBody = MessagePrivacyService::sanitize((string) $target['type'], $targetBody);
            $targetBody = (new SensitiveWordService())->filterBody($targetBody);
            $fallbacks = ['image' => '[图片]', 'video' => '[视频]', 'file' => '[文件]', 'voice' => '[语音]', 'contact_card' => '[名片]', 'shake' => '[窗口抖动]', 'system' => '[系统消息]'];
            $text = is_string($targetBody['text'] ?? null) ? $targetBody['text'] : '';
            if (trim($text) === '') {
                if ($target['type'] === 'file') $text = (string) ($targetBody['file_name'] ?? $targetBody['name'] ?? $fallbacks['file']);
                elseif ($target['type'] === 'contact_card') $text = '[名片] ' . (string) ($targetBody['nickname'] ?? '');
                else $text = $fallbacks[$target['type']] ?? '[消息]';
            }
            $summary = ['id' => $id, 'sender_id' => (int) $target['sender_id'], 'sender_name' => mb_substr((string) ($target['reply_sender_name'] ?? '已注销用户'), 0, 80), 'type' => $target['type'], 'text' => mb_substr($text, 0, 200)];
            $thumbnail = $targetBody['thumbnail_url'] ?? ($target['type'] === 'image' ? ($targetBody['url'] ?? null) : null);
            if (in_array($target['type'], ['image', 'video'], true) && is_string($thumbnail) && filter_var($thumbnail, FILTER_VALIDATE_URL) && in_array(strtolower((string) parse_url($thumbnail, PHP_URL_SCHEME)), ['http', 'https'], true)) $summary['thumbnail_url'] = $thumbnail;
        }
        $body['reply_to'] = $summary; $message['body'] = $body;
        return $message;
    }
}
