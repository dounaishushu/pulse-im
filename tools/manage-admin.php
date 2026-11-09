<?php
// Credentials come from stdin or are generated; never accept passwords as command arguments.
require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();
$options = getopt('', ['username:', 'role::', 'status::', 'password-stdin', 'output::']);
if (empty($options['username'])) { fwrite(STDERR, "Usage: php tools/manage-admin.php --username=NAME --role=admin|operator|auditor [--status=disabled] [--password-stdin] [--output=PRIVATE_PATH]\n"); exit(2); }
$status = (string) ($options['status'] ?? 'active');
$password = isset($options['password-stdin']) ? rtrim(stream_get_contents(STDIN), "\r\n") : ($status === 'disabled' ? '' : bin2hex(random_bytes(16)) . 'Aa!');
$account = (new app\Service\AdminAuthService())->saveAccount((string) $options['username'], $password, (string) ($options['role'] ?? 'operator'), $status);
if ($password !== '' && !isset($options['password-stdin'])) {
    $path = (string) ($options['output'] ?? dirname(__DIR__) . '/backend/runtime/initial-admin-credentials.txt');
    file_put_contents($path, "管理员账号: {$account['username']}\n初始密码: {$password}\n角色: {$account['role']}\n请妥善保存，并在安全位置保存后删除此文件。\n", LOCK_EX);
    @chmod($path, 0600);
    echo 'Credentials saved to: ' . $path . PHP_EOL;
}
echo json_encode(['ok' => true, 'admin' => $account, 'previous_sessions_revoked' => true], JSON_UNESCAPED_UNICODE) . PHP_EOL;
