<?php

namespace app\controller;

use app\Service\MessageService;
use app\Service\AuthService;
use think\Request;

final class MessageController
{
    public function send(Request $request)
    {
        $data = $this->payload($request);
        $body = $data['body'] ?? [];
        if (!is_array($body)) {
            $body = [];
        }
        $result = (new MessageService())->send(
            (int) ($data['conversation_id'] ?? 0),
            (int) $this->user($request)['id'],
            (string) ($data['type'] ?? ''),
            $body,
            (string) ($data['request_id'] ?? '')
        );
        return json(['ok' => true, 'data' => $result], 201);
    }

    public function history(Request $request)
    {
        $user = $this->user($request);
        $result = (new MessageService())->history(
            (int) $request->get('conversation_id', 0),
            (int) $user['id'],
            (int) $request->get('page', 1),
            (int) $request->get('size', 20),
            (int) $request->get('max_id', 0)
        );
        return json(['ok' => true, 'data' => $result]);
    }

    public function sync(Request $request)
    {
        $user = $this->user($request);
        $integer = static function (string $key, int $default = 0) use ($request): int {
            $value = filter_var($request->get($key, $default), FILTER_VALIDATE_INT, ['options' => ['min_range' => 0]]);
            if ($value === false) throw new \RuntimeException('消息同步参数无效。');
            return $value;
        };
        $result = (new MessageService())->syncMessages($integer('conversation_id'), (int) $user['id'],
            $integer('after_id'), $integer('floor_id'), $integer('limit', 100),
            $request->get('snapshot_max_id') === null ? null : $integer('snapshot_max_id'));
        return json(['ok' => true, 'data' => $result])->header(['Cache-Control' => 'no-store']);
    }

    public function shared(Request $request)
    {
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new \app\Service\ContactDetailsService())->sharedMedia((int) $user['id'], (int) $request->get('conversation_id', 0), (int) $request->get('page', 1), (int) $request->get('size', 30), (string) $request->get('type', 'all'))])->header(['Cache-Control' => 'no-store']);
    }

    public function receipt(Request $request)
    {
        $data = $this->payload($request);
        if (array_key_exists('conversation_id', $data) || array_key_exists('through_message_id', $data)) {
            if (!is_int($data['conversation_id'] ?? null) || !is_int($data['through_message_id'] ?? null) || ($data['status'] ?? '') !== 'read' || array_key_exists('message_id', $data)) throw new \RuntimeException('已读参数无效。');
            return json(['ok' => true, 'data' => (new MessageService())->readConversation((int) $this->user($request)['id'], $data['conversation_id'], $data['through_message_id'])])->header(['Cache-Control' => 'no-store']);
        }
        return json(['ok' => true, 'data' => (new MessageService())->receipt((int) $this->user($request)['id'], (int) ($data['message_id'] ?? 0), (string) ($data['status'] ?? ''))]);
    }

    public function clearHistory(Request $request)
    {
        $data = $this->payload($request);
        return json(['ok' => true, 'data' => (new MessageService())->clearHistory((int) $this->user($request)['id'], (int) ($data['conversation_id'] ?? 0))]);
    }

    public function deleteSelected(Request $request)
    {
        $data = $this->payload($request);
        if (!is_int($data['conversation_id'] ?? null) || !is_array($data['message_ids'] ?? null)) throw new \RuntimeException('消息删除参数无效。');
        return json(['ok' => true, 'data' => (new \app\Service\MessageDeletionService())->deleteForUser((int) $this->user($request)['id'], $data['conversation_id'], $data['message_ids'])])->header(['Cache-Control' => 'no-store']);
    }

    public function markUnread(Request $request)
    {
        $data = $this->payload($request);
        return json(['ok' => true, 'data' => (new MessageService())->markUnread((int) $this->user($request)['id'], (int) ($data['conversation_id'] ?? 0))]);
    }

    public function recall(Request $request)
    {
        $data = $this->payload($request);
        return json(['ok' => true, 'data' => (new MessageService())->recall((int) $this->user($request)['id'], (int) ($data['message_id'] ?? 0))]);
    }

    public function edit(Request $request)
    {
        $data = $this->payload($request);
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new MessageService())->edit((int) $user['id'], (int) ($data['message_id'] ?? 0), (string) ($data['text'] ?? ''))]);
    }

    public function search(Request $request)
    {
        return json(['ok' => true, 'data' => (new MessageService())->search((int) $this->user($request)['id'], (string) $request->get('q', ''), (int) $request->get('conversation_id', 0), (string) $request->get('type', ''), (int) $request->get('page', 1), (int) $request->get('size', 20), (int) $request->get('sender_id', 0), (string) $request->get('date', ''))]);
    }

    public function calendar(Request $request)
    {
        return json(['ok' => true, 'data' => (new MessageService())->calendar((int) $this->user($request)['id'], (int) $request->get('conversation_id', 0))]);
    }

    public function locate(Request $request)
    {
        return json(['ok' => true, 'data' => (new MessageService())->locate((int) $this->user($request)['id'], (int) $request->get('conversation_id', 0), (int) $request->get('message_id', 0), (string) $request->get('first', '') === '1')]);
    }

    private function user(Request $request): array
    {
        $token = preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', ''));
        return (new AuthService())->userByToken($token);
    }

    private function payload(Request $request): array
    {
        $payload = $request->post();
        if ($payload !== []) {
            return $payload;
        }
        $decoded = json_decode(trim($request->getContent()), true);
        return is_array($decoded) ? $decoded : [];
    }
}
