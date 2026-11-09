<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** Authorization for a profile opened from an explicitly supplied source group. */
final class GroupProfileContextService
{
    /** Adding a friend never inherits the manager exception for viewing profiles. */
    public function allowsFriendRequest(int $viewerId, int $targetId, ?int $conversationId): bool
    {
        if ($viewerId <= 0 || $targetId <= 0 || $viewerId === $targetId) return false;
        if ($conversationId === null) return true;
        return (bool) Db::name('conversations')->alias('c')
            ->join('conversation_members viewer_member', 'viewer_member.conversation_id=c.id')
            ->join('conversation_members target_member', 'target_member.conversation_id=c.id')
            ->where('c.id', $conversationId)->where('c.type', 'group')->where('c.status', 'active')
            ->where('c.allow_member_add_friend', 1)->where('viewer_member.user_id', $viewerId)->where('target_member.user_id', $targetId)
            ->field('c.id')->find();
    }

    public function parseQuery(array $query): ?int
    {
        if (!array_key_exists('context_conversation_id', $query)) return null;
        $value = $query['context_conversation_id'];
        if (is_int($value) && $value > 0) return $value;
        if (is_string($value) && preg_match('/^[1-9][0-9]*$/D', $value) === 1) {
            $maximum = (string) PHP_INT_MAX;
            if (strlen($value) < strlen($maximum) || (strlen($value) === strlen($maximum) && strcmp($value, $maximum) <= 0)) return (int) $value;
        }
        throw new RuntimeException('来源群参数无效。');
    }

    public function assertAllowed(int $viewerId, int $targetId, ?int $contextConversationId, bool $managerOnly = false): void
    {
        // Missing context retains the normal contact/internal-profile policy.
        if ($contextConversationId === null) return;
        if ($contextConversationId <= 0 || $viewerId <= 0 || $targetId <= 0 || $viewerId === $targetId) throw new RuntimeException('群成员资料参数无效。');
        // Read current policy and both memberships together. Opening public
        // profiles for friend requests never grants group management rights.
        $source = Db::name('conversations')->alias('c')
            ->join('conversation_members viewer_member', 'viewer_member.conversation_id=c.id')
            ->join('conversation_members target_member', 'target_member.conversation_id=c.id')
            ->join('users viewer', 'viewer.id=viewer_member.user_id')
            ->join('users target', 'target.id=target_member.user_id')
            ->where('c.id', $contextConversationId)->where('c.type', 'group')->where('c.status', 'active')
            ->where('viewer_member.user_id', $viewerId)->where('target_member.user_id', $targetId)
            ->where('viewer.status', 'active')->where('target.status', 'active')
            ->field('viewer_member.role,c.allow_member_add_friend')->find();
        if (!$source || (!in_array($source['role'], ['owner', 'admin'], true)
            && ($managerOnly || !(int) $source['allow_member_add_friend']))) {
            throw new RuntimeException('无权查看该群成员资料。');
        }
    }
}
