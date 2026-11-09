<?php
namespace app\Service;

/** Node-local readiness. This reports a role; it never promotes a database. */
final class RouteNodeStatus
{
    public function report(string $nonce): array
    {
        $cluster = (string) env('ROUTE_CLUSTER_ID', '');
        $ready = $cluster !== '' && (string) env('ROUTE_NODE_ROLE', 'active') === 'active';
        try {
            \think\facade\Db::query('SELECT 1');
            $flags = \think\facade\Db::query('SELECT @@global.read_only AS read_only');
            $ready = $ready && (int) ($flags[0]['read_only'] ?? 1) === 0;
            $storage = app()->getRootPath() . 'public/storage';
            $ready = $ready && $this->mediaReady($storage);
            if ((string) env('REALTIME_DRIVER', 'database') === 'redis') $ready = $ready && (new RedisTransport())->ping();
            $socket = @fsockopen((string) env('ROUTE_WS_CHECK_HOST', '127.0.0.1'), (int) env('ROUTE_WS_CHECK_PORT', 8282), $errno, $error, 0.5);
            $ready = $ready && $socket !== false;
            if (is_resource($socket)) fclose($socket);
            // An external HA controller can require a short, local writer lease.
            // The controller must fence the old writer before granting this lease.
            $gateFile = (string) env('ROUTE_WRITER_LEASE_FILE', '');
            if ($gateFile !== '') {
                $gate = is_file($gateFile) && filesize($gateFile) < 4096 ? json_decode(file_get_contents($gateFile), true) : null;
                $ready = $ready && is_array($gate) && ($gate['cluster_id'] ?? '') === $cluster && ($gate['writer'] ?? false) === true && ($gate['synced'] ?? false) === true && (int) ($gate['expires_at'] ?? 0) > time();
            }
        } catch (\Throwable) { $ready = false; }
        return ['cluster_id' => $cluster, 'ready' => $ready, 'nonce' => $nonce, 'time' => time()];
    }

    private function mediaReady(string $storage): bool
    {
        if (!is_dir($storage) || !is_readable($storage)) return false;
        // Match UploadController: the storage root can remain read-only while
        // uploads/YYYY/MM is writable. Check the directory that will receive
        // the file, or its nearest existing parent when creating a new month.
        $directory = $storage . '/uploads/' . date('Y/m');
        while (!is_dir($directory)) {
            if (file_exists($directory) || is_link($directory) || $directory === $storage) return false;
            $directory = dirname($directory);
        }
        return is_writable($directory);
    }
}
