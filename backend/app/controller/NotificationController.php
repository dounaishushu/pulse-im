<?php

namespace app\controller;

use app\Service\AuthService;
use app\Service\NotificationDeviceService;
use app\Service\UserNotificationService;
use think\Request;

final class NotificationController
{
    public function index(Request $request)
    {
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new UserNotificationService())->list((int) $user['id'], (int) $request->get('before_id', 0), (int) $request->get('limit', 30))]);
    }

    public function summary(Request $request)
    {
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new UserNotificationService())->summary((int) $user['id'])]);
    }

    public function friendChats(Request $request)
    {
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new UserNotificationService())->friendChats((int) $user['id'], (int) $request->get('after_id', 0))]);
    }

    public function read(Request $request)
    {
        $user = $this->user($request);
        $data = $this->payload($request);
        return json(['ok' => true, 'data' => (new UserNotificationService())->read((int) $user['id'], $data['ids'] ?? null)]);
    }

    public function register(Request $request)
    {
        $user = $this->user($request);
        $data = $this->payload($request);
        $token = preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', ''));
        return json(['ok' => true, 'data' => (new NotificationDeviceService())->register((int) $user['id'], (string) ($data['platform'] ?? ''), (string) ($data['device_token'] ?? ''), hash('sha256', $token))], 201);
    }

    public function unregister(Request $request)
    {
        $user = $this->user($request);
        $data = $this->payload($request);
        return json(['ok' => true, 'data' => (new NotificationDeviceService())->unregister((int) $user['id'], (string) ($data['device_token'] ?? ''))]);
    }

    public function devices(Request $request)
    {
        $user = $this->user($request);
        return json(['ok' => true, 'data' => (new NotificationDeviceService())->list((int) $user['id'])]);
    }

    private function user(Request $request): array
    {
        return (new AuthService())->userByToken(preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', '')));
    }

    private function payload(Request $request): array
    {
        $payload = $request->post();
        if ($payload !== []) return $payload;
        $decoded = json_decode(trim($request->getContent()), true);
        return is_array($decoded) ? $decoded : [];
    }
}
