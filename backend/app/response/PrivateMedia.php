<?php
namespace app\response;
use think\Response;

final class PrivateMedia extends Response
{
    public function __construct(private string $file, private int $offset, private int $length, int $status, array $headers, private bool $headOnly = false)
    {
        $this->init('', $status);
        $this->header($headers);
    }
    protected function sendData(string $data): void
    {
        if ($this->headOnly) return;
        $handle = fopen($this->file, 'rb');
        if (!$handle) return;
        try { fseek($handle, $this->offset); $remaining = $this->length; while ($remaining > 0 && !feof($handle) && !connection_aborted()) { $bytes = fread($handle, min(65536, $remaining)); if ($bytes === false || $bytes === '') break; echo $bytes; $remaining -= strlen($bytes); } }
        finally { fclose($handle); }
    }
}
