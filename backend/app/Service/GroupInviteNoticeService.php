<?php
namespace app\Service;

use think\facade\Db;

/** Server-created invitation notices are visible only to current group managers. */
final class GroupInviteNoticeService
{
    public const KIND = 'group_invite';

    /** Apply before pagination/counting, using the viewer's role in this exact group. */
    public static function visibleSql(int $viewerId, string $alias = 'messages'): string
    {
        if (!preg_match('/^[A-Za-z][A-Za-z0-9_]*$/D', $alias)) throw new \InvalidArgumentException('Invalid message table alias.');
        // The database maintains this generated flag from the same type/kind
        // predicate, so unread/history counts can use a covering index.
        return "($alias.is_group_invite = 0"
            . " OR EXISTS (SELECT 1 FROM conversation_members gin_viewer WHERE gin_viewer.conversation_id = $alias.conversation_id"
            . " AND gin_viewer.user_id = $viewerId AND gin_viewer.role IN ('owner', 'admin')))";
    }

    public static function isNotice(array $message): bool
    {
        if (($message['type'] ?? '') !== 'system') return false;
        $body = $message['body'] ?? json_decode((string) ($message['body_json'] ?? '{}'), true);
        return is_array($body) && ($body['kind'] ?? null) === self::KIND;
    }

    /** Workers pass the current membership role, never a role supplied by the client. */
    public static function allowsRole(array $message, ?string $role): bool
    {
        return !self::isNotice($message) || in_array($role, ['owner', 'admin'], true);
    }

    /** Called inside the successful membership insert transaction, with the group row locked. */
    public function record(int $conversationId, int $operatorId, int $memberId, string $now): int
    {
        $names = Db::name('users')->whereIn('id', [$operatorId, $memberId])->column('nickname', 'id');
        $operator = trim((string) ($names[$operatorId] ?? '')) ?: '用户';
        $member = trim((string) ($names[$memberId] ?? '')) ?: '用户';
        $requestId = 'group-invite:' . bin2hex(random_bytes(16));
        $body = ['kind' => self::KIND, 'text' => $operator . ' 邀请 ' . $member . ' 加入群聊',
            'operator_id' => $operatorId, 'member_id' => $memberId, 'request_id' => $requestId];
        // The existing message trigger creates the durable realtime event atomically.
        // System messages remain compatible with existing PC, Web, Android and iOS clients.
        return (int) Db::name('messages')->insertGetId(['conversation_id' => $conversationId, 'sender_id' => $operatorId,
            'type' => 'system', 'request_id' => $requestId, 'body_json' => json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), 'created_at' => $now]);
    }

    /** One insert statement, retaining the existing per-member management notice. */
    public function recordBatch(int $conversationId, int $operatorId, string $operator, array $members, string $now): void
    {
        $rows = [];
        foreach ($members as $id => $name) {
            $requestId = 'group-invite:' . bin2hex(random_bytes(16));
            $body = ['kind' => self::KIND, 'text' => ($operator ?: '用户') . ' 邀请 ' . ($name ?: '用户') . ' 加入群聊',
                'operator_id' => $operatorId, 'member_id' => (int) $id, 'request_id' => $requestId];
            $rows[] = ['conversation_id' => $conversationId, 'sender_id' => $operatorId, 'type' => 'system',
                'request_id' => $requestId, 'body_json' => json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), 'created_at' => $now];
        }
        if ($rows) Db::name('messages')->insertAll($rows);
    }
}
