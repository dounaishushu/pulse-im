<?php

namespace app\controller;

use app\Service\AuthService;
use app\Service\BlockService;
use think\Request;

final class BlockController
{
    public function index(Request $request) { $u = $this->user($request); return json(['ok' => true, 'data' => (new BlockService())->list((int) $u['id'], (int) $request->get('page', 1), (int) $request->get('size', 50))]); }
    public function candidates(Request $request) { $u = $this->user($request); return json(['ok' => true, 'data' => (new BlockService())->candidates((int) $u['id'], (string) $request->get('kind', 'contacts'), (string) $request->get('q', ''), (int) $request->get('page', 1), (int) $request->get('size', 50))]); }
    public function block(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new BlockService())->block((int) $u['id'], (int) ($d['user_id'] ?? 0), (string) ($d['reason'] ?? ''))], 201); }
    public function unblock(Request $request) { $d = $this->payload($request); $u = $this->user($request); return json(['ok' => true, 'data' => (new BlockService())->unblock((int) $u['id'], (int) ($d['user_id'] ?? 0))]); }
    private function user(Request $r): array { return (new AuthService())->userByToken(preg_replace('/^Bearer\s+/i', '', (string) $r->header('authorization', ''))); }
    private function payload(Request $r): array { $p = $r->post(); if ($p !== []) return $p; $d = json_decode(trim($r->getContent()), true); return is_array($d) ? $d : []; }
}
