<?php
namespace app\Service;
use RuntimeException;
use think\facade\Db;

/** Secret hashes stay outside the publicly returned settings JSON. */
final class UserSecurityService
{
    public const REQUIRED = '请输入两步验证密码或恢复码。';
    public function status(int $id): array
    {
        $row = Db::name('user_security')->where('user_id', $id)->find();
        return ['enabled' => (bool) $row, 'recovery_codes_remaining' => $row ? count(json_decode($row['recovery_hashes'], true) ?: []) : 0];
    }
    public function verifyLogin(int $id, string $code): void
    {
        Db::transaction(function () use ($id, $code): void {
            $row = Db::name('user_security')->where('user_id', $id)->lock(true)->find();
            if (!$row) return;
            if ($code === '') throw new RuntimeException(self::REQUIRED);
            $this->verify($row, $code, true);
        });
    }
    public function update(int $id, string $action, string $loginPassword, string $current, string $next, bool $sessionAuthorized = false): array
    {
        if (!in_array($action, ['enable', 'change', 'disable', 'recovery'], true)) throw new RuntimeException('两步验证操作无效。');
        if (in_array($action, ['enable', 'change'], true) && (strlen($next) < 8 || strlen($next) > 128)) throw new RuntimeException('两步验证密码需要8到128个字符。');
        return Db::transaction(function () use ($id, $action, $loginPassword, $current, $next, $sessionAuthorized): array {
            $user = Db::name('users')->where('id', $id)->where('status', 'active')->lock(true)->find();
            if (!$user || (!$sessionAuthorized && !password_verify($loginPassword, $user['password_hash']))) throw new RuntimeException('登录密码不正确。');
            $failures = Db::name('login_logs')->where('user_id', $id)->where('success', 0)->where('created_at', '>=', date('Y-m-d H:i:s', time() - 900))->count();
            if ($failures >= 10) throw new RuntimeException('验证失败次数过多，请稍后再试。');
            $row = Db::name('user_security')->where('user_id', $id)->lock(true)->find();
            if ($action === 'enable' && $row) throw new RuntimeException('两步验证已开启，请使用修改密码。');
            if ($action !== 'enable' && !$row) throw new RuntimeException('两步验证尚未开启。');
            if ($row) $this->verify($row, $current, false);
            if ($action === 'disable') { Db::name('user_security')->where('user_id', $id)->delete(); return ['enabled' => false]; }
            $codes = []; $hashes = [];
            for ($i = 0; $i < 8; $i++) { $code = strtoupper(bin2hex(random_bytes(8))); $codes[] = $code; $hashes[] = hash('sha256', $code); }
            $data = ['two_step_hash' => $action === 'recovery' ? $row['two_step_hash'] : password_hash($next, PASSWORD_DEFAULT), 'recovery_hashes' => json_encode($hashes), 'updated_at' => date('Y-m-d H:i:s')];
            if ($row) Db::name('user_security')->where('user_id', $id)->update($data);
            else Db::name('user_security')->insert($data + ['user_id' => $id]);
            return ['enabled' => true, 'recovery_codes' => $codes];
        });
    }
    private function verify(array $row, string $code, bool $consume): void
    {
        if (password_verify($code, $row['two_step_hash'])) return;
        $hashes = json_decode($row['recovery_hashes'], true) ?: [];
        $index = array_search(hash('sha256', strtoupper(trim($code))), $hashes, true);
        if ($index === false) throw new RuntimeException('两步验证密码或恢复码不正确。');
        if ($consume) { unset($hashes[$index]); Db::name('user_security')->where('user_id', $row['user_id'])->update(['recovery_hashes' => json_encode(array_values($hashes))]); }
    }
}
