<?php
namespace app\Service;

use RuntimeException;

/** DECIMAL(10,3) amounts are calculated in integer thousandths. */
final class WorkTaskMoney
{
    public const MAX_WAGE_MILLIS = 9999999999;

    public static function unitMillis(mixed $value, string $label = '作业单价'): int
    {
        if ((!is_string($value) && !is_int($value) && !is_float($value)) || (is_float($value) && !is_finite($value))) throw new RuntimeException($label . '必须是有效金额。');
        $text = trim((string) $value);
        if (!preg_match('/^\d{1,6}(?:\.(\d{1,3}))?$/D', $text, $match)) throw new RuntimeException($label . '必须在0至100000之间，最多三位小数。');
        $whole = (int) explode('.', $text)[0];
        $millis = $whole * 1000 + (int) str_pad($match[1] ?? '', 3, '0');
        if ($millis > 100000000) throw new RuntimeException($label . '必须在0至100000之间。');
        return $millis;
    }

    public static function assertMaximum(int $questions, mixed $unit): int
    {
        if ($questions < 2 || $questions > WorkTaskService::MAX_QUESTIONS_PER_TASK || $questions % 2 !== 0) throw new RuntimeException('题目数量必须是2至1000之间的偶数。');
        $millis = self::unitMillis($unit);
        if ($millis * $questions > self::MAX_WAGE_MILLIS) throw new RuntimeException('题目数量与单价计算的最高工资超过9999999.999元，请调低单价或题数。');
        return $millis;
    }

    public static function amount(int $millis): string
    {
        if ($millis < 0 || $millis > self::MAX_WAGE_MILLIS) throw new RuntimeException('工资金额超过可保存范围。');
        return intdiv($millis, 1000) . '.' . str_pad((string) ($millis % 1000), 3, '0', STR_PAD_LEFT);
    }
}
