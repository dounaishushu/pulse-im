<?php
// Additive migration. Existing users, messages, wallets and ledgers are retained.
require dirname(__DIR__) . '/backend/vendor/autoload.php';
$app = new think\App(dirname(__DIR__) . '/backend/');
$app->initialize();
use think\facade\Db;

$sql = file_get_contents(dirname(__DIR__) . '/database/migrations/20261015_admin_media_push.sql');
foreach (array_filter(array_map('trim', explode(';', $sql))) as $statement) Db::execute($statement);
$column = Db::query("SHOW COLUMNS FROM work_task_records LIKE 'reviewer_admin_id'");
if (!$column) Db::execute('ALTER TABLE work_task_records ADD reviewer_admin_id BIGINT UNSIGNED NULL AFTER reviewer_id');
$column = Db::query("SHOW COLUMNS FROM notification_devices LIKE 'auth_token_hash'");
if (!$column) Db::execute('ALTER TABLE notification_devices ADD auth_token_hash CHAR(64) NULL');
$column = Db::query("SHOW COLUMNS FROM push_cursor LIKE 'heartbeat_at'");
if (!$column) Db::execute('ALTER TABLE push_cursor ADD heartbeat_at DATETIME NULL');
$column = Db::query("SHOW COLUMNS FROM client_app_config LIKE 'pc_download_url'");
if (!$column) Db::execute("ALTER TABLE client_app_config ADD pc_download_url VARCHAR(2048) NOT NULL DEFAULT '' AFTER ios_download_url");
$status = Db::query("SHOW COLUMNS FROM conversations LIKE 'status'")[0]['Type'] ?? '';
if (!str_contains($status, "'deleted'")) Db::execute("ALTER TABLE conversations MODIFY status ENUM('active','disabled','deleted') NOT NULL DEFAULT 'active'");
$media = new app\Service\MediaAccessService();
$cursor = 0; $indexed = 0;
do {
    $messages = Db::name('messages')->where('id', '>', $cursor)->order('id')->limit(500)->field('id,body_json')->select()->toArray();
    foreach ($messages as $message) { $cursor = (int) $message['id']; $media->recordMessage($cursor, json_decode($message['body_json'], true) ?: []); $indexed++; }
} while (count($messages) === 500);
// Local secret initialization does not switch the development host into production.
$envPath = dirname(__DIR__) . '/backend/.env';
$envText = file_get_contents($envPath);
$envValues = parse_ini_file($envPath, false, INI_SCANNER_RAW) ?: [];
if (strlen((string) ($envValues['MEDIA_SIGNING_KEY'] ?? '')) < 32) {
    $line = 'MEDIA_SIGNING_KEY=' . bin2hex(random_bytes(32));
    $envText = preg_match('/^MEDIA_SIGNING_KEY=.*$/m', $envText) ? preg_replace('/^MEDIA_SIGNING_KEY=.*$/m', $line, $envText) : rtrim($envText) . PHP_EOL . $line . PHP_EOL;
    file_put_contents($envPath, $envText, LOCK_EX);
}
echo json_encode(['ok' => true, 'media_messages_indexed' => $indexed, 'history_preserved' => true], JSON_UNESCAPED_UNICODE) . PHP_EOL;
