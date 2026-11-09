<?php
namespace app\Service;

use RuntimeException;

/** Page permissions and an explicit method/path policy; unknown routes are denied. */
final class AdminPermissionService
{
    public static function catalog(): array
    {
        $pages = [
            'dashboard' => '运营总览', 'users' => '用户管理', 'devices' => '设备管理', 'groups' => '群组管理',
            'messages' => '消息与会话', 'moderation' => '内容审核', 'sensitive-words' => '敏感词管理',
            'login-logs' => '系统日志', 'announcement' => '通知公告', 'client-config' => '客户端配置',
            'routes' => '线路管理', 'task-config' => '任务配置', 'question-bank' => '题库管理',
            'task-records' => '作业记录', 'dispatch-tasks' => '分发任务', 'maintenance' => '数据清理',
        ];
        $items = [];
        foreach ($pages as $key => $title) $items[] = ['key' => $key, 'title' => $title, 'view' => $key . '.view',
            'manage' => in_array($key, ['dashboard', 'login-logs'], true) ? null : $key . '.manage'];
        return $items;
    }

    public static function all(): array
    {
        $all = [];
        foreach (self::catalog() as $item) { $all[] = $item['view']; if ($item['manage'] !== null) $all[] = $item['manage']; }
        return $all;
    }

    public static function normalize(array $permissions, string $role = 'operator'): array
    {
        if (!array_is_list($permissions)) throw new RuntimeException('页面权限必须为数组。');
        $known = array_flip(self::all()); $selected = [];
        foreach ($permissions as $permission) {
            if (!is_string($permission) || !isset($known[$permission])) throw new RuntimeException('包含未知页面权限。');
            if ($role === 'auditor' && str_ends_with($permission, '.manage')) throw new RuntimeException('只读管理员不能分配管理权限。');
            $selected[$permission] = true;
            if (str_ends_with($permission, '.manage')) $selected[substr($permission, 0, -7) . '.view'] = true;
        }
        return array_values(array_filter(self::all(), static fn (string $key): bool => isset($selected[$key])));
    }

    public static function permissions(array $account): array
    {
        $role = (string) ($account['role'] ?? '');
        if ($role === 'admin') return self::all();
        if (!in_array($role, ['operator', 'auditor'], true)) return [];
        if (array_key_exists('permissions_json', $account)) {
            $raw = $account['permissions_json'];
            if ($raw === null) return self::legacy($role);
            $values = is_string($raw) ? json_decode($raw, true) : $raw;
        } elseif (array_key_exists('permissions', $account)) $values = $account['permissions'];
        else return self::legacy($role);
        if (!is_array($values) || !array_is_list($values)) return [];
        $known = array_flip(self::all());
        $values = array_values(array_filter($values, static fn ($value): bool => is_string($value) && isset($known[$value]) && ($role !== 'auditor' || !str_ends_with($value, '.manage'))));
        return self::normalize($values, $role);
    }

    public static function allows(array $account, string $permission): bool
    {
        return in_array($permission, self::permissions($account), true);
    }

    private static function legacy(string $role): array
    {
        return array_values(array_filter(self::all(), static fn (string $key): bool => !str_starts_with($key, 'maintenance.') && !str_starts_with($key, 'dispatch-tasks.') && ($role === 'auditor'
            ? str_ends_with($key, '.view') : !in_array($key, ['client-config.manage', 'routes.manage', 'devices.manage'], true))));
    }

    public static function requirements(string $method, string $path): ?array
    {
        $path = strtolower(preg_replace('~^(?:(?:index\.php|api)/)+~', '', trim($path, '/')));
        $method = strtoupper($method); if ($method === 'HEAD') $method = 'GET';
        $read = [
            'admin/maintenance/config' => ['maintenance.view'], 'admin/maintenance/preview' => ['maintenance.view'],
            'admin/maintenance/cache-preview' => ['maintenance.view'], 'admin/maintenance/runs' => ['maintenance.view'], 'admin/maintenance/run' => ['maintenance.view'],
            'admin/mobile-devices' => ['devices.view'],
            'admin/stats' => ['dashboard.view'], 'admin/stats/regions' => ['dashboard.view'], 'admin/stats/offsite-logins' => ['dashboard.view'],
            'admin/users' => ['users.view'], 'admin/users/ip-locations' => ['users.view'], 'admin/users/devices' => ['users.view'],
            'admin/groups' => ['groups.view'], 'admin/groups/detail' => ['groups.view'],
            'admin/messages' => ['messages.view', 'moderation.view'], 'admin/sensitive-words' => ['sensitive-words.view'],
            'admin/login-logs' => ['login-logs.view'], 'admin/audit-logs' => ['login-logs.view'],
            'admin/announcement' => ['announcement.view'], 'admin/client-config' => ['client-config.view'],
            'admin/client-navigation' => ['client-config.view'], 'admin/client-routes' => ['routes.view'],
            'admin/work-tasks' => ['task-config.view'], 'admin/work-tasks/code' => ['task-config.manage'],
            'admin/work-questions' => ['question-bank.view'], 'admin/work-questions/template' => ['question-bank.view'], 'admin/work-questions/export' => ['question-bank.view'],
            'admin/work-records' => ['task-records.view'], 'admin/work-records/detail' => ['task-records.view'],
            'admin/work-records/export' => ['task-records.view'], 'admin/work-records/task-options' => ['task-records.view'],
            'admin/accounts' => ['@super_admin'], 'admin/accounts/permissions' => ['@super_admin'],
            'admin/dispatch-tasks' => ['dispatch-tasks.view'], 'admin/dispatch-tasks/detail' => ['dispatch-tasks.view'],
            'admin/dispatch-tasks/options' => ['dispatch-tasks.view'],
        ];
        $write = [
            'admin/maintenance/config' => ['maintenance.manage'], 'admin/maintenance/run' => ['maintenance.manage'],
            'admin/users/password/reveal' => ['@super_admin'],
            'admin/mobile-devices/unbind' => ['devices.manage'], 'admin/mobile-devices/unbind-all' => ['devices.manage'], 'admin/mobile-devices/policy' => ['devices.manage'],
            'admin/stats/regions/resolve' => ['dashboard.view'], 'admin/stats/offsite-logins/resolve' => ['dashboard.view'],
            'admin/users' => ['users.manage'], 'admin/users/batch' => ['users.manage'], 'admin/users/edit' => ['users.manage'],
            'admin/users/avatar' => ['users.manage', 'groups.manage'], 'admin/users/status' => ['users.manage'], 'admin/users/permission' => ['users.manage'],
            'admin/users/clear-chat' => ['users.manage'], 'admin/users/reset-token' => ['users.manage'], 'admin/users/logout' => ['users.manage'], 'admin/users/delete' => ['users.manage'],
            'admin/groups/create' => ['groups.manage'], 'admin/groups/update' => ['groups.manage'], 'admin/groups/delete' => ['groups.manage'],
            'admin/messages/recall' => ['messages.manage', 'moderation.manage'],
            'admin/sensitive-words' => ['sensitive-words.manage'], 'admin/sensitive-words/edit' => ['sensitive-words.manage'],
            'admin/sensitive-words/delete' => ['sensitive-words.manage'], 'admin/sensitive-words/batch-delete' => ['sensitive-words.manage'],
            'admin/announcement' => ['announcement.manage'], 'admin/client-config' => ['client-config.manage'], 'admin/client-navigation' => ['client-config.manage'],
            'admin/client-routes' => ['routes.manage'], 'admin/client-routes/delete' => ['routes.manage'],
            'admin/work-tasks' => ['task-config.manage'], 'admin/work-tasks/status' => ['task-config.manage'], 'admin/work-tasks/delete' => ['task-config.manage'],
            'admin/work-questions' => ['question-bank.manage'], 'admin/work-questions/delete' => ['question-bank.manage'],
            'admin/work-questions/import' => ['question-bank.manage'], 'admin/work-questions/upload' => ['question-bank.manage'],
            'admin/work-records/review' => ['task-records.manage'],
            'admin/accounts' => ['@super_admin'], 'admin/accounts/update' => ['@super_admin'], 'admin/accounts/status' => ['@super_admin'],
            'admin/dispatch-tasks' => ['dispatch-tasks.manage'], 'admin/dispatch-tasks/status' => ['dispatch-tasks.manage'],
            'admin/dispatch-tasks/delete' => ['dispatch-tasks.manage'],
            'admin/dispatch-tasks/upload' => ['dispatch-tasks.manage'],
        ];
        return match ($method) { 'GET' => $read[$path] ?? null, 'POST' => $write[$path] ?? null, default => null };
    }

    public static function allowsRoute(array $account, string $method, string $path): bool
    {
        $requirements = self::requirements($method, $path);
        if ($requirements === null) return false;
        if (in_array('@super_admin', $requirements, true)) return ($account['role'] ?? '') === 'admin';
        foreach ($requirements as $permission) if (self::allows($account, $permission)) return true;
        return false;
    }
}
