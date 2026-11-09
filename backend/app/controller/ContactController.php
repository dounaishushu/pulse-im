<?php

namespace app\controller;

use app\Service\AuthService;
use app\Service\ContactService;
use app\Service\GroupProfileContextService;
use app\Service\ReceivedContactCardService;
use think\Request;

require_once dirname(__DIR__) . '/Service/ContactNameService.php';

final class ContactController
{
    public function search(Request $request)
    {
        $user = $this->user($request);
        if (array_key_exists('public_id', $request->get())) {
            return json(['ok' => true, 'data' => (new ContactService())->searchPublicId($request->get('public_id'), (int) $user['id'])]);
        }
        return json(['ok' => true, 'data' => (new ContactService())->search((string) $request->get('q', ''), (int) $request->get('page', 1), (int) $request->get('size', 20), (int) $user['id'])]);
    }

    public function sendRequest(Request $request)
    {
        $data = $this->payload($request);
        $user = $this->user($request);
        $context = (new GroupProfileContextService())->parseQuery($data);
        $cards = new ReceivedContactCardService();
        if ($cards->hasContext($data)) {
            $cardContext = $cards->requestContext((int) $user['id'], (int) ($data['to_user_id'] ?? 0), $data);
            if ($context !== null && $context !== $cardContext) throw new \RuntimeException('名片来源参数不匹配。');
            $context = $cardContext;
        }
        return json(['ok' => true, 'data' => (new ContactService())->sendRequest((int) $user['id'], (int) ($data['to_user_id'] ?? 0), (string) ($data['message'] ?? ''), $context)], 201);
    }

    public function forceAdd(Request $request)
    {
        $data = $this->payload($request);
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new ContactService())->forceAdd((int) $user['id'], (int) ($data['user_id'] ?? $data['to_user_id'] ?? 0))], 201);
    }

    public function handleRequest(Request $request)
    {
        $data = $this->payload($request);
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new ContactService())->handleRequest((int) $user['id'], (int) ($data['request_id'] ?? 0), (string) ($data['action'] ?? ''), (int) ($data['notification_id'] ?? 0))]);
    }

    public function requests(Request $request)
    {
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new ContactService())->requests((int) $user['id'], (string) $request->get('direction', 'received'), (int) $request->get('page', 1), (int) $request->get('size', 20), (string) $request->get('status', ''))])->header(['Cache-Control' => 'no-store']);
    }

    public function requestSummary(Request $request)
    {
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new ContactService())->requestSummary((int) $user['id'])])->header(['Cache-Control' => 'no-store']);
    }

    public function index(Request $request)
    {
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new ContactService())->list((int) $user['id'], (int) $request->get('page', 1), (int) $request->get('size', 50))]);
    }

    public function remark(Request $request)
    {
        $data = $this->payload($request);
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new ContactService())->remark((int) $user['id'], (int) ($data['user_id'] ?? 0), array_key_exists('remark', $data) ? (string) $data['remark'] : null, array_key_exists('group_name', $data) ? (string) $data['group_name'] : null)]);
    }

    public function names(Request $request)
    {
        $user = $this->user($request);
        return json(['ok'=>true,'data'=>(new \app\Service\ContactNameService())->page((int)$user['id'],
            (int)$request->get('page',1), (int)$request->get('size',100))])->header(['Cache-Control'=>'no-store']);
    }

    public function profile(Request $request)
    {
        $user = $this->user($request);
        $context = (new GroupProfileContextService())->parseQuery($request->get(false));
        $userId = (int) $request->get('user_id', 0);
        return json(['ok' => true, 'data' => (new ContactService())->profile((int) $user['id'], $userId, $context)])->header(['Cache-Control' => 'no-store']);
    }

    public function cardProfile(Request $request)
    {
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new ReceivedContactCardService())->profile((int) $user['id'], $request->get(false))])
            ->header(['Cache-Control' => 'no-store']);
    }

    public function internalProfile(Request $request)
    {
        $user = $this->user($request);
        $context = (new GroupProfileContextService())->parseQuery($request->get(false));
        return json(['ok' => true, 'data' => (new ContactService())->internalProfile((int) $user['id'], (int) $request->get('user_id', 0), $context)])->header(['Cache-Control' => 'no-store']);
    }

    public function commonGroups(Request $request)
    {
        $user = $this->user($request);
        $context = (new GroupProfileContextService())->parseQuery($request->get(false));
        return json(['ok' => true, 'data' => (new \app\Service\ContactDetailsService())->commonGroups((int) $user['id'], (int) $request->get('user_id', 0), (int) $request->get('page', 1), (int) $request->get('size', 20), $context)])->header(['Cache-Control' => 'no-store']);
    }

    public function remove(Request $request)
    {
        $data = $this->payload($request);
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new ContactService())->remove((int) $user['id'], (int) ($data['user_id'] ?? 0))]);
    }

    private function user(Request $request): array
    {
        $token = preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', ''));
        return (new AuthService())->userByToken($token);
    }

    private function payload(Request $request): array
    {
        $payload = $request->post();
        if ($payload !== []) return $payload;
        $decoded = json_decode(trim($request->getContent()), true);
        return is_array($decoded) ? $decoded : [];
    }
}
