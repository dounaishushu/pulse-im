<?php
namespace app\controller;

use app\Service\{AuthService, MessageReceiptService};
use RuntimeException;
use think\Request;

final class MessageReceiptController
{
    public function index(Request $request)
    {
        $token = preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', ''));
        $viewerId = (int) (new AuthService())->userByToken($token)['id'];
        $conversationId = filter_var($request->get('conversation_id'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        $raw = $request->get('message_ids');
        if ($conversationId === false || !is_string($raw) || strlen($raw) > 2100) throw new RuntimeException('消息回执参数无效。');
        $ids = explode(',', $raw);
        if (count($ids) < 1 || count($ids) > 100) throw new RuntimeException('请选择 1 至 100 条消息。');
        $ids = array_map(static function (string $value): int {
            if (!preg_match('/^[1-9][0-9]*$/D', $value)) throw new RuntimeException('消息编号必须为正整数。');
            $id = filter_var($value, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
            if ($id === false) throw new RuntimeException('消息编号无效。');
            return $id;
        }, $ids);
        return json(['ok' => true, 'data' => (new MessageReceiptService())->snapshot($viewerId, $conversationId, $ids)])->header(['Cache-Control' => 'no-store']);
    }
}
