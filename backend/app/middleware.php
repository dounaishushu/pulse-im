<?php

require_once __DIR__ . '/middleware/AdminSecurity.php';
require_once __DIR__ . '/Service/RequestTrace.php';
require_once __DIR__ . '/middleware/RequestDiagnostics.php';
// 全局中间件定义文件
return [
    \app\middleware\RequestDiagnostics::class,
    \app\middleware\AdminSecurity::class,
    \app\middleware\OperationalSecurity::class,
    // 全局请求缓存
    // \think\middleware\CheckRequestCache::class,
    // 多语言加载
    // \think\middleware\LoadLangPack::class,
    // Session初始化
    // \think\middleware\SessionInit::class
];
