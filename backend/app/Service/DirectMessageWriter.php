<?php
declare(strict_types=1);

namespace app\Service;

use PDO;
use PDOException;
use RuntimeException;
use think\facade\Db;

/** Commit the common private send on the DB host, without network trips under the event lock. */
final class DirectMessageWriter
{
    public function send(int $conversationId, int $senderId, string $type, array $body, string $requestId, bool $internalBroadcast): ?array
    {
        $routine = (string) env('DIRECT_MESSAGE_WRITE_ROUTINE', '');
        if ($routine === '' || !in_array($type, ['text', 'image', 'video', 'file', 'voice'], true)
            || isset($body['reply_to_id']) || array_key_exists('mention_all', $body) || array_key_exists('mention_user_ids', $body)) return null;
        if (!preg_match('/^(?:pulse_direct_message_send_v1|capacity_direct_send_test_[a-f0-9]{12})$/D', $routine)) throw new RuntimeException('Invalid direct write routine configuration.');
        // A nested send must keep the original caller's rollback boundary. Never
        // invoke a transaction-owning procedure from an existing transaction.
        $connection = Db::connect();
        $pdo = $connection->getPdo();
        if (!$pdo instanceof PDO) {
            $connection->query('SELECT 1');
            $pdo = $connection->getPdo();
        }
        if (!$pdo instanceof PDO) throw new RuntimeException('Direct writer connection unavailable.');
        if ($pdo->inTransaction()) return null;
        $body['request_id'] = $requestId;
        $json = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $media = new MediaAccessService();
        $paths = [];
        foreach (['url', 'thumbnail_url'] as $key) $paths[] = isset($body[$key]) && is_string($body[$key]) ? $media->pathFromUrl($body[$key]) : null;
        for ($attempt = 1; ; $attempt++) {
            $statement = $pdo->prepare('CALL `' . $routine . '`(?,?,?,?,?,?,?,?,?)');
            try {
                $statement->execute([$conversationId, $senderId, $type, $requestId, $json, date('Y-m-d H:i:s'), (int) $internalBroadcast, $paths[0], $paths[1]]);
                $row = $statement->fetch(PDO::FETCH_ASSOC);
                while ($statement->nextRowset()) $statement->fetchAll(PDO::FETCH_ASSOC);
                break;
            } catch (PDOException $error) {
                // Only a proven, rolled-back MySQL deadlock is safe to retry.
                // Connection failures can have an unknown commit outcome.
                if (($error->errorInfo[0] ?? '') === '40001' && (int) ($error->errorInfo[1] ?? 0) === 1213 && $attempt < 3 && !$pdo->inTransaction()) {
                    $statement->closeCursor();
                    usleep($attempt * 10000);
                    continue;
                }
                $messages = [
                    'DIRECT_CONVERSATION_DISABLED' => '该会话已停用。',
                    'DIRECT_ACCOUNT_DISABLED' => '用户账号不可用。',
                    'DIRECT_NOT_MEMBER' => 'You are not a member of this conversation.',
                    'DIRECT_BLOCKED' => '已屏蔽的用户无法通过私聊联系。',
                    'DIRECT_STAFF_RESTRICTED' => '无权使用内部人员功能。',
                    'DIRECT_ACCOUNT_MUTED' => 'Your account is muted.',
                    'DIRECT_MEMBER_MUTED' => 'You are muted in this conversation.',
                    'DIRECT_REQUEST_COLLISION' => '消息请求编号已被其他操作使用。',
                    'DIRECT_MESSAGE_DELETED' => '该消息已从你的聊天记录删除。',
                ];
                $key = $error->errorInfo[2] ?? '';
                if (($error->errorInfo[0] ?? '') === '45000' && isset($messages[$key])) throw new RuntimeException($messages[$key], 0, $error);
                throw $error;
            } finally {
                $statement->closeCursor();
            }
        }
        if (!$row || !array_key_exists('__handled', $row) || $pdo->inTransaction()) throw new RuntimeException('Invalid direct write response.');
        if (!(int) $row['__handled']) return null;
        $sender = ['id' => (int) $row['__sender_id'], 'nickname' => $row['__sender_name'], 'avatar_url' => $row['__sender_avatar']];
        $created = (bool) $row['__created'];
        foreach (array_keys($row) as $key) if (str_starts_with($key, '__')) unset($row[$key]);
        return ['row' => $row, 'sender' => $sender, 'created' => $created];
    }
}
