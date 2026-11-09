<?php
declare (strict_types = 1);

namespace app;

use think\Service;

/**
 * 应用服务类
 */
class AppService extends Service
{
    public function register()
    {
        // Keep table-column metadata on this node. Shared application caches,
        // including sensitive-word invalidation, retain their existing driver.
        $cache = $this->app->config->get('cache');
        $cache['stores']['schema'] = [
            'type' => 'File',
            'path' => $this->app->getRuntimePath() . 'schema/',
            'expire' => 0,
        ];
        $this->app->config->set($cache, 'cache');
        $database = $this->app->config->get('database');
        $database['cache_store'] = 'schema';
        $this->app->config->set($database, 'database');
    }

    public function boot()
    {
        // 服务启动
    }
}
