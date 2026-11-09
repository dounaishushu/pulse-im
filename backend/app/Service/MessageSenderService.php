<?php
namespace app\Service;

use think\facade\Db;

/** Names belong to actual message authors, never to user-supplied bodies. */
final class MessageSenderService
{
    public static function name(mixed $nickname): ?string
    {
        return is_string($nickname) && trim($nickname) !== '' ? $nickname : null;
    }

    public static function avatar(mixed $avatarUrl): ?string
    {
        return is_string($avatarUrl) && trim($avatarUrl) !== '' ? $avatarUrl : null;
    }

    public function enrich(array $messages): array
    {
        if ($messages === []) return [];
        $ids = [];
        foreach ($messages as $message) {
            $id = (int) ($message['sender_id'] ?? 0);
            if ($id > 0) $ids[$id] = $id;
        }
        $authors = [];
        if ($ids !== []) {
            foreach (Db::name('users')->whereIn('id', array_values($ids))->field('id,nickname,avatar_url')->select()->toArray() as $author) {
                $authors[(int) $author['id']] = $author;
            }
        }
        foreach ($messages as &$message) {
            $author = $authors[(int) ($message['sender_id'] ?? 0)] ?? [];
            $message['sender_name'] = self::name($author['nickname'] ?? null);
            $message['sender_avatar_url'] = self::avatar($author['avatar_url'] ?? null);
        }
        unset($message);
        return $messages;
    }
}
