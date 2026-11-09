<?php
require dirname(__DIR__) . '/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/'))->initialize();
use app\Service\AdminIpTelegramBot;
$config = AdminIpTelegramBot::environment(); $errors = AdminIpTelegramBot::configErrors($config);
if (!function_exists('curl_init')) $errors[] = 'PHP_cURL';
if ($errors !== []) { fwrite(STDERR, 'Bot configuration required: ' . implode(', ', $errors) . PHP_EOL); exit(1); }
if (in_array('--check', $argv, true)) { echo "Telegram IP bot configuration valid (no network requests made).\n"; exit(0); }
try { $bot = new AdminIpTelegramBot($config, app()->getRuntimePath() . 'admin-ip-telegram-bot'); }
catch (Throwable) { fwrite(STDERR, "Telegram IP bot cannot start; check private runtime state and single-worker lock.\n"); exit(1); }
$once = in_array('--once', $argv, true);
do {
    try { $bot->pollOnce(); }
    catch (Throwable) { fwrite(STDERR, "Telegram IP bot poll failed; remote details suppressed.\n"); if ($once) { $bot->close(); exit(1); } sleep(2); }
} while (!$once);
$bot->close();
