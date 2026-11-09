<?php
declare(strict_types=1);

// Nginx and the local PHP router both use this entry, including for JS/CSS requests.
require_once dirname(__DIR__) . '/vendor/autoload.php';
$result = (new \app\Service\AdminAssetGateway(new \app\Service\AdminIpAccessService()))->handle($_SERVER);
http_response_code($result['status']);
foreach ($result['headers'] as $name => $value) header($name . ': ' . $value);
if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'HEAD') {
    if (isset($result['file'])) readfile($result['file']);
    else echo $result['body'];
}
