<?php
namespace app\Service;

use think\Request;
use think\exception\HttpResponseException;

/** Explain PHP's rejection before controller-level content validation can run. */
final class UploadRequestGuard
{
    public function file(Request $request): ?\think\file\UploadedFile
    {
        $limit = self::iniBytes((string) ini_get('post_max_size'));
        $length = (int) $request->server('content_length', '0');
        if ($limit > 0 && $length > $limit) {
            $this->reject('UPLOAD_POST_LIMIT', '文件超过服务器请求体限制，请管理员检查 PHP post_max_size 上传配置。', 413);
        }
        try { $file = $request->file('file'); }
        catch (\think\Exception $error) {
            match ($error->getCode()) {
                UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => $this->reject('UPLOAD_FILE_LIMIT', '文件超过服务器上传限制，请选择较小的文件或联系管理员检查 PHP upload_max_filesize。', 413),
                UPLOAD_ERR_PARTIAL => $this->reject('UPLOAD_PARTIAL', '文件未完整上传，请检查网络后重新选择发送。'),
                UPLOAD_ERR_NO_FILE => $this->reject('UPLOAD_MISSING', '没有收到上传文件，请重新选择。'),
                UPLOAD_ERR_NO_TMP_DIR, UPLOAD_ERR_CANT_WRITE => $this->reject('UPLOAD_STORAGE_UNAVAILABLE', '服务器上传目录不可用，请管理员检查临时目录、磁盘空间及写入权限。', 503),
                UPLOAD_ERR_EXTENSION => $this->reject('UPLOAD_SERVER_REJECTED', '服务器扩展阻止了上传，请联系管理员检查上传配置。', 503),
                default => throw $error,
            };
        }
        if (!$file instanceof \think\file\UploadedFile || !$file->isValid()) {
            $this->reject('UPLOAD_MISSING', '上传文件缺失或无效，请重新选择。');
        }
        return $file;
    }

    public static function iniBytes(string $value): int
    {
        $value = trim($value);
        if (!preg_match('/^([0-9]+)\s*([KMG]?)$/iD', $value, $match)) return 0;
        $factor = match (strtoupper($match[2])) { 'K' => 1024, 'M' => 1024 ** 2, 'G' => 1024 ** 3, default => 1 };
        return (int) min(PHP_INT_MAX, (float) $match[1] * $factor);
    }

    private function reject(string $code, string $message, int $status = 400): never
    {
        throw new HttpResponseException(json(['ok' => false, 'error' => ['code' => $code, 'message' => $message]], $status));
    }
}
