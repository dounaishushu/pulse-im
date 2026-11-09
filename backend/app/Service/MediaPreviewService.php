<?php
namespace app\Service;

/** Called only after the original file's grant and current read access pass.
 * Preview files stay outside public/storage and never replace original uploads. */
final class MediaPreviewService
{
    public const PIXELS = 640;
    public function __construct(private ?string $directory = null) {}

    public static function available(): bool
    {
        return extension_loaded('gd') && function_exists('imagecreatetruecolor') && function_exists('imagejpeg');
    }

    public function file(string $original): string
    {
        if (!self::available()) return $original;
        $info = @getimagesize($original);
        $bytes = @filesize($original);
        if (!$info || !$bytes || $bytes > 32 * 1024 * 1024 || !in_array($info[2], [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_GIF, IMAGETYPE_WEBP], true)) return $original;
        if ($info[2] === IMAGETYPE_JPEG && !function_exists('exif_read_data')) return $original;
        // Do not upscale or re-encode a photo which is already a small preview.
        if (max($info[0], $info[1]) <= self::PIXELS && $bytes <= 160 * 1024) return $original;
        $pixels = (float) $info[0] * $info[1];
        $limit = $this->memoryLimit();
        if ($pixels > 40_000_000 || ($limit > 0 && memory_get_usage(true) + $pixels * 6 + 20 * 1024 * 1024 > $limit)) return $original;
        $directory = $this->directory ?? app()->getRuntimePath() . 'media-previews-v1';
        if (is_link($directory) || (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory))) return $original;
        // Only a content identity is stored, never the signed URL or a session token.
        $key = hash('sha256', $original . '|' . $bytes . '|' . filemtime($original) . '|preview-640-v1');
        $target = $directory . '/' . $key . '.jpg';
        if ($this->valid($target)) return $target;
        $lock = @fopen($directory . '/' . $key . '.lock', 'c');
        if (!$lock) return $original;
        $partial = $directory . '/.' . $key . '-' . bin2hex(random_bytes(8)) . '.part';
        try {
            if (!flock($lock, LOCK_EX)) return $original;
            if ($this->valid($target)) return $target;
            $decoder = match ($info[2]) { IMAGETYPE_JPEG => 'imagecreatefromjpeg', IMAGETYPE_PNG => 'imagecreatefrompng', IMAGETYPE_GIF => 'imagecreatefromgif', IMAGETYPE_WEBP => 'imagecreatefromwebp' };
            if (!function_exists($decoder) || !($source = @$decoder($original))) return $original;
            try {
                $scale = min(1, self::PIXELS / max($info[0], $info[1]));
                $width = max(1, (int) round($info[0] * $scale)); $height = max(1, (int) round($info[1] * $scale));
                $image = imagecreatetruecolor($width, $height);
                try {
                    // JPEG previews use a white background for transparent PNG/GIF/WebP.
                    imagefill($image, 0, 0, imagecolorallocate($image, 255, 255, 255));
                    imagecopyresampled($image, $source, 0, 0, 0, 0, $width, $height, $info[0], $info[1]);
                    if ($info[2] === IMAGETYPE_JPEG && function_exists('exif_read_data')) {
                        $exif = @exif_read_data($original, 'IFD0');
                        $orientation = (int) ($exif['Orientation'] ?? 1);
                        if (in_array($orientation, [2, 4, 5, 7], true)) imageflip($image, IMG_FLIP_HORIZONTAL);
                        $rotation = match ($orientation) { 3, 4 => 180, 6, 7 => -90, 5, 8 => 90, default => 0 };
                        if ($rotation !== 0) { $rotated = imagerotate($image, $rotation, 0xFFFFFF); imagedestroy($image); $image = $rotated; }
                    }
                    imageinterlace($image, true);
                    if (!imagejpeg($image, $partial, 78) || !$this->valid($partial) || filesize($partial) >= $bytes) return $original;
                    @chmod($partial, 0600);
                    if (!@rename($partial, $target)) return $original;
                } finally { imagedestroy($image); }
            } finally { imagedestroy($source); }
            $this->prune($directory, $target);
            return $target;
        } catch (\Throwable) { return $original; }
        finally { if (is_file($partial)) @unlink($partial); flock($lock, LOCK_UN); fclose($lock); }
    }

    private function valid(string $file): bool
    {
        if (!is_file($file) || is_link($file) || filesize($file) <= 0 || filesize($file) > 2 * 1024 * 1024) return false;
        $info = @getimagesize($file);
        return $info && $info[2] === IMAGETYPE_JPEG && max($info[0], $info[1]) <= self::PIXELS;
    }
    private function memoryLimit(): int
    {
        $value = trim((string) ini_get('memory_limit'));
        return (int) $value * match (strtolower(substr($value, -1))) { 'g' => 1024 ** 3, 'm' => 1024 ** 2, 'k' => 1024, default => 1 };
    }
    private function prune(string $directory, string $keep): void
    {
        $marker = $directory . '/.prune';
        if (is_file($marker) && time() - filemtime($marker) < 3600) return;
        @touch($marker);
        $files = glob($directory . '/*.jpg') ?: [];
        usort($files, static fn ($a, $b) => filemtime($b) <=> filemtime($a));
        $bytes = 0;
        foreach ($files as $index => $file) {
            $bytes += filesize($file);
            if ($file !== $keep && ($index >= 2000 || $bytes > 512 * 1024 * 1024 || time() - filemtime($file) > 30 * 86400)) @unlink($file);
        }
    }
}
