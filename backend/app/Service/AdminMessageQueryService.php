<?php
namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** Administrative history is independent of each client's hidden/deleted history. */
final class AdminMessageQueryService
{
    public function listing(array $filters, int $page = 1, int $size = 30): array
    {
        $sender = $this->resolve($this->text($filters, 'sender', 128), '发送者');
        $receiver = $this->resolve($this->text($filters, 'receiver', 128), '接收者');
        $type = $this->text($filters, 'type', 32);
        $conversationType = $this->text($filters, 'conversation_type', 32);
        if ($type !== '' && !in_array($type, ['text','image','video','file','voice','contact_card','shake','system'], true)) throw new RuntimeException('消息类型不正确。');
        if ($conversationType !== '' && !in_array($conversationType, ['direct','group','channel','customer_service'], true)) throw new RuntimeException('会话类型不正确。');
        if ($receiver && $conversationType !== '' && $conversationType !== 'direct') throw new RuntimeException('接收者筛选仅适用于个人会话，请选择个人会话或全部会话。');
        $query = Db::name('messages')->alias('m')->where('m.type', '<>', 'red_packet')
            ->leftJoin('users u', 'u.id = m.sender_id')
            ->leftJoin('conversations c', 'c.id = m.conversation_id')
            ->field('m.id,m.conversation_id,m.sender_id,m.type,m.request_id,m.body_json,m.created_at,m.recalled_at,u.nickname AS sender_nickname,u.username AS sender_username,u.phone AS sender_phone,u.public_id AS sender_public_id,c.name AS conversation_name,c.type AS conversation_type')
            ->order('m.id', 'desc');
        if ($sender) $query->where('m.sender_id', $sender['id']);
        if ($receiver) {
            // A direct conversation has two members. Excluding the recipient as
            // sender makes this directional, without admitting shared-group posts.
            $query->where('c.type', 'direct')->where('m.sender_id', '<>', $receiver['id'])
                ->whereIn('m.conversation_id', static function ($members) use ($receiver): void {
                    $members->name('conversation_members')->field('conversation_id')->where('user_id', $receiver['id']);
                });
        }
        $conversationId = $this->text($filters, 'conversation_id', 20);
        if ($conversationId !== '') {
            $id = $this->positiveId($conversationId);
            if ($id === null) throw new RuntimeException('会话编号不正确。');
            $query->where('m.conversation_id', $id);
        }
        if ($type !== '') $query->where('m.type', $type);
        if ($conversationType !== '') $query->where('c.type', $conversationType);
        $keyword = $this->text($filters, 'q', 500);
        if ($keyword !== '') $query->whereRaw("m.body_json LIKE :message_keyword ESCAPE '!'", ['message_keyword' => '%' . strtr($keyword, ['!'=>'!!','%'=>'!%','_'=>'!_']) . '%']);
        $size = max(1, min(100, $size));
        $rows = $query->paginate(['list_rows'=>$size, 'page'=>max(1, $page)]);
        $items = $rows->items();
        $directIds = array_values(array_unique(array_map(static fn (array $row): int => (int) $row['conversation_id'], array_filter($items, static fn (array $row): bool => $row['conversation_type'] === 'direct'))));
        $members = [];
        if ($directIds !== []) {
            $people = Db::name('conversation_members')->alias('cm')->leftJoin('users u', 'u.id = cm.user_id')
                ->whereIn('cm.conversation_id', $directIds)->field('cm.conversation_id,cm.user_id AS id,u.username,u.phone,u.nickname,u.public_id')->order('cm.user_id')->select()->toArray();
            foreach ($people as $person) $members[(int) $person['conversation_id']][] = $this->identity($person);
        }
        $sensitive = new SensitiveWordService();
        $privacy = new MessagePrivacyService();
        foreach ($items as &$row) {
            $row['id'] = (int) $row['id']; $row['conversation_id'] = (int) $row['conversation_id']; $row['sender_id'] = (int) $row['sender_id'];
            $row['sender_account'] = $row['sender_username'] ?: ($row['sender_phone'] ?: '');
            $row['recipients'] = array_values(array_filter($members[$row['conversation_id']] ?? [], static fn (array $person): bool => $person['id'] !== $row['sender_id']));
            $body = json_decode((string) $row['body_json'], true);
            $row['body'] = $privacy->sanitize((string) $row['type'], $sensitive->filterBody(is_array($body) ? $body : []));
            unset($row['body_json'], $row['sender_phone']);
        }
        unset($row);
        return ['items'=>$items, 'total'=>$rows->total(), 'page'=>$rows->currentPage(), 'size'=>$size, 'filters'=>['sender'=>$sender, 'receiver'=>$receiver]];
    }

    private function resolve(string $value, string $label): ?array
    {
        if ($value === '') return null;
        if ($value[0] === '#') {
            $id = $this->positiveId(substr($value, 1));
            if ($id === null) throw new RuntimeException($label . '用户 ID 不正确。');
            $query = Db::name('users')->where('id', $id);
        } else {
            $id = $this->positiveId($value);
            $query = Db::name('users')->where(static function ($users) use ($value, $id): void {
                $users->where('username', $value)->whereOr('public_id', $value)->whereOr('phone', $value);
                if ($id !== null) $users->whereOr('id', $id);
            });
        }
        $users = $query->field('id,username,phone,nickname,public_id')->limit(2)->select()->toArray();
        if ($users === []) throw new RuntimeException('未找到' . $label . '，请输入完整账号或用户 ID。');
        if (count($users) > 1) throw new RuntimeException($label . '匹配到多个用户，请输入公开用户 ID 或 #数字用户ID。');
        return $this->identity($users[0]);
    }

    private function identity(array $row): array
    {
        return ['id'=>(int) $row['id'], 'account'=>$row['username'] ?: ($row['phone'] ?: ''), 'nickname'=>$row['nickname'] ?? '', 'public_id'=>$row['public_id'] ?? ''];
    }

    private function text(array $filters, string $key, int $max): string
    {
        $value = $filters[$key] ?? '';
        if (!is_string($value) && !is_int($value)) throw new RuntimeException('筛选参数格式不正确。');
        $value = trim((string) $value);
        if (mb_strlen($value) > $max) throw new RuntimeException('筛选内容过长。');
        return $value;
    }

    private function positiveId(string $value): ?int
    {
        if (!preg_match('/^[0-9]+$/D', $value)) return null;
        $value = ltrim($value, '0'); $max = (string) PHP_INT_MAX;
        if ($value === '' || strlen($value) > strlen($max) || (strlen($value) === strlen($max) && strcmp($value, $max) > 0)) return null;
        return (int) $value;
    }
}
