<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

final class BlockService
{
    public function block(int $blockerId, int $blockedId, string $reason = ''): array
    {
        $this->active($blockerId);
        $this->active($blockedId);
        if ($blockerId === $blockedId) throw new RuntimeException('不能屏蔽自己。');
        $now = date('Y-m-d H:i:s');
        $exists = Db::name('user_blocks')->where('blocker_id', $blockerId)->where('blocked_id', $blockedId)->find();
        if ($exists) Db::name('user_blocks')->where('blocker_id', $blockerId)->where('blocked_id', $blockedId)->update(['reason' => mb_substr(trim($reason), 0, 255)]);
        else Db::name('user_blocks')->insert(['blocker_id' => $blockerId, 'blocked_id' => $blockedId, 'reason' => mb_substr(trim($reason), 0, 255), 'created_at' => $now]);
        Db::name('contact_requests')->where(function ($q) use ($blockerId, $blockedId): void { $q->where('from_user_id', $blockerId)->whereOr('to_user_id', $blockerId); })->where(function ($q) use ($blockerId, $blockedId): void { $q->where('from_user_id', $blockedId)->whereOr('to_user_id', $blockedId); })->where('status', 'pending')->update(['status' => 'blocked', 'updated_at' => $now]);
        return ['blocker_id' => $blockerId, 'blocked_id' => $blockedId, 'status' => 'blocked'];
    }

    public function unblock(int $blockerId, int $blockedId): array
    {
        $deleted = Db::name('user_blocks')->where('blocker_id', $blockerId)->where('blocked_id', $blockedId)->delete();
        if ($deleted === 0) throw new RuntimeException('未找到该黑名单用户。');
        return ['blocked_id' => $blockedId, 'status' => 'unblocked'];
    }

    public function list(int $blockerId, int $page = 1, int $size = 50): array
    {
        $size = min(100, max(1, $size));
        $rows = Db::name('user_blocks')->alias('b')->leftJoin('users u', 'u.id = b.blocked_id')->where('b.blocker_id', $blockerId)->field('b.*,u.nickname,u.username,u.avatar_url')->order('b.created_at', 'desc')->paginate(['list_rows' => $size, 'page' => max(1, $page)]);
        return ['items' => $rows->items(), 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    public function isBlocked(int $blockerId, int $blockedId): bool
    {
        return (bool) Db::name('user_blocks')->where('blocker_id', $blockerId)->where('blocked_id', $blockedId)->find();
    }

    public function candidates(int $userId, string $kind, string $keyword = '', int $page = 1, int $size = 50): array
    {
        if (!in_array($kind, ['contacts', 'dialogs'], true)) throw new RuntimeException('屏蔽列表类型无效。');
        $keyword = trim($keyword);
        if (mb_strlen($keyword) > 64) throw new RuntimeException('搜索内容不能超过64个字符。');
        $query = Db::name('users')->alias('u')->where('u.status', 'active')->where('u.id', '<>', $userId);
        if ($kind === 'contacts') $query->join('contacts c', 'c.contact_user_id = u.id')->where('c.user_id', $userId);
        else {
            $query->whereExists(function ($q) use ($userId): void {
                $q->table('conversation_members')->alias('peer')->join('conversation_members self', 'self.conversation_id = peer.conversation_id')->join('conversations d', 'd.id = peer.conversation_id')
                    ->whereRaw('peer.user_id = u.id')->where('self.user_id', $userId)->whereNull('self.hidden_at')->where('d.type', 'direct')->where('d.status', 'active')->field('peer.user_id');
            });
        }
        $query->whereNotExists(function ($q) use ($userId): void { $q->table('user_blocks')->alias('b')->where('b.blocker_id', $userId)->whereRaw('b.blocked_id = u.id')->field('b.blocker_id'); });
        if ($keyword !== '') {
            $pattern = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $keyword) . '%';
            $query->where(function ($q) use ($pattern): void { $q->whereLike('u.nickname', $pattern)->whereOr('u.username', 'like', $pattern); });
        }
        $size = min(100, max(1, $size));
        $rows = $query->field('u.id AS user_id,u.nickname,u.username,u.avatar_url')->order('u.nickname')->order('u.id')->paginate(['list_rows' => $size, 'page' => max(1, $page)]);
        return ['items' => $rows->items(), 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    private function active(int $id): void
    {
        if ($id <= 0 || !Db::name('users')->where('id', $id)->where('status', 'active')->find()) throw new RuntimeException('用户不存在。');
    }
}
