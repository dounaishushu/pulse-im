<?php
namespace app\Service;

/** Comparison only: never rewrites stored phone numbers or changes login identities. */
final class PhoneNumberService
{
    public static function searchKey(string $input): ?string
    {
        $input = trim($input);
        if (!preg_match('/^[+0-9 -]{1,64}$/D', $input)) return null;
        $digits = str_replace([' ', '-', '+'], '', $input);
        return preg_match('/^[0-9]{1,32}$/D', $digits) ? $digits : null;
    }

    public static function comparisonSql(string $column): string
    {
        if (!preg_match('/^[A-Za-z_][A-Za-z0-9_.]*$/D', $column)) throw new \InvalidArgumentException('Invalid phone column.');
        return "REPLACE(REPLACE(REPLACE(TRIM({$column}), ' ', ''), '-', ''), '+', '')";
    }
}
