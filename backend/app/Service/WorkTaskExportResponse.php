<?php
namespace app\Service;

/** Stream a completed private artifact; remove it even if the response is abandoned. */
final class WorkTaskExportResponse extends \think\Response
{
    private string $path;

    public function __construct(string $path, string $filename, int $count)
    {
        $this->path = $path;
        $this->init('', 200);
        $this->header(['Content-Type' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition' => 'attachment; filename="' . $filename . '"', 'Content-Length' => (string) filesize($path), 'Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff', 'X-Export-Count' => (string) $count]);
        register_shutdown_function(static function () use ($path): void { if (is_file($path)) @unlink($path); });
    }

    protected function sendData(string $data): void
    {
        $stream = fopen($this->path, 'rb');
        try {
            if ($stream === false) throw new \RuntimeException('导出文件不可读。');
            while (!feof($stream)) { $chunk = fread($stream, 65536); if ($chunk === false) throw new \RuntimeException('导出读取失败。'); echo $chunk; if (connection_aborted()) break; }
        } finally { if (is_resource($stream)) fclose($stream); $this->cleanup(); }
    }

    public function __destruct() { $this->cleanup(); }
    private function cleanup(): void { if (isset($this->path) && is_file($this->path)) @unlink($this->path); }
}
