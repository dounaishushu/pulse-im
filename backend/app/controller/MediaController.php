<?php
namespace app\controller;

require_once dirname(__DIR__) . '/Service/AdminBrowserSecurity.php';
require_once dirname(__DIR__) . '/Service/MediaPreviewService.php';
use app\Service\MediaAccessService;
use app\Service\AuthService;
use app\Service\AdminAuthService;
use think\Request;

final class MediaController
{
    public function download(Request $request)
    {
        $media = new MediaAccessService();
        $path = (string) $request->get('path', '');
        if ($media->pathFromUrl($path) !== $path) return $this->denied(404);
        $grant = $media->validateGrant($path, $request->get());
        $token = \app\Service\AdminBrowserSecurity::token($request);
        if (!$grant && $token !== '') {
            $admin = (new AdminAuthService())->byHash(hash('sha256', $token));
            if ($admin) $grant = $media->adminGrant($admin);
            else { try { $grant = ['admin' => false, 'user_id' => (int) (new AuthService())->userByToken($token)['id']]; } catch (\Throwable) {} }
        }
        if (!$grant || ($grant['admin']
            ? !$media->canAdminRead($path, $grant['admin_account'])
            : !$media->canRead($path, $grant['user_id']))) return $this->denied(403);
        $root = realpath(app()->getRootPath() . 'public/storage');
        $file = realpath(app()->getRootPath() . 'public/storage/' . $path);
        if (!$root || !$file || !is_file($file) || !str_starts_with($file, $root . DIRECTORY_SEPARATOR)) return $this->denied(404);
        $preview = $request->get('media_preview', '');
        if ($preview !== '' && $preview !== '640') return $this->denied(400);
        $original = $file;
        if ($preview === '640' && preg_match('/\.(?:jpe?g|png|gif|webp)$/iD', $file)) $file = (new \app\Service\MediaPreviewService())->file($file);
        $size = (int) filesize($file); $start = 0; $end = $size - 1; $status = 200;
        $range = (string) $request->header('range', '');
        if ($range !== '') {
            if (!preg_match('/^bytes=(\d*)-(\d*)$/D', $range, $m) || ($m[1] === '' && $m[2] === '')) return response('', 416)->header(['Content-Range' => 'bytes */' . $size]);
            if ($m[1] === '') $start = max(0, $size - (int) $m[2]);
            else { $start = (int) $m[1]; if ($m[2] !== '') $end = min($end, (int) $m[2]); }
            if ($start > $end || $start >= $size) return response('', 416)->header(['Content-Range' => 'bytes */' . $size]);
            $status = 206;
        }
        $mime = (new \finfo(FILEINFO_MIME_TYPE))->file($file) ?: 'application/octet-stream';
        $headers = ['Content-Type' => $mime, 'Content-Length' => (string) ($end - $start + 1), 'Cache-Control' => 'private, no-store', 'Pragma' => 'no-cache', 'X-Content-Type-Options' => 'nosniff', 'Accept-Ranges' => 'bytes', 'Content-Disposition' => (preg_match('~^(?:image|audio|video)/~', $mime) ? 'inline' : 'attachment') . '; filename="' . basename($file) . '"'];
        if ($preview === '640') $headers['X-Pulse-Media-Variant'] = $file === $original ? 'original' : 'preview-640-v1';
        if ($status === 206) $headers['Content-Range'] = "bytes {$start}-{$end}/{$size}";
        return new \app\response\PrivateMedia($file, $start, $end - $start + 1, $status, $headers, $request->method() === 'HEAD');
    }
    private function denied(int $status) { return json(['ok' => false, 'error' => ['code' => 'MEDIA_FORBIDDEN', 'message' => '附件不存在或无权访问。']], $status)->header(['Cache-Control' => 'no-store']); }
}
