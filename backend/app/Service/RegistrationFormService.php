<?php
declare(strict_types=1);
namespace app\Service;

use RuntimeException;

/** Called only after a single-use captcha succeeds. Account and media ownership commit together. */
final class RegistrationFormService
{
    public static function validateCredentials(string $username, string $password): void
    {
        if (!preg_match('/^[A-Za-z][A-Za-z0-9]{4,9}$/D', $username) || !preg_match('/[0-9]/', $username)) throw new RuntimeException('用户名需5到10位，以字母开头，包含字母和数字。');
        if (strlen($password) < 8 || strlen($password) > 16 || !preg_match('/[A-Za-z]/', $password) || !preg_match('/[0-9]/', $password) || preg_match('/\s/', $password)) throw new RuntimeException('密码需要8到16位，必须包含字母和数字，不能包含空格。');
    }

    public function register(array $data, string $ip): array
    {
        $username = trim((string) ($data['username'] ?? ''));
        self::validateCredentials($username, (string) ($data['password'] ?? ''));
        return $this->registerWithAvatar($data, $ip, $username, '');
    }

    /** PC keeps its existing username/phone rules, enforced by AuthService. */
    public function registerDesktop(array $data, string $ip): array
    {
        if (strtolower(trim((string) ($data['device_type'] ?? ''))) !== 'pc') throw new RuntimeException('注册客户端不正确。');
        return $this->registerWithAvatar($data, $ip,
            trim((string) ($data['username'] ?? $data['account'] ?? '')), trim((string) ($data['phone'] ?? '')));
    }

    private function registerWithAvatar(array $data, string $ip, string $username, string $phone): array
    {
        $source = $data['avatar_data_url'] ?? null;
        if (!is_string($source) || strlen($source) > 1400000 || !preg_match('~^data:image/(jpeg|png);base64,([A-Za-z0-9+/]*={0,2})$~D', $source, $parts)) throw new RuntimeException('请选择头像后再注册。');
        $bytes = base64_decode($parts[2], true);
        if ($bytes === false || strlen($bytes) < 1 || strlen($bytes) > 1048576) throw new RuntimeException('头像过大或格式不正确，请重新选择。');
        $info = @getimagesizefromstring($bytes);
        if (!$info || $info[0] < 1 || $info[1] < 1 || max($info[0], $info[1]) > 1024 || !in_array($info[2], [IMAGETYPE_JPEG, IMAGETYPE_PNG], true)) throw new RuntimeException('头像内容无效，请重新选择图片。');
        if (!extension_loaded('gd') || !function_exists('imagejpeg')) throw new RuntimeException('头像服务暂不可用，请稍后重试。');
        $image = @imagecreatefromstring($bytes);
        if (!$image) throw new RuntimeException('头像无法读取，请重新选择。');
        $path = 'uploads/' . date('Y/m') . '/' . bin2hex(random_bytes(16)) . '.jpg';
        $file = app()->getRootPath() . 'public/storage/' . $path;
        $directory = dirname($file);
        $created = false;
        try {
            if (!is_dir($directory) && !@mkdir($directory, 0755, true) && !is_dir($directory)) throw new RuntimeException('服务器无法保存头像，请稍后重试。');
            $output = @fopen($file, 'xb');
            if (!$output) throw new RuntimeException('服务器无法保存头像，请稍后重试。');
            $created = true;
            try {
                // Decode and re-encode; never publish caller bytes, metadata, filenames or external URLs.
                if (!imagejpeg($image, $output, 88)) throw new RuntimeException('头像处理失败，请重新选择。');
            } finally { fclose($output); }
            $url = rtrim((string) env('FILE_BASE_URL', '/storage'), '/') . '/' . $path;
            $result = (new AuthService())->register((string) ($data['nickname'] ?? ''), $phone, (string) ($data['password'] ?? ''), (string) ($data['device_type'] ?? 'unknown'), $ip, $username, $url, true, is_string($data['device_id'] ?? null) ? $data['device_id'] : '', is_string($data['device_name'] ?? null) ? $data['device_name'] : '');
            return $result + ['avatar_url' => $url];
        } catch (\Throwable $error) {
            // Only this random file is ours. A failed registration must not leave orphan avatars.
            if ($created && is_file($file)) @unlink($file);
            throw $error;
        } finally { imagedestroy($image); }
    }
}
