<?php
namespace app\Service;

use DateTimeImmutable;
use DateTimeZone;
use RuntimeException;

/** Basic Quartz cron: seconds/minutes/hours/day/month/weekday[/year], Asia/Shanghai. */
final class DispatchScheduleService
{
    private array $cache = [];

    public function validate(string $expression): void { $this->parse($expression); }

    /** The returned whole-second occurrence is strictly later than $after. */
    public function next(string $expression, DateTimeImmutable $after): DateTimeImmutable
    {
        [$seconds, $minutes, $hours, $days, $months, $weekdays, $years] = $this->parse($expression);
        $zone = new DateTimeZone('Asia/Shanghai'); $after = $after->setTimezone($zone);
        $fromYear = (int) $after->format('Y'); $fromMonth = (int) $after->format('n'); $fromDay = (int) $after->format('j');
        foreach ($years as $year) {
            if ($year < $fromYear) continue;
            foreach ($months as $month) {
                if ($year === $fromYear && $month < $fromMonth) continue;
                foreach ($days ?? range(1, 31) as $day) {
                    if (!checkdate($month, $day, $year) || ($year === $fromYear && $month === $fromMonth && $day < $fromDay)) continue;
                    $date = new DateTimeImmutable(sprintf('%04d-%02d-%02d 00:00:00', $year, $month, $day), $zone);
                    if ($weekdays !== null && !in_array((int) $date->format('w') + 1, $weekdays, true)) continue;
                    $sameDay = $date->format('Y-m-d') === $after->format('Y-m-d');
                    foreach ($hours as $hour) {
                        if ($sameDay && $hour < (int) $after->format('G')) continue;
                        $sameHour = $sameDay && $hour === (int) $after->format('G');
                        foreach ($minutes as $minute) {
                            if ($sameHour && $minute < (int) $after->format('i')) continue;
                            foreach ($seconds as $second) {
                                $candidate = $date->setTime($hour, $minute, $second);
                                if ($candidate > $after) return $candidate;
                            }
                        }
                    }
                }
            }
        }
        throw new RuntimeException('Cron在1970至2099年范围内没有未来执行时间。');
    }

    private function parse(string $expression): array
    {
        $expression = strtoupper(trim($expression));
        if (isset($this->cache[$expression])) return $this->cache[$expression];
        if ($expression === '' || strlen($expression) > 256) throw new RuntimeException('Cron表达式必须为6或7个字段。');
        $fields = preg_split('/\s+/', $expression);
        if (!in_array(count($fields), [6, 7], true)) throw new RuntimeException('Cron表达式必须为秒、分、时、日、月、星期，以及可选年份。');
        if (($fields[3] === '?') === ($fields[5] === '?')) throw new RuntimeException('Cron的日与星期字段必须且只能有一个使用?。');
        $monthNames = array_combine(['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'], range(1, 12));
        $weekdayNames = array_combine(['SUN','MON','TUE','WED','THU','FRI','SAT'], range(1, 7));
        $result = [
            $this->field($fields[0], 0, 59), $this->field($fields[1], 0, 59), $this->field($fields[2], 0, 23),
            $fields[3] === '?' ? null : $this->field($fields[3], 1, 31),
            $this->field($fields[4], 1, 12, $monthNames),
            $fields[5] === '?' ? null : $this->field($fields[5], 1, 7, $weekdayNames),
            $this->field($fields[6] ?? '*', 1970, 2099),
        ];
        if (count($this->cache) >= 128) $this->cache = [];
        return $this->cache[$expression] = $result;
    }

    private function field(string $raw, int $minimum, int $maximum, array $names = []): array
    {
        if ($names) $raw = preg_replace_callback('/[A-Z]+/', static fn (array $match): string => isset($names[$match[0]]) ? (string) $names[$match[0]] : $match[0], $raw);
        if (preg_match('/[LW#]/', $raw)) throw new RuntimeException('当前Cron不支持L、W、#，请使用数字、*、?、列表、范围和步进。');
        if (!preg_match('/^[0-9*,\/-]+$/D', $raw)) throw new RuntimeException('Cron字段包含不支持的字符或别名。');
        $values = [];
        foreach (explode(',', $raw) as $part) {
            if (!preg_match('/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/D', $part, $match)) throw new RuntimeException('Cron列表、范围或步进格式无效。');
            $step = isset($match[2]) ? (int) $match[2] : 1;
            if ($step < 1 || $step > $maximum - $minimum + 1) throw new RuntimeException('Cron步进必须为字段范围内的正整数。');
            if ($match[1] === '*') { $start = $minimum; $end = $maximum; }
            elseif (str_contains($match[1], '-')) [$start, $end] = array_map('intval', explode('-', $match[1]));
            else { $start = (int) $match[1]; $end = isset($match[2]) ? $maximum : $start; }
            if ($start < $minimum || $end > $maximum || $start > $end) throw new RuntimeException("Cron字段范围必须在{$minimum}至{$maximum}之间，暂不支持跨边界范围。");
            for ($value = $start; $value <= $end; $value += $step) $values[$value] = true;
        }
        $result = array_keys($values); sort($result, SORT_NUMERIC);
        return $result;
    }
}
