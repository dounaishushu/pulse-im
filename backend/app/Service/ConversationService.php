<?php

namespace app\Service;

require_once __DIR__ . '/ConversationListSnapshot.php';
require_once __DIR__ . '/GroupMemberCount.php';
require_once __DIR__ . '/GroupInvitationService.php';

use RuntimeException;
use think\facade\Db;

final class ConversationService
{
    public const DEFAULT_GROUP_MEMBER_LIMIT = 500;
    private const PERMANENT_MUTE_UNTIL = '9999-12-31 23:59:59';
    public function createDirect(int $userId, int $targetId, bool $includeDetails = true): array
    {
        if ($userId === $targetId) throw new RuntimeException('不能与自己创建会话。');
        return Db::transaction(function () use ($userId, $targetId, $includeDetails): array {
            // Native requests and dispatch tasks use the same pair lock, even when
            // different administrators create the same first conversation at once.
            $pair = [$userId, $targetId]; sort($pair, SORT_NUMERIC); $accounts = [];
            foreach ($pair as $id) {
                $account = $id > 0 ? Db::name('users')->where('id', $id)->where('status', 'active')->lock(true)->find() : null;
                if (!$account) throw new RuntimeException('User not found.');
                $accounts[$id] = $account;
            }
            if (Db::name('user_blocks')->where(function ($q) use ($userId, $targetId): void { $q->where('blocker_id', $userId)->where('blocked_id', $targetId)->whereOr(function ($nested) use ($userId, $targetId): void { $nested->where('blocker_id', $targetId)->where('blocked_id', $userId); }); })->find()) throw new RuntimeException('双方存在屏蔽关系，无法创建会话。');
            // A caller can already have a repeatable-read snapshot. FOR UPDATE
            // sees the other pair-lock owner's committed conversation regardless.
            $existing = Db::name('conversations')->alias('c')->join('conversation_members m1', 'm1.conversation_id = c.id')
                ->join('conversation_members m2', 'm2.conversation_id = c.id')->where('c.type', 'direct')
                ->where('m1.user_id', $userId)->where('m2.user_id', $targetId)->field('c.*')->lock(true)->find();
            if ($existing) {
                if (!$includeDetails && ($existing['status'] ?? 'active') !== 'active') throw new RuntimeException('会话不存在或你不是该会话成员。');
                Db::name('conversation_members')->where('conversation_id', (int) $existing['id'])->where('user_id', $userId)->update(['hidden_at' => null]);
                // Friend acceptance only needs the ID. Avoid loading presence,
                // privacy and the last message while holding the pair locks.
                return $includeDetails ? $this->infoForUser($userId, (int) $existing['id']) : ['id' => (int) $existing['id']];
            }
            $target = $accounts[$targetId];
            $now = date('Y-m-d H:i:s');
            $id = Db::name('conversations')->insertGetId(['type' => 'direct', 'owner_id' => $userId, 'created_at' => $now, 'updated_at' => $now]);
            Db::name('conversation_members')->insertAll([
                ['conversation_id' => $id, 'user_id' => $userId, 'role' => 'owner', 'joined_at' => $now],
                ['conversation_id' => $id, 'user_id' => $targetId, 'role' => 'member', 'joined_at' => $now],
            ]);
            return ['id' => (int) $id, 'type' => 'direct', 'name' => $target['nickname'] ?? null, 'avatar_url' => $target['avatar_url'] ?? null, 'peer_user_id' => $targetId, 'peer_public_id' => $target['public_id'] ?? null, 'peer_nickname' => $target['nickname'] ?? null, 'peer_username' => $target['username'] ?? null, 'owner_id' => $userId, 'member_ids' => [$userId, $targetId], 'created_at' => $now];
        });
    }

    public function favorites(int $userId): array
    {
        $this->active($userId);
        $existing = Db::name('conversations')->where('type', 'favorites')->where('owner_id', $userId)->find();
        if ($existing) {
            Db::name('conversation_members')->where('conversation_id', (int) $existing['id'])->where('user_id', $userId)->update(['hidden_at' => null]);
            return $this->infoForUser($userId, (int) $existing['id']);
        }
        return Db::transaction(function () use ($userId): array {
            $now = date('Y-m-d H:i:s');
            $id = Db::name('conversations')->insertGetId(['type' => 'favorites', 'name' => '我的收藏', 'owner_id' => $userId, 'created_at' => $now, 'updated_at' => $now]);
            Db::name('conversation_members')->insert(['conversation_id' => $id, 'user_id' => $userId, 'role' => 'owner', 'joined_at' => $now]);
            return ['id' => (int) $id, 'type' => 'favorites', 'name' => '我的收藏', 'avatar_url' => null, 'owner_id' => $userId, 'created_at' => $now, 'updated_at' => $now];
        });
    }

    public function createGroup(int $ownerId, string $name, array $memberIds, bool $allowMemberAddFriend = true, ?string $avatarUrl = null): array
    {
        $this->active($ownerId);
        $permission = Db::name('user_permissions')->where('user_id', $ownerId)->find();
        if ($permission && !(int) $permission['allow_create_group']) throw new RuntimeException('当前账号不允许创建群组。');
        $name = trim($name);
        if (mb_strlen($name) < 1 || mb_strlen($name) > 128) throw new RuntimeException('群名称长度必须为 1 至 128 个字符。');
        $avatarUrl = $this->creationAvatar($avatarUrl);
        if ($avatarUrl) (new MediaAccessService())->assertCanAttach($avatarUrl, $ownerId);
        $ids = array_values(array_unique(array_map('intval', array_merge([$ownerId], $memberIds))));
        if (count($ids) > self::DEFAULT_GROUP_MEMBER_LIMIT) throw new RuntimeException('群组成员数量超过上限。');
        foreach ($ids as $id) $this->active($id);
        foreach ($ids as $id) {
            if ($id === $ownerId) continue;
            $privacy = new UserSettingsService();
            $isContact = (bool) Db::name('contacts')->where('user_id', $id)->where('contact_user_id', $ownerId)->find();
            $blocks = new BlockService();
            if (!$privacy->canView($privacy->get($id), 'invite_visibility', $ownerId, $isContact) || $blocks->isBlocked($id, $ownerId) || $blocks->isBlocked($ownerId, $id)) throw new RuntimeException('该用户的隐私设置不允许此次群组邀请。');
        }
        return Db::transaction(function () use ($ownerId, $name, $ids, $allowMemberAddFriend, $avatarUrl): array {
            $now = date('Y-m-d H:i:s');
            $id = Db::name('conversations')->insertGetId(['type' => 'group', 'name' => $name, 'avatar_url' => $avatarUrl, 'owner_id' => $ownerId, 'allow_member_add_friend' => $allowMemberAddFriend ? 1 : 0, 'created_at' => $now, 'updated_at' => $now]);
            $inviteCode = 'G' . $id . strtoupper(bin2hex(random_bytes(4)));
            Db::name('conversations')->where('id', $id)->update(['invite_code' => $inviteCode]);
            $rows = [];
            foreach ($ids as $memberId) $rows[] = ['conversation_id' => $id, 'user_id' => $memberId, 'role' => $memberId === $ownerId ? 'owner' : 'member', 'joined_at' => $now];
            Db::name('conversation_members')->insertAll($rows);
            $notifications = new UserNotificationService();
            foreach ($ids as $memberId) {
                if ($memberId !== $ownerId) $notifications->group($memberId, $ownerId, ['id' => $id, 'name' => $name]);
            }
            return ['id' => (int) $id, 'type' => 'group', 'name' => $name, 'avatar_url' => $avatarUrl, 'owner_id' => $ownerId, 'member_ids' => $ids, 'invite_code' => $inviteCode, 'allow_member_add_friend' => $allowMemberAddFriend, 'created_at' => $now];
        });
    }

    public function joinGroup(int $userId, int $conversationId = 0, string $inviteCode = ''): array
    {
        $this->active($userId);
        return Db::transaction(function () use ($userId, $conversationId, $inviteCode): array {
        $query = Db::name('conversations')->where('type', 'group');
        if ($inviteCode !== '') $query->where('invite_code', trim($inviteCode));
        else $query->where('id', $conversationId);
        $query->where('status', 'active');
        $group = $query->lock(true)->find();
        if (!$group) throw new RuntimeException('群组不存在或群号无效。');
        if (($group['join_method'] ?? 'free') === 'approval') throw new RuntimeException('该群组需要管理员审核后才能加入。');
        if (($group['join_method'] ?? 'free') === 'invite' && trim($inviteCode) === '') throw new RuntimeException('该群组只能通过邀请链接加入。');
        $conversationId = (int) $group['id'];
        $exists = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->find();
        if (!$exists) {
            $maxMembers = (int) ($group['max_members'] ?? 500);
            $memberCount = (int) Db::name('conversation_members')->where('conversation_id', $conversationId)->count();
            if ($memberCount >= $maxMembers) throw new RuntimeException('该群组成员数量已达到上限。');
            Db::name('conversation_members')->insert(['conversation_id' => $conversationId, 'user_id' => $userId, 'role' => 'member', 'joined_at' => date('Y-m-d H:i:s')]);
        }
        return ['conversation_id' => $conversationId, 'user_id' => $userId, 'status' => 'joined', 'invite_code' => $group['invite_code']];
        });
    }

    public function list(int $userId, int $page = 1, int $size = 30, string $type = ''): array
    {
        // Legacy repair runs on the first page only, never on every page.
        if (!in_array($type, ['', 'group', 'channel'], true)) throw new RuntimeException('会话类型无效。');
        if ($type === '' && $page <= 1) $this->ensureContactDirectConversations($userId);
        $query = Db::name('conversations')->alias('c')->join('conversation_members m', 'm.conversation_id = c.id')
            ->leftJoin('user_permissions viewer_permission', 'viewer_permission.user_id=m.user_id')
            ->where('m.user_id', $userId)->where('c.status', 'active');
        if ($type === '') $query->whereNull('m.hidden_at');
        if ($type !== '') $query->where('c.type', $type);
        $rows = $query->field('c.*,m.role AS my_role,m.muted_until AS my_muted_until,viewer_permission.muted AS __account_muted,m.notifications_muted,m.is_pinned,m.is_archived,m.cleared_before_message_id')->order('m.is_pinned', 'desc')->order('c.updated_at', 'desc')->order('c.id', 'desc')->paginate(['list_rows' => min(100, max(1, $size)), 'page' => max(1, $page)]);
        return ['items' => $this->listItems($userId, $rows->items()), 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => min(100, max(1, $size))];
    }

    public function updates(int $userId, array $ids): array
    {
        if (count($ids) < 1 || count($ids) > 100) throw new RuntimeException('会话更新数量必须为1至100。');
        foreach ($ids as $id) if (!is_int($id) || $id <= 0) throw new RuntimeException('会话编号无效。');
        $ids = array_values(array_unique($ids));
        $rows = Db::name('conversations')->alias('c')->join('conversation_members m', 'm.conversation_id=c.id')
            ->leftJoin('user_permissions viewer_permission', 'viewer_permission.user_id=m.user_id')
            ->where('m.user_id', $userId)->where('c.status', 'active')->whereNull('m.hidden_at')->whereIn('c.id', $ids)
            ->field('c.*,m.role AS my_role,m.muted_until AS my_muted_until,viewer_permission.muted AS __account_muted,m.notifications_muted,m.is_pinned,m.is_archived,m.cleared_before_message_id')->select()->toArray();
        $visible = array_map(static fn (array $row): int => (int) $row['id'], $rows);
        return ['incremental' => true, 'items' => $this->listItems($userId, $rows), 'removed_ids' => array_values(array_diff($ids, $visible))];
    }

    private function listItems(int $userId, array $rows): array
    {
        $items = []; $sensitiveWords = new SensitiveWordService();
        $conversationIds = array_map(static fn (array $row): int => (int) $row['id'], $rows);
        $snapshot = (new ConversationListSnapshot())->read($userId, $conversationIds);
        foreach ($rows as $row) {
            $id = (int) $row['id'];
            $item = $this->format($row, $userId, $snapshot['members'][$id] ?? null, ['peer' => $snapshot['peers'][$id] ?? null]);
            $last = $snapshot['last'][$id] ?? null;
            $lastBody = $last ? MessagePrivacyService::sanitize((string) $last['type'], $sensitiveWords->filterBody(json_decode($last['body_json'], true) ?: [])) : [];
            $item['last_message'] = $last ? ['id' => (int) $last['id'], 'sender_id' => (int) $last['sender_id'], 'sender_name' => MessageSenderService::name($last['author_name'] ?? null), 'type' => $last['type'], 'body' => $lastBody, 'created_at' => $last['created_at']] : null;
            $item['unread_count'] = $snapshot['unread'][$id] ?? 0;
            $items[] = $item;
        }
        $mentions = (new GroupMentionService())->unread($userId, $conversationIds);
        foreach ($items as &$item) $item += $mentions[(int) $item['id']] ?? ['unread_mention_count' => 0, 'last_mention_message_id' => 0];
        unset($item);
        return $items;
    }

    public function followChannel(int $userId, int $conversationId = 0, string $inviteCode = ''): array
    {
        $this->active($userId);
        $inviteCode = trim($inviteCode);
        if ($inviteCode === '' && $conversationId <= 0) throw new RuntimeException('请输入有效频道编号或邀请链接。');
        if (strlen($inviteCode) > 64) throw new RuntimeException('频道邀请码无效。');
        return Db::transaction(function () use ($userId, $conversationId, $inviteCode): array {
            // Serialize follows against the channel row: both capacity checks and
            // duplicate requests must complete before another follower can enter.
            $query = Db::name('conversations')->where('type', 'channel')->where('status', 'active');
            if ($inviteCode !== '') $query->where('invite_code', $inviteCode);
            else $query->where('id', $conversationId);
            $channel = $query->lock(true)->find();
            if (!$channel) throw new RuntimeException('频道不存在、已停用或邀请链接无效。');
            $id = (int) $channel['id'];
            $member = Db::name('conversation_members')->where('conversation_id', $id)->where('user_id', $userId)->find();
            if ($member) {
                Db::name('conversation_members')->where('conversation_id', $id)->where('user_id', $userId)->update(['hidden_at' => null]);
                return ['conversation_id' => $id, 'user_id' => $userId, 'status' => 'already_followed'];
            }
            if (($channel['join_method'] ?? 'free') === 'approval') throw new RuntimeException('该频道需要管理员邀请后才能关注。');
            if (($channel['join_method'] ?? 'free') === 'invite' && $inviteCode === '') throw new RuntimeException('该频道只能通过邀请链接关注。');
            if ((int) Db::name('conversation_members')->where('conversation_id', $id)->count() >= (int) ($channel['max_members'] ?? 500)) {
                throw new RuntimeException('该频道关注人数已达到上限。');
            }
            Db::name('conversation_members')->insert(['conversation_id' => $id, 'user_id' => $userId, 'role' => 'member', 'joined_at' => date('Y-m-d H:i:s')]);
            return ['conversation_id' => $id, 'user_id' => $userId, 'status' => 'followed'];
        });
    }

    public function createSpecial(int $ownerId, string $name, string $type, ?string $avatarUrl = null, string $description = ''): array
    {
        $this->active($ownerId);
        $name = trim($name);
        if (!in_array($type, ['channel', 'customer_service'], true) || mb_strlen($name) < 1 || mb_strlen($name) > 128) throw new RuntimeException('频道或客服名称长度必须为 1 至 128 个字符。');
        $avatarUrl = $this->creationAvatar($avatarUrl);
        if ($avatarUrl) (new MediaAccessService())->assertCanAttach($avatarUrl, $ownerId);
        $description = trim($description);
        if (mb_strlen($description) > 500) throw new RuntimeException('简介不能超过 500 个字符。');
        $now = date('Y-m-d H:i:s');
        return Db::transaction(function () use ($ownerId, $name, $type, $now, $avatarUrl, $description): array {
            $id = Db::name('conversations')->insertGetId(['type' => $type, 'name' => $name, 'avatar_url' => $avatarUrl, 'description' => $description === '' ? null : $description, 'owner_id' => $ownerId, 'created_at' => $now, 'updated_at' => $now]);
            $inviteCode = $type === 'channel' ? 'C' . $id . strtoupper(bin2hex(random_bytes(8))) : null;
            if ($inviteCode !== null) Db::name('conversations')->where('id', $id)->update(['invite_code' => $inviteCode]);
            Db::name('conversation_members')->insert(['conversation_id' => $id, 'user_id' => $ownerId, 'role' => 'owner', 'joined_at' => $now]);
            return ['id' => (int) $id, 'type' => $type, 'name' => $name, 'avatar_url' => $avatarUrl, 'description' => $description === '' ? null : $description, 'invite_code' => $inviteCode, 'owner_id' => $ownerId, 'member_ids' => [$ownerId], 'created_at' => $now];
        });
    }

    public function addMember(int $operatorId, int $conversationId, int $memberId): array
    {
        $result = (new GroupInvitationService())->add($operatorId, $conversationId, [$memberId]);
        $item = $result['items'][0];
        if ($item['status'] !== 'joined') throw new RuntimeException($item['message']);
        return ['conversation_id' => $conversationId, 'user_id' => $memberId, 'status' => 'joined'];
    }

    public function members(int $userId, int $conversationId): array
    {
        $group = $this->assertMember($userId, $conversationId);
        $rows = Db::name('conversation_members')->alias('m')
            ->join('conversation_members viewer', 'viewer.conversation_id = m.conversation_id AND viewer.user_id = ' . $userId)
            ->join('conversations source_group', 'source_group.id = m.conversation_id')
            ->leftJoin('users u', 'u.id = m.user_id')
            ->leftJoin('user_presence p', 'p.user_id = m.user_id')->leftJoin('user_settings s', 's.user_id = m.user_id')->leftJoin('user_permissions up', 'up.user_id = m.user_id')
            ->leftJoin('contacts c', 'c.user_id = m.user_id AND c.contact_user_id = ' . $userId)
            ->leftJoin('user_blocks presence_block', 'presence_block.blocker_id=m.user_id AND presence_block.blocked_id=' . $userId)
            ->where('m.conversation_id', $conversationId)
            // Authorize rows with the current source-group policy in the same read.
            ->whereRaw("(viewer.role IN ('owner', 'admin') OR (source_group.type = 'group' AND source_group.allow_member_add_friend = 1) OR m.role IN ('owner', 'admin'))")
            ->field('m.user_id,m.role,m.muted_until,m.notifications_muted,m.is_pinned,m.joined_at,u.public_id,u.nickname,u.username,u.avatar_url,up.internal_staff,p.last_seen_at,s.settings_json,c.contact_user_id AS viewer_contact_id,presence_block.blocker_id AS presence_blocked,viewer.role AS viewer_role,source_group.allow_member_add_friend AS viewer_allow_add_friend,source_group.type AS source_type')
            ->orderRaw("FIELD(m.role, 'owner', 'admin', 'member')")->order('u.nickname', 'asc')->select()->toArray();
        $visibility = in_array($rows[0]['viewer_role'] ?? 'member', ['owner', 'admin'], true)
            || (($rows[0]['source_type'] ?? '') === 'group' && (int) ($rows[0]['viewer_allow_add_friend'] ?? 0) === 1) ? 'all' : 'managers';
        $settingsService = new UserSettingsService();
        foreach ($rows as &$row) {
            $settings = json_decode((string) ($row['settings_json'] ?? ''), true) ?: [];
            $visible = (int) $row['user_id'] === $userId || ($row['presence_blocked'] === null && $settingsService->canView($settings, 'last_seen_visibility', $userId, $row['viewer_contact_id'] !== null));
            $row['online'] = $visible && !empty($row['last_seen_at']) && strtotime($row['last_seen_at']) >= time() - 60;
            $row['last_seen_hidden'] = !$visible;
            $row['internal_staff'] = (bool) ($row['internal_staff'] ?? false);
            $row['muted_permanent'] = ($row['muted_until'] ?? null) === self::PERMANENT_MUTE_UNTIL;
            $row['is_muted'] = !empty($row['muted_until']) && strtotime($row['muted_until']) > time();
            if (!$visible) $row['last_seen_at'] = null;
            unset($row['presence_blocked'], $row['settings_json'], $row['viewer_contact_id'], $row['viewer_role'], $row['viewer_allow_add_friend'], $row['source_type']);
        }
        unset($row);
        return ['conversation_id' => $conversationId, 'member_count' => (int) Db::name('conversation_members')->where('conversation_id', $conversationId)->count(), 'visible_member_count' => count($rows), 'members_visibility' => $visibility, 'items' => $rows];
    }

    public function leave(int $userId, int $conversationId): array
    {
        return Db::transaction(function () use ($userId, $conversationId): array {
            $conversation = Db::name('conversations')->where('id', $conversationId)->lock(true)->find();
            if (!$conversation) throw new RuntimeException('会话不存在。');
            if ((int) $conversation['owner_id'] === $userId) throw new RuntimeException($conversation['type'] === 'channel' ? '频道所有者不能取消关注自己的频道。' : '群主不能直接退出，请先转让群主或解散群组。');
            if (!Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->delete()) throw new RuntimeException('你不是该会话成员。');
            return ['conversation_id' => $conversationId, 'user_id' => $userId, 'status' => 'left'];
        });
    }

    public function updateGroup(int $operatorId, int $conversationId, string $name): array
    {
        $this->assertManager($operatorId, $conversationId);
        $name = trim($name);
        if (mb_strlen($name) < 1 || mb_strlen($name) > 128) throw new RuntimeException('群名称长度必须为 1 至 128 个字符。');
        Db::name('conversations')->where('id', $conversationId)->where('type', 'group')->update(['name' => $name, 'updated_at' => date('Y-m-d H:i:s')]);
        return ['conversation_id' => $conversationId, 'name' => $name];
    }

    public function removeMember(int $operatorId, int $conversationId, int $memberId): array
    {
        return Db::transaction(function () use ($operatorId, $conversationId, $memberId): array {
            $group = Db::name('conversations')->where('id', $conversationId)->where('type', 'group')->lock(true)->find();
            if (!$group) throw new RuntimeException('群组不存在。');
            $this->assertManager($operatorId, $conversationId);
            if ((int) $group['owner_id'] === $memberId) throw new RuntimeException('不能移除群主。');
            $operator = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $operatorId)->find();
            $target = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $memberId)->find();
            if (!$target) throw new RuntimeException('成员不存在。');
            if (($operator['role'] ?? '') !== 'owner' && ($target['role'] ?? '') !== 'member') throw new RuntimeException('管理员不能移除其他管理员。');
            Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $memberId)->delete();
            (new UserNotificationService())->group($memberId, $operatorId, $group, true);
            return ['conversation_id' => $conversationId, 'user_id' => $memberId, 'status' => 'removed'];
        });
    }

    public function setRole(int $operatorId, int $conversationId, int $memberId, string $role): array
    {
        $group = Db::name('conversations')->where('id', $conversationId)->where('type', 'group')->find();
        if (!$group || (int) $group['owner_id'] !== $operatorId) throw new RuntimeException('只有群主可以设置管理员。');
        if (($group['status'] ?? 'active') !== 'active') throw new RuntimeException('该群组已停用。');
        if (!in_array($role, ['admin', 'member'], true)) throw new RuntimeException('成员角色无效。');
        $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $memberId)->find();
        if (!$member || $member['role'] === 'owner') throw new RuntimeException('成员不存在或不能修改群主角色。');
        Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $memberId)->update(['role' => $role]);
        return ['conversation_id' => $conversationId, 'user_id' => $memberId, 'role' => $role];
    }

    public function muteMember(int $operatorId, int $conversationId, int $memberId, int $minutes): array
    {
        $this->assertManager($operatorId, $conversationId);
        // -1 is permanent, 0 explicitly removes the restriction. Existing timed clients remain compatible.
        if ($minutes < -1 || $minutes > 30 * 24 * 60) throw new RuntimeException('禁言时长必须为永久或 0 至 30 天之间。');
        $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $memberId)->find();
        if (!$member || $member['role'] === 'owner') throw new RuntimeException('成员不存在或不能禁言群主。');
        $operator = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $operatorId)->find();
        if (($operator['role'] ?? '') !== 'owner' && $member['role'] !== 'member') throw new RuntimeException('管理员不能禁言其他管理员。');
        $until = $minutes === -1 ? self::PERMANENT_MUTE_UNTIL : ($minutes === 0 ? null : date('Y-m-d H:i:s', time() + $minutes * 60));
        Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $memberId)->update(['muted_until' => $until]);
        return ['conversation_id' => $conversationId, 'user_id' => $memberId, 'muted_until' => $until, 'muted_permanent' => $minutes === -1, 'is_muted' => $minutes !== 0];
    }

    public function groupProfile(int $userId, int $conversationId): array
    {
        $group = $this->assertMember($userId, $conversationId);
        $member = Db::name('conversation_members')->alias('m')->leftJoin('user_permissions viewer_permission', 'viewer_permission.user_id=m.user_id')
            ->where('m.conversation_id', $conversationId)->where('m.user_id', $userId)->field('m.*,viewer_permission.muted AS __account_muted')->find();
        if (!$member) throw new RuntimeException('你不是该群组成员。');
        return [
            'conversation_id' => $conversationId,
            'id' => $conversationId,
            'type' => 'group',
            'name' => $group['name'],
            'avatar_url' => $group['avatar_url'] ?? null,
            'description' => $group['description'] ?? null,
            'announcement' => $group['announcement'] ?? null,
            'invite_code' => $group['invite_code'] ?? null,
            'allow_member_add_friend' => (bool) ($group['allow_member_add_friend'] ?? true),
            'max_members' => (int) ($group['max_members'] ?? 500),
            'all_muted' => (bool) ($group['all_muted'] ?? false),
            'join_method' => $group['join_method'] ?? 'free',
            'status' => $group['status'] ?? 'active',
            'owner_id' => (int) $group['owner_id'],
            'member_count' => GroupMemberCount::display($group, (int) Db::name('conversation_members')->where('conversation_id', $conversationId)->count()),
            'created_at' => $group['created_at'],
            'updated_at' => $group['updated_at'],
            'my_role' => $member['role'],
            'members_visibility' => in_array($member['role'], ['owner', 'admin'], true) || (bool) ($group['allow_member_add_friend'] ?? true) ? 'all' : 'managers',
            'can_manage' => in_array($member['role'], ['owner', 'admin'], true),
            'can_invite' => in_array($member['role'], ['owner', 'admin'], true),
            'is_owner' => $member['role'] === 'owner',
            'notifications_muted' => (bool) $member['notifications_muted'],
            'is_pinned' => (bool) $member['is_pinned'],
        ] + self::sendState($group + ['my_role' => $member['role'], 'my_muted_until' => $member['muted_until'], '__account_muted' => $member['__account_muted']]);
    }

    public function updateGroupProfile(int $operatorId, int $conversationId, array $data): array
    {
        $this->assertManager($operatorId, $conversationId);
        $updates = [];
        if (array_key_exists('name', $data)) {
            $name = trim((string) $data['name']);
            if (mb_strlen($name) < 1 || mb_strlen($name) > 128) throw new RuntimeException('群名称长度必须为 1 至 128 个字符。');
            $updates['name'] = $name;
        }
        foreach (['avatar_url' => 512, 'description' => 500, 'announcement' => 10000] as $field => $limit) {
            if (!array_key_exists($field, $data)) continue;
            $value = trim((string) ($data[$field] ?? ''));
            if (mb_strlen($value) > $limit) throw new RuntimeException('群资料内容过长。');
            if ($field === 'avatar_url' && $value !== '') (new MediaAccessService())->assertCanAttach($value, $operatorId);
            $updates[$field] = $value === '' ? null : $value;
        }
        if (array_key_exists('allow_member_add_friend', $data)) $updates['allow_member_add_friend'] = (int) (bool) $data['allow_member_add_friend'];
        if (array_key_exists('max_members', $data)) {
            $maxMembers = (int) $data['max_members'];
            $memberCount = (int) Db::name('conversation_members')->where('conversation_id', $conversationId)->count();
            if ($maxMembers < $memberCount || $maxMembers < 1 || $maxMembers > 10000000) throw new RuntimeException('最大成员数不能小于当前成员数。');
            $updates['max_members'] = $maxMembers;
        }
        if (array_key_exists('all_muted', $data)) $updates['all_muted'] = (int) (bool) $data['all_muted'];
        if (array_key_exists('join_method', $data) && in_array($data['join_method'], ['free', 'approval', 'invite'], true)) $updates['join_method'] = $data['join_method'];
        if ($updates === []) throw new RuntimeException('没有需要保存的群资料。');
        $updates['updated_at'] = date('Y-m-d H:i:s');
        Db::name('conversations')->where('id', $conversationId)->update($updates);
        return $this->groupProfile($operatorId, $conversationId);
    }

    public function transferGroup(int $operatorId, int $conversationId, int $newOwnerId): array
    {
        $group = $this->assertMember($operatorId, $conversationId);
        if ((int) $group['owner_id'] !== $operatorId) throw new RuntimeException('只有群主可以转让群主。');
        $newOwner = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $newOwnerId)->find();
        if (!$newOwner) throw new RuntimeException('新的群主必须是群成员。');
        if ($newOwnerId === $operatorId) throw new RuntimeException('不能转让给自己。');
        Db::transaction(function () use ($conversationId, $operatorId, $newOwnerId): void {
            Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $operatorId)->update(['role' => 'member']);
            Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $newOwnerId)->update(['role' => 'owner']);
            Db::name('conversations')->where('id', $conversationId)->update(['owner_id' => $newOwnerId, 'updated_at' => date('Y-m-d H:i:s')]);
        });
        return ['conversation_id' => $conversationId, 'owner_id' => $newOwnerId, 'status' => 'transferred'];
    }

    public function dissolveGroup(int $operatorId, int $conversationId): array
    {
        $group = $this->assertMember($operatorId, $conversationId);
        if ((int) $group['owner_id'] !== $operatorId) throw new RuntimeException('只有群主可以解散群组。');
        Db::name('conversations')->where('id', $conversationId)->update(['status' => 'deleted', 'updated_at' => date('Y-m-d H:i:s')]);
        return ['conversation_id' => $conversationId, 'status' => 'dissolved'];
    }

    public function updateGroupSettings(int $userId, int $conversationId, array $data): array
    {
        $this->assertMember($userId, $conversationId);
        $updates = [];
        if (array_key_exists('notifications_muted', $data)) $updates['notifications_muted'] = (int) (bool) $data['notifications_muted'];
        if (array_key_exists('is_pinned', $data)) $updates['is_pinned'] = (int) (bool) $data['is_pinned'];
        if ($updates === []) throw new RuntimeException('没有需要保存的群设置。');
        Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->update($updates);
        return $this->groupProfile($userId, $conversationId);
    }

    public function updateUserSettings(int $userId, int $conversationId, array $data): array
    {
        if ($conversationId <= 0) throw new RuntimeException('会话编号无效。');
        $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->find();
        if (!$member) throw new RuntimeException('你不是该会话成员。');
        $updates = [];
        if (array_key_exists('notifications_muted', $data)) $updates['notifications_muted'] = (int) (bool) $data['notifications_muted'];
        if (array_key_exists('is_pinned', $data)) $updates['is_pinned'] = (int) (bool) $data['is_pinned'];
        if (array_key_exists('is_archived', $data)) {
            if (!in_array($data['is_archived'], [true, false, 0, 1, '0', '1'], true)) throw new RuntimeException('归档状态无效。');
            $conversation = Db::name('conversations')->where('id', $conversationId)->where('status', 'active')->find();
            if (!$conversation) throw new RuntimeException('会话不存在或已停用。');
            if ($conversation['type'] === 'favorites') throw new RuntimeException('我的收藏不支持归档。');
            $updates['is_archived'] = (int) (bool) $data['is_archived'];
        }
        if ($updates === []) throw new RuntimeException('没有需要保存的会话设置。');
        Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->update($updates);
        return $this->infoForUser($userId, $conversationId);
    }

    public function hideForUser(int $userId, int $conversationId): array
    {
        if ($conversationId <= 0) throw new RuntimeException('会话编号无效。');
        $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->find();
        if (!$member) throw new RuntimeException('你不是该会话成员。');
        Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->update(['hidden_at' => date('Y-m-d H:i:s')]);
        return ['conversation_id' => $conversationId, 'status' => 'hidden'];
    }

    public function openForUser(int $userId, int $conversationId): array
    {
        $info = $this->infoForUser($userId, $conversationId);
        Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->update(['hidden_at' => null]);
        return $info;
    }

    public function infoForUser(int $userId, int $conversationId): array
    {
        $this->active($userId);
        $row = Db::name('conversations')->alias('c')->join('conversation_members m', 'm.conversation_id = c.id')
            ->leftJoin('user_permissions viewer_permission', 'viewer_permission.user_id=m.user_id')
            ->where('c.id', $conversationId)->where('m.user_id', $userId)->where('c.status', 'active')
            ->field('c.*,m.role AS my_role,m.muted_until AS my_muted_until,viewer_permission.muted AS __account_muted,m.notifications_muted,m.is_pinned,m.is_archived,m.cleared_before_message_id')->find();
        if (!$row) throw new RuntimeException('会话不存在或你不是该会话成员。');
        return $this->format($row, $userId);
    }

    public function subscriptionIds(int $userId, int $afterId): array
    {
        $this->active($userId);
        $ids = Db::name('conversation_members')->alias('m')->join('conversations c', 'c.id = m.conversation_id')
            ->where('m.user_id', $userId)->where('c.status', 'active')->where('c.id', '>', max(0, $afterId))
            ->order('c.id')->limit(500)->column('c.id');
        $ids = array_map('intval', $ids);
        return ['ids' => $ids, 'next_cursor' => count($ids) === 500 ? end($ids) : 0];
    }

    private function active(int $id): void { if ($id <= 0 || !Db::name('users')->where('id', $id)->where('status', 'active')->find()) throw new RuntimeException('User not found.'); }
    private function ensureContactDirectConversations(int $userId): void
    {
        if ($userId <= 0) return;
        $contactIds = Db::name('contacts')->alias('c')->join('users u', 'u.id = c.contact_user_id')
            ->where('c.user_id', $userId)->where('u.status', 'active')->column('c.contact_user_id');
        $contactIds = array_values(array_unique(array_map('intval', $contactIds)));
        if ($contactIds === []) return;

        $existingIds = Db::name('conversations')->alias('v')
            ->join('conversation_members m1', 'm1.conversation_id = v.id')
            ->join('conversation_members m2', 'm2.conversation_id = v.id')
            ->where('v.type', 'direct')->where('m1.user_id', $userId)->whereIn('m2.user_id', $contactIds)
            ->column('m2.user_id');
        $existingIds = array_values(array_unique(array_map('intval', $existingIds)));
        $missingIds = array_values(array_diff($contactIds, $existingIds));
        if ($missingIds === []) return;

        $blockedIds = Db::name('user_blocks')->where('blocker_id', $userId)->whereIn('blocked_id', $missingIds)->column('blocked_id');
        $blockedByIds = Db::name('user_blocks')->whereIn('blocker_id', $missingIds)->where('blocked_id', $userId)->column('blocker_id');
        $blockedIds = array_values(array_unique(array_merge(array_map('intval', $blockedIds), array_map('intval', $blockedByIds))));
        $missingIds = array_values(array_diff($missingIds, $blockedIds));
        if ($missingIds === []) return;

        Db::transaction(function () use ($userId, $missingIds): void {
            foreach ($missingIds as $contactId) {
                $exists = Db::name('conversations')->alias('v')
                    ->join('conversation_members m1', 'm1.conversation_id = v.id')
                    ->join('conversation_members m2', 'm2.conversation_id = v.id')
                    ->where('v.type', 'direct')->where('m1.user_id', $userId)->where('m2.user_id', $contactId)
                    ->field('v.id')->find();
                if ($exists) continue;
                $now = date('Y-m-d H:i:s');
                $conversationId = Db::name('conversations')->insertGetId([
                    'type' => 'direct', 'owner_id' => $userId, 'created_at' => $now, 'updated_at' => $now,
                ]);
                Db::name('conversation_members')->insertAll([
                    ['conversation_id' => $conversationId, 'user_id' => $userId, 'role' => 'owner', 'joined_at' => $now],
                    ['conversation_id' => $conversationId, 'user_id' => $contactId, 'role' => 'member', 'joined_at' => $now],
                ]);
            }
        });
    }
    private function assertManager(int $operatorId, int $conversationId): array
    {
        $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $operatorId)->whereIn('role', ['owner', 'admin'])->find();
        if (!$member) throw new RuntimeException('只有群主或管理员可以执行此操作。');
        $group = Db::name('conversations')->where('id', $conversationId)->where('type', 'group')->find();
        if (!$group) throw new RuntimeException('群组不存在。');
        if (($group['status'] ?? 'active') !== 'active') throw new RuntimeException('该群组已停用。');
        return $group;
    }
    /** Match ordinary sends in MessageService::assertPermissionRows, without per-row SQL.
     * This snapshot only controls the composer; sends still enforce current permissions. */
    private static function sendState(array $row): array
    {
        $role = $row['my_role'] ?? null;
        $manager = in_array($role, ['owner', 'admin'], true);
        $until = $row['my_muted_until'] ?? null;
        $reason = '';
        if (($row['status'] ?? 'active') !== 'active' || $role === null) $reason = 'inactive';
        elseif ($row['type'] === 'channel' && !$manager) $reason = 'channel_readonly';
        elseif ($row['type'] === 'group' && (int) ($row['all_muted'] ?? 0) === 1 && !$manager) $reason = 'group_muted';
        elseif ((int) ($row['__account_muted'] ?? 0)) $reason = 'account_muted';
        elseif (!empty($until) && strtotime($until) > time()) $reason = 'member_muted';
        return ['can_send' => $reason === '', 'send_disabled_reason' => $reason, 'my_muted_until' => $until];
    }

    private function format(array $row, int $viewerId = 0, ?int $knownMemberCount = null, ?array $peerContext = null): array
    {
        $role = $row['my_role'] ?? null;
        $name = $row['name'];
        $avatar = in_array($row['type'], ['group', 'channel', 'customer_service'], true) ? ($row['avatar_url'] ?? null) : null;
        $memberCount = in_array($row['type'], ['group', 'channel'], true)
            ? ($knownMemberCount ?? (int) Db::name('conversation_members')->where('conversation_id', (int) $row['id'])->count())
            : null;
        if ($memberCount !== null) $memberCount = GroupMemberCount::display($row, $memberCount);
        if ($row['type'] === 'favorites') $name = '我的收藏';
        $peerUserId = null;
        $peerPublicId = null;
        $peerNickname = null;
        $peerUsername = null;
        $peerOnline = false;
        $peerLastSeenAt = null;
        $remark = null;
        if ($row['type'] === 'direct' && $viewerId > 0) {
            $other = $peerContext !== null ? $peerContext['peer'] : Db::name('conversation_members')->alias('m')
                ->leftJoin('users u', 'u.id = m.user_id')
                ->leftJoin('user_presence p', 'p.user_id = m.user_id')
                ->leftJoin('user_settings s', 's.user_id = m.user_id')
                ->leftJoin('contacts c', 'c.user_id = ' . (int) $viewerId . ' AND c.contact_user_id = m.user_id')
                ->where('m.conversation_id', (int) $row['id'])
                ->where('m.user_id', '<>', $viewerId)
                ->field('u.id,u.public_id,u.nickname,u.username,u.avatar_url,p.last_seen_at,s.settings_json,c.contact_user_id AS viewer_contact_id,c.remark AS viewer_remark')->find();
            if ($other) {
                $peerUserId = (int) $other['id'];
                $peerPublicId = $other['public_id'] ?? null;
                $peerNickname = $other['nickname'] ?? null;
                $peerUsername = $other['username'] ?? null;
                $remark = trim((string) ($other['viewer_remark'] ?? '')) ?: null;
                $name = $remark ?: $other['nickname'];
                $avatar = $other['avatar_url'];
                $privacy = $peerContext !== null ? (new UserSettingsService())->fromStorage($other['settings_json'] ?? null) : (new UserSettingsService())->get($peerUserId);
                $visible = (new UserSettingsService())->canView($privacy, 'last_seen_visibility', $viewerId, $other['viewer_contact_id'] !== null);
                $visible = $visible && !($peerContext !== null ? $other['blocked_by_peer'] !== null : (new BlockService())->isBlocked($peerUserId, $viewerId));
                if ($visible) {
                    $peerLastSeenAt = $other['last_seen_at'] ?? null;
                    $peerOnline = $peerLastSeenAt !== null && strtotime($peerLastSeenAt) >= time() - 60;
                }
            }
        }
        return self::sendState($row) + ['is_archived' => (bool) ($row['is_archived'] ?? false), 'id' => (int) $row['id'], 'type' => $row['type'], 'name' => $name, 'remark' => $remark, 'avatar_url' => $avatar, 'peer_user_id' => $peerUserId, 'peer_public_id' => $peerPublicId, 'peer_nickname' => $peerNickname, 'peer_username' => $peerUsername, 'peer_online' => $peerOnline, 'peer_last_seen_at' => $peerLastSeenAt, 'description' => $row['description'] ?? null, 'member_count' => $memberCount, 'owner_id' => $row['owner_id'], 'my_role' => $role, 'can_manage' => in_array($role, ['owner', 'admin'], true), 'can_invite' => in_array($row['type'], ['group', 'channel'], true) && in_array($role, ['owner', 'admin'], true), 'can_publish' => $row['type'] !== 'channel' || in_array($role, ['owner', 'admin'], true), 'invite_code' => $row['type'] === 'group' || ($row['type'] === 'channel' && in_array($role, ['owner', 'admin'], true)) ? $row['invite_code'] ?? null : null, 'allow_member_add_friend' => $row['type'] === 'group' ? (bool) ($row['allow_member_add_friend'] ?? true) : true, 'max_members' => (int) ($row['max_members'] ?? 500), 'all_muted' => (bool) ($row['all_muted'] ?? false), 'join_method' => $row['join_method'] ?? 'free', 'status' => $row['status'] ?? 'active', 'notifications_muted' => (bool) ($row['notifications_muted'] ?? false), 'is_pinned' => (bool) ($row['is_pinned'] ?? false), 'cleared_before_message_id' => (int) ($row['cleared_before_message_id'] ?? 0), 'created_at' => $row['created_at'], 'updated_at' => $row['updated_at']];
    }

    private function creationAvatar(?string $value): ?string
    {
        $value = trim($value ?? '');
        if ($value === '') return null;
        $base = rtrim((string) env('FILE_BASE_URL', '/storage'), '/') . '/';
        if (mb_strlen($value) > 512 || !str_starts_with($value, $base)) throw new RuntimeException('请使用本地上传的图片作为头像。');
        $relative = substr($value, strlen($base));
        if (!preg_match('~^uploads/[0-9]{4}/(?:0[1-9]|1[0-2])/[a-f0-9]{32}\.(jpg|jpeg|png|gif|webp)$~D', $relative, $match)) throw new RuntimeException('头像文件地址无效。');
        $path = app()->getRootPath() . 'public/storage/' . $relative;
        $size = is_file($path) ? filesize($path) : 0;
        $image = $size > 0 && $size <= 10 * 1024 * 1024 ? @getimagesize($path) : false;
        $types = ['jpg' => IMAGETYPE_JPEG, 'jpeg' => IMAGETYPE_JPEG, 'png' => IMAGETYPE_PNG, 'gif' => IMAGETYPE_GIF, 'webp' => IMAGETYPE_WEBP];
        if (!$image || $image[2] !== $types[$match[1]]) throw new RuntimeException('头像图片不存在、无效或超过 10 MB，请重新上传。');
        return $value;
    }

    private function assertMember(int $userId, int $conversationId): array
    {
        $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->find();
        if (!$member) throw new RuntimeException('你不是该群组成员。');
        $group = Db::name('conversations')->where('id', $conversationId)->where('type', 'group')->find();
        if (!$group) throw new RuntimeException('群组不存在。');
        if (($group['status'] ?? 'active') !== 'active') throw new RuntimeException('该群组已停用。');
        return $group;
    }
}
