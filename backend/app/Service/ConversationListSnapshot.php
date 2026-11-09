<?php
namespace app\Service;

use think\facade\Db;

/** Four bounded reads per page, always scoped to this viewer's membership. */
final class ConversationListSnapshot
{
    public function read(int $viewer, array $conversationIds): array
    {
        $ids = array_values(array_unique(array_filter(array_map('intval', $conversationIds), static fn (int $id): bool => $id > 0)));
        if ($viewer <= 0 || count($ids) > 100) throw new \InvalidArgumentException('Invalid conversation snapshot.');
        $result = ['last' => [], 'unread' => [], 'members' => [], 'peers' => []];
        if ($ids === []) return $result;
        $tables = [];
        foreach (['messages', 'conversation_members', 'message_deletions', 'message_receipts', 'users', 'user_presence', 'user_settings', 'contacts', 'user_blocks'] as $name) {
            $table = Db::name($name)->getTable();
            if (!is_string($table) || !preg_match('/^[A-Za-z0-9_]+$/D', $table)) throw new \RuntimeException('Unsupported table identifier.');
            $tables[$name] = '`' . $table . '`';
        }
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $message = $tables['messages']; $member = $tables['conversation_members'];
        $hidden = $tables['message_deletions']; $receipt = $tables['message_receipts'];
        $visibleLast = GroupInviteNoticeService::visibleSql($viewer, 'v');
        $visibleUnread = GroupInviteNoticeService::visibleSql($viewer, 'm');
        // The inner LIMIT uses the conversation/id index instead of ranking an
        // entire history. It is still one database round trip for the page.
        $lastSql = "SELECT cm.conversation_id,lm.id,lm.sender_id,lm.type,lm.body_json,lm.created_at,author.nickname AS author_name
            FROM $member cm LEFT JOIN $message lm ON lm.id=(
                SELECT v.id FROM $message v WHERE v.conversation_id=cm.conversation_id
                AND v.id>COALESCE(cm.cleared_before_message_id,0) AND v.type<>'red_packet' AND v.recalled_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM $hidden h WHERE h.user_id=? AND h.message_id=v.id)
                AND $visibleLast ORDER BY v.id DESC LIMIT 1)
            LEFT JOIN {$tables['users']} author ON author.id=lm.sender_id
            WHERE cm.user_id=? AND cm.conversation_id IN ($placeholders)";
        foreach (Db::query($lastSql, [$viewer, $viewer, ...$ids]) as $row) {
            if ($row['id'] !== null) $result['last'][(int) $row['conversation_id']] = $row;
        }
        $hint = Db::connect()->getConfig('type') === 'mysql' ? ' FORCE INDEX (idx_message_visibility_count)' : '';
        $unreadSql = "SELECT m.conversation_id,COUNT(*) AS unread_count FROM $message m$hint
            JOIN $member cm ON cm.conversation_id=m.conversation_id AND cm.user_id=?
            WHERE m.conversation_id IN ($placeholders) AND COALESCE(cm.notifications_muted,0)=0
            AND m.id>COALESCE(cm.cleared_before_message_id,0) AND m.sender_id<>? AND m.type<>'red_packet' AND m.recalled_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM $hidden h WHERE h.user_id=? AND h.message_id=m.id)
            AND m.id NOT IN (SELECT message_id FROM $receipt WHERE user_id=?)
            AND $visibleUnread GROUP BY m.conversation_id";
        foreach (Db::query($unreadSql, [$viewer, ...$ids, $viewer, $viewer, $viewer]) as $row) $result['unread'][(int) $row['conversation_id']] = (int) $row['unread_count'];
        foreach (Db::name('conversation_members')->whereIn('conversation_id', $ids)->field('conversation_id,COUNT(*) AS member_count')->group('conversation_id')->select()->toArray() as $row) $result['members'][(int) $row['conversation_id']] = (int) $row['member_count'];
        $peers = Db::name('conversation_members')->alias('m')
            ->join('conversations peer_conversation', "peer_conversation.id=m.conversation_id AND peer_conversation.type='direct'")
            ->leftJoin('users u', 'u.id=m.user_id')->leftJoin('user_presence p', 'p.user_id=m.user_id')
            ->leftJoin('user_settings s', 's.user_id=m.user_id')
            ->leftJoin('contacts c', 'c.user_id=' . $viewer . ' AND c.contact_user_id=m.user_id')
            ->leftJoin('user_blocks b', 'b.blocker_id=m.user_id AND b.blocked_id=' . $viewer)
            ->whereIn('m.conversation_id', $ids)->where('m.user_id', '<>', $viewer)
            ->field('m.conversation_id,u.id,u.public_id,u.nickname,u.username,u.avatar_url,p.last_seen_at,s.settings_json,c.contact_user_id AS viewer_contact_id,c.remark AS viewer_remark,b.blocker_id AS blocked_by_peer')
            ->select()->toArray();
        foreach ($peers as $peer) if (!isset($result['peers'][(int) $peer['conversation_id']])) $result['peers'][(int) $peer['conversation_id']] = $peer;
        return $result;
    }
}
