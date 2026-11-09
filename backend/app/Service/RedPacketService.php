<?php
namespace app\Service;

use RuntimeException;

/** Retired compatibility API; no balance movement or packet allocation remains. */
final class RedPacketService
{
    public function create(int $senderId, int $conversationId, int $totalFen, int $packetCount, string $requestId): array
    {
        throw new RuntimeException('FEATURE_REMOVED: 钱包与红包功能已停用。');
    }

    public function claim(int $packetId, int $userId, string $requestId): array
    {
        throw new RuntimeException('FEATURE_REMOVED: 钱包与红包功能已停用。');
    }
}
