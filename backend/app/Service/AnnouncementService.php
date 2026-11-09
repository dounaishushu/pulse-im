<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** One global startup announcement, read from the primary database on each launch. */
final class AnnouncementService
{
    public function get(): array
    {
        $row = Db::name('client_announcements')->where('id', 1)->find();
        if (!$row) throw new RuntimeException('请先执行通知公告数据库迁移。');
        return $this->format($row);
    }

    public function active(): ?array
    {
        $row = $this->get();
        return $row['enabled'] ? $row : null;
    }

    public function save(array $payload, int $adminId, string $requestId, string $ip): array
    {
        $title = $payload['title'] ?? null;
        $content = $payload['content'] ?? null;
        $enabled = $payload['enabled'] ?? null;
        $revision = $payload['revision'] ?? null;
        if (!is_string($title) || trim($title) === '' || mb_strlen(trim($title)) > 32) {
            throw new RuntimeException('公告标题不能为空，最多32个字。');
        }
        if (!is_string($content) || trim($content) === '' || mb_strlen($content) > 4000) {
            throw new RuntimeException('公告正文不能为空，最多4000个字。');
        }
        if (!in_array($enabled, [true, false, 0, 1], true)) throw new RuntimeException('公告状态不正确。');
        if (!is_int($revision) || $revision < 1) throw new RuntimeException('公告版本不正确，请刷新后重试。');
        return Db::transaction(function () use ($title, $content, $enabled, $revision, $adminId, $requestId, $ip): array {
            $current = Db::name('client_announcements')->where('id', 1)->lock(true)->find();
            if (!$current) throw new RuntimeException('请先执行通知公告数据库迁移。');
            if ((int) $current['revision'] !== $revision) throw new RuntimeException('公告已被其他管理员修改，请刷新后重新编辑。');
            $data = ['title' => trim($title), 'content' => trim(str_replace(["\r\n", "\r"], "\n", $content)),
                'enabled' => (int) (bool) $enabled, 'revision' => $revision + 1, 'updated_at' => date('Y-m-d H:i:s')];
            Db::name('client_announcements')->where('id', 1)->update($data);
            (new AuditService())->log($adminId, 'announcement.update', 'announcement', 1, $requestId, $ip,
                ['title' => $data['title'], 'enabled' => (bool) $enabled, 'revision' => $data['revision']]);
            return $this->format(array_merge($current, $data));
        });
    }

    private function format(array $row): array
    {
        return ['id' => 1, 'title' => (string) $row['title'], 'content' => (string) $row['content'],
            'enabled' => (bool) $row['enabled'], 'revision' => (int) $row['revision'], 'updated_at' => (string) $row['updated_at']];
    }
}
