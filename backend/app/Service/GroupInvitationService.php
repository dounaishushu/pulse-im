<?php
declare(strict_types=1);
namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** Bounded group writes and a picker without message-history/unread queries. */
final class GroupInvitationService
{
    public const BATCH_LIMIT = 50;

    private function authorized(int $operatorId, int $conversationId, bool $lock = false): array
    {
        $group = Db::name('conversations')->where('id', $conversationId)->whereIn('type', ['group', 'channel'])->where('status', 'active')->lock($lock)->find();
        if (!$group) throw new RuntimeException('群组不存在。');
        $actor = Db::name('users')->where('id', $operatorId)->where('status', 'active')->field('id,nickname,avatar_url')->find();
        if (!$actor) throw new RuntimeException('User not found.');
        $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $operatorId)->lock($lock)->find();
        if (!$member) throw new RuntimeException('你不是该会话成员。');
        if (!in_array($member['role'], ['owner', 'admin'], true)) throw new RuntimeException('只有群主或管理员可以邀请新成员。');
        return [$group, $actor, $member];
    }

    public function add(int $operatorId, int $conversationId, mixed $requested): array
    {
        if (!is_array($requested) || !array_is_list($requested) || count($requested) < 1 || count($requested) > self::BATCH_LIMIT) throw new RuntimeException('每批邀请人数必须为1至50人。');
        foreach ($requested as $id) if (!is_int($id) || $id <= 0) throw new RuntimeException('群成员编号无效。');
        $ids = array_values(array_unique($requested));
        return Db::transaction(function () use ($operatorId, $conversationId, $ids): array {
            [$group, $actor] = $this->authorized($operatorId, $conversationId, true);
            // Locking reads also work for a nested caller with an older RR snapshot.
            $count = (int) Db::name('conversation_members')->where('conversation_id', $conversationId)->lock(true)->count();
            $existing = array_fill_keys(array_map('intval', Db::name('conversation_members')->where('conversation_id', $conversationId)->whereIn('user_id', $ids)->lock(true)->column('user_id')), true);
            $targets = Db::name('users')->alias('u')->leftJoin('user_settings s', 's.user_id=u.id')
                ->leftJoin('contacts c', 'c.user_id=u.id AND c.contact_user_id=' . $operatorId)
                ->leftJoin('user_blocks incoming', 'incoming.blocker_id=u.id AND incoming.blocked_id=' . $operatorId)
                ->leftJoin('user_blocks outgoing', 'outgoing.blocked_id=u.id AND outgoing.blocker_id=' . $operatorId)
                ->whereIn('u.id', $ids)->field('u.id,u.nickname,u.status,s.settings_json,c.contact_user_id,incoming.blocker_id AS blocked_in,outgoing.blocker_id AS blocked_out')->select()->toArray();
            $targets = array_column($targets, null, 'id');
            $settings = new UserSettingsService(); $items = []; $added = []; $now = date('Y-m-d H:i:s');
            foreach ($ids as $id) {
                $target = $targets[$id] ?? null; $message = null; $code = null;
                if (!$target || $target['status'] !== 'active') { $message = 'User not found.'; $code = 'USER_UNAVAILABLE'; }
                else {
                    $privacy = $settings->fromStorage($target['settings_json'] ?? null);
                    if (!$settings->canView($privacy, 'invite_visibility', $operatorId, $target['contact_user_id'] !== null)) {
                        $message = ($privacy['invite_visibility'] ?? 'everyone') === 'contacts' ? '该用户只允许联系人邀请进群。' : '该用户已关闭群组邀请。'; $code = 'INVITE_PRIVACY';
                    } elseif ($target['blocked_in'] !== null || $target['blocked_out'] !== null) { $message = '双方存在屏蔽关系，无法邀请。'; $code = 'INVITE_BLOCKED'; }
                }
                if (!$message && !isset($existing[$id]) && $count + count($added) >= (int) ($group['max_members'] ?? 500)) { $message = '该群组成员数量已达到上限。'; $code = 'GROUP_FULL'; }
                if ($message) { $items[] = ['user_id' => $id, 'status' => 'rejected', 'code' => $code, 'message' => $message]; continue; }
                $isNew = !isset($existing[$id]);
                $items[] = ['user_id' => $id, 'status' => 'joined', 'added' => $isNew];
                if ($isNew) $added[$id] = (string) $target['nickname'];
            }
            if ($added) {
                $rows = [];
                foreach ($added as $id => $_) $rows[] = ['conversation_id' => $conversationId, 'user_id' => $id, 'role' => 'member', 'joined_at' => $now];
                Db::name('conversation_members')->insertAll($rows);
                if ($group['type'] === 'group') {
                    (new GroupInviteNoticeService())->recordBatch($conversationId, $operatorId, (string) $actor['nickname'], $added, $now);
                    // Reserve notification event numbers once, at the end of this
                    // transaction. No external Redis connection delays the reply.
                    (new UserNotificationService())->groupBatch(array_keys($added), $actor, $group, $now);
                }
            }
            $actual = $count + count($added);
            return ['conversation_id' => $conversationId, 'items' => $items, 'added_count' => count($added),
                'member_count' => GroupMemberCount::display($group, $actual), 'actual_member_count' => $actual,
                'remaining' => max(0, (int) ($group['max_members'] ?? 500) - $actual)];
        });
    }

    public function candidates(int $operatorId, int $conversationId, int $page = 1, int $size = 500): array
    {
        [$group, , $member] = $this->authorized($operatorId, $conversationId);
        $page = max(1, min(1000, $page)); $size = max(1, min(500, $size));
        $actual = (int) Db::name('conversation_members')->where('conversation_id', $conversationId)->count();
        $tables = [];
        foreach (['contacts', 'conversation_members', 'conversations', 'users'] as $name) {
            $table = Db::name($name)->getTable();
            if (!is_string($table) || !preg_match('/^[A-Za-z0-9_]+$/D', $table)) throw new RuntimeException('Unsupported table identifier.');
            $tables[$name] = '`' . $table . '`';
        }
        $contacts = $tables['contacts']; $members = $tables['conversation_members']; $groups = $tables['conversations']; $users = $tables['users'];
        // Start from this account's indexed relations, never scan every user or
        // compute message previews, unread totals, online status or IP locations.
        $sql = "SELECT u.id AS user_id,u.nickname,u.username,u.public_id,u.avatar_url,c.remark,
            choices.is_contact,choices.is_pinned,choices.last_activity,choices.contact_created_at,
            CASE WHEN present.user_id IS NULL THEN 0 ELSE 1 END AS in_group
            FROM (SELECT user_id,MAX(is_contact) AS is_contact,MAX(is_pinned) AS is_pinned,
                  MAX(last_activity) AS last_activity,MAX(contact_created_at) AS contact_created_at FROM (
                SELECT contact_user_id AS user_id,1 AS is_contact,0 AS is_pinned,'' AS last_activity,created_at AS contact_created_at FROM $contacts WHERE user_id=?
                UNION ALL
                SELECT peer.user_id,0,COALESCE(self.is_pinned,0),conv.updated_at,'' FROM $members self
                JOIN $groups conv ON conv.id=self.conversation_id AND conv.type='direct' AND conv.status='active'
                JOIN $members peer ON peer.conversation_id=self.conversation_id AND peer.user_id<>self.user_id
                WHERE self.user_id=? AND self.hidden_at IS NULL
            ) relations GROUP BY user_id) choices
            JOIN $users u ON u.id=choices.user_id AND u.status='active' AND u.id<>?
            LEFT JOIN $contacts c ON c.user_id=? AND c.contact_user_id=u.id
            LEFT JOIN $members present ON present.conversation_id=? AND present.user_id=u.id
            ORDER BY choices.is_pinned DESC,choices.last_activity DESC,choices.contact_created_at DESC,u.id ASC
            LIMIT " . ($size + 1) . ' OFFSET ' . (($page - 1) * $size);
        $rows = Db::query($sql, [$operatorId, $operatorId, $operatorId, $operatorId, $conversationId]);
        $more = count($rows) > $size; $rows = array_slice($rows, 0, $size);
        foreach ($rows as &$row) {
            $row['user_id'] = (int) $row['user_id'];
            foreach (['is_contact', 'is_pinned', 'in_group'] as $key) $row[$key] = (bool) $row[$key];
        }
        unset($row);
        return ['items' => $rows, 'has_more' => $more, 'page' => $page, 'size' => $size,
            'group' => ['id' => $conversationId, 'type' => $group['type'], 'name' => $group['name'], 'avatar_url' => $group['avatar_url'] ?? null,
                'my_role' => $member['role'], 'can_invite' => true, 'max_members' => (int) ($group['max_members'] ?? 500),
                'member_count' => GroupMemberCount::display($group, $actual), 'actual_member_count' => $actual,
                'remaining' => max(0, (int) ($group['max_members'] ?? 500) - $actual)]];
    }
}
