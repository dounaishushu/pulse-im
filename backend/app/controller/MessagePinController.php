<?php
namespace app\controller;

use app\Service\AuthService;
use app\Service\MessagePinService;
use RuntimeException;
use think\Request;

final class MessagePinController
{
    public function index(Request $request)
    {
        $conversationId = filter_var($request->get('conversation_id'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($conversationId === false) throw new RuntimeException('会话编号无效。');
        return json(['ok' => true, 'data' => (new MessagePinService())->snapshot($conversationId, $this->viewer($request))])->header(['Cache-Control' => 'no-store']);
    }
    public function pin(Request $request) { return $this->change($request, true); }
    public function unpin(Request $request) { return $this->change($request, false); }
    private function change(Request $request, bool $pin)
    {
        $data = $request->post();
        if ($data === []) $data = json_decode(trim($request->getContent()), true) ?: [];
        if (!is_array($data) || !is_int($data['conversation_id'] ?? null) || !is_int($data['message_id'] ?? null)) throw new RuntimeException('会话和消息编号必须为整数。');
        return json(['ok' => true, 'data' => (new MessagePinService())->change($data['conversation_id'], $this->viewer($request), $data['message_id'], $pin)])->header(['Cache-Control' => 'no-store']);
    }
    private function viewer(Request $request): int
    {
        $token = preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', ''));
        return (int) (new AuthService())->userByToken($token)['id'];
    }
}
