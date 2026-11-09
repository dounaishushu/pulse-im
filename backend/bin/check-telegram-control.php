<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/app/Service/TelegramBotRuntime.php';
use app\Service\{AdminIpTelegramBot,TelegramBotRuntime};
use think\facade\Db;
try {
    (new think\App(dirname(__DIR__) . '/'))->initialize();
    $config = AdminIpTelegramBot::environment(); $errors = AdminIpTelegramBot::configErrors($config);
    if ($errors !== []) {
        echo json_encode(['ok'=>false,'error_number'=>'TG-CONFIG','config_fields'=>$errors,'credentials_printed'=>false]),PHP_EOL;exit(1);
    }
    $result = TelegramBotRuntime::databaseOperation(static function()use($config):array {
        Db::query('SELECT 1');
        // Zero-row reads validate required tables/columns without returning codes,
        // creating daily codes or changing application records.
        Db::name('work_tasks')->field('id,name,status,sort_order')->whereRaw('1=0')->select();
        Db::name('work_task_codes')->field('task_id,task_date,code')->whereRaw('1=0')->select();
        $entries = in_array(strtolower($config['TELEGRAM_ADMIN_ACCOUNTS_ENABLED'] ?? ''),['true','1'],true);
        if ($entries) {
            Db::name('admin_accounts')->field('id,username,status')->whereRaw('1=0')->select();
            Db::name('admin_account_entries')->field('admin_id,telegram_user_id,token_hash,token_salt,revoked_at')->whereRaw('1=0')->select();
        }
        return ['database_connection'=>true,'task_schema'=>true,'entry_schema_checked'=>$entries];
    });
    echo json_encode(['ok'=>true,'beijing_date'=>(new DateTimeImmutable('now',new DateTimeZone('Asia/Shanghai')))->format('Y-m-d'),
        'control_mode'=>($config['TELEGRAM_CONTROL_MODE'] ?? '') ?: 'http','codes_source'=>'current_backend_database',
        'records_modified'=>false,'credentials_printed'=>false,'telegram_messages_sent'=>false,'external_control_http_tested'=>false]+$result,JSON_UNESCAPED_SLASHES),PHP_EOL;
} catch(Throwable $error) {
    $number=TelegramBotRuntime::number($error);
    $suggestion=match($number){'TG-DB-CONNECTION'=>'检查数据库服务、连接配置和连接数。','TG-DB-SCHEMA'=>'任务或后台账号表结构缺失，请核对已安装迁移；不要清空数据库。',default=>'请按错误编号核对机器人服务日志。'};
    echo json_encode(['ok'=>false,'error_number'=>$number,'suggestion'=>$suggestion,'records_modified'=>false,'credentials_printed'=>false,'telegram_messages_sent'=>false],JSON_UNESCAPED_UNICODE),PHP_EOL;exit(1);
}
