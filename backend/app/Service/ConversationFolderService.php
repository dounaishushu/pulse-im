<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

final class ConversationFolderService
{
    public static function scope(mixed $scope): string
    {
        if (!is_string($scope) || !in_array($scope, ['direct', 'groups'], true)) throw new RuntimeException('分组范围不正确。');
        return $scope;
    }

    public function list(int $userId, mixed $scope = null): array
    {
        $query = Db::name('conversation_folders')->where('user_id', $userId);
        if ($scope !== null) $query->where('scope', self::scope($scope));
        $folders = $query->order('sort_order')->order('id')->select()->toArray(); $items = [];
        if ($folders !== []) {
            $rows = Db::name('conversation_folder_items')->alias('i')
                ->join('conversation_folders f', 'f.id = i.folder_id')->join('conversations c', 'c.id = i.conversation_id')
                ->join('conversation_members m', 'm.conversation_id = c.id AND m.user_id = i.user_id')
                ->where('f.user_id', $userId)->where('i.user_id', $userId)->whereIn('f.id', array_column($folders, 'id'))
                ->where('c.status', 'active')->whereRaw("((f.scope = 'direct' AND c.type = 'direct') OR (f.scope = 'groups' AND c.type = 'group'))")
                ->field('i.folder_id,i.conversation_id')->order('i.conversation_id')->select()->toArray();
            foreach ($rows as $row) $items[(int) $row['folder_id']][] = (int) $row['conversation_id'];
        }
        return ['items' => array_map(static fn(array $folder): array => [
            'id' => (int) $folder['id'], 'name' => $folder['name'], 'scope' => self::scope($folder['scope']),
            'collapsed' => (bool) $folder['collapsed'], 'conversation_ids' => $items[(int) $folder['id']] ?? [], 'sort_order' => (int) $folder['sort_order'],
        ], $folders)];
    }

    public function create(int $userId, string $name, mixed $scope = 'direct'): array
    {
        $scope = self::scope($scope); $name = $this->name($name);
        try {
            return Db::transaction(function () use ($userId, $name, $scope): array {
                if (Db::name('conversation_folders')->where('user_id', $userId)->where('scope', $scope)->where('name', $name)->find()) throw new RuntimeException('这个分组已经存在。');
                $now = date('Y-m-d H:i:s');
                $sort = (int) Db::name('conversation_folders')->where('user_id', $userId)->where('scope', $scope)->max('sort_order') + 1;
                $id = Db::name('conversation_folders')->insertGetId(['user_id' => $userId, 'name' => $name, 'scope' => $scope, 'sort_order' => $sort, 'collapsed' => 1, 'created_at' => $now, 'updated_at' => $now]);
                return ['id' => (int) $id, 'name' => $name, 'scope' => $scope, 'collapsed' => true, 'conversation_ids' => [], 'sort_order' => $sort];
            });
        } catch (\think\db\exception\PDOException $error) { $this->rethrowNameCollision($error); }
    }

    public function toggle(int $userId, int $folderId, bool $collapsed, mixed $scope = null): array
    {
        if ($scope !== null) $scope = self::scope($scope);
        return Db::transaction(function () use ($userId, $folderId, $collapsed, $scope): array {
            $folder = $this->owned($userId, $folderId, $scope);
            Db::name('conversation_folders')->where('id', $folderId)->where('user_id', $userId)->update(['collapsed' => $collapsed ? 1 : 0, 'updated_at' => date('Y-m-d H:i:s')]);
            return ['id' => $folderId, 'scope' => $folder['scope'], 'collapsed' => $collapsed];
        });
    }

    public function rename(int $userId, int $folderId, string $name, mixed $scope = null): array
    {
        if ($scope !== null) $scope = self::scope($scope);
        $name = $this->name($name);
        try {
            return Db::transaction(function () use ($userId, $folderId, $name, $scope): array {
                $folder = $this->owned($userId, $folderId, $scope);
                if (Db::name('conversation_folders')->where('user_id', $userId)->where('scope', $folder['scope'])->where('name', $name)->where('id', '<>', $folderId)->find()) throw new RuntimeException('这个分组已经存在。');
                Db::name('conversation_folders')->where('id', $folderId)->where('user_id', $userId)->update(['name' => $name, 'updated_at' => date('Y-m-d H:i:s')]);
                return ['id' => $folderId, 'scope' => $folder['scope'], 'name' => $name];
            });
        } catch (\think\db\exception\PDOException $error) { $this->rethrowNameCollision($error); }
    }

    public function assign(int $userId, int $folderId, int $conversationId, mixed $scope = null): array
    {
        if ($scope !== null) $scope = self::scope($scope);
        return Db::transaction(function () use ($userId, $folderId, $conversationId, $scope): array {
            // Match existing leave/send lock order. Competing moves of the same
            // member serialize before replacing its unique assignment.
            $conversation = Db::name('conversations')->where('id', $conversationId)->where('status', 'active')->lock(true)->find();
            if (!$conversation) throw new RuntimeException('会话不存在或已停用。');
            if (!Db::name('conversation_members')->where('conversation_id', $conversationId)->where('user_id', $userId)->lock(true)->find()) throw new RuntimeException('你不是该会话成员。');
            if ($folderId === 0) {
                $conversationScope = match ($conversation['type']) {
                    'direct' => 'direct', 'group' => 'groups',
                    default => throw new RuntimeException('会话类型与分组范围不匹配。'),
                };
                if ($scope !== null && $scope !== $conversationScope) throw new RuntimeException('分组范围不匹配。');
                Db::name('conversation_folder_items')->where('user_id', $userId)->where('conversation_id', $conversationId)->delete();
                return ['folder_id' => 0, 'conversation_id' => $conversationId, 'scope' => $conversationScope];
            }
            $folder = $this->owned($userId, $folderId, $scope);
            if ($conversation['type'] !== ($folder['scope'] === 'direct' ? 'direct' : 'group')) throw new RuntimeException('会话类型与分组范围不匹配。');
            Db::name('conversation_folder_items')->where('user_id', $userId)->where('conversation_id', $conversationId)->delete();
            Db::name('conversation_folder_items')->insert(['folder_id' => $folderId, 'conversation_id' => $conversationId, 'user_id' => $userId, 'created_at' => date('Y-m-d H:i:s')]);
            return ['folder_id' => $folderId, 'conversation_id' => $conversationId, 'scope' => $folder['scope']];
        });
    }

    private function owned(int $userId, int $folderId, ?string $scope): array
    {
        $folder = Db::name('conversation_folders')->where('id', $folderId)->where('user_id', $userId)->lock(true)->find();
        if (!$folder) throw new RuntimeException('分组不存在。');
        self::scope($folder['scope']);
        if ($scope !== null && $scope !== $folder['scope']) throw new RuntimeException('分组范围不匹配。');
        return $folder;
    }
    private function name(string $name): string
    {
        $name = trim($name);
        if ($name === '' || mb_strlen($name) > 64) throw new RuntimeException('分组名称不能为空且不能超过 64 个字符。');
        return $name;
    }
    private function rethrowNameCollision(\think\db\exception\PDOException $error): never
    {
        $info = $error->getData()['PDO Error Info'] ?? [];
        if ((int) ($info['Driver Error Code'] ?? 0) === 1062 && preg_match("/for key ['`](?:[^'`]*\\.)?uk_folder_user_scope_name['`]/i", (string) ($info['Driver Error Message'] ?? ''))) throw new RuntimeException('这个分组已经存在。', 0, $error);
        throw $error;
    }
}
