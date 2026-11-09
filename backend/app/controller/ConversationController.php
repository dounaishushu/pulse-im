<?php

namespace app\controller;

use app\Service\AuthService;
use app\Service\ConversationService;
use think\Request;

final class ConversationController
{
    public function mentionMembers(Request $request) { $u = $this->user($request); return json(['ok' => true, 'data' => (new \app\Service\GroupMentionService())->search((int) $u['id'], (int) $request->get('conversation_id', 0), (string) $request->get('q', ''), (int) $request->get('page', 1))]); }
    public function index(Request $request) { $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->list((int) $u['id'], (int) $request->get('page', 1), (int) $request->get('size', 30), (string) $request->get('type', ''))]); }
    public function updates(Request $request)
    {
        $u = $this->user($request); $raw = (string) $request->get('ids', '');
        if (!preg_match('/^[1-9][0-9]*(?:,[1-9][0-9]*){0,99}$/D', $raw) || strlen($raw) > 1700) throw new \RuntimeException('会话编号格式无效。');
        $ids = array_map('intval', explode(',', $raw));
        return json(['ok' => true, 'data' => (new ConversationService())->updates((int) $u['id'], $ids)]);
    }
    public function direct(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->createDirect((int) $u['id'], (int) ($d['user_id'] ?? 0))], 201); }
    public function favorites(Request $request) { $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->favorites((int) $u['id'])], 201); }
    public function group(Request $request) { $d = $this->payload($request); $u = $this->user($request); $allowMemberAddFriend = !array_key_exists('allow_member_add_friend', $d) || (bool) $d['allow_member_add_friend']; return json(['ok' => true, 'data' => (new ConversationService())->createGroup((int) $u['id'], (string) ($d['name'] ?? ''), is_array($d['member_ids'] ?? null) ? $d['member_ids'] : [], $allowMemberAddFriend, (string) ($d['avatar_url'] ?? ''))], 201); }
    public function joinGroup(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->joinGroup((int) $u['id'], (int) ($d['conversation_id'] ?? 0), (string) ($d['invite_code'] ?? ''))]); }
    public function followChannel(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->followChannel((int) $u['id'], (int) ($d['conversation_id'] ?? 0), (string) ($d['invite_code'] ?? ''))]); }
    public function channel(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->createSpecial((int) $u['id'], (string) ($d['name'] ?? ''), 'channel', (string) ($d['avatar_url'] ?? ''), (string) ($d['description'] ?? ''))], 201); }
    public function customerService(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->createSpecial((int) $u['id'], (string) ($d['name'] ?? ''), 'customer_service')], 201); }
    public function members(Request $request)
    {
        $u = $this->user($request);
        $query = $request->get('q', null);
        if ($query !== null && !is_string($query)) throw new \RuntimeException('群成员搜索参数无效。');
        $data = $query === null
            ? (new ConversationService())->members((int) $u['id'], (int) $request->get('conversation_id', 0))
            : (new \app\Service\GroupMemberSearchService())->search((int) $u['id'], (int) $request->get('conversation_id', 0), $query, (int) $request->get('page', 1));
        return json(['ok' => true, 'data' => $data])->header(['Cache-Control' => 'no-store']);
    }
    public function leave(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->leave((int) $u['id'], (int) ($d['conversation_id'] ?? 0))]); }
    public function hide(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->hideForUser((int) $u['id'], (int) ($d['conversation_id'] ?? 0))]); }
    public function open(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->openForUser((int) $u['id'], (int) ($d['conversation_id'] ?? 0))]); }
    public function info(Request $request) { $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->infoForUser((int) $u['id'], (int) $request->get('conversation_id', 0))]); }
    public function settings(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->updateUserSettings((int) $u['id'], (int) ($d['conversation_id'] ?? 0), $d)]); }
    public function subscriptions(Request $request) { $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->subscriptionIds((int) $u['id'], (int) $request->get('after', 0))]); }
    public function addMember(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->addMember((int) $u['id'], (int) ($d['conversation_id'] ?? 0), (int) ($d['user_id'] ?? 0))], 201); }
    public function addMembers(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new \app\Service\GroupInvitationService())->add((int) $u['id'], (int) ($d['conversation_id'] ?? 0), $d['user_ids'] ?? null)], 201); }
    public function inviteCandidates(Request $request) { $u = $this->user($request); return json(['ok' => true, 'data' => (new \app\Service\GroupInvitationService())->candidates((int) $u['id'], (int) $request->get('conversation_id', 0), (int) $request->get('page', 1), (int) $request->get('size', 500))])->header(['Cache-Control' => 'no-store']); }
    public function updateGroup(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->updateGroup((int) $u['id'], (int) ($d['conversation_id'] ?? 0), (string) ($d['name'] ?? ''))]); }
    public function groupProfile(Request $request) { $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->groupProfile((int) $u['id'], (int) $request->get('conversation_id', 0))]); }
    public function updateGroupProfile(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->updateGroupProfile((int) $u['id'], (int) ($d['conversation_id'] ?? 0), $d)]); }
    public function transferGroup(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->transferGroup((int) $u['id'], (int) ($d['conversation_id'] ?? 0), (int) ($d['user_id'] ?? 0))]); }
    public function dissolveGroup(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->dissolveGroup((int) $u['id'], (int) ($d['conversation_id'] ?? 0))]); }
    public function updateGroupSettings(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->updateGroupSettings((int) $u['id'], (int) ($d['conversation_id'] ?? 0), $d)]); }
    public function removeMember(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->removeMember((int) $u['id'], (int) ($d['conversation_id'] ?? 0), (int) ($d['user_id'] ?? 0))]); }
    public function setRole(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->setRole((int) $u['id'], (int) ($d['conversation_id'] ?? 0), (int) ($d['user_id'] ?? 0), (string) ($d['role'] ?? ''))]); }
    public function muteMember(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new ConversationService())->muteMember((int) $u['id'], (int) ($d['conversation_id'] ?? 0), (int) ($d['user_id'] ?? 0), (int) ($d['minutes'] ?? 0))]); }
    private function user(Request $r): array { return (new AuthService())->userByToken(preg_replace('/^Bearer\s+/i', '', (string) $r->header('authorization', ''))); }
    private function payload(Request $r): array { $p = $r->post(); if ($p !== []) return $p; $d = json_decode(trim($r->getContent()), true); return is_array($d) ? $d : []; }
}
