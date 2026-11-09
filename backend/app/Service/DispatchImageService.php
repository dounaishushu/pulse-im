<?php
namespace app\Service;

use RuntimeException;
use Throwable;
use think\facade\Db;
use think\file\UploadedFile;

/** Local images retain both their uploading administrator and selected sender. */
final class DispatchImageService
{
    private const MAX_BYTES = 50 * 1024 * 1024;
    private const TYPES = [
        IMAGETYPE_JPEG => ['mime' => 'image/jpeg', 'extensions' => ['jpg', 'jpeg']],
        IMAGETYPE_PNG => ['mime' => 'image/png', 'extensions' => ['png']],
        IMAGETYPE_GIF => ['mime' => 'image/gif', 'extensions' => ['gif']],
        IMAGETYPE_WEBP => ['mime' => 'image/webp', 'extensions' => ['webp']],
    ];

    public function upload(UploadedFile $file, int $senderId, array $account, string $ip = '', string $requestId = ''): array
    {
        if (!$file->isValid()) throw new RuntimeException('上传图片缺失或无效。');
        $info = $this->inspect($file->getRealPath(), strtolower($file->getOriginalExtension()));
        $storedFile = null;
        try {
            return Db::transaction(function () use ($file, $senderId, $account, $ip, $requestId, $info, &$storedFile): array {
                $actor = Db::name('admin_accounts')->where('id', (int) ($account['id'] ?? 0))->lock(true)->find();
                if (!$actor || $actor['status'] !== 'active' || !AdminPermissionService::allows($actor, 'dispatch-tasks.manage')) throw new RuntimeException('当前管理员无权上传分发图片。');
                if ($senderId <= 0 || !Db::name('users')->where('id', $senderId)->where('status', 'active')->lock(true)->find()) throw new RuntimeException('发送账号不存在或已停用。');
                $relative = 'uploads/' . date('Y/m');
                $storage = $this->storageRoot();
                $resolvedDirectory = $storage;
                foreach (explode('/', $relative) as $segment) {
                    $directory = $resolvedDirectory . '/' . $segment;
                    if (!is_dir($directory) && !mkdir($directory, 0755) && !is_dir($directory)) throw new RuntimeException('无法创建图片上传目录。');
                    $resolvedDirectory = realpath($directory);
                    if (!$resolvedDirectory || !$this->inside($resolvedDirectory, $storage)) throw new RuntimeException('图片上传目录无效。');
                }
                $name = bin2hex(random_bytes(16)) . '.' . strtolower($file->getOriginalExtension());
                $path = $relative . '/' . $name;
                $storedFile = $resolvedDirectory . '/' . $name;
                $file->move($resolvedDirectory, $name);
                (new MediaAccessService())->recordUpload($path, $senderId, 'dispatch_image', (int) $actor['id']);
                (new AuditService())->log((int) $actor['id'], 'dispatch.image.upload', 'media', null, $requestId, $ip,
                    ['path' => $path, 'sender_id' => $senderId, 'mime' => $info['mime'], 'size' => $info['size'], 'width' => $info['width'], 'height' => $info['height']]);
                return ['url' => rtrim((string) env('FILE_BASE_URL', '/storage'), '/') . '/' . $path, 'path' => $path] + $info;
            });
        } catch (Throwable $error) {
            if ($storedFile !== null && is_file($storedFile)) unlink($storedFile);
            throw $error;
        }
    }

    public function validate(string $url, int $senderId, array $account): string
    {
        $url = $this->url($url); $media = new MediaAccessService();
        if (($path = $media->pathFromUrl($url)) !== null) {
            $media->assertAdminCanAttach($url, $account);
            if (!$media->canRead($path, $senderId)) throw new RuntimeException('发送账号无权使用此图片，请为该账号重新上传。');
            $this->localInfo($path);
        }
        return $media->canonicalUrl($url);
    }

    /** External URLs are validated without fetching; local permissions are rechecked at delivery. */
    public function imageBody(string $url, int $senderId): array
    {
        $url = $this->url($url); $media = new MediaAccessService();
        $body = ['url' => $media->canonicalUrl($url)];
        if (($path = $media->pathFromUrl($url)) !== null) {
            if (!$media->canRead($path, $senderId)) throw new RuntimeException('发送账号无权使用此图片，请重新上传。');
            $info = $this->localInfo($path); $body['width'] = $info['width']; $body['height'] = $info['height'];
        }
        return $body;
    }

    private function url(string $url): string
    {
        $url = trim($url);
        // Admin entrance sessions receive /api/media?... URLs; deployments may also use /storage/.
        // Only recognized media paths are local. validate()/imageBody() still enforce ownership and file checks.
        if (strlen($url) > 2048 || !(new MediaAccessService())->isValidUrl($url)) throw new RuntimeException('请上传图片或填写有效的站内图片地址、HTTP/HTTPS地址，地址最多2048字节。');
        return $url;
    }

    private function localInfo(string $path): array
    {
        $root = $this->storageRoot(); $file = realpath($root . '/' . $path);
        if (!$file || !$this->inside($file, $root) || !is_file($file)) throw new RuntimeException('本地图片不存在或路径无效。');
        return $this->inspect($file, strtolower(pathinfo($path, PATHINFO_EXTENSION)));
    }

    private function inspect(string|false $file, string $extension): array
    {
        if (!$file || !is_file($file) || !is_readable($file)) throw new RuntimeException('图片文件不可读取。');
        $size = filesize($file);
        if ($size === false || $size <= 0 || $size > self::MAX_BYTES) throw new RuntimeException('图片须非空且不超过50MB。');
        $dimensions = @getimagesize($file);
        $type = $dimensions ? self::TYPES[$dimensions[2]] ?? null : null;
        if (!$type || !in_array($extension, $type['extensions'], true)) throw new RuntimeException('仅支持内容与后缀一致的JPG、PNG、GIF、WebP图片。');
        $mime = (new \finfo(FILEINFO_MIME_TYPE))->file($file);
        if ($mime !== $type['mime'] || (int) $dimensions[0] <= 0 || (int) $dimensions[1] <= 0) throw new RuntimeException('图片内容或类型无效。');
        return ['mime' => $mime, 'size' => (int) $size, 'width' => (int) $dimensions[0], 'height' => (int) $dimensions[1]];
    }

    private function storageRoot(): string
    {
        $root = realpath(app()->getRootPath() . 'public/storage');
        if (!$root || !is_dir($root)) throw new RuntimeException('图片存储目录不可用。');
        return $root;
    }

    private function inside(string $path, string $root): bool
    {
        $path = str_replace('\\', '/', $path); $root = rtrim(str_replace('\\', '/', $root), '/') . '/';
        if (DIRECTORY_SEPARATOR === '\\') { $path = strtolower($path); $root = strtolower($root); }
        return str_starts_with($path, $root);
    }
}
