<?php
declare(strict_types=1);
namespace app\Service;

require_once __DIR__ . '/UserPasswordCipher.php';

use RuntimeException;
use think\facade\Db;

final class UserPasswordVault
{
    public const MISSING = '该账号尚未保存可查看的原密码，旧的密码哈希无法还原。请使用密码成功登录一次，或重新设置密码后再查看。';
    private UserPasswordCipher $cipher;
    private string $lastFailure = 'PV_STORE_ERROR';
    public const REVISION = '20261106-password-web-runtime-v2';

    public function __construct(?UserPasswordCipher $cipher = null) { $this->cipher = $cipher ?? new UserPasswordCipher(); }

    /** New accounts and password changes commit together with their readable record. */
    public function captureRequired(int $userId, #[\SensitiveParameter] string $password, string $verifiedHash): void
    {
        if (!$this->captureVerified($userId, $password, $verifiedHash)) throw new RuntimeException('密码记录保存失败（' . $this->lastFailure . '），请联系管理员。本次注册或密码修改未完成。');
    }

    /** Only call after verifying this password, or hashing it for a committed change. */
    public function captureVerified(int $userId, #[\SensitiveParameter] string $password, string $verifiedHash): bool
    {
        $stage = 'PV_TABLE_READ'; $this->lastFailure = 'PV_STORE_ERROR';
        try {
            if ($userId <= 0 || $verifiedHash === '') { $this->lastFailure = 'PV_ACCOUNT_CONFLICT'; return false; }
            $digest = hash('sha256', $verifiedHash);
            $old = Db::name('user_password_vault')->where('user_id', $userId)->find();
            if ($old && hash_equals($digest, (string) $old['password_digest'])) {
                // Validate an existing record so a subsequent login repairs damaged ciphertext.
                try { if (hash_equals($password, $this->cipher->open($userId, $old['encrypted_password'], $verifiedHash))) return true; } catch (\Throwable) {}
            }
            $stage = 'PV_CIPHER_ERROR';
            $encrypted = $this->cipher->seal($userId, $password, $verifiedHash);
            $stage = 'PV_TABLE_WRITE';
            return Db::transaction(function () use ($userId, $verifiedHash, $digest, $encrypted): bool {
                // This ordering also prevents an old login from replacing a newer password change.
                $user = Db::name('users')->where('id', $userId)->lock(true)->find();
                if (!$user || $user['status'] === 'deleted' || !hash_equals((string) $user['password_hash'], $verifiedHash)) { $this->lastFailure = 'PV_ACCOUNT_CONFLICT'; return false; }
                $data = ['password_digest' => $digest, 'encrypted_password' => $encrypted, 'updated_at' => date('Y-m-d H:i:s')];
                if (Db::name('user_password_vault')->where('user_id', $userId)->find()) Db::name('user_password_vault')->where('user_id', $userId)->update($data);
                else Db::name('user_password_vault')->insert(['user_id' => $userId] + $data);
                return true;
            });
        } catch (\Throwable $error) {
            // Existing logins can continue; captureRequired makes writes atomic.
            // Never log the password, key, exception message, arguments, or SQL.
            $this->lastFailure = in_array($error->getCode(), [7101, 7102, 7103], true) ? UserPasswordCipher::failureReason($error) : $stage;
            error_log('User password vault write unavailable; user_id=' . $userId . '; reason=' . $this->lastFailure . '; error_type=' . get_class($error));
            return false;
        }
    }

    /** Non-destructive check from the actual web worker; never reads a real password. */
    public function readiness(): array
    {
        $result = $this->cipher->readiness();
        if ($result['status'] === 'up') {
            try { Db::name('user_password_vault')->field('user_id,password_digest,encrypted_password,updated_at')->whereRaw('1=0')->select(); }
            catch (\Throwable) { $result = ['status' => 'down', 'reason' => 'PV_TABLE_READ']; }
        }
        if ($result['status'] === 'up') {
            try {
                $table = Db::name('user_password_vault')->getTable();
                if (!preg_match('/^[A-Za-z0-9_]+$/D', $table)) throw new RuntimeException('Invalid vault table');
                // Zero-row statements check the actual connection's INSERT/UPDATE
                // permissions; they never create or change a password record.
                Db::execute("INSERT INTO `{$table}` (user_id,password_digest,encrypted_password,updated_at) SELECT 0,'','','2000-01-01 00:00:00' WHERE 1=0");
                Db::execute("UPDATE `{$table}` SET encrypted_password=encrypted_password WHERE 1=0");
            } catch (\Throwable) { $result = ['status' => 'down', 'reason' => 'PV_TABLE_WRITE']; }
        }
        return $result + ['revision' => self::REVISION];
    }

    public function reveal(int $userId): string
    {
        if ($userId <= 0) throw new RuntimeException('用户ID不正确。');
        return Db::transaction(function () use ($userId): string {
            $user = Db::name('users')->where('id', $userId)->lock(true)->find();
            if (!$user || $user['status'] === 'deleted') throw new RuntimeException('用户账号不可用。');
            $row = Db::name('user_password_vault')->where('user_id', $userId)->find();
            if (!$row || !hash_equals(hash('sha256', (string) $user['password_hash']), (string) $row['password_digest'])) throw new RuntimeException(self::MISSING);
            return $this->cipher->open($userId, $row['encrypted_password'], $user['password_hash']);
        });
    }
}
