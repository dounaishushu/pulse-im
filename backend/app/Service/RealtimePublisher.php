<?php

namespace app\Service;

/**
 * Redis only wakes the durable database event reader. Transactional database
 * triggers record events even if this process crashes before publishing.
 */
final class RealtimePublisher
{
    public function publish(array $message, string $eventType = 'message.new'): void
    {
        if ((string) env('REALTIME_DRIVER', 'database') !== 'redis') return;
        $channel = (string) env('REALTIME_CHANNEL', 'pulse-im:messages');
        // Do not put message contents (including historical private fields) on the bus.
        $payload = json_encode(['source' => 'api', 'type' => 'events.available'], JSON_THROW_ON_ERROR);
        (new RedisTransport())->publish($channel, $payload);
    }
}
