<?php
declare(strict_types=1);
namespace app\controller;
use app\Service\RegistrationCaptchaService;
use think\Request;

final class RegistrationCaptchaController
{
    public function issue(Request $request)
    {
        return json(['ok' => true, 'data' => (new RegistrationCaptchaService())->issue((string) $request->ip(), (string) $request->get('format', 'legacy'))])
            ->header(['Cache-Control' => 'no-store', 'Pragma' => 'no-cache']);
    }
}
