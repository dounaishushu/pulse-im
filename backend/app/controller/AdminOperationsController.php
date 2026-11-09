<?php

namespace app\controller;

require_once dirname(__DIR__) . '/Service/GroupMemberCount.php';

use app\Service\AuditService;
use app\Service\GroupMemberCount;
use app\Service\SensitiveWordService;
use RuntimeException;
use think\Request;
use think\facade\Db;

final class AdminOperationsController
{
    public function wallets(Request $request)
    {
        return (new RetiredFinanceController())->unavailable();
    }

    public function walletBalance(Request $request)
    {
        return (new RetiredFinanceController())->unavailable();
    }

    public function redPackets(Request $request)
    {
        return (new RetiredFinanceController())->unavailable();
    }

    public function messages(Request $request)
    {
        $this->admin($request);
        // Production Composer uses a frozen class map; load the new query class explicitly.
        require_once dirname(__DIR__) . '/Service/AdminMessageQueryService.php';
        $data = (new \app\Service\AdminMessageQueryService())->listing($request->get(), $this->page($request), $this->size($request));
        return json(['ok' => true, 'data' => $data])->header(['Cache-Control' => 'no-store']);
    }

    public function recallMessage(Request $request)
    {
        $this->admin($request);
        $payload = $this->payload($request);
        $messageId = (int) ($payload['message_id'] ?? 0);
        if ($messageId <= 0) throw new RuntimeException('Invalid message id.');
        $message = Db::name('messages')->where('id', $messageId)->find();
        if (!$message) throw new RuntimeException('Message not found.');
        if ($message['recalled_at'] === null) Db::name('messages')->where('id', $messageId)->update(['recalled_at' => date('Y-m-d H:i:s')]);
        (new AuditService())->log($this->adminId($request), 'message.moderate_recall', 'message', $messageId, (string) ($payload['request_id'] ?? ''), (string) $request->ip(), ['conversation_id' => (int) $message['conversation_id'], 'sender_id' => (int) $message['sender_id']]);
        return json(['ok' => true, 'data' => ['message_id' => $messageId, 'status' => 'recalled']]);
    }

    public function groups(Request $request)
    {
        $this->admin($request);
        $page = $this->page($request);
        $size = $this->size($request);
        $query = Db::name('conversations')->alias('c')
            ->leftJoin('users u', 'u.id = c.owner_id')
            ->whereIn('c.type', ['group', 'channel', 'customer_service'])->where('c.status', '<>', 'deleted')
            ->field('c.id,c.id AS group_id,c.type,c.name,c.owner_id,c.description,c.announcement,c.invite_code,c.allow_member_add_friend,c.max_members,c.member_count_offset,c.all_muted,c.join_method,c.status,c.created_at,c.updated_at,u.nickname AS owner_nickname,u.username AS owner_username,u.phone AS owner_phone')
            ->order('c.id', 'desc');
        $name = trim((string) $request->get('name', $request->get('q', '')));
        if ($name !== '') $query->whereLike('c.name', '%' . addcslashes($name, '%_') . '%');
        $groupId = (int) $request->get('group_id', 0);
        if ($groupId > 0) $query->where('c.id', $groupId);
        $owner = trim((string) $request->get('owner', ''));
        if ($owner !== '') {
            $escaped = '%' . addcslashes($owner, '%_') . '%';
            $query->where(function ($builder) use ($owner, $escaped): void {
                $builder->whereLike('u.nickname', $escaped)->whereOr('u.username', $owner)->whereOr('u.phone', $owner);
                if (ctype_digit($owner)) $builder->whereOr('c.owner_id', (int) $owner);
            });
        }
        $rows = $query->paginate(['list_rows' => $size, 'page' => $page]);
        $items = array_map(static function (array $row): array {
            $row = GroupMemberCount::admin($row, (int) Db::name('conversation_members')->where('conversation_id', (int) $row['id'])->count());
            $row['id'] = (int) $row['id'];
            $row['group_id'] = (int) $row['group_id'];
            $row['owner_id'] = $row['owner_id'] === null ? null : (int) $row['owner_id'];
            $row['max_members'] = (int) ($row['max_members'] ?? 500);
            $row['all_muted'] = (int) ($row['all_muted'] ?? 0);
            $row['allow_member_add_friend'] = (int) ($row['allow_member_add_friend'] ?? 1);
            $row['status'] = $row['status'] ?? 'active';
            $row['join_method'] = $row['join_method'] ?? 'free';
            return $row;
        }, $rows->items());
        return json(['ok' => true, 'data' => ['items' => $items, 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size]]);
    }

    public function groupDetail(Request $request)
    {
        $this->admin($request);
        return json(['ok' => true, 'data' => $this->adminGroup((int) $request->get('id', $request->get('group_id', 0)))]);
    }

    public function groupCreate(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $name = trim((string) ($data['name'] ?? ''));
        $ownerId = (int) ($data['owner_id'] ?? 0);
        $type = (string) ($data['type'] ?? 'group');
        if (!in_array($type, ['group', 'channel', 'customer_service'], true)) throw new RuntimeException('群组类型不正确。');
        if (mb_strlen($name) < 1 || mb_strlen($name) > 128) throw new RuntimeException('群组名称长度必须为 1 至 128 个字符。');
        $this->activeAdminUser($ownerId);
        $maxMembers = $this->maxMembers($data['max_members'] ?? 500);
        $displayCount = GroupMemberCount::configured($data['display_member_count'] ?? null);
        if ($type !== 'group' && $displayCount !== null) throw new RuntimeException('只有群组可以设置虚拟显示人数。');
        $now = date('Y-m-d H:i:s');
        $id = Db::transaction(function () use ($data, $name, $ownerId, $type, $maxMembers, $displayCount, $now): int {
            $inviteCode = $type === 'group' ? 'G' . strtoupper(bin2hex(random_bytes(6))) : null;
            $id = (int) Db::name('conversations')->insertGetId([
                'type' => $type,
                'name' => $name,
                'owner_id' => $ownerId,
                'description' => $this->optionalText($data['description'] ?? null, 500),
                'announcement' => $this->optionalText($data['announcement'] ?? null, 10000),
                'invite_code' => $inviteCode,
                'allow_member_add_friend' => $this->boolValue($data['allow_member_add_friend'] ?? true) ? 1 : 0,
                'max_members' => $maxMembers,
                'member_count_offset' => GroupMemberCount::offset($displayCount, 1),
                'all_muted' => $this->boolValue($data['all_muted'] ?? false) ? 1 : 0,
                'join_method' => $this->joinMethod($data['join_method'] ?? 'free'),
                'status' => $this->groupStatus($data['status'] ?? 'active'),
                'created_at' => $now,
                'updated_at' => $now,
            ]);
            Db::name('conversation_members')->insert(['conversation_id' => $id, 'user_id' => $ownerId, 'role' => 'owner', 'joined_at' => $now]);
            return $id;
        });
        (new AuditService())->log($this->adminId($request), 'group.create', 'group', $id, (string) ($data['request_id'] ?? ''), (string) $request->ip(), ['owner_id' => $ownerId, 'type' => $type]);
        return json(['ok' => true, 'data' => $this->adminGroup($id)], 201);
    }

    public function groupUpdate(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $groupId = (int) ($data['group_id'] ?? $data['id'] ?? 0);
        $current = $this->adminGroup($groupId);
        $updates = [];
        if (array_key_exists('name', $data)) {
            $name = trim((string) $data['name']);
            if (mb_strlen($name) < 1 || mb_strlen($name) > 128) throw new RuntimeException('群组名称长度必须为 1 至 128 个字符。');
            $updates['name'] = $name;
        }
        if (array_key_exists('description', $data)) $updates['description'] = $this->optionalText($data['description'], 500);
        if (array_key_exists('announcement', $data)) $updates['announcement'] = $this->optionalText($data['announcement'], 10000);
        if (array_key_exists('type', $data)) {
            if (!in_array($data['type'], ['group', 'channel', 'customer_service'], true)) throw new RuntimeException('群组类型不正确。');
            $updates['type'] = $data['type'];
        }
        $newType = (string) ($updates['type'] ?? $current['type']);
        if ($newType === 'group' && empty($current['invite_code'])) $updates['invite_code'] = 'G' . strtoupper(bin2hex(random_bytes(6)));
        if ($newType !== 'group' && $current['type'] === 'group') $updates['invite_code'] = null;
        if (array_key_exists('max_members', $data)) {
            $maxMembers = $this->maxMembers($data['max_members']);
            if ($maxMembers < (int) $current['member_count']) throw new RuntimeException('最大成员数不能小于当前成员数。');
            $updates['max_members'] = $maxMembers;
        }
        if (array_key_exists('all_muted', $data)) $updates['all_muted'] = $this->boolValue($data['all_muted']) ? 1 : 0;
        if (array_key_exists('allow_member_add_friend', $data)) $updates['allow_member_add_friend'] = $this->boolValue($data['allow_member_add_friend']) ? 1 : 0;
        if (array_key_exists('join_method', $data)) $updates['join_method'] = $this->joinMethod($data['join_method']);
        if (array_key_exists('status', $data)) $updates['status'] = $this->groupStatus($data['status']);
        $newOwnerId = array_key_exists('owner_id', $data) ? (int) $data['owner_id'] : (int) $current['owner_id'];
        if ($newOwnerId <= 0) throw new RuntimeException('群主不能为空。');
        $this->activeAdminUser($newOwnerId);
        if ($newOwnerId !== (int) $current['owner_id']) $updates['owner_id'] = $newOwnerId;
        $hasDisplayCount = array_key_exists('display_member_count', $data);
        $displayCount = $hasDisplayCount ? GroupMemberCount::configured($data['display_member_count']) : null;
        if ($newType !== 'group' && $displayCount !== null) throw new RuntimeException('只有群组可以设置虚拟显示人数。');
        if ($updates === [] && !$hasDisplayCount) throw new RuntimeException('没有需要保存的群组资料。');
        $updates['updated_at'] = date('Y-m-d H:i:s');
        Db::transaction(function () use ($groupId, $current, $newOwnerId, &$updates, $hasDisplayCount, $displayCount, $newType): void {
            $locked = Db::name('conversations')->where('id', $groupId)->where('status', '<>', 'deleted')->lock(true)->find();
            if (!$locked) throw new RuntimeException('群组不存在。');
            if ($newOwnerId !== (int) $current['owner_id']) {
                Db::name('conversation_members')->where('conversation_id', $groupId)->where('role', 'owner')->update(['role' => 'member']);
                $member = Db::name('conversation_members')->where('conversation_id', $groupId)->where('user_id', $newOwnerId)->find();
                if ($member) Db::name('conversation_members')->where('conversation_id', $groupId)->where('user_id', $newOwnerId)->update(['role' => 'owner']);
                else Db::name('conversation_members')->insert(['conversation_id' => $groupId, 'user_id' => $newOwnerId, 'role' => 'owner', 'joined_at' => date('Y-m-d H:i:s')]);
            }
            // Read actual membership after an owner change, so a newly added owner
            // is included in the configured baseline. Joins never edit this offset.
            if ($hasDisplayCount || $newType !== 'group') {
                $actual = (int) Db::name('conversation_members')->where('conversation_id', $groupId)->count();
                $updates['member_count_offset'] = GroupMemberCount::offset($newType === 'group' ? $displayCount : null, $actual);
            }
            if (isset($updates['max_members']) && $updates['max_members'] < (int) Db::name('conversation_members')->where('conversation_id', $groupId)->count()) throw new RuntimeException('最大成员数不能小于当前真实成员数。');
            Db::name('conversations')->where('id', $groupId)->update($updates);
        });
        (new AuditService())->log($this->adminId($request), 'group.update', 'group', $groupId, (string) ($data['request_id'] ?? ''), (string) $request->ip(), ['fields' => array_keys($updates)]);
        return json(['ok' => true, 'data' => $this->adminGroup($groupId)]);
    }

    public function groupDelete(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $ids = $data['ids'] ?? ($data['group_ids'] ?? []);
        if (!is_array($ids)) $ids = [$ids];
        if (array_key_exists('group_id', $data)) $ids[] = $data['group_id'];
        $ids = array_values(array_unique(array_filter(array_map('intval', $ids), static fn (int $id): bool => $id > 0)));
        if ($ids === []) throw new RuntimeException('请选择要删除的群组。');
        Db::transaction(function () use ($ids): void {
            foreach ($ids as $id) {
                $this->adminGroup($id);
                Db::name('conversations')->where('id', $id)->update(['status' => 'deleted', 'updated_at' => date('Y-m-d H:i:s')]);
            }
        });
        foreach ($ids as $id) (new AuditService())->log($this->adminId($request), 'group.delete', 'group', $id, (string) ($data['request_id'] ?? ''), (string) $request->ip(), ['deleted' => true]);
        return json(['ok' => true, 'data' => ['ids' => $ids, 'count' => count($ids)] ]);
    }

    private function adminGroup(int $groupId): array
    {
        if ($groupId <= 0) throw new RuntimeException('群组编号不正确。');
        $row = Db::name('conversations')->alias('c')->leftJoin('users u', 'u.id = c.owner_id')
            ->where('c.id', $groupId)->whereIn('c.type', ['group', 'channel', 'customer_service'])->where('c.status', '<>', 'deleted')
            ->field('c.id,c.id AS group_id,c.type,c.name,c.owner_id,c.avatar_url,c.description,c.announcement,c.invite_code,c.allow_member_add_friend,c.max_members,c.member_count_offset,c.all_muted,c.join_method,c.status,c.created_at,c.updated_at,u.nickname AS owner_nickname,u.username AS owner_username,u.phone AS owner_phone')->find();
        if (!$row) throw new RuntimeException('群组不存在。');
        $row['id'] = (int) $row['id'];
        $row['group_id'] = (int) $row['group_id'];
        $row['owner_id'] = $row['owner_id'] === null ? null : (int) $row['owner_id'];
        $row = GroupMemberCount::admin($row, (int) Db::name('conversation_members')->where('conversation_id', $groupId)->count());
        $row['max_members'] = (int) ($row['max_members'] ?? 500);
        $row['all_muted'] = (int) ($row['all_muted'] ?? 0);
        $row['allow_member_add_friend'] = (int) ($row['allow_member_add_friend'] ?? 1);
        $row['join_method'] = $row['join_method'] ?? 'free';
        $row['status'] = $row['status'] ?? 'active';
        return $row;
    }

    private function activeAdminUser(int $userId): void
    {
        if ($userId <= 0 || !Db::name('users')->where('id', $userId)->where('status', 'active')->find()) throw new RuntimeException('群主不存在或已被停用。');
    }

    private function optionalText($value, int $limit): ?string
    {
        $value = trim((string) ($value ?? ''));
        if (mb_strlen($value) > $limit) throw new RuntimeException('群组资料内容过长。');
        return $value === '' ? null : $value;
    }

    private function maxMembers($value): int
    {
        $value = (int) $value;
        if ($value < 1 || $value > 10000000) throw new RuntimeException('最大成员数必须在 1 至 10000000 之间。');
        return $value;
    }

    private function joinMethod($value): string
    {
        $value = (string) $value;
        if (!in_array($value, ['free', 'approval', 'invite'], true)) throw new RuntimeException('加群方式不正确。');
        return $value;
    }

    private function groupStatus($value): string
    {
        $value = (string) $value;
        if (!in_array($value, ['active', 'disabled'], true)) throw new RuntimeException('有效状态不正确。');
        return $value;
    }

    private function boolValue($value): bool
    {
        if (is_bool($value)) return $value;
        return in_array(strtolower((string) $value), ['1', 'true', 'yes', 'on', '是', '开启'], true);
    }

    private function page(Request $request): int { return max(1, (int) $request->get('page', 1)); }

    private function size(Request $request): int { return min(100, max(1, (int) $request->get('size', 30))); }

    private function adminId(Request $request): int { return (new \app\Service\AdminAuthService())->id($request); }

    private function payload(Request $request): array
    {
        $payload = $request->post();
        if ($payload !== []) return $payload;
        $decoded = json_decode(trim($request->getContent()), true);
        return is_array($decoded) ? $decoded : [];
    }

    private function pageResult(object $rows, int $size)
    {
        return json(['ok' => true, 'data' => ['items' => $rows->items(), 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size]]);
    }

    private function admin(Request $request): void
    {
        (new \app\Service\AdminAuthService())->authorize($request);
    }
}
