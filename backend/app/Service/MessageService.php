<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

// Release packages may retain Composer's authoritative class map. Keep the
// adjacent writer available without rebuilding unrelated vendor metadata.
require_once __DIR__ . '/GroupTextWriter.php';
require_once __DIR__ . '/DirectMessageWriter.php';
require_once __DIR__ . '/ConversationReadProgress.php';

final class MessageService
{
    private const TYPES = ['text', 'image', 'video', 'file', 'voice', 'contact_card', 'shake'];

    public function send(int $conversationId, int $senderId, string $type, array $body, string $requestId, bool $publish = true, bool $internalBroadcast = false): array
    {
        if ($conversationId <= 0 || $senderId <= 0 || !in_array($type, self::TYPES, true)) {
            throw new RuntimeException('Invalid message parameters.');
        }
        if (!preg_match('/^[A-Za-z0-9._:-]{8,80}$/', $requestId)) {
            throw new RuntimeException('Invalid idempotency request id.');
        }
        $this->validateBody($type, $body);
        $replyId = (new MessageReplyService())->inputId($body);
        $body = array_intersect_key($body, array_flip(match ($type) {
            'text' => ['text', 'mention_user_ids', 'mention_all'],
            'shake' => ['text'],
            'contact_card' => ['user_id'],
            default => ['url', 'thumbnail_url', 'text', 'mime', 'size', 'name', 'file_name', 'original_name', 'width', 'height', 'original', 'duration_ms', 'mention_user_ids', 'mention_all'],
        }));
        if ($type === 'contact_card') $body = $this->normalizeContactCard($body);
        if (in_array($type, ['image', 'video', 'file', 'voice'], true)) {
            $media = new MediaAccessService();
            foreach (['url', 'thumbnail_url'] as $key) {
                if (!isset($body[$key])) continue;
                if (!is_string($body[$key]) || !$media->isValidUrl($body[$key])) throw new RuntimeException('附件地址无效。');
                $media->assertCanAttach($body[$key], $senderId);
                $body[$key] = $media->canonicalUrl($body[$key]);
            }
        }
        $body = (new MessagePrivacyService())->sanitize($type, $body);
        $body = (new SensitiveWordService())->filterBody($body);
        if ($replyId !== null) $body['reply_to_id'] = $replyId;

        $direct = (new DirectMessageWriter())->send($conversationId, $senderId, $type, $body, $requestId, $internalBroadcast);
        if ($direct !== null) {
            $message = $this->formatForSender($direct['row'], $direct['sender']);
            if ($direct['created'] && $publish) (new RealtimePublisher())->publish($message);
            return $message;
        }

        $result = Db::transaction(function () use ($conversationId, $senderId, $type, $body, $requestId, $internalBroadcast): array {
            if ($type === 'text' && !isset($body['reply_to_id']) && !array_key_exists('mention_all', $body) && !array_key_exists('mention_user_ids', $body) && !str_contains((string) ($body['text'] ?? ''), '@')) {
                $batch = (new GroupTextWriter())->send($conversationId, $senderId, $body, $requestId, $internalBroadcast);
                if ($batch !== null) return ['message' => $this->formatForSender($batch['row'], $batch['sender']), 'created' => $batch['created']];
            }
            // Lock the conversation before inserting into the global event sequence,
            // matching the poll write order and avoiding a sequence/conversation deadlock.
            $conversation = Db::name('conversations')->where('id', $conversationId)->where('status', 'active')->lock(true)->find();
            if (!$conversation) throw new RuntimeException('该会话已停用。');
            $restoreMemberIds = null;
            // Serialize retries from the same sender and validate permissions inside
            // the transaction used by both HTTP and WebSocket writes.
            if (in_array($conversation['type'], ['group', 'channel'], true)) {
                // One current locking read replaces three database round trips
                // while every sender in the group waits for this conversation.
                $sender = Db::name('users')->alias('u')
                    ->leftJoin('conversation_members m', 'm.user_id=u.id AND m.conversation_id=' . $conversationId)
                    ->leftJoin('user_permissions p', 'p.user_id=u.id')
                    ->where('u.id', $senderId)->where('u.status', 'active')
                    ->field('u.*,m.user_id AS __member_id,m.role AS __member_role,m.muted_until AS __member_muted_until,p.muted AS __account_muted,p.internal_staff AS __internal_staff')
                    ->lock(true)->find();
                if (!$sender) throw new RuntimeException('用户账号不可用。');
                if ($sender['__member_id'] === null) throw new RuntimeException('You are not a member of this conversation.');
                $this->assertPermissionRows($conversation,
                    ['role' => $sender['__member_role'], 'muted_until' => $sender['__member_muted_until']],
                    ['muted' => $sender['__account_muted'], 'internal_staff' => $sender['__internal_staff']], $internalBroadcast);
            } else {
                $sender = Db::name('users')->where('id', $senderId)->where('status', 'active')->lock(true)->find();
                if (!$sender) throw new RuntimeException('用户账号不可用。');
                $restoreMemberIds = $this->assertSendPermissions($conversationId, $senderId, $conversation, true, $internalBroadcast);
            }
            if ($type === 'shake') {
                if ($conversation['type'] !== 'direct') throw new RuntimeException('窗口抖动仅支持私聊。');
                // Read the current permission inside the send transaction, including
                // retries from old clients whose login state still says staff.
                $staff = Db::name('user_permissions')->where('user_id', $senderId)->lock(true)->value('internal_staff');
                if ((int) $staff !== 1) throw new RuntimeException('窗口抖动仅限内部人员使用。');
            }
            $existing = Db::name('messages')->where('request_id', $requestId)->find();
            if ($existing) {
                if ((int) $existing['sender_id'] !== $senderId || (int) $existing['conversation_id'] !== $conversationId || $existing['type'] !== $type) throw new RuntimeException('消息请求编号已被其他操作使用。');
                if (MessageDeletionService::hidden($senderId, (int) $existing['id'])) throw new RuntimeException('该消息已从你的聊天记录删除。');
                return ['message' => $this->formatForSender($existing, $sender), 'created' => false];
            }
            $body = (new GroupMentionService())->normalize($body, $conversationId, $senderId, $conversation['type'], (string) ($sender['__member_role'] ?? ''));
            if (isset($body['reply_to_id'])) (new MessageReplyService())->assertVisible($conversationId, $senderId, $body['reply_to_id']);
            $body['request_id'] = $requestId;
            $now = date('Y-m-d H:i:s');
            // Direct-chat members were already locked by their complete primary
            // keys. A hidden_at range scan also locks the adjacent conversation,
            // in the opposite secondary/primary index order. Reuse exact keys
            // and acquire all membership locks before the event-sequence lock.
            if ($conversation['type'] === 'direct') {
                foreach ($restoreMemberIds as $memberId) {
                    Db::execute('UPDATE conversation_members FORCE INDEX (PRIMARY) SET hidden_at=NULL WHERE conversation_id=:conversation_id AND user_id=:user_id AND hidden_at IS NOT NULL',
                        ['conversation_id' => $conversationId, 'user_id' => $memberId]);
                }
            } else {
                Db::execute('UPDATE conversation_members FORCE INDEX (idx_member_hidden) SET hidden_at=NULL WHERE conversation_id=:conversation_id AND hidden_at IS NOT NULL',
                    ['conversation_id' => $conversationId]);
            }
            $id = (int) Db::name('messages')->insertGetId([
                'conversation_id' => $conversationId,
                'sender_id' => $senderId,
                'type' => $type,
                'request_id' => $requestId,
                'body_json' => json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
                'created_at' => $now,
            ]);
            (new MediaAccessService())->recordMessage($id, $body);
            (new GroupMentionService())->record($id, $conversationId, $body);
            Db::name('conversations')->where('id', $conversationId)->update(['updated_at' => $now]);
            return ['message' => $this->formatForSender(['id' => $id, 'conversation_id' => $conversationId, 'sender_id' => $senderId, 'type' => $type, 'body_json' => json_encode($body, JSON_UNESCAPED_UNICODE), 'created_at' => $now], $sender), 'created' => true];
        });
        if ($result['created'] && $publish) (new RealtimePublisher())->publish($result['message']);
        return $result['message'];
    }

    public function history(int $conversationId, int $viewerId, int $page, int $size, int $maxId = 0): array
    {
        if ($conversationId <= 0) {
            throw new RuntimeException('Invalid conversation id.');
        }
        $member = $this->assertMember($conversationId, $viewerId);
        if ($maxId < 0) throw new RuntimeException('历史消息范围无效。');
        $size = min(100, max(1, $size));
        $query = Db::name('messages')->force('idx_message_visibility_count')->where('conversation_id', $conversationId)->where('type', '<>', 'red_packet')->where('id', '>', (int) $member['cleared_before_message_id'])->whereNull('recalled_at')->whereNotIn('id', MessageDeletionService::hiddenQuery($viewerId))->whereRaw(GroupInviteNoticeService::visibleSql($viewerId));
        if ($maxId > 0) $query->where('id', '<=', $maxId);
        $rows = $query->order('id', 'desc')->paginate(['list_rows' => $size, 'page' => max(1, $page)]);
        $items = $this->formatRows($rows->items(), $viewerId);
        return ['items' => $items, 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    /** Reconcile an already displayed range after subscribing, using stable ID pages. */
    public function syncMessages(int $conversationId, int $viewerId, int $afterId = 0, int $floorId = 0, int $limit = 100, ?int $snapshotMaxId = null): array
    {
        if ($conversationId <= 0 || $afterId < 0 || $floorId < 0 || ($snapshotMaxId !== null && $snapshotMaxId < 0) || $limit < 1 || $limit > 100) {
            throw new RuntimeException('消息同步范围无效。');
        }
        $member = $this->assertMember($conversationId, $viewerId);
        $cleared = (int) $member['cleared_before_message_id'];
        $snapshotMaxId ??= (int) Db::name('messages')->where('conversation_id', $conversationId)->whereRaw(GroupInviteNoticeService::visibleSql($viewerId))->max('id');
        $floorId = max($floorId, $cleared + 1);
        $rows = Db::name('messages')->where('conversation_id', $conversationId)
            ->where('id', '>', max($afterId, $floorId - 1))->where('id', '<=', $snapshotMaxId)
            ->where('type', '<>', 'red_packet')->whereNull('recalled_at')->whereNotIn('id', MessageDeletionService::hiddenQuery($viewerId))
            ->whereRaw(GroupInviteNoticeService::visibleSql($viewerId))
            ->order('id')->limit($limit + 1)->select()->toArray();
        $more = count($rows) > $limit;
        if ($more) array_pop($rows);
        $items = $this->formatRows($rows, $viewerId);
        return ['conversation_id' => $conversationId, 'items' => $items, 'floor_id' => $floorId,
            'snapshot_max_id' => $snapshotMaxId, 'next_after_id' => $more ? (int) end($rows)['id'] : max($afterId, $snapshotMaxId),
            'has_more' => $more, 'cleared_before_message_id' => $cleared];
    }

    public function receipt(int $userId, int $messageId, string $status): array
    {
        if (!in_array($status, ['delivered', 'read'], true) || $messageId <= 0) throw new RuntimeException('Invalid receipt parameters.');
        $message = Db::name('messages')->where('id', $messageId)->find();
        if (!$message) throw new RuntimeException('Message not found.');
        $member = $this->assertMember((int) $message['conversation_id'], $userId);
        if (!GroupInviteNoticeService::allowsRole($message, $member['role'])) throw new RuntimeException('消息不存在或不可见。');
        if ((int) $message['sender_id'] === $userId) throw new RuntimeException('Sender does not need a receipt for own message.');
        $now = date('Y-m-d H:i:s');
        // A late delivered packet must never overwrite read, including concurrent devices.
        Db::name('message_receipts')->duplicate(['status' => Db::raw("IF(`status` = 'read', 'read', VALUES(`status`))"), 'updated_at' => $now])
            ->insert(['message_id' => $messageId, 'user_id' => $userId, 'status' => $status, 'updated_at' => $now]);
        $stored = Db::name('message_receipts')->where('message_id', $messageId)->where('user_id', $userId)->find();
        return ['message_id' => $messageId, 'user_id' => $userId, 'status' => $stored['status'], 'updated_at' => $stored['updated_at']];
    }

    /** Read a displayed conversation snapshot, including older pages, never newer arrivals. */
    public function readConversation(int $userId, int $conversationId, int $throughMessageId): array
    {
        if ($userId <= 0 || $conversationId <= 0 || $throughMessageId <= 0) throw new RuntimeException('已读参数无效。');
        // An outer REPEATABLE READ transaction may already have an old snapshot.
        // Only our own transaction can establish a new contiguous prefix safely.
        $pdo = Db::connect()->getPdo();
        $trackProgress = !($pdo instanceof \PDO) || !$pdo->inTransaction();
        return Db::transaction(function () use ($userId, $conversationId, $throughMessageId, $trackProgress): array {
            if (!Db::name('conversations')->where('id', $conversationId)->where('status', 'active')->lock(true)->find()) throw new RuntimeException('该会话已停用。');
            if (!Db::name('users')->where('id', $userId)->where('status', 'active')->lock(true)->find()) throw new RuntimeException('用户账号不可用。');
            $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->lock(true)->find();
            if (!$member) throw new RuntimeException('你不是该会话成员。');
            $boundary = Db::name('messages')->where('conversation_id', $conversationId)->where('id', $throughMessageId)->find();
            if (!$boundary || !GroupInviteNoticeService::allowsRole($boundary, $member['role']) || MessageDeletionService::hidden($userId, $throughMessageId)) throw new RuntimeException('已读消息不存在或不可见。');
            $previous = $trackProgress ? ConversationReadProgress::through($userId, $conversationId, $member) : 0;
            $visible = static function () use ($conversationId, $userId, $member) {
                $query = Db::name('messages')->where('conversation_id', $conversationId)
                    ->where('id', '>', (int) $member['cleared_before_message_id'])->where('sender_id', '<>', $userId)
                    ->where('type', '<>', 'red_packet')->whereNull('recalled_at')
                    ->whereNotIn('id', MessageDeletionService::hiddenQuery($userId))->whereRaw(GroupInviteNoticeService::visibleSql($userId));
                if (Db::connect()->getConfig('type') === 'mysql') $query->force('idx_message_visibility_count');
                return $query;
            };
            $now = date('Y-m-d H:i:s'); $cursor = max($previous, (int) $member['cleared_before_message_id']); $count = 0;
            while ($cursor < $throughMessageId) {
                // Bound memory without limiting how many historical unread messages can be cleared.
                $ids = $visible()->where('id', '>', $cursor)->where('id', '<=', $throughMessageId)
                    ->whereRaw("NOT EXISTS (SELECT 1 FROM message_receipts rr WHERE rr.message_id = messages.id AND rr.user_id = $userId AND rr.status = 'read')")
                    ->order('id')->limit(500)->column('id');
                if ($ids !== []) {
                    Db::name('message_receipts')->duplicate(['status' => 'read', 'updated_at' => $now])
                        ->insertAll(array_map(static fn ($id): array => ['message_id' => (int) $id, 'user_id' => $userId, 'status' => 'read', 'updated_at' => $now], $ids));
                    $cursor = (int) end($ids); $count += count($ids);
                }
                if (count($ids) < 500) break;
            }
            $completedThrough = max($previous, $throughMessageId);
            // Everything visible up to this boundary now has a read receipt.
            // Never recount the entire historical prefix while holding the group lock.
            $unread = $visible()->where('id', '>', $completedThrough)
                ->whereRaw("NOT EXISTS (SELECT 1 FROM message_receipts rr WHERE rr.message_id = messages.id AND rr.user_id = $userId)")->count();
            $mentions = (new GroupMentionService())->unread($userId, [$conversationId]);
            if ($trackProgress && $completedThrough > $previous) ConversationReadProgress::advance($userId, $conversationId, $member, $completedThrough);
            return ['conversation_id' => $conversationId, 'through_message_id' => $throughMessageId, 'status' => 'read', 'message_count' => $count, 'unread_count' => (int) $unread]
                + ($mentions[$conversationId] ?? ['unread_mention_count' => 0, 'last_mention_message_id' => 0]);
        });
    }

    public function recall(int $userId, int $messageId): array
    {
        $probe = Db::name('messages')->where('id', $messageId)->field('conversation_id')->find();
        if (!$probe) throw new RuntimeException('Message not found.');
        $event = $this->changeTransaction(function () use ($userId, $messageId, $probe): array {
            [$message, $internal] = $this->messageForChange($userId, $messageId, (int) $probe['conversation_id']);
            if (!$internal) throw new RuntimeException('只有内部员工可以撤回消息。');
            $recalledAt = $message['recalled_at'] ?: date('Y-m-d H:i:s');
            if ($message['recalled_at'] === null) Db::name('messages')->where('id', $messageId)->whereNull('recalled_at')->update(['recalled_at' => $recalledAt]);
            // The durable event contains the tombstone already. Do not extend
            // the write locks with author/profile lookups for a discarded body.
            $event = $this->formatBase(array_merge($message, ['recalled_at' => $recalledAt]), []);
            $event['status'] = 'recalled';
            return $event;
        });
        (new RealtimePublisher())->publish($event, 'message.recalled');
        return ['message_id' => $messageId, 'conversation_id' => (int) $event['conversation_id'],
            'status' => 'recalled', 'recalled_at' => $event['recalled_at']];
    }

    public function edit(int $userId, int $messageId, string $text): array
    {
        $text = trim($text);
        if ($text === '' || mb_strlen($text) > 5000) throw new RuntimeException('消息内容不能为空，且不能超过 5000 个字符。');
        $probe = Db::name('messages')->where('id', $messageId)->field('conversation_id')->find();
        if (!$probe) throw new RuntimeException('消息不存在。');
        $event = $this->changeTransaction(function () use ($userId, $messageId, $text, $probe): array {
            [$message, $internal] = $this->messageForChange($userId, $messageId, (int) $probe['conversation_id']);
            if ((int) $message['sender_id'] !== $userId && !$internal) throw new RuntimeException('只能编辑自己发送的消息。');
            if ($message['type'] !== 'text') throw new RuntimeException('只有文字消息可以编辑。');
            if ($message['recalled_at'] !== null) throw new RuntimeException('已撤回的消息不能编辑。');
            // Staff retain their existing moderation exception. Ordinary edits
            // require the same current permissions as sending a new message.
            if (!$internal) $this->assertCanSend((int) $message['conversation_id'], $userId, true);
            $body = json_decode((string) $message['body_json'], true) ?: [];
            $body['text'] = $text;
            $body = (new SensitiveWordService())->filterBody($body);
            $body = (new GroupMentionService())->retainAfterEdit($messageId, $body);
            $bodyJson = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
            $editedAt = date('Y-m-d H:i:s');
            Db::name('messages')->where('id', $messageId)->whereNull('recalled_at')->update(['body_json' => $bodyJson, 'edited_at' => $editedAt]);
            $event = $this->format(array_merge($message, ['body_json' => $bodyJson, 'edited_at' => $editedAt]), $userId);
            $event['status'] = 'edited';
            return $event;
        });
        (new RealtimePublisher())->publish($event, 'message.updated');
        return $event;
    }

    public function search(int $userId, string $keyword, int $conversationId = 0, string $type = '', int $page = 1, int $size = 20, int $senderId = 0, string $date = ''): array
    {
        $keyword = trim($keyword);
        if ($senderId < 0) throw new RuntimeException('发送者参数无效。');
        if (mb_strlen($keyword) > 200) throw new RuntimeException('搜索关键词不能超过200个字符。');
        if ($date !== '') {
            $parsedDate = \DateTimeImmutable::createFromFormat('!Y-m-d', $date);
            if (!$parsedDate || $parsedDate->format('Y-m-d') !== $date || $date < '1000-01-01') throw new RuntimeException('消息日期无效。');
        }
        if ($keyword === '' && $senderId === 0 && $date === '') throw new RuntimeException('请输入关键词或选择发送者、日期。');
        // 纯筛选必须限定具体会话，避免空关键词扫描所有历史记录。
        if ($keyword === '' && $conversationId <= 0) throw new RuntimeException('请选择要搜索的会话。');
        $size = min(50, max(1, $size));
        $query = Db::name('messages')->alias('m')->join('conversation_members cm', 'cm.conversation_id = m.conversation_id AND cm.user_id = ' . $userId)->join('conversations c', 'c.id = m.conversation_id')->leftJoin('users u', 'u.id = m.sender_id')->where('c.status', 'active')->where('m.type', '<>', 'red_packet')->whereRaw('m.id > cm.cleared_before_message_id')->whereNull('m.recalled_at')->whereNotIn('m.id', MessageDeletionService::hiddenQuery($userId))->whereRaw(GroupInviteNoticeService::visibleSql($userId, 'm'));
        if ($keyword !== '') {
            $pattern = '%' . addcslashes($keyword, '\\%_') . '%';
            $query->where(function ($search) use ($pattern): void {
                $search->where(function ($normal) use ($pattern): void { $normal->where('m.type', '<>', 'contact_card')->whereLike('m.body_json', $pattern); });
                // Sanitizing the response alone is insufficient: matching a hidden
                // historical phone would reveal it through search results/totals.
                $search->whereOr(function ($card) use ($pattern): void {
                    $card->where('m.type', 'contact_card')->whereRaw("CONCAT_WS(' ', JSON_UNQUOTE(JSON_EXTRACT(m.body_json, '$.nickname')), JSON_UNQUOTE(JSON_EXTRACT(m.body_json, '$.username'))) LIKE ?", [$pattern]);
                });
            });
        }
        if ($conversationId > 0) $query->where('m.conversation_id', $conversationId);
        if ($senderId > 0) $query->where('m.sender_id', $senderId);
        if ($date !== '') $query->where('m.created_at', '>=', $date . ' 00:00:00')->where('m.created_at', '<=', $date . ' 23:59:59');
        if ($type !== '' && !in_array($type, [...self::TYPES, 'system'], true)) throw new RuntimeException('消息类型无效。');
        if ($type !== '') $query->where('m.type', $type);
        $rows = $query->field('m.*,u.nickname AS sender_nickname')->order('m.id', 'desc')->paginate(['list_rows' => $size, 'page' => max(1, $page)]);
        $raw = $rows->items(); $items = $this->formatRows($raw, $userId);
        foreach ($items as $index => &$item) $item['sender_nickname'] = (string) ($raw[$index]['sender_nickname'] ?? '已注销用户');
        unset($item);
        return ['items' => $items, 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    public function calendar(int $userId, int $conversationId): array
    {
        $member = $this->assertMember($conversationId, $userId);
        $range = Db::name('messages')->where('conversation_id', $conversationId)
            ->whereNotIn('id', MessageDeletionService::hiddenQuery($userId))
            ->whereRaw(GroupInviteNoticeService::visibleSql($userId))
            ->where('type', '<>', 'red_packet')
            ->where('id', '>', (int) $member['cleared_before_message_id'])->whereNull('recalled_at')
            ->field('MIN(created_at) AS first_at, MAX(created_at) AS last_at')->find();
        return ['conversation_id' => $conversationId, 'today' => date('Y-m-d'),
            'first_date' => empty($range['first_at']) ? null : substr($range['first_at'], 0, 10),
            'last_date' => empty($range['last_at']) ? null : substr($range['last_at'], 0, 10)];
    }

    public function locate(int $userId, int $conversationId, int $messageId = 0, bool $first = false): array
    {
        if ($messageId < 0 || (!$first && $messageId === 0)) throw new RuntimeException('请选择要定位的消息。');
        $member = $this->assertMember($conversationId, $userId);
        $visible = fn () => Db::name('messages')->where('conversation_id', $conversationId)
            ->whereNotIn('id', MessageDeletionService::hiddenQuery($userId))
            ->whereRaw(GroupInviteNoticeService::visibleSql($userId))
            ->where('type', '<>', 'red_packet')
            ->where('id', '>', (int) $member['cleared_before_message_id'])->whereNull('recalled_at');
        $target = $first ? $visible()->order('id', 'asc')->find() : $visible()->where('id', $messageId)->find();
        if (!$target) throw new RuntimeException($first ? '当前没有可查看的聊天记录。' : '该消息已撤回、已清空或不属于当前会话。');
        $size = 50;
        $maxId = (int) $visible()->max('id');
        $page = intdiv((int) $visible()->where('id', '>', (int) $target['id'])->where('id', '<=', $maxId)->count(), $size) + 1;
        return $this->history($conversationId, $userId, $page, $size, $maxId) + ['target_id' => (int) $target['id'], 'max_id' => $maxId];
    }

    private function validateBody(string $type, array $body): void
    {
        if (strlen(json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)) > 32768) throw new RuntimeException('消息内容过大。');
        if (in_array($type, ['image', 'video', 'file'], true) && (isset($body['text']) && (!is_string($body['text']) || mb_strlen($body['text']) > 1000))) throw new RuntimeException('媒体说明不能超过1000个字符。');
        if ($type === 'image') {
            foreach (['width', 'height'] as $dimension) {
                if (isset($body[$dimension]) && (!is_int($body[$dimension]) || $body[$dimension] < 1 || $body[$dimension] > 10000)) throw new RuntimeException('图片尺寸参数无效。');
            }
            if (isset($body['original']) && !is_bool($body['original'])) throw new RuntimeException('原图发送参数无效。');
        }
        if ($type === 'text' && (!is_string($body['text'] ?? null) || trim($body['text']) === '' || mb_strlen($body['text']) > 5000)) {
            throw new RuntimeException('文字消息需填写 1 至 5000 个字符。');
        }
        if (in_array($type, ['image', 'video', 'file', 'voice'], true)) {
            if (!is_string($body['url'] ?? null) || !(new MediaAccessService())->isValidUrl($body['url'])) {
                throw new RuntimeException('Media message requires a valid URL.');
            }
        }
        if ($type === 'video' && (!empty($body['mime']) && !str_starts_with(strtolower((string) $body['mime']), 'video/'))) throw new RuntimeException('视频消息的媒体类型无效。');
        if ($type === 'voice' && ((int) ($body['duration_ms'] ?? 0) <= 0 || (int) ($body['duration_ms'] ?? 0) > 300000)) {
            throw new RuntimeException('Voice duration must be between 1ms and 5 minutes.');
        }
        if ($type === 'contact_card' && (int) ($body['user_id'] ?? 0) <= 0) throw new RuntimeException('名片联系人无效。');
        if ($type === 'shake') {
            if (isset($body['text']) && (!is_string($body['text']) || mb_strlen($body['text']) > 30)) throw new RuntimeException('窗口抖动消息无效。');
        }
    }

    private function normalizeContactCard(array $body): array
    {
        $userId = (int) ($body['user_id'] ?? 0);
        $user = Db::name('users')->where('id', $userId)->where('status', 'active')->field('id,public_id,nickname,username,avatar_url')->find();
        if (!$user) throw new RuntimeException('名片联系人不存在。');
        return [
            'user_id' => (int) $user['id'],
            'public_id' => $user['public_id'] ?? null,
            'nickname' => (string) ($user['nickname'] ?? ''),
            'username' => (string) ($user['username'] ?? ''),
            'avatar_url' => (string) ($user['avatar_url'] ?? ''),
        ];
    }

    public function clearHistory(int $userId, int $conversationId): array
    {
        return Db::transaction(function () use ($userId, $conversationId): array {
            if (!Db::name('conversations')->where('id', $conversationId)->where('status', 'active')->lock(true)->find()) throw new RuntimeException('该会话已停用。');
            $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->lock(true)->find();
            if (!$member) throw new RuntimeException('你不是该会话成员。');
            $lastId = (int) Db::name('messages')->where('conversation_id', $conversationId)->max('id');
            $watermark = max($lastId, (int) $member['cleared_before_message_id']);
            Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->update(['cleared_before_message_id' => $watermark]);
            return ['conversation_id' => $conversationId, 'cleared_before_message_id' => $watermark];
        });
    }

    public function markUnread(int $userId, int $conversationId): array
    {
        return Db::transaction(function () use ($userId, $conversationId): array {
            $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->lock(true)->find();
            if (!$member) throw new RuntimeException('你不是该会话成员。');

            ConversationReadProgress::forget($userId, $conversationId);

            $messageIds = Db::name('messages')->where('conversation_id', $conversationId)
                ->whereRaw(GroupInviteNoticeService::visibleSql($userId))
                ->where('id', '>', (int) ($member['cleared_before_message_id'] ?? 0))
                ->where('sender_id', '<>', $userId)->whereNull('recalled_at')->whereNotIn('id', MessageDeletionService::hiddenQuery($userId))->column('id');
            if ($messageIds !== []) {
                Db::name('message_receipts')->where('user_id', $userId)->whereIn('message_id', $messageIds)->delete();
            }
            return ['conversation_id' => $conversationId, 'status' => 'unread', 'message_count' => count($messageIds)];
        });
    }

    private function assertMember(int $conversationId, int $userId): array
    {
        $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->find();
        if (!$member) {
            throw new RuntimeException('You are not a member of this conversation.');
        }
        $conversation = Db::name('conversations')->where('id', $conversationId)->find();
        if (!$conversation || ($conversation['status'] ?? 'active') !== 'active') throw new RuntimeException('该会话已停用。');
        return $member;
    }

    /** Retry only an owned transaction: MySQL can abort it while createDirect holds users first. */
    private function changeTransaction(callable $callback): array
    {
        $connection = Db::connect();
        $pdo = $connection->getPdo();
        // A nested deadlock aborts the caller's whole transaction. Never restart it here.
        $canRetry = $connection->getConfig('type') === 'mysql' && $pdo instanceof \PDO && !$pdo->inTransaction();
        for ($attempt = 1; ; $attempt++) {
            $failure = null;
            try {
                return $connection->transaction(function () use ($callback, &$failure): array {
                    try {
                        return $callback();
                    } catch (\Throwable $error) {
                        $failure = $error;
                        throw $error;
                    }
                });
            } catch (\Throwable $error) {
                // A nested deadlock destroys its savepoint; ORM rollback may mask
                // the original 1213 with "savepoint does not exist" (1305).
                if ($failure !== null && $this->isMysqlDeadlock($failure)) $error = $failure;
                if (!$canRetry || $attempt >= 3 || !$this->isMysqlDeadlock($error) || $pdo->inTransaction()) throw $error;
                usleep($attempt * 10000);
            }
        }
    }

    private function isMysqlDeadlock(\Throwable $error): bool
    {
        do {
            if ($error instanceof \PDOException) {
                $state = $error->errorInfo[0] ?? null;
                $number = $error->errorInfo[1] ?? null;
            } elseif ($error instanceof \think\db\exception\PDOException) {
                // ThinkORM keeps structured PDO details, but drops the previous exception.
                $details = $error->getData()['PDO Error Info'] ?? [];
                $state = $details['SQLSTATE'] ?? null;
                $number = $details['Driver Error Code'] ?? null;
            } else {
                $state = $number = null;
            }
            if ($state === '40001' && (int) $number === 1213) return true;
        } while ($error = $error->getPrevious());
        return false;
    }

    /** Lock conversation first, matching send/leave/clear/pin order. */
    private function messageForChange(int $userId, int $messageId, int $conversationId): array
    {
        if (!Db::name('conversations')->where('id', $conversationId)->where('status', 'active')->lock(true)->find()) throw new RuntimeException('该会话已停用。');
        if (!Db::name('users')->where('id', $userId)->where('status', 'active')->lock(true)->find()) throw new RuntimeException('用户账号不可用。');
        $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->lock(true)->find();
        if (!$member) throw new RuntimeException('You are not a member of this conversation.');
        $message = Db::name('messages')->where('id', $messageId)->where('conversation_id', $conversationId)->lock(true)->find();
        if (!$message) throw new RuntimeException('消息不存在。');
        if (!GroupInviteNoticeService::allowsRole($message, $member['role'])) throw new RuntimeException('消息不存在或不可见。');
        if ($messageId <= (int) $member['cleared_before_message_id']) throw new RuntimeException('消息已清空，无法操作。');
        if (MessageDeletionService::hidden($userId, $messageId)) throw new RuntimeException('该消息已从你的聊天记录删除。');
        $permission = Db::name('user_permissions')->where('user_id', $userId)->lock(true)->find();
        return [$message, (bool) ($permission['internal_staff'] ?? false)];
    }

    public function assertCanSend(int $conversationId, int $userId, bool $lock = false): void
    {
        if (!Db::name('users')->where('id', $userId)->where('status', 'active')->lock($lock)->find()) throw new RuntimeException('用户账号不可用。');
        $conversation = Db::name('conversations')->where('id', $conversationId)->lock($lock)->find();
        if (!$conversation || ($conversation['status'] ?? 'active') !== 'active') throw new RuntimeException('该会话已停用。');
        $this->assertSendPermissions($conversationId, $userId, $conversation, $lock);
    }

    /** The send path already holds the conversation and active account locks. */
    private function assertSendPermissions(int $conversationId, int $userId, array $conversation, bool $lock, bool $internalBroadcast = false): array
    {
        $member = Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->lock($lock)->find();
        if (!$member) throw new RuntimeException('You are not a member of this conversation.');
        if ($conversation['type'] === 'direct') {
            $other = (int) Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', '<>', $userId)->lock($lock)->value('user_id');
            $blocked = $other && ($lock
                ? Db::name('user_blocks')->where(function ($q) use ($userId, $other): void { $q->where('blocker_id', $userId)->where('blocked_id', $other)->whereOr(function ($nested) use ($userId, $other): void { $nested->where('blocker_id', $other)->where('blocked_id', $userId); }); })->lock(true)->find()
                : ((new BlockService())->isBlocked($userId, $other) || (new BlockService())->isBlocked($other, $userId)));
            if ($blocked) throw new RuntimeException('已屏蔽的用户无法通过私聊联系。');
        }
        $permission = Db::name('user_permissions')->where('user_id', $userId)->lock($lock)->find();
        $this->assertPermissionRows($conversation, $member, $permission ?? [], $internalBroadcast);
        return isset($other) && $other > 0 ? [$userId, $other] : [$userId];
    }

    private function assertPermissionRows(array $conversation, array $member, array $permission, bool $internalBroadcast): void
    {
        if ($conversation['type'] === 'channel' && !in_array($member['role'], ['owner', 'admin'], true)) throw new RuntimeException('只有频道所有者或管理员可以发布内容。');
        if (($conversation['type'] ?? '') === 'group' && (int) ($conversation['all_muted'] ?? 0) === 1 && !in_array($member['role'], ['owner', 'admin'], true)) throw new RuntimeException('该群组已开启全员禁言。');
        // This flag is supplied only by BroadcastService. Keep the current locking
        // read so a staff revocation applies before a subsequent broadcast write.
        if ($internalBroadcast && empty($permission['internal_staff'])) throw new RuntimeException('无权使用内部人员功能。');
        if ($permission && (int) $permission['muted']) throw new RuntimeException('Your account is muted.');
        if (!empty($member['muted_until']) && strtotime($member['muted_until']) > time()) throw new RuntimeException('You are muted in this conversation.');
    }

    public function format(array $row, int $viewerId = 0): array
    {
        return $this->formatRows([$row], $viewerId)[0];
    }

    public function formatRows(array $rows, int $viewerId = 0): array
    {
        $rows = array_values($rows);
        $privacy = new MessagePrivacyService();
        $bodies = array_map(static fn (array $row): array => empty($row['recalled_at'])
            ? $privacy->sanitize((string) $row['type'], json_decode((string) $row['body_json'], true) ?: []) : [], $rows);
        $bodies = (new SensitiveWordService())->filterBody($bodies);
        $messages = [];
        foreach ($rows as $index => $row) $messages[] = $this->formatBase($row, $bodies[$index]);
        $messages = (new MessageSenderService())->enrich($messages);
        return (new MessageReplyService())->enrich($messages, $viewerId);
    }

    /** Same DTO as format(), using the verified author row held by this send. */
    private function formatForSender(array $row, array $sender): array
    {
        $message = $this->formatBase($row);
        $message['sender_name'] = MessageSenderService::name($sender['nickname'] ?? null);
        $message['sender_avatar_url'] = MessageSenderService::avatar($sender['avatar_url'] ?? null);
        return (new MessageReplyService())->enrich([$message], (int) $sender['id'])[0];
    }

    private function formatBase(array $row, ?array $filteredBody = null): array
    {
        $body = $filteredBody;
        if ($body === null) {
            $body = empty($row['recalled_at']) ? (json_decode((string) $row['body_json'], true) ?: []) : [];
            $body = (new MessagePrivacyService())->sanitize((string) $row['type'], $body);
            $body = (new SensitiveWordService())->filterBody($body);
        }
        return ['id' => (int) $row['id'], 'conversation_id' => (int) $row['conversation_id'], 'sender_id' => (int) $row['sender_id'], 'type' => $row['type'], 'body' => $body, 'created_at' => $row['created_at'], 'edited_at' => $row['edited_at'] ?? null, 'recalled_at' => $row['recalled_at'] ?? null, 'status' => !empty($row['recalled_at']) ? 'recalled' : (!empty($row['edited_at']) ? 'edited' : 'sent')];
    }
}
