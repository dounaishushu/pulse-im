<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** Public contact details. Login, phone and IP data never enter this DTO. */
final class ContactDetailsService
{
    public function profile(int $viewerId, int $targetId, ?int $contextConversationId = null): array
    {
        $context = new GroupProfileContextService();
        $context->assertAllowed($viewerId, $targetId, $contextConversationId);
        [$target, $contact] = $this->relationship($viewerId, $targetId);
        $settings = new UserSettingsService();
        // "Contacts" privacy is owned by the target, not by the viewer's address book.
        $targetHasViewer = (bool) Db::name('contacts')->where('user_id', $targetId)->where('contact_user_id', $viewerId)->find();
        $blocks = new BlockService();
        $targetPermission = Db::name('user_permissions')->where('user_id', $targetId)->find();
        $canAddFriend = $contact === null && $target['status'] === 'active' && $viewerId !== $targetId
            && (!$targetPermission || (bool) $targetPermission['allow_add_friend'])
            && !$blocks->isBlocked($viewerId, $targetId) && !$blocks->isBlocked($targetId, $viewerId)
            && $context->allowsFriendRequest($viewerId, $targetId, $contextConversationId);
        $showSeen = $target['status'] === 'active' && !$blocks->isBlocked($targetId, $viewerId)
            && $settings->canView($settings->get($targetId), 'last_seen_visibility', $viewerId, $targetHasViewer);
        $seen = $showSeen ? Db::name('user_presence')->where('user_id', $targetId)->value('last_seen_at') : null;
        $source = (string) ($contact['source_type'] ?? '');
        $source = in_array($source, ['friend_request', 'internal_staff'], true) ? $source : 'unknown';
        $label = ['friend_request' => '好友申请', 'internal_staff' => '内部账号添加', 'unknown' => '未知'][$source];
        $profile = [
            'user_id' => $targetId, 'public_id' => $target['public_id'] ?? null, 'nickname' => $target['nickname'], 'username' => $target['username'],
            'avatar_url' => $target['avatar_url'], 'status' => $target['status'], 'gender' => $target['gender'] ?: null,
            'internal_staff' => (bool) Db::name('user_permissions')->where('user_id', $targetId)->value('internal_staff'),
            'remark' => $contact['remark'] ?? null, 'group_name' => $contact['group_name'] ?? null,
            'added_at' => $contact['created_at'] ?? null, 'is_contact' => $contact !== null, 'can_add_friend' => $canAddFriend,
            'blocked_by_me' => $blocks->isBlocked($viewerId, $targetId),
            'online' => !empty($seen) && strtotime($seen) >= time() - 60,
            'last_seen_at' => $seen ?: null, 'last_seen_hidden' => !$showSeen,
            'friend_source' => ['type' => $source, 'label' => $label], 'friend_source_label' => $label,
            'common_group_count' => (int) $this->commonQuery($viewerId, $targetId)->count(),
            // Retain nullable legacy keys without exposing privileged login data.
            'phone' => null, 'last_login_at' => null, 'last_login_device' => null, 'last_login_ip' => null, 'ip_location' => null,
        ];
        $context->assertAllowed($viewerId, $targetId, $contextConversationId);
        return $profile;
    }

    public function commonGroups(int $viewerId, int $targetId, int $page = 1, int $size = 20, ?int $contextConversationId = null): array
    {
        $context = new GroupProfileContextService();
        $context->assertAllowed($viewerId, $targetId, $contextConversationId);
        $this->relationship($viewerId, $targetId);
        $size = min(50, max(1, $size));
        $rows = $this->commonQuery($viewerId, $targetId)->field('c.id')->order('c.updated_at', 'desc')->order('c.id', 'desc')
            ->paginate(['list_rows' => $size, 'page' => max(1, $page)]);
        $conversations = new ConversationService(); $items = [];
        foreach ($rows->items() as $row) {
            // Recheck both memberships after pagination, including a concurrent leave.
            if (!$this->commonQuery($viewerId, $targetId)->where('c.id', $row['id'])->find()) continue;
            try { $items[] = $conversations->infoForUser($viewerId, (int) $row['id']); }
            catch (RuntimeException) { /* A dissolved/left group is no longer enterable. */ }
        }
        $context->assertAllowed($viewerId, $targetId, $contextConversationId);
        return ['items' => $items, 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    public function sharedMedia(int $viewerId, int $conversationId, int $page = 1, int $size = 30, string $type = 'all'): array
    {
        if (!in_array($type, ['all', 'image', 'video', 'file'], true)) throw new RuntimeException('共享媒体类型无效。');
        (new ConversationService())->infoForUser($viewerId, $conversationId);
        $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $viewerId)->find();
        if (!$member) throw new RuntimeException('你不是该会话成员。');
        $cutoff = (int) $member['cleared_before_message_id']; $size = min(50, max(1, $size));
        // Keep membership and the current clear watermark in the actual rows
        // query, rather than relying only on the earlier permission lookup.
        $query = Db::name('messages')->alias('m')->join('conversation_members cm', 'cm.conversation_id=m.conversation_id')
            ->whereNotIn('m.id', MessageDeletionService::hiddenQuery($viewerId))
            ->join('conversations c', 'c.id=m.conversation_id')->join('users viewer', 'viewer.id=cm.user_id')
            ->where('m.conversation_id', $conversationId)->where('cm.user_id', $viewerId)->where('c.status', 'active')->where('viewer.status', 'active')
            ->whereRaw('m.id > cm.cleared_before_message_id')->whereNull('m.recalled_at');
        if ($type === 'all') $query->whereIn('m.type', ['image', 'video', 'file']);
        else $query->where('m.type', $type);
        $rows = $query->field('m.*')->order('m.id', 'desc')->paginate(['list_rows' => $size, 'page' => max(1, $page)]);
        return ['conversation_id' => $conversationId, 'cleared_before_message_id' => $cutoff,
            'items' => (new MessageService())->formatRows($rows->items(), $viewerId),
            'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    private function relationship(int $viewerId, int $targetId): array
    {
        if ($viewerId <= 0 || $targetId <= 0 || $viewerId === $targetId) throw new RuntimeException('联系人资料参数无效。');
        if (!Db::name('users')->where('id', $viewerId)->where('status', 'active')->find()) throw new RuntimeException('用户账号不可用。');
        $target = Db::name('users')->where('id', $targetId)->field('id,public_id,nickname,username,avatar_url,status,gender')->find();
        if (!$target) throw new RuntimeException('用户不存在。');
        $contact = Db::name('contacts')->where('user_id', $viewerId)->where('contact_user_id', $targetId)->find();
        if (!$contact) {
            $shared = Db::name('conversation_members')->alias('self')->join('conversation_members peer', 'peer.conversation_id=self.conversation_id')
                ->join('conversations c', 'c.id=self.conversation_id')->where('self.user_id', $viewerId)->where('peer.user_id', $targetId)
                ->where('c.status', 'active')->whereIn('c.type', ['direct', 'group'])->find();
            if (!$shared || $target['status'] !== 'active') throw new RuntimeException('没有可查看的联系人资料。');
        }
        return [$target, $contact ?: null];
    }

    private function commonQuery(int $viewerId, int $targetId)
    {
        return Db::name('conversations')->alias('c')->join('conversation_members self', 'self.conversation_id=c.id')
            ->join('conversation_members peer', 'peer.conversation_id=c.id')->join('users viewer', 'viewer.id=self.user_id')
            ->join('users target', 'target.id=peer.user_id')->where('self.user_id', $viewerId)->where('peer.user_id', $targetId)
            ->where('viewer.status', 'active')->where('target.status', 'active')->where('c.type', 'group')->where('c.status', 'active');
    }
}
