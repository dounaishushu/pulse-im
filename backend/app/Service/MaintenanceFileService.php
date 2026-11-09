<?php
declare(strict_types=1);
namespace app\Service;

/** Only expired ThinkPHP file cache and dated application logs under runtime. */
final class MaintenanceFileService
{
    public function __construct(private ?string $runtime = null) { $this->runtime ??= app()->getRuntimePath(); }

    public function process(int $keepDays, bool $remove = false, ?int $now = null, ?callable $heartbeat = null): array
    {
        $now ??= time();
        $result = ['files' => 0, 'bytes' => 0, 'failed' => 0, 'scan_limited' => false];
        $runtime = realpath($this->runtime);
        if (!$runtime || is_link($this->runtime)) return $result;
        $visited = 0;
        $processed = 0;
        foreach (['cache', 'log'] as $kind) {
            $base = $runtime . DIRECTORY_SEPARATOR . $kind;
            if (!is_dir($base) || is_link($base) || realpath($base) !== $base) continue;
            foreach ($this->files($base, $visited, $result) as $path) {
                if (++$processed % 100 === 0 && $heartbeat && !$heartbeat()) throw new \RuntimeException('LEASE_LOST', 409);
                $relative = str_replace(DIRECTORY_SEPARATOR, '/', substr($path, strlen($base) + 1));
                $valid = $kind === 'cache'
                    ? preg_match('~^(?:[a-f0-9]{2}/)?[a-f0-9]{30,32}\.php$~D', $relative)
                    : preg_match('~^(?:\d{6}/\d{2}|\d{8})(?:_[a-zA-Z0-9_]+)?(?:-\d{10})?\.log$~D', $relative);
                if (!$valid || is_link($path) || !is_file($path)) continue;
                $handle = @fopen($path, 'rb');
                if (!$handle) continue;
                try {
                    if (!flock($handle, LOCK_EX | LOCK_NB)) continue;
                    $stat = fstat($handle); clearstatcache(true, $path); $current = @lstat($path);
                    if (!$stat || !$current || $stat['ino'] !== $current['ino'] || $stat['dev'] !== $current['dev']) continue;
                    if ($kind === 'cache') {
                        $header = fread($handle, 32);
                        if (!preg_match('~^<\?php\n//(\d{12})\n exit\(\);\?>\n$~D', $header, $match)) continue;
                        $ttl = (int) $match[1];
                        if ($ttl <= 0 || $stat['mtime'] + $ttl > $now - 60) continue;
                    } elseif ($stat['mtime'] >= $now - $keepDays * 86400) continue;
                    // Re-check the resolved pathname while holding the same file lock.
                    if (realpath($path) !== $path || !str_starts_with($path, $base . DIRECTORY_SEPARATOR)) continue;
                    if ($remove && !@unlink($path)) { $result['failed']++; continue; }
                    $result['files']++; $result['bytes'] += $stat['size'];
                    if ($result['files'] >= 5000) { $result['scan_limited'] = true; return $result; }
                } finally { fclose($handle); }
            }
        }
        return $result;
    }

    private function files(string $directory, int &$visited, array &$result, int $depth = 0): \Generator
    {
        if ($depth > 2) return;
        foreach (new \DirectoryIterator($directory) as $item) {
            if ($item->isDot()) continue;
            if (++$visited > 20000) { $result['scan_limited'] = true; return; }
            if ($item->isLink()) continue;
            if ($item->isDir()) yield from $this->files($item->getPathname(), $visited, $result, $depth + 1);
            elseif ($item->isFile()) yield $item->getPathname();
            if ($result['scan_limited']) return;
        }
    }
}
