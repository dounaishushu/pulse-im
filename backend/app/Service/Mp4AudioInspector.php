<?php
declare(strict_types=1);

namespace app\Service;

/** Bounded validation for non-fragmented, local AAC-LC MP4 voice recordings. */
final class Mp4AudioInspector
{
    private const MAX_BYTES = 10 * 1024 * 1024;
    private const MAX_BOXES = 2048;
    private const MAX_SAMPLES = 32768;
    private const MAX_TRACKS = 4;
    private int $boxCount = 0;
    private int $sampleBudget = self::MAX_SAMPLES;
    private array $mediaRanges = [];
    private array $sampleRanges = [];
    private array $trackIds = [];

    private function __construct(private string $bytes) {}

    public static function isAudioOnly(string $path): bool
    {
        try {
            if (!is_file($path)) return false;
            $size = filesize($path);
            if (!is_int($size) || $size < 8 || $size > self::MAX_BYTES) return false;
            $bytes = @file_get_contents($path, false, null, 0, self::MAX_BYTES + 1);
            if (!is_string($bytes) || strlen($bytes) !== $size) return false;
            (new self($bytes))->inspect();
            return true;
        } catch (\Throwable $error) {
            return false;
        }
    }

    private function inspect(): void
    {
        $top = $this->children(0, strlen($this->bytes));
        $this->allowed($top, ['ftyp', 'moov', 'mdat', 'free', 'skip']);
        $this->require($top !== [] && $top[0]['type'] === 'ftyp');
        $ftyp = $this->one($top, 'ftyp');
        $movie = $this->one($top, 'moov');
        $this->fileType($ftyp);
        foreach ($top as $box) {
            if ($box['type'] !== 'mdat') continue;
            $this->require($box['end'] > $box['payload'] && count($this->mediaRanges) < 16);
            $this->mediaRanges[] = [$box['payload'], $box['end']];
        }
        $this->require($this->mediaRanges !== []);
        $children = $this->children($movie['payload'], $movie['end']);
        $this->allowed($children, ['mvhd', 'trak', 'meta', 'udta']);
        $this->movieHeader($this->one($children, 'mvhd'));
        $this->optionalMetadata($children);
        $tracks = array_values(array_filter($children, static fn (array $box): bool => $box['type'] === 'trak'));
        $this->require(count($tracks) >= 1 && count($tracks) <= self::MAX_TRACKS);
        foreach ($tracks as $track) $this->track($track);
        usort($this->sampleRanges, static fn (array $left, array $right): int => $left[0] <=> $right[0]);
        $lastEnd = 0;
        foreach ($this->sampleRanges as [$start, $end]) {
            $this->require($start >= $lastEnd && $end > $start);
            $lastEnd = $end;
        }
        $this->require($this->sampleRanges !== []);
    }

    /** All lengths are bounded by the complete file before any offset arithmetic. */
    private function children(int $start, int $end): array
    {
        $this->require($start >= 0 && $start <= $end && $end <= strlen($this->bytes));
        $boxes = [];
        for ($offset = $start; $offset < $end;) {
            $this->require($end - $offset >= 8 && ++$this->boxCount <= self::MAX_BOXES);
            $size = $this->u32($offset); $header = 8;
            if ($size === 1) {
                $this->require($end - $offset >= 16);
                $size = $this->u64($offset + 8, self::MAX_BYTES); $header = 16;
            }
            // Open-ended boxes and unsupported padding headers are not in this subset.
            $this->require($size >= $header && $size <= $end - $offset);
            $boxes[] = ['type' => substr($this->bytes, $offset + 4, 4), 'payload' => $offset + $header, 'end' => $offset + $size];
            $offset += $size;
        }
        return $boxes;
    }

    private function fileType(array $box): void
    {
        $length = $box['end'] - $box['payload'];
        $this->require($length >= 12 && $length <= 264 && ($length - 8) % 4 === 0);
        $brands = ['isom', 'iso2', 'mp41', 'mp42', 'M4A '];
        $this->require(in_array(substr($this->bytes, $box['payload'], 4), $brands, true));
        for ($offset = $box['payload'] + 8; $offset < $box['end']; $offset += 4) {
            $this->require(in_array(substr($this->bytes, $offset, 4), $brands, true));
        }
    }

    private function movieHeader(array $box): void
    {
        $version = $this->version($box);
        $this->require($version <= 1 && $this->u24($box['payload'] + 1) === 0);
        $this->require($box['end'] - $box['payload'] === ($version === 0 ? 100 : 112));
        $offset = $box['payload'] + ($version === 0 ? 12 : 20);
        $this->require($this->u32($offset) > 0);
        $duration = $version === 0 ? $this->u32($offset + 4) : $this->u64($offset + 4, PHP_INT_MAX);
        $this->require($duration > 0);
    }

    private function track(array $box): void
    {
        $children = $this->children($box['payload'], $box['end']);
        $this->allowed($children, ['tkhd', 'mdia']);
        $header = $this->one($children, 'tkhd');
        $version = $this->version($header);
        $flags = $this->u24($header['payload'] + 1);
        $this->require($version <= 1 && ($flags & 1) === 1 && ($flags & ~15) === 0);
        $this->require($header['end'] - $header['payload'] === ($version === 0 ? 84 : 96));
        $id = $this->u32($header['payload'] + ($version === 0 ? 12 : 20));
        $this->require($id > 0 && !isset($this->trackIds[$id]));
        $this->trackIds[$id] = true;
        $this->require($this->u32($header['end'] - 8) === 0 && $this->u32($header['end'] - 4) === 0);
        $media = $this->one($children, 'mdia');
        $fields = $this->children($media['payload'], $media['end']);
        $this->allowed($fields, ['mdhd', 'hdlr', 'minf']);
        $mdhd = $this->one($fields, 'mdhd');
        $version = $this->version($mdhd);
        $this->require($version <= 1 && $this->u24($mdhd['payload'] + 1) === 0);
        $this->require($mdhd['end'] - $mdhd['payload'] === ($version === 0 ? 24 : 36));
        $offset = $mdhd['payload'] + ($version === 0 ? 12 : 20);
        $timeScale = $this->u32($offset);
        $duration = $version === 0 ? $this->u32($offset + 4) : $this->u64($offset + 4, self::MAX_SAMPLES * 1024);
        $this->require($timeScale > 0 && $duration > 0);
        $this->handler($this->one($fields, 'hdlr'), 'soun');
        $info = $this->one($fields, 'minf');
        $items = $this->children($info['payload'], $info['end']);
        $this->allowed($items, ['smhd', 'dinf', 'stbl']);
        $sound = $this->one($items, 'smhd');
        $this->full($sound, 8);
        $this->require(substr($this->bytes, $sound['payload'] + 4, 4) === str_repeat("\0", 4));
        $this->dataReference($this->one($items, 'dinf'));
        $this->samples($this->one($items, 'stbl'), $timeScale, $duration);
    }

    private function handler(array $box, string $expected): void
    {
        $this->require($box['end'] - $box['payload'] >= 24);
        $this->full($box);
        $this->require($this->u32($box['payload'] + 4) === 0
            && substr($this->bytes, $box['payload'] + 8, 4) === $expected
            && substr($this->bytes, $box['payload'] + 12, 12) === str_repeat("\0", 12));
    }

    private function dataReference(array $box): void
    {
        $children = $this->children($box['payload'], $box['end']);
        $this->allowed($children, ['dref']);
        $reference = $this->one($children, 'dref');
        $this->full($reference);
        $this->require($reference['end'] - $reference['payload'] >= 8 && $this->u32($reference['payload'] + 4) === 1);
        $entries = $this->children($reference['payload'] + 8, $reference['end']);
        $this->require(count($entries) === 1 && $entries[0]['type'] === 'url ');
        $this->full($entries[0], 4, 1); // Self-contained local data; no URL payload.
    }

    private function samples(array $box, int $timeScale, int $duration): void
    {
        $children = $this->children($box['payload'], $box['end']);
        $this->allowed($children, ['stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64']);
        $description = $this->one($children, 'stsd');
        $this->full($description);
        $this->require($description['end'] - $description['payload'] >= 8 && $this->u32($description['payload'] + 4) === 1);
        $entries = $this->children($description['payload'] + 8, $description['end']);
        $this->require(count($entries) === 1 && $entries[0]['type'] === 'mp4a');
        $rate = $this->audioEntry($entries[0]);
        $this->require($rate === $timeScale);

        $sizes = $this->one($children, 'stsz');
        $this->full($sizes);
        $this->require($sizes['end'] - $sizes['payload'] >= 12);
        $uniform = $this->u32($sizes['payload'] + 4);
        $sampleCount = $this->u32($sizes['payload'] + 8);
        $this->require($sampleCount > 0 && $sampleCount <= $this->sampleBudget && $uniform <= self::MAX_BYTES);
        $this->sampleBudget -= $sampleCount;
        $this->require($sizes['end'] - $sizes['payload'] === 12 + ($uniform === 0 ? $sampleCount * 4 : 0));
        $timing = $this->one($children, 'stts');
        $timingCount = $this->table($timing, 8);
        $timedSamples = 0;
        for ($i = 0; $i < $timingCount; $i++) {
            $offset = $timing['payload'] + 8 + $i * 8;
            $count = $this->u32($offset);
            $this->require($count > 0 && $count <= $sampleCount - $timedSamples && $this->u32($offset + 4) === 1024);
            $timedSamples += $count;
        }
        $this->require($timedSamples === $sampleCount && $duration === $sampleCount * 1024);

        $offsetBoxes = array_values(array_filter($children, static fn (array $item): bool => in_array($item['type'], ['stco', 'co64'], true)));
        $this->require(count($offsetBoxes) === 1);
        $offsetBox = $offsetBoxes[0];
        $wide = $offsetBox['type'] === 'co64';
        $chunkCount = $this->table($offsetBox, $wide ? 8 : 4);
        $this->require($chunkCount <= $sampleCount);
        $mapping = $this->one($children, 'stsc');
        $mapCount = $this->table($mapping, 12);
        $this->require($mapCount <= $chunkCount);
        $maps = []; $previous = 0;
        for ($i = 0; $i < $mapCount; $i++) {
            $offset = $mapping['payload'] + 8 + $i * 12;
            $first = $this->u32($offset); $count = $this->u32($offset + 4);
            $this->require($first > $previous && $first <= $chunkCount && ($i > 0 || $first === 1)
                && $count > 0 && $count <= $sampleCount && $this->u32($offset + 8) === 1);
            $maps[] = [$first, $count]; $previous = $first;
        }
        $sample = 0; $map = 0; $previousOffset = -1;
        for ($chunk = 1; $chunk <= $chunkCount; $chunk++) {
            if (isset($maps[$map + 1]) && $maps[$map + 1][0] === $chunk) $map++;
            $offset = $offsetBox['payload'] + 8 + ($chunk - 1) * ($wide ? 8 : 4);
            $start = $wide ? $this->u64($offset, self::MAX_BYTES) : $this->u32($offset);
            $this->require($start > $previousOffset && $maps[$map][1] <= $sampleCount - $sample);
            $previousOffset = $start; $length = 0;
            for ($i = 0; $i < $maps[$map][1]; $i++, $sample++) {
                $size = $uniform ?: $this->u32($sizes['payload'] + 12 + $sample * 4);
                $this->require($size > 0 && $size <= self::MAX_BYTES - $length);
                $length += $size;
            }
            $inside = false;
            foreach ($this->mediaRanges as [$mediaStart, $mediaEnd]) {
                if ($start >= $mediaStart && $start <= $mediaEnd && $length <= $mediaEnd - $start) { $inside = true; break; }
            }
            $this->require($inside);
            $this->sampleRanges[] = [$start, $start + $length];
        }
        $this->require($sample === $sampleCount);
    }

    private function audioEntry(array $box): int
    {
        $offset = $box['payload'];
        $this->require($box['end'] - $offset >= 28
            && substr($this->bytes, $offset, 6) === str_repeat("\0", 6) && $this->u16($offset + 6) === 1
            && substr($this->bytes, $offset + 8, 8) === str_repeat("\0", 8));
        $channels = $this->u16($offset + 16);
        $this->require(in_array($channels, [1, 2], true) && $this->u16($offset + 18) === 16
            && $this->u32($offset + 20) === 0 && $this->u16($offset + 26) === 0);
        $rate = $this->u16($offset + 24);
        $children = $this->children($offset + 28, $box['end']);
        $this->allowed($children, ['esds']);
        $esds = $this->one($children, 'esds');
        $this->full($esds);
        $es = $this->descriptor($esds['payload'] + 4, $esds['end'], 3);
        $this->require($es['end'] === $esds['end'] && $es['end'] - $es['payload'] >= 3
            && ord($this->bytes[$es['payload'] + 2]) === 0);
        $decoder = $this->descriptor($es['payload'] + 3, $es['end'], 4);
        $this->require($decoder['end'] - $decoder['payload'] >= 13
            && ord($this->bytes[$decoder['payload']]) === 0x40
            && ord($this->bytes[$decoder['payload'] + 1]) === 0x15);
        $specific = $this->descriptor($decoder['payload'] + 13, $decoder['end'], 5);
        $this->require($specific['end'] === $decoder['end'] && $specific['end'] - $specific['payload'] === 2);
        $first = ord($this->bytes[$specific['payload']]); $second = ord($this->bytes[$specific['payload'] + 1]);
        $rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
        $frequency = (($first & 7) << 1) | ($second >> 7);
        $this->require(($first >> 3) === 2 && isset($rates[$frequency]) && $rates[$frequency] === $rate
            && (($second >> 3) & 15) === $channels && ($second & 7) === 0);
        $sl = $this->descriptor($decoder['end'], $es['end'], 6);
        $this->require($sl['end'] === $es['end'] && $sl['end'] - $sl['payload'] === 1 && ord($this->bytes[$sl['payload']]) === 2);
        return $rate;
    }

    private function descriptor(int $offset, int $end, int $tag): array
    {
        $this->require($end - $offset >= 2 && ord($this->bytes[$offset++]) === $tag);
        $length = 0; $complete = false;
        for ($i = 0; $i < 4; $i++) {
            $this->require($offset < $end);
            $byte = ord($this->bytes[$offset++]);
            $length = ($length << 7) | ($byte & 127);
            $this->require($length <= self::MAX_BYTES);
            if (($byte & 128) === 0) { $complete = true; break; }
        }
        $this->require($complete && $length <= $end - $offset);
        return ['payload' => $offset, 'end' => $offset + $length];
    }

    private function optionalMetadata(array $children): void
    {
        foreach (['meta', 'udta'] as $type) {
            $boxes = array_values(array_filter($children, static fn (array $box): bool => $box['type'] === $type));
            $this->require(count($boxes) <= 1);
            if ($boxes === []) continue;
            if ($type === 'meta') $this->metadata($boxes[0]);
            else {
                $items = $this->children($boxes[0]['payload'], $boxes[0]['end']);
                $this->allowed($items, ['meta']);
                $this->metadata($this->one($items, 'meta'));
            }
        }
    }

    private function metadata(array $box): void
    {
        $start = $box['payload'];
        $this->require($box['end'] - $start >= 8);
        // Android's mdta meta omits FullBox version/flags; ISO meta includes zero flags.
        if ($this->u32($start) === 0) $start += 4;
        $children = $this->children($start, $box['end']);
        $this->allowed($children, ['hdlr', 'keys', 'ilst']);
        $this->handler($this->one($children, 'hdlr'), 'mdta');
        $keys = $this->one($children, 'keys');
        $this->full($keys);
        $this->require($keys['end'] - $keys['payload'] >= 8);
        $count = $this->u32($keys['payload'] + 4);
        $this->require($count > 0 && $count <= 64);
        $offset = $keys['payload'] + 8;
        for ($i = 0; $i < $count; $i++) {
            $this->require($keys['end'] - $offset >= 8);
            $size = $this->u32($offset);
            $this->require($size > 8 && $size <= $keys['end'] - $offset && substr($this->bytes, $offset + 4, 4) === 'mdta');
            $offset += $size;
        }
        $this->require($offset === $keys['end']);
        $list = $this->one($children, 'ilst');
        $items = $this->children($list['payload'], $list['end']); $seen = [];
        $this->require(count($items) <= $count);
        foreach ($items as $item) {
            $id = unpack('N', $item['type'])[1];
            $this->require($id > 0 && $id <= $count && !isset($seen[$id])); $seen[$id] = true;
            $values = $this->children($item['payload'], $item['end']);
            $this->allowed($values, ['data']); $value = $this->one($values, 'data');
            $this->require($value['end'] - $value['payload'] >= 8 && $this->u32($value['payload']) === 1
                && $this->u32($value['payload'] + 4) === 0);
        }
    }

    private function table(array $box, int $entrySize): int
    {
        $this->full($box);
        $this->require($box['end'] - $box['payload'] >= 8);
        $count = $this->u32($box['payload'] + 4);
        $this->require($count > 0 && $count <= self::MAX_SAMPLES && $box['end'] - $box['payload'] === 8 + $count * $entrySize);
        return $count;
    }

    private function one(array $boxes, string $type): array
    {
        $matching = array_values(array_filter($boxes, static fn (array $box): bool => $box['type'] === $type));
        $this->require(count($matching) === 1);
        return $matching[0];
    }

    private function allowed(array $boxes, array $types): void
    {
        foreach ($boxes as $box) $this->require(in_array($box['type'], $types, true));
    }

    private function full(array $box, ?int $length = null, int $flags = 0): void
    {
        $this->require($box['end'] - $box['payload'] >= 4 && $this->u32($box['payload']) === $flags
            && ($length === null || $box['end'] - $box['payload'] === $length));
    }

    private function version(array $box): int
    {
        $this->require($box['end'] - $box['payload'] >= 4);
        return ord($this->bytes[$box['payload']]);
    }

    private function u16(int $offset): int { return unpack('n', substr($this->bytes, $offset, 2))[1]; }
    private function u24(int $offset): int { return (ord($this->bytes[$offset]) << 16) | (ord($this->bytes[$offset + 1]) << 8) | ord($this->bytes[$offset + 2]); }
    private function u32(int $offset): int { return unpack('N', substr($this->bytes, $offset, 4))[1]; }

    private function u64(int $offset, int $maximum): int
    {
        $parts = unpack('Nhigh/Nlow', substr($this->bytes, $offset, 8));
        $this->require($parts['high'] <= intdiv($maximum, 4294967296));
        $value = $parts['high'] * 4294967296 + $parts['low'];
        $this->require(is_int($value) && $value <= $maximum);
        return $value;
    }

    private function require(bool $condition): void
    {
        if (!$condition) throw new \RuntimeException('Unsupported or invalid MP4 audio structure.');
    }
}
