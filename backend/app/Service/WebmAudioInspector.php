<?php
namespace app\Service;

/** 兼容 fileinfo 把纯音频 WebM 识别为 video/webm，但绝不放行视频轨道。 */
final class WebmAudioInspector
{
    public static function isAudioOnly(string $path): bool
    {
        $bytes = file_get_contents($path, false, null, 0, 262144);
        if ($bytes === false || substr($bytes, 0, 4) !== "\x1a\x45\xdf\xa3") return false;
        $offset = 0; $limit = strlen($bytes); $header = self::element($bytes, $offset, $limit);
        if (!$header || $header['size'] === null || $offset + $header['size'] > $limit) return false;
        $headerEnd = $offset + $header['size']; $docType = '';
        while ($offset < $headerEnd) {
            $element = self::element($bytes, $offset, $headerEnd);
            if (!$element || $element['size'] === null || $offset + $element['size'] > $headerEnd) return false;
            if ($element['id'] === 0x4282) $docType = substr($bytes, $offset, $element['size']);
            $offset += $element['size'];
        }
        if ($docType !== 'webm') return false;
        $segment = self::element($bytes, $offset, $limit);
        if (!$segment || $segment['id'] !== 0x18538067) return false;
        $end = $segment['size'] === null ? $limit : min($limit, $offset + $segment['size']);
        for ($count = 0; $offset < $end && $count < 1024; $count++) {
            $element = self::element($bytes, $offset, $end);
            if (!$element || $element['size'] === null || $offset + $element['size'] > $end) return false;
            if ($element['id'] === 0x1654ae6b) return self::audioTracks($bytes, $offset, $offset + $element['size']);
            $offset += $element['size'];
        }
        return false;
    }

    private static function audioTracks(string $bytes, int $offset, int $end): bool
    {
        $tracks = 0;
        while ($offset < $end) {
            $entry = self::element($bytes, $offset, $end);
            if (!$entry || $entry['size'] === null || $offset + $entry['size'] > $end) return false;
            $entryEnd = $offset + $entry['size'];
            if ($entry['id'] === 0xae) {
                $type = 0; $codec = '';
                while ($offset < $entryEnd) {
                    $field = self::element($bytes, $offset, $entryEnd);
                    if (!$field || $field['size'] === null || $offset + $field['size'] > $entryEnd) return false;
                    if ($field['id'] === 0x83) { if ($field['size'] !== 1) return false; $type = ord($bytes[$offset]); }
                    if ($field['id'] === 0x86) $codec = substr($bytes, $offset, $field['size']);
                    $offset += $field['size'];
                }
                if ($type !== 2 || !in_array($codec, ['A_OPUS', 'A_VORBIS'], true)) return false;
                $tracks++;
            }
            $offset = $entryEnd;
        }
        return $tracks > 0;
    }

    private static function element(string $bytes, int &$offset, int $limit): ?array
    {
        if ($offset >= $limit) return null;
        $first = ord($bytes[$offset]); $length = 1; $mask = 0x80;
        while ($length <= 4 && !($first & $mask)) { $length++; $mask >>= 1; }
        if ($length > 4 || $offset + $length >= $limit) return null;
        $id = 0; for ($i = 0; $i < $length; $i++) $id = ($id << 8) | ord($bytes[$offset++]);
        $first = ord($bytes[$offset]); $length = 1; $mask = 0x80;
        while ($length <= 8 && !($first & $mask)) { $length++; $mask >>= 1; }
        if ($length > 8 || $offset + $length > $limit) return null;
        $size = $first & ($mask - 1); $offset++;
        for ($i = 1; $i < $length; $i++) $size = ($size << 8) | ord($bytes[$offset++]);
        return ['id' => $id, 'size' => $size === (1 << (7 * $length)) - 1 ? null : $size];
    }
}
