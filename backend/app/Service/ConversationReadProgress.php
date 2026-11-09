<?php
namespace app\Service;

use think\facade\Db;

/** A committed, contiguous receipt prefix, never a replacement for receipts. */
final class ConversationReadProgress
{
    /** Caller holds the current conversation, user and membership locks. */
    public static function through(int $user, int $conversation, array $member): int
    {
        // Do not lock a missing primary key: gap locks from first reads in
        // independent groups can deadlock when both later insert their progress.
        // A no-op upsert locks/creates this exact row before the current read.
        Db::name('conversation_read_progress')->duplicate(['through_message_id' => Db::raw('through_message_id')])
            ->insert(['conversation_id' => $conversation, 'user_id' => $user, 'through_message_id' => 0,
                'member_role' => $member['role'], 'cleared_before_message_id' => (int) $member['cleared_before_message_id'],
                'joined_at' => $member['joined_at'], 'updated_at' => date('Y-m-d H:i:s')]);
        // A current read also observes a committed mark-unread reset.
        $row = Db::name('conversation_read_progress')->where('conversation_id', $conversation)
            ->where('user_id', $user)->lock(true)->find();
        if (!$row || $row['member_role'] !== $member['role']
            || (int) $row['cleared_before_message_id'] !== (int) $member['cleared_before_message_id']
            || $row['joined_at'] !== $member['joined_at']) return 0;
        return (int) $row['through_message_id'];
    }

    public static function advance(int $user, int $conversation, array $member, int $through): void
    {
        $values = ['through_message_id' => $through, 'member_role' => $member['role'],
            'cleared_before_message_id' => (int) $member['cleared_before_message_id'],
            'joined_at' => $member['joined_at'], 'updated_at' => date('Y-m-d H:i:s')];
        // The caller commits this only after every visible receipt in the prefix.
        Db::name('conversation_read_progress')->duplicate($values)
            ->insert(['conversation_id' => $conversation, 'user_id' => $user] + $values);
    }

    public static function forget(int $user, ?int $conversation = null): void
    {
        $query = Db::name('conversation_read_progress')->where('user_id', $user);
        if ($conversation !== null) $query->where('conversation_id', $conversation);
        $query->delete();
    }
}
