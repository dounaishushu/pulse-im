<?php
namespace app\Service;

use RuntimeException;

/** Retired compatibility API; historical accounting records remain untouched. */
final class WalletService
{
    public function topUp(int $userId, int $amountFen, ?int $operatorId, string $requestId, string $remark): array
    {
        throw new RuntimeException('FEATURE_REMOVED: 钱包与红包功能已停用。');
    }

    public function debit(int $userId, int $amountFen, string $requestId, string $remark): array
    {
        throw new RuntimeException('FEATURE_REMOVED: 钱包与红包功能已停用。');
    }
}
