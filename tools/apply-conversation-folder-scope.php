<?php
declare(strict_types=1);

/** Dedicated incremental migration. Requiring it never boots the application. */
final class ConversationFolderScopeMigration
{
    private readonly string $database;
    public function __construct(private readonly PDO $pdo, private readonly string $prefix = '', private readonly ?Closure $checkpoint = null)
    {
        if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) !== 'mysql' || !preg_match('/^[A-Za-z0-9_]*$/D', $prefix) || strlen($prefix . 'conversation_folder_items') > 64) throw new RuntimeException('unsupported_database_or_prefix');
        $this->database = (string) $pdo->query('SELECT DATABASE()')->fetchColumn();
        if ($this->database === '') throw new RuntimeException('database_not_selected');
    }
    private function table(string $name): string { return '`' . $this->prefix . $name . '`'; }
    private function rows(string $sql, array $bindings = []): array
    {
        $statement = $this->pdo->prepare($sql); $statement->execute($bindings); return $statement->fetchAll(PDO::FETCH_ASSOC);
    }
    private function selected(): void
    {
        if ($this->pdo->query('SELECT DATABASE()')->fetchColumn() !== $this->database) throw new RuntimeException('selected_database_changed');
    }
    private function index(string $table, string $name, array $columns, bool $unique): bool
    {
        $rows = $this->rows('SELECT NON_UNIQUE,COLUMN_NAME,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=? ORDER BY SEQ_IN_INDEX', [$this->database, $this->prefix . $table, $name]);
        if ($rows === []) return false;
        if (array_column($rows, 'COLUMN_NAME') !== $columns || array_filter($rows, static fn(array $row): bool => (int) $row['NON_UNIQUE'] !== ($unique ? 0 : 1) || $row['SUB_PART'] !== null)) throw new RuntimeException('incompatible_folder_index');
        return true;
    }
    public function check(): array
    {
        $this->selected();
        foreach (['users', 'conversations', 'conversation_folders', 'conversation_folder_items'] as $table) {
            $rows = $this->rows('SELECT TABLE_TYPE,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [$this->database, $this->prefix . $table]);
            if (count($rows) !== 1 || $rows[0]['TABLE_TYPE'] !== 'BASE TABLE' || strcasecmp((string) $rows[0]['ENGINE'], 'InnoDB') !== 0) throw new RuntimeException('folder_migration_requires_innodb_tables');
        }
        $folders = $this->table('conversation_folders'); $items = $this->table('conversation_folder_items'); $conversations = $this->table('conversations'); $users = $this->table('users');
        $column = $this->rows('SELECT DATA_TYPE,CHARACTER_MAXIMUM_LENGTH,CHARACTER_SET_NAME,COLLATION_NAME,IS_NULLABLE,COLUMN_DEFAULT,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?', [$this->database, $this->prefix . 'conversation_folders', 'scope']);
        $scoped = $column !== [];
        if ($scoped && ($column[0]['DATA_TYPE'] !== 'varchar' || (int) $column[0]['CHARACTER_MAXIMUM_LENGTH'] !== 8 || $column[0]['CHARACTER_SET_NAME'] !== 'ascii' || $column[0]['COLLATION_NAME'] !== 'ascii_bin' || $column[0]['IS_NULLABLE'] !== 'NO' || $column[0]['COLUMN_DEFAULT'] !== 'direct' || $column[0]['EXTRA'] !== '')) throw new RuntimeException('incompatible_folder_scope_column');
        $old = $this->index('conversation_folders', 'uk_folder_user_name', ['user_id', 'name'], true);
        $named = $this->index('conversation_folders', 'uk_folder_user_scope_name', ['user_id', 'scope', 'name'], true);
        $order = $this->index('conversation_folders', 'idx_folder_user_scope_order', ['user_id', 'scope', 'sort_order', 'id'], false);
        $oldOrder = $this->index('conversation_folders', 'idx_folder_user_order', ['user_id', 'sort_order', 'id'], false);
        $itemUnique = $this->index('conversation_folder_items', 'uk_folder_item_user_conversation', ['user_id', 'conversation_id'], true);
        $itemOld = $this->index('conversation_folder_items', 'idx_folder_item_user', ['user_id', 'conversation_id'], false);
        if (!$scoped && ($named || $order)) throw new RuntimeException('incompatible_folder_index');
        if ($this->rows("SELECT f.id FROM {$folders} f LEFT JOIN {$users} u ON u.id=f.user_id WHERE u.id IS NULL OR CHAR_LENGTH(TRIM(f.name))=0 OR CHAR_LENGTH(f.name)>64 LIMIT 1") !== []) throw new RuntimeException('corrupt_folder_owner_or_name');
        if ($this->rows("SELECT i.folder_id FROM {$items} i LEFT JOIN {$folders} f ON f.id=i.folder_id LEFT JOIN {$conversations} c ON c.id=i.conversation_id LEFT JOIN {$users} u ON u.id=i.user_id WHERE f.id IS NULL OR c.id IS NULL OR u.id IS NULL OR i.user_id<>f.user_id LIMIT 1") !== []) throw new RuntimeException('corrupt_folder_assignment');
        if ($this->rows("SELECT user_id,conversation_id FROM {$items} GROUP BY user_id,conversation_id HAVING COUNT(*)>1 LIMIT 1") !== []) throw new RuntimeException('conflicting_folder_assignments');
        if ($this->rows("SELECT i.folder_id FROM {$items} i JOIN {$conversations} c ON c.id=i.conversation_id WHERE c.type NOT IN ('direct','group') LIMIT 1") !== []) throw new RuntimeException('unsupported_legacy_conversation_type');
        if ($scoped && $this->rows("SELECT id FROM {$folders} WHERE scope NOT IN ('direct','groups') LIMIT 1") !== []) throw new RuntimeException('invalid_folder_scope');
        $scopeExpr = $scoped ? 'f.scope' : "'direct'";
        if ($this->rows("SELECT f.user_id,f.name,{$scopeExpr} FROM {$folders} f GROUP BY f.user_id,{$scopeExpr},f.name HAVING COUNT(*)>1 LIMIT 1") !== []) throw new RuntimeException('conflicting_folder_names');
        if ($scoped && $this->rows("SELECT f.id FROM {$folders} f JOIN {$items} i ON i.folder_id=f.id JOIN {$conversations} c ON c.id=i.conversation_id WHERE f.scope='groups' AND c.type<>'group' LIMIT 1") !== []) throw new RuntimeException('corrupt_groups_scope_assignment');
        $pending = $this->rows("SELECT f.id,f.user_id,f.name,MAX(c.type='direct') AS has_direct FROM {$folders} f JOIN {$items} i ON i.folder_id=f.id JOIN {$conversations} c ON c.id=i.conversation_id WHERE {$scopeExpr}='direct' GROUP BY f.id,f.user_id,f.name HAVING MAX(c.type='group')=1 ORDER BY f.id");
        if ($scoped) foreach ($pending as $row) if ($this->rows("SELECT id FROM {$folders} WHERE user_id=? AND scope='groups' AND name=? LIMIT 1", [$row['user_id'], $row['name']]) !== []) throw new RuntimeException('unknown_existing_groups_split_target');
        return ['scope_column_exists' => $scoped, 'scoped_name_index' => $named, 'legacy_name_index' => $old, 'scoped_order_index' => $order, 'legacy_order_index' => $oldOrder,
            'unique_assignment_index' => $itemUnique, 'legacy_assignment_index' => $itemOld, 'folders' => (int) $this->pdo->query("SELECT COUNT(*) FROM {$folders}")->fetchColumn(),
            'assignments' => (int) $this->pdo->query("SELECT COUNT(*) FROM {$items}")->fetchColumn(), 'pending_folders' => count($pending), 'pending_mixed' => count(array_filter($pending, static fn(array $row): bool => (bool) $row['has_direct']))];
    }
    public function apply(?int $maxFolders = null): array
    {
        if ($maxFolders !== null && $maxFolders < 1) throw new RuntimeException('invalid_folder_limit');
        if ($this->pdo->inTransaction()) throw new RuntimeException('migration_requires_no_active_transaction_ddl_implicitly_commits');
        $lockName = 'pulse-folder-scope-' . substr(hash('sha256', $this->database . '/' . $this->prefix), 0, 40);
        if ((int) $this->rows('SELECT GET_LOCK(?,0) AS locked', [$lockName])[0]['locked'] !== 1) throw new RuntimeException('folder_scope_migration_already_running');
        try {
            $before = $this->check(); $folders = $this->table('conversation_folders'); $items = $this->table('conversation_folder_items'); $conversations = $this->table('conversations'); $alter = [];
            if (!$before['scope_column_exists']) $alter[] = "ADD COLUMN scope VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'direct'";
            if ($before['legacy_name_index']) $alter[] = 'DROP INDEX uk_folder_user_name';
            if (!$before['scoped_name_index']) $alter[] = 'ADD UNIQUE KEY uk_folder_user_scope_name(user_id,scope,name)';
            if ($before['legacy_order_index']) $alter[] = 'DROP INDEX idx_folder_user_order';
            if (!$before['scoped_order_index']) $alter[] = 'ADD KEY idx_folder_user_scope_order(user_id,scope,sort_order,id)';
            if ($alter !== []) $this->pdo->exec("ALTER TABLE {$folders} " . implode(',', $alter));
            $this->hit('after_folders_ddl');
            $alter = [];
            if ($before['legacy_assignment_index']) $alter[] = 'DROP INDEX idx_folder_item_user';
            if (!$before['unique_assignment_index']) $alter[] = 'ADD UNIQUE KEY uk_folder_item_user_conversation(user_id,conversation_id)';
            if ($alter !== []) $this->pdo->exec("ALTER TABLE {$items} " . implode(',', $alter));
            $this->hit('after_items_ddl'); $changed = 0; $splits = [];
            $pending = $this->rows("SELECT DISTINCT f.id FROM {$folders} f JOIN {$items} i ON i.folder_id=f.id JOIN {$conversations} c ON c.id=i.conversation_id WHERE f.scope='direct' AND c.type='group' ORDER BY f.id" . ($maxFolders === null ? '' : ' LIMIT ' . $maxFolders));
            foreach ($pending as $row) {
                $this->selected(); $this->pdo->beginTransaction();
                try {
                    $source = $this->rows("SELECT * FROM {$folders} WHERE id=? FOR UPDATE", [$row['id']])[0];
                    $assigned = $this->rows("SELECT i.*,c.type FROM {$items} i JOIN {$conversations} c ON c.id=i.conversation_id WHERE i.folder_id=? ORDER BY i.conversation_id FOR UPDATE", [$row['id']]);
                    if ($source['scope'] !== 'direct') throw new RuntimeException('folder_changed_during_migration');
                    $direct = false; $groupIds = [];
                    foreach ($assigned as $item) {
                        if ((int) $item['user_id'] !== (int) $source['user_id'] || !in_array($item['type'], ['direct', 'group'], true)) throw new RuntimeException('folder_changed_during_migration');
                        if ($item['type'] === 'direct') $direct = true; else $groupIds[] = $item['conversation_id'];
                    }
                    if ($groupIds === []) { $this->pdo->commit(); continue; }
                    if ($this->rows("SELECT id FROM {$folders} WHERE user_id=? AND scope='groups' AND name=? FOR UPDATE", [$source['user_id'], $source['name']]) !== []) throw new RuntimeException('unknown_existing_groups_split_target');
                    $split = null;
                    if (!$direct) {
                        $statement = $this->pdo->prepare("UPDATE {$folders} SET scope='groups' WHERE id=?"); $statement->execute([$source['id']]);
                    } else {
                        $statement = $this->pdo->prepare("INSERT INTO {$folders} (user_id,name,scope,sort_order,collapsed,created_at,updated_at) VALUES (?,?,'groups',?,?,?,?)");
                        $statement->execute([$source['user_id'], $source['name'], $source['sort_order'], $source['collapsed'], $source['created_at'], $source['updated_at']]);
                        $targetId = (int) $this->pdo->lastInsertId(); $this->hit('after_split_insert');
                        $statement = $this->pdo->prepare("UPDATE {$items} SET folder_id=? WHERE folder_id=? AND user_id=? AND conversation_id IN (" . implode(',', array_fill(0, count($groupIds), '?')) . ')');
                        $statement->execute([$targetId, $source['id'], $source['user_id'], ...$groupIds]);
                        if ($statement->rowCount() !== count($groupIds)) throw new RuntimeException('folder_changed_during_migration');
                        $split = ['source_id' => (int) $source['id'], 'groups_id' => $targetId];
                    }
                    $this->hit('before_folder_commit'); $this->pdo->commit(); $changed++;
                    if ($split !== null) $splits[] = $split;
                } catch (Throwable $error) { if ($this->pdo->inTransaction()) $this->pdo->rollBack(); throw $error; }
            }
            return $this->check() + ['changed' => $changed, 'splits' => $splits];
        } finally { $this->rows('SELECT RELEASE_LOCK(?)', [$lockName]); }
    }
    private function hit(string $phase): void { if ($this->checkpoint !== null) ($this->checkpoint)($phase); }
    public function verify(): array
    {
        $result = $this->check();
        if (!$result['scope_column_exists'] || !$result['scoped_name_index'] || !$result['scoped_order_index'] || !$result['unique_assignment_index'] || $result['legacy_name_index'] || $result['pending_folders'] !== 0) throw new RuntimeException('folder_scope_migration_incomplete');
        return $result + ['verified' => true];
    }
}

if (realpath((string) ($_SERVER['SCRIPT_FILENAME'] ?? '')) === __FILE__) {
    $mode = $argv[1] ?? 'check';
    if (!in_array($mode, ['check', 'apply', 'verify'], true) || count($argv) > 2) { fwrite(STDERR, "Usage: php tools/apply-conversation-folder-scope.php [check|apply|verify]\n"); exit(2); }
    try {
        require dirname(__DIR__) . '/backend/vendor/autoload.php'; (new think\App(dirname(__DIR__) . '/backend/'))->initialize();
        $config = config('database'); $connection = $config['connections'][$config['default']] ?? [];
        if (($connection['type'] ?? '') !== 'mysql' || !empty($connection['dsn']) || (int) ($connection['deploy'] ?? 0) !== 0 || !empty($connection['rw_separate'])) throw new RuntimeException('single_mysql_connection_required');
        $db = think\facade\Db::connect(); $db->query('SELECT DATABASE()'); $migration = new ConversationFolderScopeMigration($db->getPdo(), (string) ($connection['prefix'] ?? ''));
        $result = match ($mode) { 'apply' => $migration->apply(), 'verify' => $migration->verify(), default => $migration->check() };
        echo json_encode(['ok' => true, 'mode' => $mode, 'read_only' => $mode !== 'apply', 'result' => $result], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . PHP_EOL;
    } catch (Throwable $error) {
        $reason = get_class($error) === RuntimeException::class && preg_match('/^[a-z_]+$/D', $error->getMessage()) ? $error->getMessage() : 'folder_scope_migration_failed_without_exposing_database_details';
        echo json_encode(['ok' => false, 'mode' => $mode, 'error_class' => get_class($error), 'reason' => $reason], JSON_PRETTY_PRINT) . PHP_EOL; exit(1);
    }
}
