<?php
namespace app\Service;

require_once __DIR__ . '/AdminEntryService.php';

use RuntimeException;
use think\facade\Db;
use think\exception\HttpResponseException;

final class MediaAccessService
{
    public function __construct(private ?AdminEntryService $entries = null, private ?AdminIpAccessService $adminAccess = null) {}
    /** URL syntax only; callers must still enforce attachment ownership and file permissions. */
    public function isValidUrl(string $url): bool
    {
        if ($url === '' || preg_match('/[\x00-\x20\x7f\\\\]/', $url)) return false;
        $parts = parse_url($url);
        if (!is_array($parts)) return false;
        if (filter_var($url, FILTER_VALIDATE_URL) && in_array(strtolower((string) ($parts['scheme'] ?? '')), ['http', 'https'], true)) return true;
        if (isset($parts['scheme']) || isset($parts['host'])) return false;
        $local = in_array($parts['path'] ?? '', ['/api/media', '/media'], true) || str_starts_with($url, '/storage/');
        return $local && $this->pathFromUrl($url) !== null;
    }

    public function pathFromUrl(string $url): ?string
    {
        $parts = parse_url($url);
        if ($parts === false) return null;
        $path = rawurldecode((string) ($parts['path'] ?? ''));
        if (str_ends_with($path, '/media')) {
            parse_str((string) ($parts['query'] ?? ''), $query);
            $path = (string) ($query['path'] ?? '');
        } else {
            $index = strpos($path, '/storage/');
            if ($index !== false) $path = substr($path, $index + strlen('/storage/'));
        }
        return preg_match('~^(?:uploads/[0-9]{4}/(?:0[1-9]|1[0-2])/[a-f0-9]{32}\.[a-z0-9]{1,8}|work-questions/[0-9]{4}/(?:0[1-9]|1[0-2])/[a-f0-9]{64}\.(?:jpg|png|gif|webp))$~D', $path) ? $path : null;
    }

    public function canonicalUrl(string $url): string
    {
        $path = $this->pathFromUrl($url);
        return $path === null ? $url : rtrim((string) env('FILE_BASE_URL', '/storage'), '/') . '/' . $path;
    }

    public function canonicalizePayload(mixed $data): mixed
    {
        if (!is_array($data)) return $data;
        foreach ($data as $key => $value) {
            if (is_array($value)) $data[$key] = $this->canonicalizePayload($value);
            elseif (is_string($value) && in_array($key, ['url', 'avatar_url', 'actor_avatar_url', 'sender_avatar_url', 'image_url', 'thumbnail_url'], true)) $data[$key] = $this->canonicalUrl($value);
        }
        return $data;
    }

    public function transformPayload(mixed $data, string $sessionHash, string $sessionKind = 'user'): mixed
    {
        if (!is_array($data)) return $data;
        foreach ($data as $key => $value) {
            if (is_array($value)) $data[$key] = $this->transformPayload($value, $sessionHash, $sessionKind);
            elseif (is_string($value) && in_array($key, ['url', 'avatar_url', 'actor_avatar_url', 'sender_avatar_url', 'image_url', 'thumbnail_url'], true) && ($path = $this->pathFromUrl($value)) !== null) {
                $expires = time() + 3600;
                $signature = hash_hmac('sha256', $path . '|' . $expires . '|' . $sessionKind . '|' . $sessionHash, $this->secret());
                $query = ['media_expires' => $expires, 'media_session' => $sessionHash, 'media_kind' => $sessionKind, 'media_signature' => $signature];
                // Host-only entrance cookies stay on the admin host, including signed images.
                $data[$key] = $sessionKind === 'admin' && ($this->entries ?? new AdminEntryService())->enabled()
                    ? '/api/media?' . http_build_query(['path' => $path] + $query)
                    : $this->canonicalUrl($value) . '?' . http_build_query($query);
            }
        }
        return $data;
    }

    public function validateGrant(string $path, array $query): ?array
    {
        $expires = (int) ($query['media_expires'] ?? 0);
        $hash = (string) ($query['media_session'] ?? '');
        $kind = (string) ($query['media_kind'] ?? 'user');
        $signature = (string) ($query['media_signature'] ?? '');
        if ($expires < time() || $expires > time() + 3600 || !preg_match('/^[a-f0-9]{64}$/D', $hash) || !in_array($kind, ['user', 'admin'], true)) return null;
        if (!hash_equals(hash_hmac('sha256', $path . '|' . $expires . '|' . $kind . '|' . $hash, $this->secret()), $signature)) return null;
        if ($kind === 'admin') {
            $account = (new AdminAuthService())->byHash($hash);
            return $account ? $this->adminGrant($account) : null;
        }
        $id = Db::name('auth_tokens')->alias('t')->join('users u', 'u.id=t.user_id')->where('t.token_hash', $hash)->where('t.expires_at', '>', date('Y-m-d H:i:s'))->where('u.status', 'active')->value('u.id');
        return $id ? ['admin' => false, 'user_id' => (int) $id] : null;
    }

    public function adminGrant(array $account): array
    {
        ($this->entries ?? new AdminEntryService())->requireServer($_SERVER, (int) $account['id']);
        // Admin media uses public /media and legacy /storage paths, so route-prefix guards do not cover it.
        if (!($this->adminAccess ?? new AdminIpAccessService())->allows($_SERVER)) {
            $denied = AdminIpAccessService::notFoundResponse();
            throw new HttpResponseException(response($denied['body'], $denied['status'])->header($denied['headers']));
        }
        return ['admin' => true, 'user_id' => 0, 'admin_account' => $account];
    }

    public function recordUpload(string $path, ?int $userId, string $kind, ?int $adminId = null): void
    {
        Db::name('media_uploads')->insert(['path' => $path, 'user_id' => $userId, 'admin_id' => $adminId, 'kind' => $kind, 'created_at' => date('Y-m-d H:i:s')]);
    }

    public function recordMessage(int $messageId, array $body): void
    {
        foreach (['url', 'thumbnail_url'] as $key) {
            $path = isset($body[$key]) && is_string($body[$key]) ? $this->pathFromUrl($body[$key]) : null;
            if ($path !== null) Db::name('media_references')->extra('IGNORE')->insert(['path' => $path, 'message_id' => $messageId]);
        }
    }

    public function canRead(string $path, int $userId): bool
    {
        if ($userId <= 0) return false;
        if (Db::name('media_uploads')->where('path', $path)->where('user_id', $userId)->find()) return true;
        $message = Db::name('media_references')->alias('r')->join('messages m', 'm.id=r.message_id')
            ->whereNotIn('m.id', MessageDeletionService::hiddenQuery($userId))
            ->join('conversation_members cm', 'cm.conversation_id=m.conversation_id')->join('conversations c', 'c.id=m.conversation_id')
            ->where('r.path', $path)->where('cm.user_id', $userId)->where('c.status', 'active')->whereNull('m.recalled_at')
            ->whereRaw('m.id > cm.cleared_before_message_id')->find();
        if ($message) return true;
        $url = rtrim((string) env('FILE_BASE_URL', '/storage'), '/') . '/' . $path;
        // Profile pictures and published group pictures are visible to signed-in users.
        if (Db::name('users')->where('avatar_url', $url)->where('status', 'active')->find()) return true;
        if (Db::name('conversations')->where('avatar_url', $url)->where('status', 'active')->find()) return true;
        // A task image is available only to a user whose assigned snapshot contains it.
        return (bool) Db::name('work_task_records')->where('user_id', $userId)->whereLike('question_snapshot_json', '%' . $path . '%')->find();
    }

    public function assertCanAttach(string $url, int $userId): void
    {
        $path = $this->pathFromUrl($url);
        if ($path !== null && !$this->canRead($path, $userId)) throw new RuntimeException('无权使用此附件，请重新上传。');
    }

    public function canAdminRead(string $path, array $account): bool
    {
        if (($account['role'] ?? '') === 'admin') return true;
        if ((int) ($account['id'] ?? 0) <= 0) return false;
        $allows = static fn (string $permission): bool => AdminPermissionService::allows($account, $permission);
        $url = rtrim((string) env('FILE_BASE_URL', '/storage'), '/') . '/' . $path;
        if ($allows('users.view') && Db::name('users')->where('avatar_url', $url)->find()) return true;
        if ($allows('groups.view')) {
            if (Db::name('conversations')->where('avatar_url', $url)->whereIn('type', ['group', 'channel'])->find()) return true;
            if (Db::name('users')->alias('u')->join('conversation_members cm', 'cm.user_id=u.id')
                ->join('conversations c', 'c.id=cm.conversation_id')->where('u.avatar_url', $url)->whereIn('c.type', ['group', 'channel'])->find()) return true;
        }
        if ($allows('messages.view') || $allows('moderation.view')) {
            if (Db::name('media_references')->alias('r')->join('messages m', 'm.id=r.message_id')
                ->where('r.path', $path)->whereNull('m.recalled_at')->find()) return true;
            if (Db::name('users')->alias('u')->join('messages m', 'm.sender_id=u.id')->where('u.avatar_url', $url)->find()) return true;
        }
        if ($allows('question-bank.view') && Db::name('work_questions')->where('image_url', $url)->find()) return true;
        // Search only actual image fields, with literal URL matching rather than text content or wildcard patterns.
        $literalUrl = strtr($url, ['!' => '!!', '%' => '!%', '_' => '!_']);
        if ($allows('dispatch-tasks.view') && Db::name('dispatch_tasks')->where('status', '<>', 'deleted')
            ->whereRaw("JSON_SEARCH(steps_json, 'one', ?, '!', '$[*].image_url') IS NOT NULL", [$literalUrl])->find()) return true;
        if ($allows('task-records.view')) {
            if (Db::name('work_task_records')->whereLike('question_snapshot_json', '%' . $path . '%')->find()) return true;
            if (Db::name('users')->alias('u')->join('work_task_records r', 'r.user_id=u.id')->where('u.avatar_url', $url)->find()) return true;
        }
        // Uploaded images must preview before they are saved to a user, group, or question.
        $upload = Db::name('media_uploads')->where('path', $path)->where('admin_id', (int) $account['id'])->find();
        return $upload && (($upload['kind'] === 'avatar' && ($allows('users.manage') || $allows('groups.manage')))
            || ($upload['kind'] === 'question' && $allows('question-bank.manage'))
            || ($upload['kind'] === 'dispatch_image' && $allows('dispatch-tasks.manage')));
    }

    public function assertAdminCanAttach(string $url, array $account): void
    {
        $path = $this->pathFromUrl($url);
        if ($path !== null && !$this->canAdminRead($path, $account)) throw new RuntimeException('无权使用此附件，请重新上传。');
    }

    private function secret(): string
    {
        $secret = (string) env('MEDIA_SIGNING_KEY', '');
        if (strlen($secret) < 32) throw new RuntimeException('附件访问密钥尚未配置。');
        return $secret;
    }
}
