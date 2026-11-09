<?php

namespace app\controller;

use app\Service\AuthService;
use app\Service\UserSettingsService;
use think\Request;

final class AuthController
{
    public function register(Request $request)
    {
        $data = $this->payload($request);
        // All HTTP registration clients use the same one-shot proof. Platform headers
        // and device_type are supplied by clients and cannot exempt a registration.
        $singlePage = ($data['registration_form'] ?? '') === 'single_page_v1';
        $desktopAvatar = !$singlePage && strtolower(trim((string) ($data['device_type'] ?? ''))) === 'pc';
        (new \app\Service\RegistrationCaptchaService())->consume($data['captcha_id'] ?? null, $data['captcha_code'] ?? null, (string) $request->ip(), $singlePage ? 'digits4' : null);
        // Some deployed Composer loaders use a frozen class map. Load this new
        // local module without modifying vendor files or rebuilding that map.
        if ($singlePage || $desktopAvatar) require_once dirname(__DIR__) . '/Service/RegistrationFormService.php';
        $result = $singlePage || $desktopAvatar
            ? ($singlePage
                ? (new \app\Service\RegistrationFormService())->register($data, (string) $request->ip())
                : (new \app\Service\RegistrationFormService())->registerDesktop($data, (string) $request->ip()))
            : (new AuthService())->register((string) ($data['nickname'] ?? ''), (string) ($data['phone'] ?? ''), (string) ($data['password'] ?? ''), (string) ($data['device_type'] ?? 'unknown'), (string) $request->ip(), (string) ($data['username'] ?? $data['account'] ?? ''), (string) ($data['avatar_url'] ?? ''), false, is_string($data['device_id'] ?? null) ? $data['device_id'] : '', is_string($data['device_name'] ?? null) ? $data['device_name'] : '');
        return json(['ok' => true, 'data' => $result], 201)->header(['Cache-Control' => 'no-store']);
    }

    public function login(Request $request)
    {
        $data = $this->payload($request);
        $account = trim((string) ($data['phone'] ?? ''));
        if ($account === '') $account = trim((string) ($data['username'] ?? $data['account'] ?? ''));
        $result = (new AuthService())->login($account, (string) ($data['password'] ?? ''), (string) ($data['device_type'] ?? 'unknown'), (string) $request->ip(), (string) ($data['two_step_code'] ?? ''), is_string($data['device_id'] ?? null) ? $data['device_id'] : '', is_string($data['device_name'] ?? null) ? $data['device_name'] : '');
        return json(['ok' => true, 'data' => $result]);
    }

    public function me(Request $request)
    {
        $token = preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', ''));
        return json(['ok' => true, 'data' => (new AuthService())->userByToken($token)]);
    }

    public function profile(Request $request)
    {
        $data = $this->payload($request);
        $user = $this->currentUser($request);
        return json(['ok' => true, 'data' => (new AuthService())->updateProfile((int) $user['id'], $data)]);
    }

    public function settings(Request $request)
    {
        $user = $this->currentUser($request);
        $service = new UserSettingsService();
        if ($request->isGet()) return json(['ok' => true, 'data' => $service->get((int) $user['id'])])->header(['Cache-Control' => 'no-store']);
        $data = $this->payload($request);
        try {
            return json(['ok' => true, 'data' => $service->update((int) $user['id'], (array) ($data['settings'] ?? $data))])->header(['Cache-Control' => 'no-store']);
        } catch (\RuntimeException $error) {
            if ($error->getCode() !== 403) throw $error;
            return json(['ok' => false, 'error' => ['code' => 'PRIVACY_SETTINGS_FORBIDDEN', 'message' => $error->getMessage()]], 403)->header(['Cache-Control' => 'no-store']);
        }
    }

    public function password(Request $request)
    {
        $data = $this->payload($request);
        $user = $this->currentUser($request);
        return json(['ok' => true, 'data' => (new AuthService())->changePassword((int) $user['id'], (string) ($data['current_password'] ?? ''), (string) ($data['new_password'] ?? ''))]);
    }

    public function sessions(Request $request)
    {
        $token = $this->token($request);
        $user = (new AuthService())->userByToken($token);
        return json(['ok' => true, 'data' => (new AuthService())->sessions((int) $user['id'], $token)]);
    }

    public function security(Request $request)
    {
        $user = $this->currentUser($request);
        $service = new \app\Service\UserSecurityService();
        if ($request->isGet()) return json(['ok' => true, 'data' => $service->status((int) $user['id'])]);
        $data = $this->payload($request);
        try {
            // The bearer token already authenticated this request. The setup screens intentionally do not ask for the login password again;
            // existing two-step passwords or recovery codes are still required for change, recovery and deletion.
            $result = $service->update((int) $user['id'], (string) ($data['action'] ?? ''), (string) ($data['login_password'] ?? ''), (string) ($data['current_code'] ?? ''), (string) ($data['new_password'] ?? ''), true);
            return json(['ok' => true, 'data' => $result]);
        } catch (\RuntimeException $error) {
            \think\facade\Db::name('login_logs')->insert(['user_id' => (int) $user['id'], 'phone' => $user['phone'] ?? $user['username'], 'device_type' => 'security', 'ip' => substr((string) $request->ip(), 0, 45), 'success' => 0, 'created_at' => date('Y-m-d H:i:s')]);
            throw $error;
        }
    }

    public function revokeSession(Request $request)
    {
        $data = $this->payload($request);
        $user = $this->currentUser($request);
        return json(['ok' => true, 'data' => (new AuthService())->revokeSession((int) $user['id'], (int) ($data['session_id'] ?? 0))]);
    }

    public function logout(Request $request)
    {
        return json(['ok' => true, 'data' => (new AuthService())->logout($this->token($request))]);
    }

    private function currentUser(Request $request): array
    {
        return (new AuthService())->userByToken($this->token($request));
    }

    private function token(Request $request): string
    {
        return preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', ''));
    }

    private function payload(Request $request): array
    {
        $payload = $request->post();
        if ($payload !== []) return $payload;
        $decoded = json_decode(trim($request->getContent()), true);
        return is_array($decoded) ? $decoded : [];
    }
}
