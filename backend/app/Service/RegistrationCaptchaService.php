<?php
declare(strict_types=1);
namespace app\Service;

use Closure;
use RuntimeException;
use think\exception\HttpResponseException;
use think\facade\Db;

/** Shared, single-use challenges. Plain answers never enter JSON responses or storage. */
final class RegistrationCaptchaService
{
    public const TTL_SECONDS = 120;
    public const CODE_LENGTH = 5;
    private const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    private Closure $clock;
    private ?Closure $renderer;
    private ?Closure $codeGenerator;
    private string $key;

    /** Optional collaborators are for isolated tests; HTTP callers cannot select them. */
    public function __construct(?callable $clock = null, ?callable $renderer = null, ?callable $codeGenerator = null, ?string $secret = null,
        private int $issueLimit = 30, private int $submitLimit = 20)
    {
        $this->clock = $clock === null ? static fn (): int => time() : Closure::fromCallable($clock);
        $this->renderer = $renderer === null ? null : Closure::fromCallable($renderer);
        $this->codeGenerator = $codeGenerator === null ? null : Closure::fromCallable($codeGenerator);
        $secret ??= (string) env('MEDIA_SIGNING_KEY', '');
        if (strlen($secret) < 32 || $issueLimit < 1 || $submitLimit < 1) $this->fail('CAPTCHA_UNAVAILABLE', 503);
        $this->key = hash_hmac('sha256', 'pulse:registration-captcha:key:v1', $secret, true);
    }

    public function issue(string $ip, string $format = 'legacy'): array
    {
        if (!in_array($format, ['legacy', 'digits4'], true)) $this->fail('CAPTCHA_INVALID', 400);
        if ($this->renderer === null && (!extension_loaded('gd') || !function_exists('imagepng'))) $this->fail('CAPTCHA_UNAVAILABLE', 503);
        $now = ($this->clock)();
        $ipHash = $this->ipHash($ip);
        $this->rate('issue', $ipHash, $now, $this->issueLimit);
        $id = bin2hex(random_bytes(32));
        $code = $this->codeGenerator === null ? ($format === 'digits4' ? str_pad((string) random_int(0, 9999), 4, '0', STR_PAD_LEFT) : $this->randomCode()) : ($this->codeGenerator)();
        if (!is_string($code) || !preg_match($format === 'digits4' ? '/^[0-9]{4}$/D' : '/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/D', $code)) throw new RuntimeException('Invalid captcha generator.');
        $image = $this->renderer === null ? $this->render($code) : ($this->renderer)($code);
        if (!is_string($image) || !str_starts_with($image, "\x89PNG\r\n\x1a\n") || strlen($image) > 262144) $this->fail('CAPTCHA_UNAVAILABLE', 503);
        $issuedAt = ($this->clock)();
        Db::name('registration_captchas')->insert([
            'challenge_id' => $id, 'scene' => $format === 'digits4' ? 'register_digits4' : 'register', 'ip_hash' => $ipHash,
            'answer_hash' => $this->answerHash($id, $code), 'created_at' => $this->stamp($issuedAt),
            'expires_at' => $this->stamp($issuedAt + self::TTL_SECONDS), 'consumed_at' => null,
        ]);
        // Indexed, bounded maintenance; no valid or recently consumed challenge is deleted.
        Db::name('registration_captchas')->where('expires_at', '<', $this->stamp($now - 3600))->limit(100)->delete();
        Db::name('registration_captcha_rates')->where('expires_at', '<', $this->stamp($now - 3600))->limit(100)->delete();
        return ['challenge_id' => $id, 'image_data_url' => 'data:image/png;base64,' . base64_encode($image),
            'expires_in' => self::TTL_SECONDS, 'code_length' => $format === 'digits4' ? 4 : self::CODE_LENGTH];
    }

    public function consume(mixed $id, mixed $answer, string $ip, ?string $format = null): void
    {
        $now = ($this->clock)(); $ipHash = $this->ipHash($ip);
        $this->rate('submit', $ipHash, $now, $this->submitLimit);
        if ($id === null || $id === '') $this->fail('CAPTCHA_REQUIRED', 400);
        if (!is_string($id) || !preg_match('/^[a-f0-9]{64}$/D', $id)) $this->fail('CAPTCHA_INVALID', 400);
        // Even malformed/wrong answers consume a known challenge. Do not throw inside
        // this transaction: doing so would roll back consumption on failed attempts.
        $failure = Db::transaction(function () use ($id, $answer, $ipHash, $format): ?string {
            $row = Db::name('registration_captchas')->where('challenge_id', $id)->lock(true)->find();
            if (!$row) return 'CAPTCHA_INVALID';
            if ($row['consumed_at'] !== null) return 'CAPTCHA_USED';
            // Lock/rate waits may cross the deadline. Check the clock after the lock.
            $verifiedAt = ($this->clock)();
            Db::name('registration_captchas')->where('challenge_id', $id)->update(['consumed_at' => $this->stamp($verifiedAt)]);
            if (strtotime($row['expires_at']) <= $verifiedAt) return 'CAPTCHA_EXPIRED';
            if (!in_array($row['scene'], ['register', 'register_digits4'], true) || !hash_equals($row['ip_hash'], $ipHash)) return 'CAPTCHA_INVALID';
            if ($format === 'digits4' && $row['scene'] !== 'register_digits4') return 'CAPTCHA_INVALID';
            if ($answer === null || $answer === '') return 'CAPTCHA_REQUIRED';
            if (!is_string($answer) || strlen($answer) > 64) return 'CAPTCHA_INVALID';
            $normalized = strtoupper(trim($answer));
            if (!preg_match($row['scene'] === 'register_digits4' ? '/^[0-9]{4}$/D' : '/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/D', $normalized)
                || !hash_equals($row['answer_hash'], $this->answerHash($id, $normalized))) return 'CAPTCHA_INVALID';
            return null;
        });
        if ($failure !== null) $this->fail($failure, 400);
    }

    private function ipHash(string $ip): string
    {
        $packed = filter_var($ip, FILTER_VALIDATE_IP) ? inet_pton($ip) : false;
        if ($packed === false) $this->fail('CAPTCHA_UNAVAILABLE', 503);
        if (strlen($packed) === 16 && substr($packed, 0, 12) === str_repeat("\0", 10) . "\xff\xff") $packed = substr($packed, 12);
        return hash_hmac('sha256', "register:ip:v1\0" . $packed, $this->key);
    }

    private function answerHash(string $id, string $answer): string
    {
        return hash_hmac('sha256', "register:answer:v1\0" . $id . "\0" . $answer, $this->key);
    }

    private function rate(string $scope, string $ipHash, int $now, int $limit): void
    {
        $window = intdiv($now, 60);
        $key = hash_hmac('sha256', 'register:rate:v1:' . $scope . ':' . $ipHash . ':' . $window, $this->key);
        $allowed = Db::transaction(function () use ($key, $window, $limit): bool {
            // The duplicate branch obtains an exclusive lock. INSERT IGNORE could
            // leave simultaneous duplicate readers upgrading shared locks into a deadlock.
            $table = Db::name('registration_captcha_rates')->getTable();
            Db::execute("INSERT INTO {$table} (bucket_key,hits,expires_at) VALUES (?,0,?) ON DUPLICATE KEY UPDATE bucket_key=VALUES(bucket_key)", [$key, $this->stamp(($window + 1) * 60)]);
            $row = Db::name('registration_captcha_rates')->where('bucket_key', $key)->lock(true)->find();
            if (!$row || (int) $row['hits'] >= $limit) return false;
            Db::name('registration_captcha_rates')->where('bucket_key', $key)->update(['hits' => (int) $row['hits'] + 1]);
            return true;
        });
        if (!$allowed) $this->fail('CAPTCHA_RATE_LIMITED', 429, ($window + 1) * 60 - $now);
    }

    private function randomCode(): string
    {
        $code = '';
        for ($i = 0; $i < self::CODE_LENGTH; $i++) $code .= self::ALPHABET[random_int(0, strlen(self::ALPHABET) - 1)];
        return $code;
    }

    private function render(string $code): string
    {
        $canvas = imagecreatetruecolor(190, 58);
        if ($canvas === false) $this->fail('CAPTCHA_UNAVAILABLE', 503);
        try {
            $background = imagecolorallocate($canvas, 243, 247, 253); imagefill($canvas, 0, 0, $background);
            for ($i = 0; $i < 150; $i++) imagesetpixel($canvas, random_int(0, 189), random_int(0, 57), imagecolorallocate($canvas, random_int(155, 220), random_int(165, 225), random_int(175, 235)));
            for ($i = 0; $i < 4; $i++) imageline($canvas, random_int(0, 189), random_int(0, 57), random_int(0, 189), random_int(0, 57), imagecolorallocate($canvas, 178, 195, 222));
            for ($i = 0; $i < strlen($code); $i++) {
                $glyph = imagecreatetruecolor(18, 24); imagefill($glyph, 0, 0, $background);
                imagestring($glyph, 5, 4, 3, $code[$i], imagecolorallocate($glyph, random_int(25, 65), random_int(65, 105), random_int(125, 180)));
                imagecopyresampled($canvas, $glyph, strlen($code) === 4 ? 23 + $i * 39 : 15 + $i * 33, random_int(8, 14), 0, 0, 29, 35, 18, 24);
                imagedestroy($glyph);
            }
            ob_start();
            try { if (!imagepng($canvas)) $this->fail('CAPTCHA_UNAVAILABLE', 503); return (string) ob_get_contents(); }
            finally { ob_end_clean(); }
        } finally { imagedestroy($canvas); }
    }

    private function stamp(int $time): string { return date('Y-m-d H:i:s', $time); }

    private function fail(string $code, int $status, int $retryAfter = 0): never
    {
        $message = match ($code) {
            'CAPTCHA_REQUIRED' => '请填写注册验证码。', 'CAPTCHA_USED' => '验证码已使用，请更换后重试。',
            'CAPTCHA_EXPIRED' => '验证码已过期，请更换后重试。', 'CAPTCHA_RATE_LIMITED' => '操作过于频繁，请稍后再试。',
            'CAPTCHA_UNAVAILABLE' => '验证码服务暂不可用，请稍后重试。', default => '验证码不正确，请更换后重试。',
        };
        $headers = ['Cache-Control' => 'no-store'];
        if ($retryAfter > 0) $headers['Retry-After'] = (string) $retryAfter;
        throw new HttpResponseException(json(['ok' => false, 'error' => ['code' => $code, 'message' => $message]], $status)->header($headers));
    }
}
