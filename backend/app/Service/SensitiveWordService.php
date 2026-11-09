<?php

namespace app\Service;

use RuntimeException;
use think\facade\Cache;
use think\facade\Db;

final class SensitiveWordService
{
    private const CACHE_KEY = 'pulse_sensitive_words_active';

    public function activeWords(): array
    {
        $cached = Cache::get(self::CACHE_KEY);
        if (is_array($cached)) return $cached;
        $rows = Db::name('sensitive_words')->where('status', 1)->field('word,replacement')->orderRaw('CHAR_LENGTH(word) DESC')->select()->toArray();
        $words = array_values(array_filter(array_map(static fn (array $row): array => ['word' => (string) $row['word'], 'replacement' => (string) $row['replacement']], $rows), static fn (array $row): bool => $row['word'] !== ''));
        Cache::set(self::CACHE_KEY, $words, 60);
        return $words;
    }

    public function filterText(string $text): string
    {
        if ($text === '') return $text;
        return $this->replaceText($text, $this->activeWords());
    }

    public function filterBody(array $body): array
    {
        // One snapshot for this operation, including a list of message bodies.
        // A subsequent operation reads the shared cache again after any update.
        $words = null;
        return $this->filterValue($body, '', $words);
    }

    public function create(string $word, string $replacement): array
    {
        [$word, $replacement] = $this->validate($word, $replacement);
        if (Db::name('sensitive_words')->where('word', $word)->find()) throw new RuntimeException('敏感词已经存在。');
        $now = date('Y-m-d H:i:s');
        $id = Db::name('sensitive_words')->insertGetId(['word' => $word, 'replacement' => $replacement, 'status' => 1, 'created_at' => $now, 'updated_at' => $now]);
        $this->clearCache();
        return ['id' => (int) $id, 'word' => $word, 'replacement' => $replacement, 'status' => 1, 'created_at' => $now, 'updated_at' => $now];
    }

    public function update(int $id, string $word, string $replacement): array
    {
        if ($id <= 0) throw new RuntimeException('敏感词编号不正确。');
        [$word, $replacement] = $this->validate($word, $replacement);
        $current = Db::name('sensitive_words')->where('id', $id)->find();
        if (!$current) throw new RuntimeException('敏感词不存在。');
        if (Db::name('sensitive_words')->where('word', $word)->where('id', '<>', $id)->find()) throw new RuntimeException('敏感词已经存在。');
        $now = date('Y-m-d H:i:s');
        Db::name('sensitive_words')->where('id', $id)->update(['word' => $word, 'replacement' => $replacement, 'updated_at' => $now]);
        $this->clearCache();
        return ['id' => $id, 'word' => $word, 'replacement' => $replacement, 'status' => (int) $current['status'], 'created_at' => $current['created_at'], 'updated_at' => $now];
    }

    public function delete(int $id): void
    {
        if ($id <= 0 || !Db::name('sensitive_words')->where('id', $id)->find()) throw new RuntimeException('敏感词不存在。');
        Db::name('sensitive_words')->where('id', $id)->delete();
        $this->clearCache();
    }

    public function deleteMany(array $ids): int
    {
        $ids = array_values(array_unique(array_filter(array_map('intval', $ids), static fn (int $id): bool => $id > 0)));
        if ($ids === []) throw new RuntimeException('请选择要删除的敏感词。');
        $deleted = Db::name('sensitive_words')->whereIn('id', $ids)->delete();
        $this->clearCache();
        return (int) $deleted;
    }

    private function replaceText(string $text, array $words): string
    {
        foreach ($words as $item) $text = str_replace($item['word'], $item['replacement'], $text);
        return $text;
    }

    private function filterValue(mixed $value, string $key, ?array &$words): mixed
    {
        if (is_string($value) && $value !== '' && !in_array(strtolower($key), ['url', 'path', 'request_id', 'mime'], true)) {
            return $this->replaceText($value, $words ??= $this->activeWords());
        }
        if (!is_array($value)) return $value;
        $result = [];
        foreach ($value as $childKey => $childValue) $result[$childKey] = $this->filterValue($childValue, (string) $childKey, $words);
        return $result;
    }

    private function validate(string $word, string $replacement): array
    {
        $word = trim($word);
        $replacement = trim($replacement);
        if ($word === '' || mb_strlen($word) > 128) throw new RuntimeException('匹配文字不能为空且不能超过128个字符。');
        if (mb_strlen($replacement) > 128) throw new RuntimeException('替换文字不能超过128个字符。');
        return [$word, $replacement];
    }

    private function clearCache(): void
    {
        Cache::delete(self::CACHE_KEY);
    }
}
