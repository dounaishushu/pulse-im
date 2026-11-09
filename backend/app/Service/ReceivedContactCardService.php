<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** A received card authorizes only its current public profile, not arbitrary IDs. */
final class ReceivedContactCardService
{
    public function profile(int $viewerId, array $query): array
    {
        $conversationId = $this->positiveId($query['conversation_id'] ?? null);
        $messageId = $this->positiveId($query['message_id'] ?? null);
        $targetId = $this->positiveId($query['user_id'] ?? null);
        [$source, $target] = $this->resolve($viewerId, $targetId, $conversationId, $messageId);
        $contact = (bool) Db::name('contacts')->where('user_id', $viewerId)->where('contact_user_id', $targetId)->find();
        $groupId = $this->groupContext($source, $targetId);
        $restricted = $groupId !== null && !(int) $source['allow_member_add_friend'];
        $this->resolve($viewerId, $targetId, $conversationId, $messageId);
        return [
            'id' => $targetId, 'user_id' => $targetId, 'nickname' => (string) $target['nickname'],
            'username' => $target['username'], 'public_id' => $target['public_id'], 'avatar_url' => $target['avatar_url'],
            'is_contact' => $contact, 'can_add_friend' => $viewerId !== $targetId && !$contact && !$restricted,
            'add_friend_restriction' => $restricted ? '该群已禁止群成员互相添加好友。' : null,
            'source_conversation_id' => $conversationId, 'source_message_id' => $messageId,
        ];
    }

    public function hasContext(array $payload): bool
    {
        return array_key_exists('card_conversation_id', $payload) || array_key_exists('card_message_id', $payload);
    }

    public function requestContext(int $viewerId, int $targetId, array $payload): ?int
    {
        $conversationId = $this->positiveId($payload['card_conversation_id'] ?? null);
        $messageId = $this->positiveId($payload['card_message_id'] ?? null);
        [$source] = $this->resolve($viewerId, $targetId, $conversationId, $messageId);
        return $this->groupContext($source, $targetId);
    }

    private function positiveId(mixed $value): int
    {
        if (is_int($value) && $value > 0) return $value;
        if (is_string($value) && preg_match('/^[1-9][0-9]*$/D', $value) === 1) {
            $maximum = (string) PHP_INT_MAX;
            if (strlen($value) < strlen($maximum) || strlen($value) === strlen($maximum) && strcmp($value, $maximum) <= 0) return (int) $value;
        }
        throw new RuntimeException('名片来源参数无效。');
    }

    private function resolve(int $viewerId, int $targetId, int $conversationId, int $messageId): array
    {
        if ($viewerId <= 0 || $targetId <= 0) throw new RuntimeException('名片来源参数无效。');
        $source = Db::name('messages')->alias('m')
            ->join('conversations c', 'c.id=m.conversation_id')
            ->join('conversation_members cm', 'cm.conversation_id=m.conversation_id')
            ->join('users viewer', 'viewer.id=cm.user_id')
            ->where('m.id', $messageId)->where('m.conversation_id', $conversationId)->where('m.type', 'contact_card')
            ->where('cm.user_id', $viewerId)->where('c.status', 'active')->where('viewer.status', 'active')
            ->whereRaw('m.id > cm.cleared_before_message_id')->whereNull('m.recalled_at')
            ->whereNotIn('m.id', MessageDeletionService::hiddenQuery($viewerId))
            ->field('m.body_json,m.conversation_id,c.type AS conversation_type,c.allow_member_add_friend')->find();
        if (!$source) throw new RuntimeException('名片已不可用，请返回聊天重新查看。');
        $body = json_decode((string) $source['body_json'], true);
        if (!is_array($body) || $this->positiveId($body['user_id'] ?? null) !== $targetId) throw new RuntimeException('名片用户不匹配。');
        $target = Db::name('users')->where('id', $targetId)->where('status', 'active')
            ->field('id,public_id,nickname,username,avatar_url')->find();
        if (!$target) throw new RuntimeException('名片用户不存在或已停用。');
        return [$source, $target];
    }

    private function groupContext(array $source, int $targetId): ?int
    {
        $id = (int) $source['conversation_id'];
        return $source['conversation_type'] === 'group'
            && Db::name('conversation_members')->where('conversation_id', $id)->where('user_id', $targetId)->find() ? $id : null;
    }
}
