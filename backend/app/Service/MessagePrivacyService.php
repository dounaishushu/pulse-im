<?php

namespace app\Service;

/** Apply the same privacy rules to new messages, historical rows and realtime events. */
final class MessagePrivacyService
{
    public static function sanitize(string $type, array $body): array
    {
        if ($type === 'contact_card') {
            // A shared card must never carry a snapshot of someone's private phone number.
            return array_intersect_key($body, array_flip(['user_id', 'public_id', 'nickname', 'username', 'avatar_url', 'request_id', 'reply_to_id', 'reply_to']));
        }
        return $body;
    }
}
