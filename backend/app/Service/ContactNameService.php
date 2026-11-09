<?php
declare(strict_types=1);
namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** A viewer's remarks are private account data, never group/message content. */
final class ContactNameService
{
    public function page(int $viewerId, int $page = 1, int $size = 100): array
    {
        if ($viewerId <= 0) throw new RuntimeException('无效联系人账号。');
        $size = max(1, min(100, $size)); $page = max(1, $page);
        $rows = Db::name('contacts')->alias('c')->join('users u', 'u.id=c.contact_user_id')
            ->where('c.user_id', $viewerId)->where('u.status', 'active')
            ->field('c.contact_user_id AS user_id,c.remark,u.nickname')->order('c.contact_user_id', 'asc')
            ->paginate(['list_rows' => $size, 'page' => $page]);
        $items = array_map(static fn(array $row): array => ['user_id'=>(int)$row['user_id'],
            'remark'=>trim((string)($row['remark'] ?? '')), 'nickname'=>(string)$row['nickname']], $rows->items());
        return ['items'=>$items,'total'=>$rows->total(),'page'=>$rows->currentPage(),'size'=>$size];
    }

    /** Call in the same transaction as the contact write; the event contains no remark. */
    public static function changed(int $viewerId): void
    {
        if ($viewerId <= 0) throw new RuntimeException('无效联系人账号。');
        $sequence = Db::name('realtime_sequence')->where('id', 1)->lock(true)->find();
        if (!$sequence) throw new RuntimeException('联系人同步队列未初始化。');
        $id = (int)$sequence['last_id'] + 1;
        Db::name('realtime_sequence')->where('id', 1)->update(['last_id'=>$id]);
        Db::name('realtime_events')->insert(['id'=>$id,'message_id'=>0,'conversation_id'=>0,'event_type'=>'notification.updated',
            'payload_json'=>json_encode(['user_id'=>$viewerId], JSON_THROW_ON_ERROR),
            'created_at'=>(new \DateTimeImmutable())->format('Y-m-d H:i:s.u')]);
    }
}
