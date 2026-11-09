<?php

namespace app\controller;

use app\Service\AuthService;
use app\Service\WebmAudioInspector;
use app\Service\Mp4AudioInspector;
use app\Service\UploadRequestGuard;
use RuntimeException;
use think\Request;

final class UploadController
{
    private const RULES = [
        'voice' => ['max' => 10 * 1024 * 1024, 'mimes' => ['audio/ogg', 'audio/opus', 'audio/webm', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav'], 'extensions' => ['ogg', 'opus', 'webm', 'mp3', 'm4a', 'wav']],
        'image' => ['max' => 10 * 1024 * 1024, 'mimes' => ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], 'extensions' => ['jpg', 'jpeg', 'png', 'gif', 'webp']],
        'video' => ['max' => 100 * 1024 * 1024, 'mimes' => ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/ogg', 'video/mpeg', 'video/3gpp', 'video/x-m4v', 'video/x-ms-wmv'], 'extensions' => ['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogv', 'mpeg', 'mpg', '3gp', 'm4v', 'wmv']],
        'file' => ['max' => 50 * 1024 * 1024, 'mimes' => ['application/pdf', 'text/plain', 'application/zip', 'application/octet-stream', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], 'extensions' => ['pdf', 'txt', 'zip', 'doc', 'docx']],
    ];

    public function upload(Request $request)
    {
        $user = $this->user($request);
        $file = (new UploadRequestGuard())->file($request);
        $kind = strtolower((string) $request->post('kind', 'file'));
        if (!isset(self::RULES[$kind])) throw new RuntimeException('不支持此上传类型。');
        $rule = self::RULES[$kind];
        $size = (int) $file->getSize();
        $mime = $this->detectMime($file->getRealPath());
        $extension = strtolower((string) $file->getOriginalExtension());
        if ($size <= 0 || $size > $rule['max']) throw new RuntimeException('文件大小超过上传限制或文件为空。');
        if (!in_array($extension, $rule['extensions'], true)) throw new RuntimeException('不支持此文件后缀。');
        $realMime = $mime;
        if ($kind === 'voice' && $extension === 'webm' && $realMime === 'video/webm' && WebmAudioInspector::isAudioOnly($file->getRealPath())) $realMime = $mime = 'audio/webm';
        if ($kind === 'voice' && $extension === 'm4a' && $realMime === 'video/mp4' && Mp4AudioInspector::isAudioOnly($file->getRealPath())) $realMime = $mime = 'audio/mp4';
        if (!in_array($realMime, $rule['mimes'], true) && !($kind === 'file' && $realMime === 'application/octet-stream' && $mime === 'application/octet-stream')) throw new RuntimeException('文件内容与允许的类型不符。');
        if ($kind === 'image' && @getimagesize($file->getRealPath()) === false) throw new RuntimeException('图片内容无效。');

        $relative = 'uploads/' . date('Y/m');
        $directory = app()->getRootPath() . 'public/storage/' . $relative;
        if (!is_dir($directory) && !@mkdir($directory, 0755, true) && !is_dir($directory)) throw new RuntimeException('服务器无法创建上传目录，请管理员检查磁盘空间和写入权限。');
        $name = bin2hex(random_bytes(16)) . ($extension !== '' ? '.' . preg_replace('/[^a-z0-9]/i', '', $extension) : '');
        try { $file->move($directory, $name); }
        catch (\think\exception\FileException $error) { throw new RuntimeException('服务器无法保存上传文件，请管理员检查磁盘空间和写入权限。', 0, $error); }
        try { (new \app\Service\MediaAccessService())->recordUpload($relative . '/' . $name, (int) $user['id'], $kind); }
        catch (\Throwable $error) {
            // Ownership must exist before the private attachment is returned to the client.
            @unlink($directory . '/' . $name);
            throw $error;
        }
        $baseUrl = rtrim((string) env('FILE_BASE_URL', '/storage'), '/');
        return json(['ok' => true, 'data' => ['kind' => $kind, 'url' => $baseUrl . '/' . $relative . '/' . $name, 'path' => $relative . '/' . $name, 'mime' => $mime, 'size' => $size]], 201);
    }

    private function detectMime(?string $path): string
    {
        if (!function_exists('finfo_open')) throw new RuntimeException('服务器未启用文件类型检测，请管理员启用 PHP fileinfo 扩展。');
        if (!$path || !is_file($path)) return '';
        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        if (!$finfo) return '';
        $mime = finfo_file($finfo, $path) ?: '';
        finfo_close($finfo);
        return strtolower($mime);
    }

    private function user(Request $request): array
    {
        return (new AuthService())->userByToken(preg_replace('/^Bearer\s+/i', '', (string) $request->header('authorization', '')));
    }
}
