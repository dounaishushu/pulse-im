<?php

require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();

$sql = file_get_contents(dirname(__DIR__) . '/database/migrations/20261012_client_announcements.sql');
think\facade\Db::execute(explode(';', $sql, 2)[0]);
// Import the old environment notice once; re-running never overwrites admin edits or re-enables a disabled notice.
if (!think\facade\Db::name('client_announcements')->where('id', 1)->find()) {
    $legacy = trim((string) env('CLIENT_CHAT_NOTICE', ''));
    think\facade\Db::name('client_announcements')->insert([
        'id' => 1, 'title' => '官方提示',
        'content' => $legacy !== '' ? $legacy : "欢迎来到{app_name}！\n配置由后台系统管理 - 通知公告",
        'enabled' => $legacy !== '' ? 1 : 0, 'revision' => 1, 'updated_at' => date('Y-m-d H:i:s'),
    ]);
}
echo "通知公告数据库已就绪，已有配置保持不变。\n";
