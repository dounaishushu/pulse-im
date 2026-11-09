<?php

namespace app\Service;

require_once __DIR__ . '/MobileDeviceService.php';
require_once __DIR__ . '/UserPasswordVault.php';

use RuntimeException;
use think\db\exception\PDOException;
use think\facade\Db;

final class AuthService
{
    public function register(string $nickname, string $phone, string $password, string $deviceType, string $ip = '', string $username = '', string $avatarUrl = '', bool $registrationAvatar = false, string $deviceId = '', string $deviceName = ''): array
    {
        if (MobileDeviceService::mobile($deviceType)) $deviceType = strtolower(trim($deviceType));
        $nickname = trim($nickname);
        $phone = trim($phone);
        $username = trim($username);
        $avatarUrl = trim($avatarUrl);
        $clientConfig = (new ClientConfigService())->get();
        if ($clientConfig['register_require_avatar'] && $avatarUrl === '') throw new RuntimeException('注册前必须上传头像。');
        if ($avatarUrl !== '' && !$this->isAllowedAvatarUrl($avatarUrl)) throw new RuntimeException('头像地址不正确。');
        // An anonymous registration may not publish a private message attachment as an avatar.
        $avatarPath = (new MediaAccessService())->pathFromUrl($avatarUrl);
        if ($avatarPath !== null && !$registrationAvatar) throw new RuntimeException('请使用默认头像完成注册，再登录上传自己的头像。');
        // Only RegistrationFormService may pass its freshly encoded local file.
        // No HTTP flag or supplied avatar URL can opt into this path.
        if ($registrationAvatar && ($avatarPath === null || !str_starts_with($avatarPath, 'uploads/') || !is_file(app()->getRootPath() . 'public/storage/' . $avatarPath))) throw new RuntimeException('注册头像尚未保存，请重试。');
        if ($clientConfig['max_register_accounts_per_ip'] > 0 && $ip !== '') {
            $registered = (int) Db::name('users')->where('register_ip', substr($ip, 0, 45))->count();
            if ($registered >= $clientConfig['max_register_accounts_per_ip']) {
                $displayIp = filter_var($ip, FILTER_VALIDATE_IP) ? $ip : '无法识别';
                throw new RuntimeException("当前IP注册账号数量已达到上限。\n当前IP：" . $displayIp);
            }
        }
        if (mb_strlen($nickname) < 2 || mb_strlen($nickname) > 32) {
            throw new RuntimeException('昵称长度必须为 2 到 32 个字符。');
        }
        if ($username !== '') {
            if (!preg_match('/^[A-Za-z][A-Za-z0-9]{4,31}$/D', $username)) {
                throw new RuntimeException('账号需要 5 到 32 位，以字母开头，只能包含字母和数字。');
            }
            if (strlen($password) < 8 || strlen($password) > 16 || !preg_match('/[A-Za-z]/', $password) || !preg_match('/[0-9]/', $password) || preg_match('/\s/', $password)) {
                throw new RuntimeException('密码需要 8 到 16 位，必须包含字母和数字，不能包含空格。');
            }
            if (Db::name('users')->where('username', $username)->find()) {
                throw new RuntimeException('账号已经注册，请更换账号或直接登录。');
            }
        } elseif (!preg_match('/^[0-9+ -]{6,32}$/D', $phone) || strlen($password) < 8) {
            throw new RuntimeException('手机号或密码格式不正确。');
        }
        if ($phone !== '' && !preg_match('/^[0-9+ -]{6,32}$/D', $phone)) {
            throw new RuntimeException('手机号格式不正确。');
        }
        if ($phone !== '' && Db::name('users')->where('phone', $phone)->find()) {
            throw new RuntimeException('手机号已经注册。');
        }

        // 哈希在事务外计算，避免密码计算期间占用数据库事务。
        $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        try {
            $result = Db::transaction(function () use ($nickname, $phone, $username, $avatarUrl, $avatarPath, $registrationAvatar, $password, $passwordHash, $deviceType, $ip, $deviceId, $deviceName): array {
                $devicePolicy = (new MobileDeviceService())->lockPolicy($deviceType);
                $now = date('Y-m-d H:i:s');
                $created = (new PublicUserIdService())->insertUser([
                    'nickname' => $nickname,
                    'phone' => $phone !== '' ? $phone : null,
                    'username' => $username !== '' ? $username : null,
                    'password_hash' => $passwordHash,
                    'avatar_url' => $avatarUrl !== '' ? $avatarUrl : null,
                    'status' => 'active',
                    'register_ip' => substr($ip, 0, 45) ?: null,
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
                $userId = $created['id'];
                if ($registrationAvatar) (new MediaAccessService())->recordUpload($avatarPath, $userId, 'image');
                Db::name('user_permissions')->insert(['user_id' => $userId, 'muted' => 0, 'allow_add_friend' => 1, 'allow_create_group' => 0, 'internal_staff' => 0, 'formal_employee' => 0, 'allow_view_devices' => 0, 'updated_at' => $now]);
                (new UserPasswordVault())->captureRequired((int) $userId, $password, $passwordHash);
                return $this->issueToken($userId, $deviceType, $username !== '' ? $username : $phone, $ip, $created['public_id'], $deviceId, $deviceName, $devicePolicy);
            });
            return $result;
        } catch (PDOException $error) {
            $info = $error->getData()['PDO Error Info'] ?? [];
            // 唯一索引处理并发注册同一账号，返回可以直接展示的业务错误。
            if ((int) ($info['Driver Error Code'] ?? 0) === 1062 && str_contains((string) ($info['Driver Error Message'] ?? ''), 'uk_user_username')) {
                throw new RuntimeException('账号已经注册，请更换账号或直接登录。', 0, $error);
            }
            throw $error;
        }
    }

    public function login(string $phone, string $password, string $deviceType, string $ip = '', string $twoStepCode = '', string $deviceId = '', string $deviceName = ''): array
    {
        if (MobileDeviceService::mobile($deviceType)) $deviceType = strtolower(trim($deviceType));
        $this->assertLoginAllowed($phone, $ip);
        $user = Db::name('users')->where(function ($query) use ($phone): void {
            $query->where('phone', $phone)->whereOr('username', $phone);
        })->find();
        if (!$user || $user['status'] !== 'active' || !password_verify($password, $user['password_hash'])) {
            Db::name('login_logs')->insert(['user_id' => $user ? (int) $user['id'] : null, 'phone' => $phone, 'device_type' => substr($deviceType ?: 'unknown', 0, 20), 'ip' => substr($ip, 0, 45), 'success' => 0, 'created_at' => date('Y-m-d H:i:s')]);
            throw new RuntimeException('手机号或密码错误。');
        }
        try { $result = Db::transaction(function () use ($user, $phone, $deviceType, $ip, $twoStepCode, $deviceId, $deviceName): array {
        $devicePolicy = (new MobileDeviceService())->lockPolicy($deviceType);
        $current = Db::name('users')->where('id', $user['id'])->where('status', 'active')->lock(true)->find();
        if (!$current || $current['password_hash'] !== $user['password_hash']) throw new RuntimeException('登录资料已变更，请重新登录。');
        (new UserSecurityService())->verifyLogin((int) $user['id'], $twoStepCode);
        if (!Db::name('user_permissions')->where('user_id', (int) $user['id'])->find()) {
            Db::name('user_permissions')->insert(['user_id' => (int) $user['id'], 'muted' => 0, 'allow_add_friend' => 1, 'allow_create_group' => 1, 'internal_staff' => 0, 'formal_employee' => 0, 'allow_view_devices' => 0, 'updated_at' => date('Y-m-d H:i:s')]);
        }
        return $this->issueToken((int) $user['id'], $deviceType, $phone, $ip, (string) ($current['public_id'] ?? ''), $deviceId, $deviceName, $devicePolicy);
        }); } catch (RuntimeException $error) {
            if (!in_array($error->getMessage(), [UserSecurityService::REQUIRED, MobileDeviceService::LOCKED, MobileDeviceService::UPDATE_REQUIRED], true)) Db::name('login_logs')->insert(['user_id' => (int) $user['id'], 'phone' => $phone, 'device_type' => substr($deviceType ?: 'unknown', 0, 20), 'ip' => substr($ip, 0, 45), 'success' => 0, 'created_at' => date('Y-m-d H:i:s')]);
            throw $error;
        }
        (new UserPasswordVault())->captureVerified((int) $result['user_id'], $password, $user['password_hash']);
        return $result;
    }

    private function assertLoginAllowed(string $phone, string $ip): void
    {
        $windowSeconds = max(60, (int) env('LOGIN_RATE_WINDOW', 900));
        $limit = max(3, (int) env('LOGIN_RATE_LIMIT', 10));
        $since = date('Y-m-d H:i:s', time() - $windowSeconds);
        $phoneFailures = $phone !== ''
            ? (int) Db::name('login_logs')->where('phone', substr($phone, 0, 32))->where('success', 0)->where('created_at', '>=', $since)->count()
            : 0;
        $ipFailures = $ip !== ''
            ? (int) Db::name('login_logs')->where('ip', substr($ip, 0, 45))->where('success', 0)->where('created_at', '>=', $since)->count()
            : 0;
        if ($phoneFailures >= $limit || $ipFailures >= $limit) {
            throw new RuntimeException('登录失败次数过多，请稍后再试。');
        }
    }

    public function userByToken(string $token): array
    {
        if ($token === '') throw new RuntimeException('请先登录。');
        // HTTP authentication is a point-in-time read, not a write transaction.
        // One fresh join avoids holding the account row across several network
        // round trips on every history/list request. Mutating services recheck
        // their current permissions under their own write locks.
        $pdo = Db::connect()->getPdo();
        if ($pdo instanceof \PDO && $pdo->inTransaction()) return $this->userByTokenLocked($token);
        $hash = hash('sha256', $token);
        $user = Db::name('auth_tokens')->alias('t')->join('users u', 'u.id=t.user_id')->leftJoin('user_permissions p', 'p.user_id=u.id')
            ->where('t.token_hash', $hash)->where('t.expires_at', '>', date('Y-m-d H:i:s'))
            ->field('u.*,t.id AS __auth_session_id,t.last_used_at AS __auth_last_used_at,p.internal_staff,p.formal_employee')->find();
        if (!$user) throw new RuntimeException('登录状态已过期，请重新登录。');
        if ($user['status'] !== 'active') throw new RuntimeException('用户账号不可用。');
        $this->touchSessionActivity(['id' => $user['__auth_session_id'], 'last_used_at' => $user['__auth_last_used_at']], $hash);
        $user['internal_staff'] = (bool) ($user['internal_staff'] ?? false);
        $user['formal_employee'] = (bool) ($user['formal_employee'] ?? false);
        unset($user['password_hash'], $user['__auth_session_id'], $user['__auth_last_used_at']);
        return $user;
    }

    /** Nested callers retain current locking reads rather than an old RR snapshot. */
    private function userByTokenLocked(string $token): array
    {
        return Db::transaction(function () use ($token): array {
        if ($token === '') {
            throw new RuntimeException('请先登录。');
        }
        $row = Db::name('auth_tokens')->where('token_hash', hash('sha256', $token))->find();
        if (!$row || strtotime($row['expires_at']) <= time()) {
            throw new RuntimeException('登录状态已过期，请重新登录。');
        }
        $user = Db::name('users')->where('id', $row['user_id'])->lock(true)->find();
        if (!$user || $user['status'] !== 'active') {
            throw new RuntimeException('用户账号不可用。');
        }
        if (!Db::name('auth_tokens')->where('id', $row['id'])->where('expires_at', '>', date('Y-m-d H:i:s'))->find()) throw new RuntimeException('登录状态已过期，请重新登录。');
        $this->touchSessionActivity($row, hash('sha256', $token));
        $permission = Db::name('user_permissions')->where('user_id', (int) $user['id'])->field('internal_staff,formal_employee')->find();
        $user['internal_staff'] = (bool) ($permission['internal_staff'] ?? false);
        $user['formal_employee'] = (bool) ($permission['formal_employee'] ?? false);
        unset($user['password_hash']);
        return $user;
        });
    }

    private function touchSessionActivity(array $row, string $hash): void
    {
        // Activity is display metadata. Conditional writes also prevent two
        // concurrent readers from updating it again, or touching a rotated token.
        $activityCutoff = date('Y-m-d H:i:s', time() - 60);
        if (empty($row['last_used_at']) || $row['last_used_at'] <= $activityCutoff) {
            Db::name('auth_tokens')->where('id', $row['id'])->where('token_hash', $hash)->where('expires_at', '>', date('Y-m-d H:i:s'))->where(function ($query) use ($activityCutoff): void {
                $query->whereNull('last_used_at')->whereOr('last_used_at', '<=', $activityCutoff);
            })->update(['last_used_at' => date('Y-m-d H:i:s')]);
        }
    }

    public function assertInternalStaff(int $userId): void
    {
        if (!$this->isInternalStaff($userId)) {
            throw new RuntimeException('无权使用内部人员功能。');
        }
    }

    public function isInternalStaff(int $userId): bool
    {
        return $userId > 0 && (bool) Db::name('user_permissions')->where('user_id', $userId)->value('internal_staff');
    }

    public function updateProfile(int $userId, array $profile): array
    {
        return Db::transaction(function () use ($userId, $profile): array {
        $current = Db::name('users')->where('id', $userId)->where('status', 'active')->lock(true)->find();
        if (!$current) throw new RuntimeException('用户账号不可用。');
        $nickname = trim((string) ($profile['nickname'] ?? $current['nickname']));
        $currentUsername = trim((string) ($current['username'] ?? ''));
        $username = trim((string) ($profile['username'] ?? $currentUsername));
        $currentBirthday = trim((string) ($current['birthday'] ?? ''));
        $birthday = trim((string) ($profile['birthday'] ?? $currentBirthday));
        $birthdayChangeCount = (int) ($current['birthday_change_count'] ?? 0);
        $gender = trim((string) ($profile['gender'] ?? ($current['gender'] ?? '')));
        $signature = trim((string) ($profile['signature'] ?? ($current['signature'] ?? '')));
        $avatarUrl = trim((string) ($profile['avatar_url'] ?? ($current['avatar_url'] ?? '')));
        if (mb_strlen($nickname) < 2 || mb_strlen($nickname) > 32) throw new RuntimeException('昵称长度必须为 2 到 32 个字符。');
        if ($currentUsername !== '' && array_key_exists('username', $profile) && $username !== $currentUsername) throw new RuntimeException('账号设置后不能再次修改。');
        if ($username !== '' && !preg_match('/^[A-Za-z0-9_]{2,32}$/', $username)) throw new RuntimeException('账号只能使用 2 到 32 位字母、数字或下划线。');
        if ($username !== '' && Db::name('users')->where('username', $username)->where('id', '<>', $userId)->find()) throw new RuntimeException('这个账号已经被使用。');
        if ($birthday !== '') {
            $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $birthday);
            if (!$date || $date->format('Y-m-d') !== $birthday || $birthday > date('Y-m-d')) throw new RuntimeException('生日格式不正确或晚于今天。');
        }
        if (array_key_exists('birthday', $profile) && $birthday !== $currentBirthday) {
            if ($birthdayChangeCount >= 1) throw new RuntimeException('生日只能修改一次，不能再次修改。');
            if ($currentBirthday !== '') $birthdayChangeCount = 1;
        }
        if ($gender !== '' && !in_array($gender, ['男', '女', '保密'], true)) throw new RuntimeException('性别选项不正确。');
        if (mb_strlen($signature) > 70) throw new RuntimeException('个性签名最多 70 个字符。');
        if ($avatarUrl !== '' && !$this->isAllowedAvatarUrl($avatarUrl)) throw new RuntimeException('头像地址不正确。');
        if ($avatarUrl !== '' && $avatarUrl !== ($current['avatar_url'] ?? '')) (new MediaAccessService())->assertCanAttach($avatarUrl, $userId);
        $updated = Db::name('users')->where('id', $userId)->where('status', 'active')->update([
            'nickname' => $nickname,
            'username' => $username !== '' ? $username : null,
            'birthday' => $birthday !== '' ? $birthday : null,
            'birthday_change_count' => $birthdayChangeCount,
            'gender' => $gender !== '' ? $gender : null,
            'signature' => $signature !== '' ? $signature : null,
            'avatar_url' => $avatarUrl !== '' ? $avatarUrl : null,
            'updated_at' => date('Y-m-d H:i:s'),
        ]);
        if (!$updated) {
            $exists = Db::name('users')->where('id', $userId)->where('status', 'active')->find();
            if (!$exists) throw new RuntimeException('用户账号不可用。');
        }
        $user = Db::name('users')->where('id', $userId)->field('id,public_id,nickname,phone,username,birthday,birthday_change_count,gender,signature,avatar_url,status,created_at,updated_at')->find();
        if (!$user) throw new RuntimeException('用户账号不可用。');
        return $user;
        });
    }

    public function changePassword(int $userId, string $currentPassword, string $newPassword): array
    {
        if (strlen($newPassword) < 8 || strlen($newPassword) > 128) throw new RuntimeException('New password must contain 8 to 128 characters.');
        $user = Db::name('users')->where('id', $userId)->where('status', 'active')->find();
        if (!$user || !password_verify($currentPassword, $user['password_hash'])) throw new RuntimeException('Current password is incorrect.');
        $newHash = password_hash($newPassword, PASSWORD_DEFAULT);
        Db::transaction(function () use ($userId, $user, $newPassword, $newHash): void {
            $current = Db::name('users')->where('id', $userId)->where('status', 'active')->lock(true)->find();
            if (!$current || !hash_equals((string) $user['password_hash'], (string) $current['password_hash'])) throw new RuntimeException('登录资料已变更，请重新登录。');
            Db::name('users')->where('id', $userId)->update(['password_hash' => $newHash, 'updated_at' => date('Y-m-d H:i:s')]);
            (new UserPasswordVault())->captureRequired($userId, $newPassword, $newHash);
            Db::name('auth_tokens')->where('user_id', $userId)->delete();
        });
        return ['user_id' => $userId, 'status' => 'password_changed', 'sessions_revoked' => true];
    }

    public function sessions(int $userId, string $currentToken): array
    {
        $rows = Db::name('auth_tokens')->where('user_id', $userId)->field('id,device_type,created_at,last_used_at,expires_at')->order('id', 'desc')->select()->toArray();
        $hash = hash('sha256', $currentToken);
        $current = Db::name('auth_tokens')->where('user_id', $userId)->where('token_hash', $hash)->value('id');
        return ['items' => array_map(static fn (array $row): array => $row + ['is_current' => (int) $row['id'] === (int) $current], $rows)];
    }

    public function revokeSession(int $userId, int $sessionId): array
    {
        if ($sessionId <= 0 || !Db::name('auth_tokens')->where('id', $sessionId)->where('user_id', $userId)->find()) throw new RuntimeException('Session not found.');
        Db::name('auth_tokens')->where('id', $sessionId)->where('user_id', $userId)->delete();
        return ['session_id' => $sessionId, 'status' => 'revoked'];
    }

    public function logout(string $token): array
    {
        if ($token === '') throw new RuntimeException('Authentication required.');
        $deleted = Db::name('auth_tokens')->where('token_hash', hash('sha256', $token))->delete();
        return ['status' => $deleted ? 'logged_out' : 'already_logged_out'];
    }

    private function issueToken(int $userId, string $deviceType, string $account, string $ip, string $publicId, string $deviceId = '', string $deviceName = '', ?array $devicePolicy = null): array
    {
        if (!PublicUserIdService::valid($publicId)) throw new RuntimeException('公开用户ID尚未就绪，请联系管理员完成升级。');
        (new MobileDeviceService())->bindLogin($userId, $deviceType, $deviceId, $deviceName, $devicePolicy);
        $token = bin2hex(random_bytes(32));
        $now = date('Y-m-d H:i:s');
        Db::name('auth_tokens')->insert([
            'user_id' => $userId,
            'token_hash' => hash('sha256', $token),
            'device_type' => substr($deviceType ?: 'unknown', 0, 20),
            'expires_at' => date('Y-m-d H:i:s', time() + 60 * 60 * 24 * 30),
            'created_at' => $now,
            'last_used_at' => $now,
        ]);
        // Registration returns an authenticated session too. Keep its successful
        // login record and token in the caller's transaction, just like password login.
        Db::name('login_logs')->insert([
            'user_id' => $userId,
            'phone' => substr($account, 0, 32),
            'device_type' => substr($deviceType ?: 'unknown', 0, 20),
            'ip' => substr($ip, 0, 45),
            'success' => 1,
            'created_at' => $now,
        ]);
        return ['user_id' => $userId, 'public_id' => $publicId, 'access_token' => $token, 'token_type' => 'Bearer', 'expires_in' => 2592000];
    }

    private function isAllowedAvatarUrl(string $value): bool
    {
        if (filter_var($value, FILTER_VALIDATE_URL) && preg_match('~^https?://~i', $value)) return true;
        // 宝塔部署默认使用同域相对地址，例如 /storage/uploads/2026/10/xxx.jpg。
        return preg_match('~^/storage/uploads/[0-9]{4}/(?:0[1-9]|1[0-2])/[a-f0-9]{32}\.(jpg|jpeg|png|gif|webp)$~D', $value) === 1;
    }
}
