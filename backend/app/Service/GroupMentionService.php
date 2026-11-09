<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** Mention permissions and sparse unread index; never grants roster/profile access. */
final class GroupMentionService
{
    private const MENTION_ROLES = ['owner', 'admin'];

    public function search(int $viewer, int $conversation, string $query = '', int $page = 1): array
    {
        $query = trim($query);
        if ($viewer <= 0 || $conversation <= 0 || mb_strlen($query) > 80 || $page < 1 || $page > 10000) throw new RuntimeException('@搜索参数无效。');
        $member = Db::name('conversation_members')->alias('v')->join('conversations g', 'g.id = v.conversation_id')
            ->join('users a', 'a.id = v.user_id')
            ->where('v.conversation_id', $conversation)->where('v.user_id', $viewer)->where('g.type', 'group')->where('g.status', 'active')->where('a.status', 'active')
            ->field('v.role')->find();
        if (!$member) throw new RuntimeException('你不是该群组成员，或群组已停用。');
        $allowed = in_array($member['role'], self::MENTION_ROLES, true);
        if (!$allowed) return ['conversation_id' => $conversation, 'can_search' => false, 'items' => [], 'page' => $page, 'has_more' => false];
        $rows = Db::name('conversation_members')->alias('m')->join('users u', 'u.id = m.user_id')
            ->join('conversation_members v', 'v.conversation_id = m.conversation_id AND v.user_id = ' . $viewer)
            ->where('m.conversation_id', $conversation)->where('u.status', 'active')->where('m.user_id', '<>', $viewer)
            // Recheck the current role in the data SELECT, including after revocation.
            ->whereIn('v.role', self::MENTION_ROLES);
        if ($query !== '') {
            // Treat % and _ as literal characters, not wildcard operators.
            $pattern = '%' . str_replace(['=', '%', '_'], ['==', '=%', '=_'], $query) . '%';
            $rows->whereRaw("(u.nickname LIKE ? ESCAPE '=' OR u.username LIKE ? ESCAPE '=' OR CONVERT(u.public_id USING utf8mb4) LIKE ? ESCAPE '=')", [$pattern, $pattern, $pattern]);
        }
        $items = $rows->field('m.user_id,u.nickname,u.username,u.public_id,u.avatar_url')->order('u.nickname')->order('m.user_id')->limit(($page - 1) * 30, 31)->select()->toArray();
        $more = count($items) > 30;
        if ($more) array_pop($items);
        foreach ($items as &$item) $item['user_id'] = (int) $item['user_id'];
        return ['conversation_id' => $conversation, 'can_search' => true, 'can_mention_all' => true, 'items' => $items, 'page' => $page, 'has_more' => $more];
    }

    /** Called inside the message transaction, after locking the current group role. */
    public function normalize(array $body, int $conversation, int $sender, string $type, string $role): array
    {
        $explicit = array_key_exists('mention_user_ids', $body) || array_key_exists('mention_all', $body);
        $ids = $body['mention_user_ids'] ?? null;
        $all = $body['mention_all'] ?? false;
        unset($body['mention_user_ids'], $body['mention_all']);
        if ($explicit && (($ids !== null && (!is_array($ids) || !array_is_list($ids) || count($ids) > 100)) || !is_bool($all))) throw new RuntimeException('@参数无效。');
        if ($type !== 'group') return $body;
        $manager = in_array($role, self::MENTION_ROLES, true);
        if (!$manager && $role !== 'member') {
            if ($explicit) throw new RuntimeException('你不是该群组的有效成员。');
            return $body;
        }
        if ($all && !$manager) throw new RuntimeException('只有群主和管理员可以@所有人。');
        // Members may address the exact author selected from a visible message.
        // Do not infer identities from arbitrary names or expose the member list.
        if (!$manager && $ids === null) return $body;
        $text = (string) ($body['text'] ?? '');
        if (!str_contains($text, '@')) {
            if ($all || !empty($ids)) throw new RuntimeException('@对象与消息内容不匹配，请重新选择。');
            return $body;
        }
        if ($all) {
            if (!self::contains($text, '所有人')) throw new RuntimeException('@所有人与消息内容不匹配，请重新选择。');
            $body['mention_all'] = true;
            return $body;
        }
        if ($ids !== null) {
            foreach ($ids as $id) if (!is_int($id) || $id <= 0 || $id === $sender) throw new RuntimeException('@成员参数无效。');
            $ids = array_values(array_unique($ids));
            if ($ids === []) return $body;
        }
        // Legacy mobile clients insert text only. Match complete, unique display
        // names; duplicate names require an explicit user ID from the picker.
        $query = Db::name('conversation_members')->alias('m')->join('users u', 'u.id=m.user_id')
            ->where('m.conversation_id', $conversation)->where('u.status', 'active')->where('m.user_id', '<>', $sender);
        if ($ids !== null) $query->whereIn('m.user_id', $ids);
        $members = $query->field('m.user_id,u.nickname')->select()->toArray();
        $names = []; $matched = [];
        foreach ($members as $member) {
            $name = self::displayName((string) $member['nickname']);
            if ($name === '' || ($name === '所有人' && $ids === null) || !self::contains($text, $name)) continue;
            $names[$name][] = (int) $member['user_id'];
        }
        foreach ($names as $users) if ($ids !== null || count($users) === 1) foreach ($users as $id) $matched[] = $id;
        if ($ids !== null && count($matched) !== count($ids)) throw new RuntimeException('@成员已变化或不在群内，请重新选择。');
        if (count($matched) > 100) throw new RuntimeException('单条消息最多@100位成员，请使用@所有人。');
        if ($matched !== []) $body['mention_user_ids'] = $matched;
        return $body;
    }

    private static function displayName(string $name): string
    {
        return mb_substr(trim(preg_replace('/\s+/u', ' ', preg_replace('/[\p{Cc}\p{Cf}]/u', '', $name))), 0, 80);
    }

    private static function contains(string $text, string $name): bool
    {
        return preg_match('/(?:^|\s)@' . preg_quote($name, '/') . '(?=\s|$)/u', $text) === 1;
    }

    public function record(int $message, int $conversation, array $body): void
    {
        $ids = !empty($body['mention_all']) ? [0] : ($body['mention_user_ids'] ?? []);
        if ($ids !== []) Db::name('message_mentions')->insertAll(array_map(static fn (int $user): array => ['message_id' => $message, 'conversation_id' => $conversation, 'user_id' => $user], $ids));
    }

    /** One indexed query per conversation-list page, including muted groups. */
    public function unread(int $user, array $conversations): array
    {
        if ($conversations === []) return [];
        $rows = Db::name('message_mentions')->alias('mm')
            ->join('messages m', 'm.id=mm.message_id AND m.conversation_id=mm.conversation_id')
            ->join('conversation_members cm', 'cm.conversation_id=mm.conversation_id AND cm.user_id=' . $user)
            ->join('conversations c', 'c.id=mm.conversation_id')
            ->leftJoin('message_receipts r', 'r.message_id=mm.message_id AND r.user_id=' . $user)
            ->whereIn('mm.conversation_id', $conversations)->whereIn('mm.user_id', [0, $user])
            ->where('c.type', 'group')->where('c.status', 'active')->where('m.sender_id', '<>', $user)
            ->whereRaw('m.id > cm.cleared_before_message_id AND m.created_at >= cm.joined_at')
            ->whereNull('m.recalled_at')->whereRaw("(r.status IS NULL OR r.status <> 'read')")
            ->whereNotIn('m.id', MessageDeletionService::hiddenQuery($user))
            ->field('mm.conversation_id,COUNT(DISTINCT mm.message_id) AS unread_mention_count,MAX(mm.message_id) AS last_mention_message_id')
            ->group('mm.conversation_id')->select()->toArray();
        $result = [];
        foreach ($rows as $row) $result[(int) $row['conversation_id']] = ['unread_mention_count' => (int) $row['unread_mention_count'], 'last_mention_message_id' => (int) $row['last_mention_message_id']];
        return $result;
    }

    /** Edits may remove an existing reminder, but cannot create a fresh alert. */
    public function retainAfterEdit(int $message, array $body): array
    {
        $text = (string) ($body['text'] ?? '');
        if (!empty($body['mention_all']) && !self::contains($text, '所有人')) unset($body['mention_all']);
        $ids = $body['mention_user_ids'] ?? [];
        if ($ids !== []) {
            $members = Db::name('users')->whereIn('id', $ids)->field('id,nickname')->select()->toArray();
            $body['mention_user_ids'] = array_values(array_map(static fn (array $row): int => (int) $row['id'], array_filter($members, static fn (array $row): bool => self::contains($text, self::displayName((string) $row['nickname'])))));
            if ($body['mention_user_ids'] === []) unset($body['mention_user_ids']);
        }
        $keep = !empty($body['mention_all']) ? [0] : ($body['mention_user_ids'] ?? []);
        $query = Db::name('message_mentions')->where('message_id', $message);
        if ($keep !== []) $query->whereNotIn('user_id', $keep);
        $query->delete();
        return $body;
    }
}
