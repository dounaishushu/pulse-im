<?php
// Deployment configuration: copy to backend/config/cache.php on every API/WS node.
// Requires phpredis. This profile uses private TCP and password-only AUTH.
return [
    'default' => 'redis',
    'stores' => [
        'redis' => [
            'type' => 'Redis',
            'host' => env('REDIS_HOST', '127.0.0.1'),
            'port' => (int) env('REDIS_PORT', 6379),
            'password' => env('REDIS_PASSWORD', ''),
            'select' => 0,
            'timeout' => 2,
            'persistent' => false,
            'prefix' => 'pulse-im:cache:',
            'tag_prefix' => 'pulse-im:cache-tag:',
            'expire' => 0,
            'serialize' => [],
        ],
    ],
];
