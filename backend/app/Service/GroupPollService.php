<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

final class GroupPollService
{
    public function create(int $userId, int $conversationId, array $data): array
    {
        $question = trim((string) ($data['question'] ?? ''));
        $options = is_array($data['options'] ?? null) ? array_values($data['options']) : [];
        if ($question === '' || mb_strlen($question) > 200) throw new RuntimeException('投票问题需填写 1 至 200 个字符。');
        if (count($options) < 2 || count($options) > 10) throw new RuntimeException('请设置 2 至 10 个投票选项。');
        foreach ($options as &$option) {
            if (!is_string($option)) throw new RuntimeException('投票选项格式不正确。');
            $option = trim($option);
            if ($option === '' || mb_strlen($option) > 100) throw new RuntimeException('每个选项需填写 1 至 100 个字符。');
        }
        unset($option);
        if (count(array_unique($options)) !== count($options)) throw new RuntimeException('投票选项不能重复。');
        $requestId = (string) ($data['request_id'] ?? '');
        if (!preg_match('/^[A-Za-z0-9._:-]{8,80}$/', $requestId)) throw new RuntimeException('投票请求编号无效。');
        $hours = (int) ($data['duration_hours'] ?? 0);
        if ($hours < 0 || $hours > 24 * 30) throw new RuntimeException('投票时长需在 0 至 720 小时之间。');
        $multiple = (bool) ($data['multiple_choice'] ?? false);
        $filter = new SensitiveWordService();
        $question = $filter->filterText($question);
        $options = array_map(fn (string $value): string => $filter->filterText($value), $options);

        $result = Db::transaction(function () use ($userId, $conversationId, $question, $options, $requestId, $hours, $multiple): array {
            // 锁群行使同一个群中的重试串行，消息和投票在同一事务内落库。
            $group = Db::name('conversations')->where('id', $conversationId)->where('type', 'group')->lock(true)->find();
            if (!$group) throw new RuntimeException('群组不存在。');
            (new MessageService())->assertCanSend($conversationId, $userId);
            $existing = Db::name('group_polls')->where('request_id', $requestId)->find();
            if ($existing) {
                if ((int) $existing['creator_id'] !== $userId || (int) $existing['conversation_id'] !== $conversationId) throw new RuntimeException('投票请求编号已经使用。');
                return ['id' => (int) $existing['id'], 'created' => false];
            }
            $now = date('Y-m-d H:i:s');
            $pollId = (int) Db::name('group_polls')->insertGetId([
                'conversation_id' => $conversationId, 'creator_id' => $userId, 'question' => $question,
                'multiple_choice' => $multiple ? 1 : 0, 'request_id' => $requestId,
                'expires_at' => $hours === 0 ? null : date('Y-m-d H:i:s', time() + $hours * 3600),
                'created_at' => $now,
            ]);
            $rows = [];
            foreach ($options as $index => $label) $rows[] = ['poll_id' => $pollId, 'label' => $label, 'sort_order' => $index];
            Db::name('group_poll_options')->insertAll($rows);
            // 使用系统消息兼容尚未更新的手机端，旧端仍能看到投票问题。
            $body = ['poll_id' => $pollId, 'text' => '发起投票：' . $question, 'request_id' => $requestId];
            $messageId = (int) Db::name('messages')->insertGetId([
                'conversation_id' => $conversationId, 'sender_id' => $userId, 'type' => 'system',
                'request_id' => $requestId, 'body_json' => json_encode($body, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), 'created_at' => $now,
            ]);
            Db::name('group_polls')->where('id', $pollId)->update(['message_id' => $messageId]);
            Db::name('conversations')->where('id', $conversationId)->update(['updated_at' => $now]);
            return ['id' => $pollId, 'created' => true];
        });
        $poll = $this->detail($userId, $result['id']);
        $message = $this->message($poll['message_id'], $userId);
        if ($result['created']) (new RealtimePublisher())->publish($message);
        return ['poll' => $poll, 'message' => $message];
    }

    public function list(int $userId, int $conversationId, array $ids): array
    {
        $profile = (new ConversationService())->groupProfile($userId, $conversationId);
        $ids = array_values(array_unique(array_filter(array_map('intval', $ids), fn (int $id): bool => $id > 0)));
        if (count($ids) > 50) throw new RuntimeException('一次最多读取 50 个投票。');
        if ($ids === []) return ['items' => []];
        $polls = Db::name('group_polls')->where('conversation_id', $conversationId)->whereIn('id', $ids)->select()->toArray();
        if ($polls === []) return ['items' => []];
        $pollIds = array_column($polls, 'id');
        $options = Db::name('group_poll_options')->whereIn('poll_id', $pollIds)->order('sort_order', 'asc')->select()->toArray();
        $counts = Db::name('group_poll_votes')->whereIn('poll_id', $pollIds)->field('option_id,COUNT(*) AS votes')->group('option_id')->select()->toArray();
        $totals = Db::name('group_poll_votes')->whereIn('poll_id', $pollIds)->field('poll_id,COUNT(DISTINCT user_id) AS voters')->group('poll_id')->select()->toArray();
        $mine = Db::name('group_poll_votes')->whereIn('poll_id', $pollIds)->where('user_id', $userId)->field('poll_id,option_id')->select()->toArray();
        $countMap = array_column($counts, 'votes', 'option_id');
        $totalMap = array_column($totals, 'voters', 'poll_id');
        $items = [];
        $filter = new SensitiveWordService();
        foreach ($polls as $poll) {
            $pollId = (int) $poll['id'];
            $voters = (int) ($totalMap[$pollId] ?? 0);
            $items[] = [
                'id' => $pollId, 'conversation_id' => $conversationId, 'message_id' => (int) $poll['message_id'],
                'question' => $filter->filterText($poll['question']), 'multiple_choice' => (bool) $poll['multiple_choice'],
                'closed' => $poll['closed_at'] !== null || ($poll['expires_at'] !== null && strtotime($poll['expires_at']) <= time()),
                'expires_at' => $poll['expires_at'], 'voter_count' => $voters,
                'can_close' => (int) $poll['creator_id'] === $userId || $profile['can_manage'],
                'selected_option_ids' => array_values(array_map(fn (array $row): int => (int) $row['option_id'], array_filter($mine, fn (array $row): bool => (int) $row['poll_id'] === $pollId))),
                'options' => array_values(array_map(function (array $row) use ($countMap, $voters, $filter): array {
                    $votes = (int) ($countMap[$row['id']] ?? 0);
                    return ['id' => (int) $row['id'], 'label' => $filter->filterText($row['label']), 'votes' => $votes, 'percent' => $voters ? round($votes / $voters * 100) : 0];
                }, array_filter($options, fn (array $row): bool => (int) $row['poll_id'] === $pollId))),
            ];
        }
        return ['items' => $items];
    }

    public function detail(int $userId, int $pollId): array
    {
        $poll = Db::name('group_polls')->where('id', $pollId)->find();
        if (!$poll) throw new RuntimeException('投票不存在。');
        return $this->list($userId, (int) $poll['conversation_id'], [$pollId])['items'][0];
    }

    public function vote(int $userId, int $pollId, array $optionIds): array
    {
        $ids = array_values(array_unique(array_map('intval', $optionIds)));
        if (count($ids) < 1 || count($ids) > 10) throw new RuntimeException('请选择投票选项。');
        Db::transaction(function () use ($userId, $pollId, $ids): void {
            $poll = Db::name('group_polls')->where('id', $pollId)->lock(true)->find();
            if (!$poll) throw new RuntimeException('投票不存在。');
            (new ConversationService())->groupProfile($userId, (int) $poll['conversation_id']);
            (new MessageService())->assertCanSend((int) $poll['conversation_id'], $userId);
            if ($poll['closed_at'] !== null || ($poll['expires_at'] !== null && strtotime($poll['expires_at']) <= time())) throw new RuntimeException('该投票已经结束。');
            if (!(bool) $poll['multiple_choice'] && count($ids) !== 1) throw new RuntimeException('此投票只能选择一个选项。');
            if (Db::name('group_poll_options')->where('poll_id', $pollId)->whereIn('id', $ids)->count() !== count($ids)) throw new RuntimeException('投票选项无效。');
            // 单个投票行锁 + 唯一键防重复票，允许重新选择。
            Db::name('group_poll_votes')->where('poll_id', $pollId)->where('user_id', $userId)->delete();
            $rows = [];
            foreach ($ids as $optionId) $rows[] = ['poll_id' => $pollId, 'option_id' => $optionId, 'user_id' => $userId, 'created_at' => date('Y-m-d H:i:s')];
            Db::name('group_poll_votes')->insertAll($rows);
        });
        return $this->detail($userId, $pollId);
    }

    public function close(int $userId, int $pollId): array
    {
        Db::transaction(function () use ($userId, $pollId): void {
            $poll = Db::name('group_polls')->where('id', $pollId)->lock(true)->find();
            if (!$poll) throw new RuntimeException('投票不存在。');
            $profile = (new ConversationService())->groupProfile($userId, (int) $poll['conversation_id']);
            if ((int) $poll['creator_id'] !== $userId && !$profile['can_manage']) throw new RuntimeException('只有发起人、群主或管理员可以结束投票。');
            if ($poll['closed_at'] === null) Db::name('group_polls')->where('id', $pollId)->update(['closed_at' => date('Y-m-d H:i:s')]);
        });
        return $this->detail($userId, $pollId);
    }

    private function message(int $messageId, int $viewerId): array
    {
        $row = Db::name('messages')->where('id', $messageId)->find();
        return (new MessageService())->format($row, $viewerId);
    }
}
