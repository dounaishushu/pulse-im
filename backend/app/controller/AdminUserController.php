<?php

namespace app\controller;

require_once dirname(__DIR__) . '/Service/UserPasswordVault.php';
require_once dirname(__DIR__) . '/Service/RegistrationFormService.php';
require_once dirname(__DIR__) . '/Service/ConversationReadProgress.php';

use RuntimeException;
use think\Request;
use think\facade\Db;
use app\Service\AuditService;
use app\Service\AdminIpLocationService;

final class AdminUserController
{
    private const PERMISSION_FIELDS = ['muted', 'allow_add_friend', 'allow_create_group', 'internal_staff', 'formal_employee', 'allow_view_devices'];
    private array $locationCache = [];

    public function index(Request $request)
    {
        $this->admin($request);
        $page = max(1, (int) $request->get('page', 1));
        $size = min(100, max(1, (int) $request->get('size', 30)));
        $query = Db::name('users')->alias('search_user')->field('id,public_id,nickname,phone,username,avatar_url,register_ip,status,created_at,updated_at')->order('id', 'desc');
        $keyword = trim((string) $request->get('q', ''));
        if (mb_strlen($keyword) > 128) throw new RuntimeException('搜索内容不能超过128个字符。');
        if ($keyword !== '') {
            $query->where(function ($q) use ($keyword): void {
                $pattern = '%' . strtr($keyword, ['!' => '!!', '%' => '!%', '_' => '!_']) . '%';
                $search = "nickname LIKE :search_nickname ESCAPE '!' OR phone LIKE :search_phone ESCAPE '!' OR username LIKE :search_username ESCAPE '!'";
                $bindings = ['search_nickname' => $pattern, 'search_phone' => $pattern, 'search_username' => $pattern];
                if (strpbrk($keyword, '.:') !== false && preg_match('/\A[0-9a-f:.]+\z/i', $keyword)) {
                    // Match the same latest successful login used by the visible IP column.
                    // A scalar subquery keeps users and pagination unique, including users with no logins.
                    $latestIp = Db::name('login_logs')->alias('search_login')->field('search_login.ip')
                        ->whereColumn('search_login.user_id', 'search_user.id')->where('search_login.success', 1)
                        ->order('search_login.id', 'desc')->limit(1)->buildSql();
                    $search .= " OR register_ip LIKE :search_register_ip ESCAPE '!' OR {$latestIp} LIKE :search_login_ip ESCAPE '!'";
                    $ipPattern = filter_var($keyword, FILTER_VALIDATE_IP) !== false ? $keyword : $pattern;
                    $bindings['search_register_ip'] = $ipPattern;
                    $bindings['search_login_ip'] = $ipPattern;
                }
                $q->whereRaw($search, $bindings);
                $q->whereOr('public_id', $keyword);
                if (ctype_digit($keyword)) $q->whereOr('id', (int) $keyword);
            });
        }
        $userId = (int) $request->get('user_id', 0);
        if ($userId > 0) $query->where('id', $userId);
        $status = (string) $request->get('status', '');
        if (in_array($status, ['active', 'frozen', 'deleted'], true)) $query->where('status', $status);
        $rows = $query->paginate(['list_rows' => $size, 'page' => $page]);
        $details = $this->userDetails(array_column($rows->items(), 'id'));
        $items = array_map(fn (array $row): array => $this->formatUser($row, $details), $rows->items());
        return json(['ok' => true, 'data' => ['items' => $items, 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size]]);
    }

    public function ipLocations(Request $request)
    {
        $this->admin($request);
        $ips = $request->get('ips', []);
        if (!is_array($ips) || count($ips) > AdminIpLocationService::BATCH_SIZE) throw new RuntimeException('每次最多查询8个IP地址。');
        foreach ($ips as $ip) {
            if (!is_string($ip) || !filter_var($ip, FILTER_VALIDATE_IP)) throw new RuntimeException('IP地址格式不正确。');
        }
        return json(['ok' => true, 'data' => ['items' => (new AdminIpLocationService())->resolve($ips)]]);
    }

    public function create(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $username = $data['username'] ?? $data['account'] ?? '';
        if (!is_string($username) || !is_string($data['password'] ?? null)) throw new RuntimeException('用户名或密码格式不正确。');
        $username = trim($username);
        if ($username !== '') {
            \app\Service\RegistrationFormService::validateCredentials($username, $data['password']);
            $data['username'] = $username;
        }
        (new \app\Service\MediaAccessService())->assertAdminCanAttach(trim((string) ($data['avatar_url'] ?? '')), (new \app\Service\AdminAuthService())->authenticate($request));
        $user = Db::transaction(fn (): array => $this->createUser($data, (string) $request->ip()));
        $this->audit($request, 'user.create', (int) $user['id'], ['nickname' => $user['nickname']]);
        return json(['ok' => true, 'data' => $user], 201);
    }

    public function batchCreate(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        if (array_key_exists('prefix', $data) || array_key_exists('start', $data) || array_key_exists('count', $data)) {
            $prefix = is_string($data['prefix'] ?? null) ? trim($data['prefix']) : '';
            $start = filter_var($data['start'] ?? 1, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 999999999]]);
            $count = filter_var($data['count'] ?? 0, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 100]]);
            $password = is_string($data['password'] ?? null) ? $data['password'] : '';
            if (!preg_match('/^[A-Za-z][A-Za-z0-9_]{0,23}$/', $prefix)) throw new RuntimeException('账号前缀只能使用字母、数字或下划线，且必须以字母开头。');
            if ($start === false || $count === false) throw new RuntimeException('起始编号必须不小于1，创建数量必须在1到100之间。');
            if (strlen($password) < 8 || strlen($password) > 128) throw new RuntimeException('统一密码长度必须在8到128位之间。');
            $users = [];
            $seen = [];
            for ($offset = 0; $offset < $count; $offset++) {
                $username = $prefix . (string) ($start + $offset);
                if (strlen($username) > 32) throw new RuntimeException('生成的账号不能超过32位，请缩短前缀或调整起始编号。');
                if (isset($seen[$username]) || Db::name('users')->where('username', $username)->find()) throw new RuntimeException('账号已经存在：' . $username);
                $seen[$username] = true;
                $users[] = ['nickname' => $username, 'username' => $username, 'phone' => null, 'password' => $password];
            }
        } else {
            $users = $data['users'] ?? [];
        }
        if (!is_array($users) || count($users) < 1 || count($users) > 100) throw new RuntimeException('批量创建数量必须在1到100之间。');
        $account = (new \app\Service\AdminAuthService())->authenticate($request);
        foreach ($users as $item) {
            if (!is_array($item)) throw new RuntimeException('批量用户数据格式不正确。');
            (new \app\Service\MediaAccessService())->assertAdminCanAttach(trim((string) ($item['avatar_url'] ?? '')), $account);
        }
        $created = Db::transaction(function () use ($users, $request): array {
            $result = [];
            foreach ($users as $item) {
                if (!is_array($item)) throw new RuntimeException('批量用户数据格式不正确。');
                $result[] = $this->createUser($item, (string) $request->ip());
            }
            return $result;
        });
        $this->audit($request, 'user.batch_create', null, ['count' => count($created), 'prefix' => $data['prefix'] ?? null, 'start' => $data['start'] ?? null]);
        return json(['ok' => true, 'data' => ['items' => $created, 'count' => count($created)]], 201);
    }

    public function edit(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $userId = (int) ($data['user_id'] ?? 0);
        $this->findUser($userId);
        $update = [];
        if (array_key_exists('nickname', $data)) {
            $nickname = trim((string) $data['nickname']);
            if (mb_strlen($nickname) < 2 || mb_strlen($nickname) > 32) throw new RuntimeException('昵称长度必须为2到32个字符。');
            $update['nickname'] = $nickname;
        }
        if (array_key_exists('phone', $data)) {
            $phone = trim((string) $data['phone']);
            if ($phone !== '' && !preg_match('/^[0-9+ -]{6,32}$/', $phone)) throw new RuntimeException('账号格式不正确。');
            if ($phone !== '' && Db::name('users')->where('phone', $phone)->where('id', '<>', $userId)->find()) throw new RuntimeException('账号已经存在。');
            $update['phone'] = $phone !== '' ? $phone : null;
        }
        if (array_key_exists('avatar_url', $data)) {
            $avatar = trim((string) $data['avatar_url']);
            (new \app\Service\MediaAccessService())->assertAdminCanAttach($avatar, (new \app\Service\AdminAuthService())->authenticate($request));
            $update['avatar_url'] = $avatar ?: null;
        }
        if (!empty($data['password'])) {
            if (strlen((string) $data['password']) < 8 || strlen((string) $data['password']) > 128) throw new RuntimeException('密码长度必须为8到128个字符。');
            $update['password_hash'] = password_hash((string) $data['password'], PASSWORD_DEFAULT);
        }
        if ($update !== []) {
            $update['updated_at'] = date('Y-m-d H:i:s');
            Db::transaction(function () use ($userId, $update, $data): void {
                Db::name('users')->where('id', $userId)->update($update);
                if (isset($update['password_hash'])) {
                    (new \app\Service\UserPasswordVault())->captureRequired($userId, (string) $data['password'], $update['password_hash']);
                    Db::name('auth_tokens')->where('user_id', $userId)->delete();
                }
            });
        }
        $this->audit($request, 'user.edit', $userId, ['fields' => array_keys($update)]);
        return json(['ok' => true, 'data' => $this->formatUser($this->findUser($userId))]);
    }

    public function revealPassword(Request $request)
    {
        $this->admin($request);
        $account = (new \app\Service\AdminAuthService())->authenticate($request);
        if (($account['role'] ?? '') !== 'admin') throw new \think\exception\HttpResponseException(json(['ok' => false, 'error' => ['code' => 'FORBIDDEN', 'message' => '仅超级管理员可以查看当前密码。']], 403)->header(['Cache-Control' => 'no-store']));
        $data = $this->payload($request);
        $userId = filter_var($data['user_id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($userId === false || $userId === null) throw new RuntimeException('用户ID不正确。');
        $password = (new \app\Service\UserPasswordVault())->reveal($userId);
        // Audit must succeed before any plaintext is returned. Never include the password.
        $this->audit($request, 'user.password.reveal', $userId);
        return json(['ok' => true, 'data' => ['user_id' => $userId, 'password' => $password]])
            ->header(['Cache-Control' => 'no-store, private, max-age=0', 'Pragma' => 'no-cache', 'Expires' => '0']);
    }

    public function avatar(Request $request)
    {
        $this->admin($request);
        $file = $request->file('file');
        if (!$file || !$file->isValid()) throw new RuntimeException('头像文件不存在或上传失败。');
        $size = (int) $file->getSize();
        $extension = strtolower((string) $file->getOriginalExtension());
        $mime = strtolower((string) $file->getMime());
        if ($size <= 0 || $size > 5 * 1024 * 1024) throw new RuntimeException('头像大小不能超过5MB。');
        if (!in_array($extension, ['jpg', 'jpeg', 'png'], true)) throw new RuntimeException('头像格式必须为PNG、JPG或JPEG。');
        $realMime = $this->detectMime($file->getRealPath());
        if (!in_array($realMime, ['image/jpeg', 'image/png'], true) || @getimagesize($file->getRealPath()) === false) throw new RuntimeException('头像文件内容不是有效图片。');
        $relative = 'uploads/' . date('Y/m');
        $directory = app()->getRootPath() . 'public/storage/' . $relative;
        if (!is_dir($directory) && !mkdir($directory, 0755, true) && !is_dir($directory)) throw new RuntimeException('头像目录创建失败。');
        $name = bin2hex(random_bytes(16)) . '.' . $extension;
        $file->move($directory, $name);
        (new \app\Service\MediaAccessService())->recordUpload($relative . '/' . $name, null, 'avatar', (new \app\Service\AdminAuthService())->id($request));
        $baseUrl = rtrim((string) env('FILE_BASE_URL', '/storage'), '/');
        return json(['ok' => true, 'data' => ['url' => $baseUrl . '/' . $relative . '/' . $name, 'size' => $size, 'mime' => $mime]], 201);
    }

    public function status(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $userId = (int) ($data['user_id'] ?? 0);
        $status = (string) ($data['status'] ?? '');
        if ($userId <= 0 || !in_array($status, ['active', 'frozen'], true)) throw new RuntimeException('用户状态参数不正确。');
        $user = $this->findUser($userId);
        if ($user['status'] === 'deleted' && $status !== 'active') throw new RuntimeException('已删除用户只能恢复为正常状态。');
        Db::name('users')->where('id', $userId)->update(['status' => $status, 'updated_at' => date('Y-m-d H:i:s')]);
        if ($status === 'frozen') Db::name('auth_tokens')->where('user_id', $userId)->delete();
        $this->audit($request, 'user.status', $userId, ['status' => $status]);
        return json(['ok' => true, 'data' => ['user_id' => $userId, 'status' => $status]]);
    }

    public function permission(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $userId = (int) ($data['user_id'] ?? 0);
        $field = (string) ($data['field'] ?? '');
        if ($userId <= 0 || !in_array($field, self::PERMISSION_FIELDS, true)) throw new RuntimeException('用户权限参数不正确。');
        $this->findUser($userId);
        $value = filter_var($data['value'] ?? null, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
        if ($value === null) throw new RuntimeException('权限开关值不正确。');
        if ($field === 'internal_staff') {
            require_once dirname(__DIR__) . '/Service/MobileDeviceService.php';
            (new \app\Service\MobileDeviceService())->changeStaffStatus($userId, $value);
        } else $this->savePermissions($userId, [$field => $value ? 1 : 0]);
        $this->audit($request, 'user.permission', $userId, [$field => $value]);
        return json(['ok' => true, 'data' => ['user_id' => $userId, 'field' => $field, 'value' => $value]]);
    }

    public function clearChat(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $userId = (int) ($data['user_id'] ?? 0);
        $this->findUser($userId);
        // 清理聊天只对该用户生效：为该用户的每个会话写入历史水位，
        // 保留消息原文，避免误删其他成员仍然需要查看的消息。
        $members = Db::name('conversation_members')->where('user_id', $userId)->field('conversation_id,cleared_before_message_id')->select()->toArray();
        $cleared = 0;
        $hidden = 0;
        Db::transaction(function () use ($userId, $members, &$cleared, &$hidden): void {
            foreach ($members as $member) {
                $conversationId = (int) $member['conversation_id'];
                $lastMessageId = (int) Db::name('messages')->where('conversation_id', $conversationId)->max('id');
                $watermark = max($lastMessageId, (int) ($member['cleared_before_message_id'] ?? 0));
                if ($watermark > (int) ($member['cleared_before_message_id'] ?? 0)) {
                    Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->update(['cleared_before_message_id' => $watermark]);
                    $cleared++;
                }
                $hidden += (int) Db::name('messages')->where('conversation_id', $conversationId)->where('id', '<=', $watermark)->whereNull('recalled_at')->count();
            }
            \app\Service\ConversationReadProgress::forget($userId);
            Db::name('message_receipts')->where('user_id', $userId)->delete();
        });
        $this->audit($request, 'user.clear_chat', $userId, ['cleared_conversations' => $cleared, 'hidden_messages' => $hidden]);
        return json(['ok' => true, 'data' => ['user_id' => $userId, 'cleared_conversations' => $cleared, 'hidden_messages' => $hidden]]);
    }

    public function resetToken(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $userId = (int) ($data['user_id'] ?? 0);
        $this->findUser($userId);
        $deleted = Db::name('auth_tokens')->where('user_id', $userId)->delete();
        $this->audit($request, 'user.reset_token', $userId, ['revoked_tokens' => $deleted]);
        return json(['ok' => true, 'data' => ['user_id' => $userId, 'revoked_tokens' => $deleted]]);
    }

    public function logout(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $userId = (int) ($data['user_id'] ?? 0);
        $this->findUser($userId);
        $deleted = Db::name('auth_tokens')->where('user_id', $userId)->delete();
        $this->audit($request, 'user.logout', $userId, ['revoked_tokens' => $deleted]);
        return json(['ok' => true, 'data' => ['user_id' => $userId, 'revoked_tokens' => $deleted]]);
    }

    public function delete(Request $request)
    {
        $this->admin($request);
        $data = $this->payload($request);
        $userId = (int) ($data['user_id'] ?? 0);
        $this->findUser($userId);
        Db::transaction(function () use ($userId): void {
            Db::name('users')->where('id', $userId)->update(['status' => 'deleted', 'updated_at' => date('Y-m-d H:i:s')]);
            Db::name('user_password_vault')->where('user_id', $userId)->delete();
            Db::name('auth_tokens')->where('user_id', $userId)->delete();
            Db::name('user_presence')->where('user_id', $userId)->delete();
        });
        $this->audit($request, 'user.delete', $userId, ['soft_delete' => true]);
        return json(['ok' => true, 'data' => ['user_id' => $userId, 'status' => 'deleted']]);
    }

    public function devices(Request $request)
    {
        $this->admin($request);
        $userId = (int) $request->get('user_id', 0);
        $this->findUser($userId);
        $permission = $this->permissions($userId);
        if (!(int) $permission['allow_view_devices']) return json(['ok' => true, 'data' => ['hidden' => true, 'items' => []]]);
        $tokens = Db::name('auth_tokens')->where('user_id', $userId)->field('id,device_type,created_at,last_used_at,expires_at')->order('id', 'desc')->select()->toArray();
        $push = Db::name('notification_devices')->where('user_id', $userId)->field('id,platform,enabled,created_at,updated_at,last_used_at')->order('id', 'desc')->select()->toArray();
        return json(['ok' => true, 'data' => ['hidden' => false, 'items' => ['登录设备' => $tokens, '推送设备' => $push]]]);
    }

    private function createUser(array $data, string $ip): array
    {
        $username = trim((string) ($data['username'] ?? ''));
        $nickname = trim((string) ($data['nickname'] ?? ($username !== '' ? $username : '')));
        $phone = trim((string) ($data['phone'] ?? ''));
        $password = (string) ($data['password'] ?? '');
        if (mb_strlen($nickname) < 2 || mb_strlen($nickname) > 32) throw new RuntimeException('昵称长度必须为2到32个字符。');
        if ($username !== '' && !preg_match('/^[A-Za-z][A-Za-z0-9_]{1,31}$/', $username)) throw new RuntimeException('账号只能使用2到32位字母、数字或下划线，且必须以字母开头。');
        if ($phone !== '' && !preg_match('/^[0-9+ -]{6,32}$/', $phone)) throw new RuntimeException('手机号格式不正确。');
        if ($username === '' && $phone === '') throw new RuntimeException('账号不能为空。');
        if (strlen($password) < 8 || strlen($password) > 128) throw new RuntimeException('密码长度必须在8到128位之间。');
        if ($username !== '' && Db::name('users')->where('username', $username)->find()) throw new RuntimeException('账号已经存在。');
        if ($phone !== '' && Db::name('users')->where('phone', $phone)->find()) throw new RuntimeException('手机号已经存在。');
        $now = date('Y-m-d H:i:s');
        $avatar = trim((string) ($data['avatar_url'] ?? '')) ?: null;
        $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        $created = (new \app\Service\PublicUserIdService())->insertUser(['nickname' => $nickname, 'phone' => $phone !== '' ? $phone : null, 'username' => $username !== '' ? $username : null, 'password_hash' => $passwordHash, 'avatar_url' => $avatar, 'register_ip' => substr($ip, 0, 45) ?: null, 'status' => 'active', 'created_at' => $now, 'updated_at' => $now]);
        $id = $created['id'];
        Db::name('user_permissions')->insert(['user_id' => $id, 'muted' => 0, 'allow_add_friend' => 1, 'allow_create_group' => 0, 'internal_staff' => 0, 'formal_employee' => 0, 'allow_view_devices' => 0, 'updated_at' => $now]);
        (new \app\Service\UserPasswordVault())->captureRequired((int) $id, $password, $passwordHash);
        return ['id' => (int) $id, 'public_id' => $created['public_id'], 'nickname' => $nickname, 'username' => $username !== '' ? $username : null, 'account' => $username !== '' ? $username : $phone, 'phone' => $phone !== '' ? $phone : null, 'avatar_url' => $avatar, 'status' => 'active', 'created_at' => $now];
    }

    private function userDetails(array $ids): array
    {
        if ($ids === []) return ['logins' => [], 'presence' => [], 'tokens' => [], 'permissions' => []];
        // 查询次数与每页用户数无关；先聚合最新记录，避免关联多条登录记录造成重复用户。
        $latestLogins = Db::name('login_logs')->whereIn('user_id', $ids)->where('success', 1)->field('MAX(id) AS latest_id')->group('user_id')->select()->toArray();
        $loginIds = array_column($latestLogins, 'latest_id');
        $logins = $loginIds === [] ? [] : Db::name('login_logs')->whereIn('id', $loginIds)->field('user_id,ip,created_at,device_type')->select()->toArray();
        $presence = Db::name('user_presence')->whereIn('user_id', $ids)->field('user_id,last_seen_at')->select()->toArray();
        $tokens = Db::name('auth_tokens')->whereIn('user_id', $ids)->where('expires_at', '>', date('Y-m-d H:i:s'))->whereNotNull('last_used_at')->field('user_id,MAX(last_used_at) AS last_used_at')->group('user_id')->select()->toArray();
        $permissions = Db::name('user_permissions')->whereIn('user_id', $ids)->field('user_id,' . implode(',', self::PERMISSION_FIELDS))->select()->toArray();
        return ['logins' => array_column($logins, null, 'user_id'), 'presence' => array_column($presence, 'last_seen_at', 'user_id'), 'tokens' => array_column($tokens, 'last_used_at', 'user_id'), 'permissions' => array_column($permissions, null, 'user_id')];
    }

    private function formatUser(array $row, ?array $details = null): array
    {
        $userId = (int) $row['id'];
        $details ??= $this->userDetails([$userId]);
        $login = $details['logins'][$userId] ?? [];
        $presence = $details['presence'][$userId] ?? null;
        $tokenActivity = $details['tokens'][$userId] ?? null;
        $permission = $this->permissionDefaults($details['permissions'][$userId] ?? []);
        $registerIp = (string) ($row['register_ip'] ?? '');
        $loginIp = (string) ($login['ip'] ?? '');
        $registerLocation = $this->ipLocation($registerIp);
        $loginLocation = $this->ipLocation($loginIp);
        $activities = array_values(array_filter([(int) ($presence ? strtotime($presence) : 0), (int) ($tokenActivity ? strtotime($tokenActivity) : 0)]));
        $lastActivity = $activities === [] ? 0 : max($activities);
        return [
            'id' => $userId, 'member_id' => $userId, 'public_id' => $row['public_id'] ?? null, 'account' => $row['username'] ?: $row['phone'],
            'username' => $row['username'], 'phone' => $row['phone'], 'nickname' => $row['nickname'],
            'avatar_url' => $row['avatar_url'], 'status' => $row['status'], 'online' => $lastActivity >= time() - 60,
            'register_ip' => $registerIp ?: null, 'register_ip_location' => $registerLocation['location'],
            'register_ip_location_status' => $registerLocation['status'], 'register_ip_location_error_code' => $registerLocation['error_code'] ?? null,
            'login_ip' => $loginIp ?: null, 'login_ip_location' => $loginLocation['location'],
            'login_ip_location_status' => $loginLocation['status'], 'login_ip_location_error_code' => $loginLocation['error_code'] ?? null,
            'login_at' => $login['created_at'] ?? null, 'login_device' => $login['device_type'] ?? null,
            'registered_at' => $row['created_at'], 'created_at' => $row['created_at'], 'updated_at' => $row['updated_at'], 'permissions' => $permission,
        ];
    }

    private function permissions(int $userId): array
    {
        $row = Db::name('user_permissions')->where('user_id', $userId)->find();
        return $this->permissionDefaults($row ?? []);
    }

    private function permissionDefaults(array $row): array
    {
        return ['muted' => (int) ($row['muted'] ?? 0), 'allow_add_friend' => (int) ($row['allow_add_friend'] ?? 1), 'allow_create_group' => (int) ($row['allow_create_group'] ?? 1), 'internal_staff' => (int) ($row['internal_staff'] ?? 0), 'formal_employee' => (int) ($row['formal_employee'] ?? 0), 'allow_view_devices' => (int) ($row['allow_view_devices'] ?? 0)];
    }

    private function savePermissions(int $userId, array $values): void
    {
        $now = date('Y-m-d H:i:s');
        if (!Db::name('user_permissions')->where('user_id', $userId)->find()) Db::name('user_permissions')->insert(['user_id' => $userId, 'muted' => 0, 'allow_add_friend' => 1, 'allow_create_group' => 1, 'internal_staff' => 0, 'formal_employee' => 0, 'allow_view_devices' => 0, 'updated_at' => $now]);
        $values['updated_at'] = $now;
        Db::name('user_permissions')->where('user_id', $userId)->update($values);
    }

    private function findUser(int $userId): array
    {
        if ($userId <= 0) throw new RuntimeException('用户编号不正确。');
        $user = Db::name('users')->where('id', $userId)->find();
        if (!$user) throw new RuntimeException('用户不存在。');
        return $user;
    }

    private function ipLocation(string $ip): array
    {
        // 列表和资料保存只读取缓存；网络查询由前端独立补全，不能阻塞用户列表。
        return $this->locationCache[$ip] ??= (new AdminIpLocationService())->cached($ip);
    }

    private function detectMime(?string $path): string
    {
        if (!$path || !is_file($path) || !function_exists('finfo_open')) return '';
        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        if (!$finfo) return '';
        $mime = finfo_file($finfo, $path) ?: '';
        finfo_close($finfo);
        return strtolower($mime);
    }

    private function audit(Request $request, string $action, ?int $userId, array $detail = []): void
    {
        $payload = $this->payload($request);
        (new AuditService())->log($this->adminId($request), $action, 'user', $userId, (string) ($payload['request_id'] ?? ''), (string) $request->ip(), $detail);
    }

    private function admin(Request $request): void
    {
        (new \app\Service\AdminAuthService())->authorize($request);
    }

    private function adminId(Request $request): int { return (new \app\Service\AdminAuthService())->id($request); }

    private function payload(Request $request): array
    {
        $payload = $request->post();
        if ($payload !== []) return $payload;
        $decoded = json_decode(trim($request->getContent()), true);
        return is_array($decoded) ? $decoded : [];
    }
}
