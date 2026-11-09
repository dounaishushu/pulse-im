<?php

namespace app\controller;

use app\Service\AuthService;
use app\Service\ConversationFolderService;
use think\Request;

final class ConversationFolderController
{
    public function index(Request $request) { return json(['ok' => true, 'data' => (new ConversationFolderService())->list((int) $this->user($request)['id'], $this->scope($request->get()))]); }
    public function create(Request $request) { $d = $this->payload($request); return json(['ok' => true, 'data' => (new ConversationFolderService())->create((int) $this->user($request)['id'], (string) ($d['name'] ?? ''), $this->scope($d, 'direct'))], 201); }
    public function toggle(Request $request) { $d = $this->payload($request); return json(['ok' => true, 'data' => (new ConversationFolderService())->toggle((int) $this->user($request)['id'], (int) ($d['folder_id'] ?? 0), (bool) ($d['collapsed'] ?? false), $this->scope($d))]); }
    public function rename(Request $request) { $d = $this->payload($request); return json(['ok' => true, 'data' => (new ConversationFolderService())->rename((int) $this->user($request)['id'], (int) ($d['folder_id'] ?? 0), (string) ($d['name'] ?? ''), $this->scope($d))]); }
    public function assign(Request $request) { $d = $this->payload($request); return json(['ok' => true, 'data' => (new ConversationFolderService())->assign((int) $this->user($request)['id'], $this->folderId($d), (int) ($d['conversation_id'] ?? 0), $this->scope($d))]); }
    private function folderId(array $data): int
    {
        $id = $data['folder_id'] ?? null;
        // Zero explicitly means ungroup. Missing or malformed input must not do it.
        if ((!is_int($id) && !(is_string($id) && ctype_digit($id))) || filter_var($id, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]) === false) throw new \RuntimeException('分组编号不正确。');
        return (int) $id;
    }
    private function scope(array $data, ?string $default = null): ?string { return array_key_exists('scope', $data) ? ConversationFolderService::scope($data['scope']) : $default; }
    private function user(Request $r): array { return (new AuthService())->userByToken(preg_replace('/^Bearer\s+/i', '', (string) $r->header('authorization', ''))); }
    private function payload(Request $r): array { $p = $r->post(); if ($p !== []) return $p; $d = json_decode(trim($r->getContent()), true); return is_array($d) ? $d : []; }
}
