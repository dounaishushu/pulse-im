<?php
declare(strict_types=1);

/** Additive migration: never rewrites memberships, offsets or application secrets. */
function groupDisplayCountMigrate(PDO $pdo, string $table, bool $apply): array
{
    if (!preg_match('/^[A-Za-z0-9_]+$/D', $table)) throw new RuntimeException('群组表名称无效。');
    $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    if (!in_array($driver, ['mysql', 'sqlite'], true)) throw new RuntimeException('不支持当前数据库类型。');
    $column = static function () use ($pdo, $driver, $table): ?array {
        $rows = $pdo->query($driver === 'mysql' ? "SHOW COLUMNS FROM `$table`" : "PRAGMA table_info(`$table`)")->fetchAll(PDO::FETCH_ASSOC);
        if (!$rows) throw new RuntimeException('群组表不存在或无权读取。');
        foreach ($rows as $row) if (($row[$driver === 'mysql' ? 'Field' : 'name'] ?? '') === 'member_count_offset') return $row;
        return null;
    };
    $existing = $column(); $changed = false;
    if ($existing === null && $apply) {
        try { $pdo->exec("ALTER TABLE `$table` ADD COLUMN `member_count_offset` INT NOT NULL DEFAULT 0"); $changed = true; }
        catch (Throwable $error) { if ($column() === null) throw $error; }
        $existing = $column();
    }
    if ($existing !== null) {
        $type = strtolower((string) ($existing[$driver === 'mysql' ? 'Type' : 'type'] ?? ''));
        if (!preg_match('/^int(?:\(\d+\))?$/D', $type) || str_contains($type, 'unsigned')) throw new RuntimeException('已有显示人数字段类型不兼容，请先核对。');
    }
    return ['ok' => true, 'migration_required' => $existing === null, 'column_ready' => $existing !== null,
        'database_changed' => $changed, 'membership_changed' => false];
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
    try {
        $mode = $argv[1] ?? '--check'; $root = realpath($argv[2] ?? '');
        if (!in_array($mode, ['--check', '--apply', '--verify'], true) || !$root || !is_file($root . '/backend/vendor/autoload.php') || !is_file($root . '/backend/public/index.php')) throw new RuntimeException('用法：php apply-group-display-count-migration.php --check|--apply|--verify IM项目目录');
        require $root . '/backend/vendor/autoload.php';
        (new think\App($root . '/backend/'))->initialize();
        $connection = think\facade\Db::connect(); $table = think\facade\Db::name('conversations')->getTable();
        $result = groupDisplayCountMigrate($connection->connect(), $table, $mode === '--apply');
        if ($mode !== '--check' && $result['column_ready']) $connection->getSchemaInfo($table, true);
        if ($mode === '--verify' && !$result['column_ready']) throw new RuntimeException('显示人数字段尚未创建，请先执行迁移。');
        echo json_encode(['mode' => $mode] + $result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL;
    } catch (Throwable $error) {
        $message = $error instanceof PDOException ? '数据库迁移未完成，请检查数据库连接、群组表及ALTER权限。' : $error->getMessage();
        fwrite(STDERR, json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE) . PHP_EOL); exit(1);
    }
}
