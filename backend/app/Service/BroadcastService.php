<?php

namespace app\Service;

use RuntimeException;
use think\exception\HttpResponseException;
use think\facade\Db;

/** Internal staff use ordinary conversations and the ordinary message delivery path. */
final class BroadcastService
{
    public function targets(int $userId, string $type, int $afterId = 0, int $limit = 100, ?int $snapshotMaxId = null): array
    {
        $this->assertStaff($userId);
        if (!in_array($type, ['friend', 'group'], true) || $afterId < 0 || $limit < 1 || $limit > 100 || ($snapshotMaxId !== null && $snapshotMaxId < 0)) {
            throw new RuntimeException('群发目标参数无效。');
        }
        if ($type === 'friend') {
            $query = $this->friendTargetsQuery($userId);
            $key = 'u.id';
            $fields = 'u.id,u.nickname,u.username,u.avatar_url,r.remark';
        } else {
            $query = Db::name('conversations')->alias('c')->join('conversation_members r', 'r.conversation_id=c.id')
                ->where('r.user_id', $userId)->where('c.type', 'group')->where('c.status', 'active');
            $key = 'c.id';
            $fields = 'c.id,c.name,c.avatar_url';
        }
        // Stable cursors include every page without chasing newly created targets forever.
        $snapshotMaxId ??= (int) (clone $query)->max($key);
        $query->where($key, '<=', $snapshotMaxId);
        $total = (int) (clone $query)->count();
        $rows = $query->where($key, '>', $afterId)->field($fields)->order($key)->limit($limit + 1)->select()->toArray();
        $more = count($rows) > $limit;
        if ($more) array_pop($rows);
        $items = array_map(static function (array $row) use ($type): array {
            return [
                'id' => (int) $row['id'], 'type' => $type,
                'name' => $type === 'friend' ? (string) ($row['remark'] ?: $row['nickname'] ?: $row['username'] ?: '好友') : (string) ($row['name'] ?: '群聊'),
                'username' => $type === 'friend' ? (string) ($row['username'] ?? '') : '',
                'avatar_url' => (string) ($row['avatar_url'] ?? ''),
            ];
        }, $rows);
        return ['items' => $items, 'total' => $total, 'has_more' => $more,
            'snapshot_max_id' => $snapshotMaxId, 'next_after_id' => $rows === [] ? $afterId : (int) end($rows)['id']];
    }

    /** One recipient per request keeps large broadcasts resumable and bounded. */
    public function send(int $userId, array $target, array $messages, string $requestId): array
    {
        $this->assertStaff($userId);
        $type = $target['type'] ?? null;
        $id = $target['id'] ?? null;
        if (!in_array($type, ['friend', 'group'], true) || !is_int($id) || $id <= 0 || !preg_match('/^[A-Za-z0-9_-]{8,64}$/D', $requestId)) {
            throw new RuntimeException('群发请求参数无效。');
        }
        // Validate all attachments before the first message or conversation is written.
        $messages = $this->messages($userId, $messages);
        $this->assertTarget($userId, $type, $id);
        $conversationId = $type === 'friend' ? (int) (new ConversationService())->createDirect($userId, $id)['id'] : $id;
        $fingerprint = hash('sha256', json_encode($messages, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
        $ids = [];
        foreach ($messages as $index => $message) {
            $this->assertStaff($userId);
            try {
                $this->assertTarget($userId, $type, $id);
                // The same immutable draft can safely retry after a lost response or partial delivery.
                $messageRequestId = 'broadcast:' . hash('sha256', "$userId|$requestId|$type|$id|$fingerprint|$index");
                $sent = (new MessageService())->send($conversationId, $userId, $message['type'], $message['body'], $messageRequestId, true, true);
                $ids[] = (int) $sent['id'];
            } catch (RuntimeException $error) {
                if ($error instanceof \PDOException || $error instanceof \think\db\exception\PDOException) throw $error;
                $this->assertStaff($userId);
                return ['target' => ['type' => $type, 'id' => $id], 'conversation_id' => $conversationId,
                    'complete' => false, 'message_ids' => $ids, 'total_messages' => count($messages),
                    'error' => ['code' => 'TARGET_SEND_FAILED', 'message' => $error->getMessage()]];
            }
        }
        return ['target' => ['type' => $type, 'id' => $id], 'conversation_id' => $conversationId,
            'complete' => true, 'message_ids' => $ids, 'total_messages' => count($messages)];
    }

    private function assertStaff(int $userId): void
    {
        if (!(new AuthService())->isInternalStaff($userId)) {
            throw new HttpResponseException(json(['ok' => false, 'error' => [
                'code' => 'INTERNAL_STAFF_REQUIRED', 'message' => '群发助手仅对后台已开启内部人员权限的账号开放。',
            ]], 403)->header(['Cache-Control' => 'no-store']));
        }
    }

    private function assertTarget(int $userId, string $type, int $id): void
    {
        if ($type === 'friend') {
            $allowed = $this->friendTargetsQuery($userId)->where('u.id', $id)->find();
            if (!$allowed) throw new RuntimeException('对方已不在你的好友列表中或账号不可用。');
        } else {
            $allowed = Db::name('conversations')->alias('c')->join('conversation_members r', 'r.conversation_id=c.id')
                ->where('r.user_id', $userId)->where('c.id', $id)->where('c.type', 'group')->where('c.status', 'active')->find();
            if (!$allowed) throw new RuntimeException('你已不在该群聊中或群聊不可用。');
        }
    }

    private function friendTargetsQuery(int $userId): \think\db\Query
    {
        // The PC friends sidebar also contains existing private conversations.
        // EXISTS includes those peers once, even with legacy duplicate directs,
        // without creating contact relations or exposing unrelated group members.
        $direct = Db::name('conversations')->alias('dc')
            ->join('conversation_members viewer', 'viewer.conversation_id=dc.id')
            ->join('conversation_members peer', 'peer.conversation_id=dc.id')
            ->where('viewer.user_id', $userId)->whereNull('viewer.hidden_at')
            ->where('dc.type', 'direct')->where('dc.status', 'active')
            ->whereColumn('peer.user_id', 'u.id')->fieldRaw('1')->buildSql();
        return Db::name('users')->alias('u')
            ->leftJoin('contacts r', 'r.contact_user_id=u.id AND r.user_id=' . $userId)
            ->where('u.status', 'active')->where('u.id', '<>', $userId)
            ->where(function ($query) use ($direct): void {
                $query->whereNotNull('r.contact_user_id')->whereExists($direct, 'OR');
            });
    }

    private function messages(int $userId, array $messages): array
    {
        if (!array_is_list($messages) || count($messages) < 1 || count($messages) > 11) throw new RuntimeException('请填写文字或添加图片、视频，每次最多 10 个附件。');
        $normalized = [];
        $texts = 0;
        $attachments = 0;
        $media = new MediaAccessService();
        foreach ($messages as $message) {
            if (!is_array($message) || !in_array($message['type'] ?? null, ['text', 'image', 'video'], true) || !is_array($message['body'] ?? null)) throw new RuntimeException('群发仅支持文字、图片和视频。');
            $type = $message['type'];
            $body = $message['body'];
            if ($type === 'text') {
                if (++$texts > 1 || !is_string($body['text'] ?? null) || trim($body['text']) === '' || mb_strlen($body['text']) > 5000) throw new RuntimeException('文字消息需填写 1 至 5000 个字符。');
                $body = ['text' => trim($body['text'])];
            } else {
                if (++$attachments > 10) throw new RuntimeException('每次最多添加 10 个图片或视频附件。');
                $body = array_intersect_key($body, array_flip(['url', 'thumbnail_url', 'mime', 'size', 'name']));
                if (!isset($body['url'])) throw new RuntimeException('请先上传附件。');
                foreach (['url', 'thumbnail_url'] as $key) {
                    if (!array_key_exists($key, $body)) continue;
                    $url = $body[$key];
                    if (!is_string($url) || !filter_var($url, FILTER_VALIDATE_URL) || !in_array(strtolower((string) parse_url($url, PHP_URL_SCHEME)), ['http', 'https'], true)) throw new RuntimeException('附件地址无效。');
                    $media->assertCanAttach($url, $userId);
                    $body[$key] = $media->canonicalUrl($url);
                }
                if (isset($body['mime']) && (!is_string($body['mime']) || strlen($body['mime']) > 120 || ($type === 'video' && !str_starts_with(strtolower($body['mime']), 'video/')))) throw new RuntimeException('附件媒体类型无效。');
                if (isset($body['name']) && (!is_string($body['name']) || mb_strlen($body['name']) > 255)) throw new RuntimeException('附件名称过长。');
                if (isset($body['size']) && (!is_int($body['size']) || $body['size'] < 0 || $body['size'] > ($type === 'image' ? 10 : 100) * 1024 * 1024)) throw new RuntimeException('附件大小超出限制。');
                ksort($body, SORT_STRING);
            }
            if (strlen(json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)) > 32768) throw new RuntimeException('消息内容过大。');
            $normalized[] = ['type' => $type, 'body' => $body];
        }
        return $normalized;
    }
}
