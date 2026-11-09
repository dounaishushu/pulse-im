<?php
declare(strict_types=1);

namespace app\Service;

use PDO;
use PDOException;
use RuntimeException;
use think\facade\Db;

/** One bound call, with the caller's existing transaction and privileges. */
final class GroupTextWriter
{
    public function send(int $conversationId, int $senderId, array $body, string $requestId, bool $internalBroadcast): ?array
    {
        $routine = (string) env('GROUP_TEXT_WRITE_ROUTINE', '');
        if ($routine === '') return null;
        // This is an administrative setting, never an HTTP/body parameter.
        if (!preg_match('/^(?:pulse_group_text_send_v1|capacity_group_text_test_[a-f0-9]{12})$/D', $routine)) throw new RuntimeException('Invalid group write routine configuration.');
        $pdo = Db::connect()->getPdo();
        if (!$pdo instanceof PDO || !$pdo->inTransaction()) throw new RuntimeException('Group writer requires the caller transaction.');
        $body['request_id'] = $requestId;
        $statement = $pdo->prepare('CALL `' . $routine . '`(?,?,?,?,?,?)');
        try {
            $statement->execute([$conversationId, $senderId, $requestId, json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), date('Y-m-d H:i:s'), (int) $internalBroadcast]);
            $row = $statement->fetch(PDO::FETCH_ASSOC);
            while ($statement->nextRowset()) $statement->fetchAll(PDO::FETCH_ASSOC);
        } catch (PDOException $error) {
            $messages = [
                'GROUP_CONVERSATION_DISABLED' => '该会话已停用。',
                'GROUP_ACCOUNT_DISABLED' => '用户账号不可用。',
                'GROUP_NOT_MEMBER' => 'You are not a member of this conversation.',
                'GROUP_CHANNEL_RESTRICTED' => '只有频道所有者或管理员可以发布内容。',
                'GROUP_ALL_MUTED' => '该群组已开启全员禁言。',
                'GROUP_STAFF_RESTRICTED' => '无权使用内部人员功能。',
                'GROUP_ACCOUNT_MUTED' => 'Your account is muted.',
                'GROUP_MEMBER_MUTED' => 'You are muted in this conversation.',
                'GROUP_REQUEST_COLLISION' => '消息请求编号已被其他操作使用。',
                'GROUP_MESSAGE_DELETED' => '该消息已从你的聊天记录删除。',
            ];
            $key = $error->errorInfo[2] ?? '';
            if (($error->errorInfo[0] ?? '') === '45000' && isset($messages[$key])) throw new RuntimeException($messages[$key], 0, $error);
            throw $error;
        } finally {
            $statement->closeCursor();
        }
        if (!$row || !array_key_exists('__handled', $row)) throw new RuntimeException('Invalid group write response.');
        if (!(int) $row['__handled']) return null;
        $sender = ['id' => (int) $row['__sender_id'], 'nickname' => $row['__sender_name'], 'avatar_url' => $row['__sender_avatar']];
        $created = (bool) $row['__created'];
        foreach (array_keys($row) as $key) if (str_starts_with($key, '__')) unset($row[$key]);
        return ['row' => $row, 'sender' => $sender, 'created' => $created];
    }
}
