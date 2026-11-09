<?php
declare(strict_types=1);

namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** Search only the current group; contact remarks always belong to the viewer. */
final class GroupMemberSearchService
{
    public function search(int $viewer, int $conversation, string $query, int $page = 1): array
    {
        $query = trim(ltrim(trim($query), '@'));
        if ($viewer <= 0 || $conversation <= 0 || mb_strlen($query) > 80 || $page < 1 || $page > 10000) {
            throw new RuntimeException('群成员搜索参数无效。');
        }
        $member = Db::name('conversation_members')->alias('v')
            ->join('conversations g', 'g.id=v.conversation_id')->join('users a', 'a.id=v.user_id')
            ->where('v.conversation_id', $conversation)->where('v.user_id', $viewer)
            ->where('g.type', 'group')->where('g.status', 'active')->where('a.status', 'active')
            ->field('v.role')->find();
        if (!$member) throw new RuntimeException('你不是该群组成员，或群组已停用。');
        $scope = in_array($member['role'], ['owner', 'admin'], true) ? 'group' : 'friends';
        $result = ['conversation_id'=>$conversation, 'query'=>$query, 'search_scope'=>$scope, 'page'=>$page, 'has_more'=>false, 'items'=>[]];
        if ($query === '') return $result;

        // All row access, role checks and contact checks share the same SELECT.
        // The reverse contact join is used only for the target's presence privacy.
        $rows = Db::name('conversation_members')->alias('m')
            ->join('conversation_members v', 'v.conversation_id=m.conversation_id AND v.user_id=' . $viewer)
            ->join('conversations g', 'g.id=m.conversation_id')->join('users a', 'a.id=v.user_id')
            ->join('users u', 'u.id=m.user_id')
            ->leftJoin('contacts own', 'own.user_id=v.user_id AND own.contact_user_id=m.user_id')
            ->leftJoin('contacts reverse_contact', 'reverse_contact.user_id=m.user_id AND reverse_contact.contact_user_id=v.user_id')
            ->leftJoin('user_presence p', 'p.user_id=m.user_id')->leftJoin('user_settings s', 's.user_id=m.user_id')
            ->leftJoin('user_permissions up', 'up.user_id=m.user_id')
            ->leftJoin('user_blocks b', 'b.blocker_id=m.user_id AND b.blocked_id=v.user_id')
            ->where('m.conversation_id', $conversation)->where('g.type', 'group')->where('g.status', 'active')
            ->where('a.status', 'active')->where('u.status', 'active')
            ->whereRaw("(v.role IN ('owner','admin') OR own.contact_user_id IS NOT NULL)");
        $pattern = '%' . str_replace(['=', '%', '_'], ['==', '=%', '=_'], mb_strtolower($query)) . '%';
        // public_id uses ascii_bin in the schema. Convert it to the connection's
        // utf8mb4 charset before LIKE, including when the viewer is not a manager:
        // MySQL resolves collations before evaluating the role condition.
        $rows->whereRaw("(LOWER(own.remark) LIKE ? ESCAPE '=' OR LOWER(u.nickname) LIKE ? ESCAPE '=' OR (v.role IN ('owner','admin') AND (LOWER(u.username) LIKE ? ESCAPE '=' OR LOWER(CAST(u.public_id AS CHAR)) LIKE ? ESCAPE '=')))", [$pattern, $pattern, $pattern, $pattern]);
        $items = $rows->field('m.user_id,m.role,m.muted_until,u.nickname,u.username,u.public_id,u.avatar_url,own.remark,own.contact_user_id AS own_contact_id,up.internal_staff,p.last_seen_at,s.settings_json,reverse_contact.contact_user_id AS reverse_contact_id,b.blocker_id AS presence_blocked,v.role AS viewer_role')
            ->orderRaw("CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END")
            ->order('u.nickname', 'asc')->order('m.user_id', 'asc')->limit(($page - 1) * 100, 101)->select()->toArray();
        $result['has_more'] = count($items) > 100;
        if ($result['has_more']) array_pop($items);
        if ($items !== []) $result['search_scope'] = in_array($items[0]['viewer_role'], ['owner', 'admin'], true) ? 'group' : 'friends';
        $settingsService = new UserSettingsService();
        foreach ($items as &$item) {
            $settings = json_decode((string) ($item['settings_json'] ?? ''), true) ?: [];
            $visible = (int) $item['user_id'] === $viewer || ($item['presence_blocked'] === null && $settingsService->canView($settings, 'last_seen_visibility', $viewer, $item['reverse_contact_id'] !== null));
            $item['user_id'] = (int) $item['user_id'];
            $item['is_contact'] = $item['own_contact_id'] !== null;
            $item['remark'] = $item['is_contact'] ? trim((string) ($item['remark'] ?? '')) : '';
            $item['online'] = $visible && !empty($item['last_seen_at']) && strtotime($item['last_seen_at']) >= time() - 60;
            $item['last_seen_hidden'] = !$visible;
            if (!$visible) $item['last_seen_at'] = null;
            $item['internal_staff'] = (bool) ($item['internal_staff'] ?? false);
            $item['muted_permanent'] = ($item['muted_until'] ?? null) === '9999-12-31 23:59:59';
            $item['is_muted'] = !empty($item['muted_until']) && strtotime($item['muted_until']) > time();
            unset($item['own_contact_id'], $item['reverse_contact_id'], $item['presence_blocked'], $item['settings_json'], $item['viewer_role']);
        }
        unset($item);
        $result['items'] = $items;
        return $result;
    }
}
