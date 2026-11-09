<?php
declare(strict_types=1);
require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();
set_exception_handler(static function (Throwable $error): void { fwrite(STDERR, 'Registration captcha migration failed: ' . get_class($error) . PHP_EOL); exit(1); });
foreach (explode(';', file_get_contents(dirname(__DIR__) . '/database/migrations/20261016_registration_captcha.sql')) as $statement) {
    if (trim($statement) !== '') think\facade\Db::execute(trim($statement));
}
echo "注册验证码共享挑战与原子限流表已就绪；现有账号及配置保持不变。\n";
