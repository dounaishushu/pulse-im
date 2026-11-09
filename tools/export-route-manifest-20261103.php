<?php
declare(strict_types=1);
// Run only on the signing/control host. The output contains only a public signed policy.
$root = $argv[1] ?? dirname(__DIR__) . '/backend';
$output = '';
foreach ($argv as $argument) if (str_starts_with($argument, '--output=')) $output = substr($argument, 9);
if ($output === '' || !str_starts_with($output, '/')) throw new RuntimeException('Supply an absolute Linux --output path for the public signed policy.');
require rtrim($root, '/\\') . '/vendor/autoload.php';
(new think\App(rtrim($root, '/\\') . '/'))->initialize();
require_once rtrim($root, '/\\') . '/app/Service/ClientRouteService.php';
require_once rtrim($root, '/\\') . '/app/Service/ClientRouteManifest.php';
$envelope = (new app\Service\ClientRouteManifest())->get();
$bytes = json_encode(['ok' => true, 'data' => $envelope], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
$directory = dirname($output);
if (!is_dir($directory) || !is_writable($directory)) throw new RuntimeException('Output parent directory must already exist and be writable.');
$temporary = tempnam($directory, '.route-public-');
try {
    if (file_put_contents($temporary, $bytes, LOCK_EX) !== strlen($bytes)) throw new RuntimeException('Cannot write signed public policy.');
    chmod($temporary, 0644);
    if (!rename($temporary, $output)) throw new RuntimeException('Cannot atomically publish signed public policy.');
} finally { if (is_file($temporary)) unlink($temporary); }
echo json_encode(['ok' => true, 'public_output' => $output, 'bytes' => strlen($bytes), 'sha256' => hash('sha256', $bytes), 'private_key_exported' => false]) . "\n";
