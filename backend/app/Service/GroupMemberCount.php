<?php
declare(strict_types=1);
namespace app\Service;

/** Display adjustments never create members or affect capacity/authorization. */
final class GroupMemberCount
{
    public const MAX_CONFIGURED_COUNT = 10000000;

    public static function display(array $conversation, int $actual): int
    {
        return max(0, $actual + (($conversation['type'] ?? '') === 'group' ? (int) ($conversation['member_count_offset'] ?? 0) : 0));
    }

    public static function configured(mixed $value): ?int
    {
        if ($value === null || $value === '') return null;
        if ((!is_int($value) && (!is_string($value) || !preg_match('/^(?:0|[1-9][0-9]{0,7})$/D', $value)))
            || (int) $value < 0 || (int) $value > self::MAX_CONFIGURED_COUNT) {
            throw new \RuntimeException('虚拟显示人数必须是0至10000000的整数，清空可恢复真实人数。');
        }
        return (int) $value;
    }

    public static function offset(?int $configured, int $actual): int
    {
        return $configured === null ? 0 : $configured - $actual;
    }

    public static function admin(array $row, int $actual): array
    {
        $row['member_count'] = $actual;
        $row['member_count_offset'] = (int) ($row['member_count_offset'] ?? 0);
        $row['display_member_count'] = self::display($row, $actual);
        return $row;
    }
}
