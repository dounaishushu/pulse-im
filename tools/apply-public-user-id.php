<?php
declare(strict_types=1);

use app\Service\PublicUserIdService;

/** Dedicated incremental migration. Requiring this file does not boot or connect. */
final class PublicUserIdMigration
{
    private readonly string $database;
    private readonly string $table;
    public function __construct(private readonly PDO $pdo, string $prefix = '', private readonly PublicUserIdService $ids = new PublicUserIdService())
    {
        if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) !== 'mysql' || !preg_match('/^[A-Za-z0-9_]*$/D', $prefix)) throw new RuntimeException('unsupported_database_or_prefix');
        $this->database = (string) $pdo->query('SELECT DATABASE()')->fetchColumn();
        if ($this->database === '') throw new RuntimeException('database_not_selected');
        $this->table = $prefix . 'users';
        if (strlen($this->table) > 64) throw new RuntimeException('unsupported_table_name');
    }
    private function quotedTable(): string { return '`' . $this->table . '`'; }
    private function rows(string $sql, array $bindings = []): array
    {
        $statement = $this->pdo->prepare($sql); $statement->execute($bindings);
        return $statement->fetchAll(PDO::FETCH_ASSOC);
    }
    private function assertSelectedDatabase(): void
    {
        if ($this->pdo->query('SELECT DATABASE()')->fetchColumn() !== $this->database) throw new RuntimeException('selected_database_changed');
    }
    public function check(): array
    {
        $this->assertSelectedDatabase();
        $tables = $this->rows('SELECT TABLE_TYPE, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [$this->database, $this->table]);
        if (count($tables) !== 1 || $tables[0]['TABLE_TYPE'] !== 'BASE TABLE' || strcasecmp((string) $tables[0]['ENGINE'], 'InnoDB') !== 0) throw new RuntimeException('users_table_is_not_innodb');
        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM ' . $this->quotedTable())->fetchColumn();
        $columns = $this->rows('SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, CHARACTER_SET_NAME, COLLATION_NAME, IS_NULLABLE, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [$this->database, $this->table, 'public_id']);
        if ($columns === []) return ['column_exists' => false, 'unique_index_exists' => false, 'nullable' => true, 'users' => $count, 'missing' => $count];
        $column = $columns[0];
        if ($column['DATA_TYPE'] !== 'varchar' || (int) $column['CHARACTER_MAXIMUM_LENGTH'] !== 16
            || $column['CHARACTER_SET_NAME'] !== 'ascii' || $column['COLLATION_NAME'] !== 'ascii_bin'
            || $column['COLUMN_DEFAULT'] !== null || $column['EXTRA'] !== '') throw new RuntimeException('incompatible_public_id_column');
        $index = $this->rows('SELECT NON_UNIQUE, COLUMN_NAME, SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX', [$this->database, $this->table, PublicUserIdService::UNIQUE_INDEX]);
        if ($index !== [] && (count($index) !== 1 || (int) $index[0]['NON_UNIQUE'] !== 0 || $index[0]['COLUMN_NAME'] !== 'public_id' || $index[0]['SUB_PART'] !== null)) throw new RuntimeException('incompatible_public_id_index');
        // Validate before ALTER/backfill: never silently reassign a nonempty old ID.
        $statement = $this->pdo->query('SELECT public_id FROM ' . $this->quotedTable() . " WHERE public_id IS NOT NULL AND public_id <> ''");
        while (($publicId = $statement->fetchColumn()) !== false) if (!PublicUserIdService::valid($publicId)) throw new RuntimeException('invalid_existing_public_id');
        $duplicates = $this->rows('SELECT public_id FROM ' . $this->quotedTable() . " WHERE public_id IS NOT NULL AND public_id <> '' GROUP BY public_id HAVING COUNT(*) > 1 LIMIT 1");
        if ($duplicates !== []) throw new RuntimeException('duplicate_existing_public_id');
        $missing = (int) $this->pdo->query('SELECT COUNT(*) FROM ' . $this->quotedTable() . " WHERE public_id IS NULL OR public_id = ''")->fetchColumn();
        return ['column_exists' => true, 'unique_index_exists' => $index !== [], 'nullable' => $column['IS_NULLABLE'] === 'YES', 'users' => $count, 'missing' => $missing];
    }
    public function apply(int $batchSize = 200, ?int $maxBatches = null): array
    {
        if ($batchSize < 1 || $batchSize > 1000 || ($maxBatches !== null && $maxBatches < 1)) throw new RuntimeException('invalid_batch_limit');
        if ($this->pdo->inTransaction()) throw new RuntimeException('migration_requires_no_active_transaction_ddl_implicitly_commits');
        $before = $this->check(); $table = $this->quotedTable();
        if (!$before['column_exists']) {
            $this->pdo->exec("ALTER TABLE {$table} ADD COLUMN public_id VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL, ADD UNIQUE KEY " . PublicUserIdService::UNIQUE_INDEX . ' (public_id)');
        } elseif (!$before['unique_index_exists']) {
            // A valid interrupted expansion can resume; several empty strings are
            // missing identities, so normalize only those to NULL before UNIQUE.
            if (!$before['nullable']) throw new RuntimeException('incompatible_missing_index_on_nonnullable_column');
            $this->pdo->exec("UPDATE {$table} SET public_id = NULL WHERE public_id = ''");
            $this->pdo->exec("ALTER TABLE {$table} ADD UNIQUE KEY " . PublicUserIdService::UNIQUE_INDEX . ' (public_id)');
        }
        $filled = 0; $batches = 0;
        while ($maxBatches === null || $batches < $maxBatches) {
            $this->assertSelectedDatabase();
            $rows = $this->rows("SELECT id FROM {$table} WHERE public_id IS NULL OR public_id = '' ORDER BY id LIMIT " . $batchSize);
            if ($rows === []) break;
            foreach ($rows as $row) {
                for ($attempt = 0; $attempt < PublicUserIdService::MAX_ATTEMPTS; $attempt++) {
                    try {
                        $statement = $this->pdo->prepare("UPDATE {$table} SET public_id = ? WHERE id = ? AND (public_id IS NULL OR public_id = '')");
                        $statement->execute([$this->ids->generate(), $row['id']]);
                        $filled += $statement->rowCount();
                        break;
                    } catch (PDOException $error) {
                        if (!PublicUserIdService::isPublicIdCollision($error)) throw $error;
                        if ($attempt + 1 === PublicUserIdService::MAX_ATTEMPTS) throw new RuntimeException('public_id_collision_retry_exhausted', 0, $error);
                    }
                }
            }
            $batches++;
        }
        return $this->check() + ['filled' => $filled, 'batches' => $batches];
    }
    public function verify(): array
    {
        $result = $this->check();
        if (!$result['column_exists'] || !$result['unique_index_exists'] || $result['missing'] !== 0) throw new RuntimeException('public_id_migration_incomplete');
        return $result + ['verified' => true];
    }
}

if (realpath((string) ($_SERVER['SCRIPT_FILENAME'] ?? '')) === __FILE__) {
    $mode = $argv[1] ?? 'check';
    if (!in_array($mode, ['check', 'apply', 'verify'], true) || count($argv) > 3) {
        fwrite(STDERR, "Usage: php tools/apply-public-user-id.php [check|apply|verify] [batch-size]\n"); exit(2);
    }
    $batch = $argv[2] ?? '200';
    if (!ctype_digit($batch) || (int) $batch < 1 || (int) $batch > 1000) { fwrite(STDERR, "Invalid batch size.\n"); exit(2); }
    try {
        require dirname(__DIR__) . '/backend/vendor/autoload.php';
        (new think\App(dirname(__DIR__) . '/backend/'))->initialize();
        $config = config('database'); $connection = $config['connections'][$config['default']] ?? [];
        if (($connection['type'] ?? '') !== 'mysql' || !empty($connection['dsn']) || (int) ($connection['deploy'] ?? 0) !== 0 || !empty($connection['rw_separate'])) throw new RuntimeException('single_mysql_connection_required');
        $database = think\facade\Db::connect(); $database->query('SELECT DATABASE()');
        $migration = new PublicUserIdMigration($database->getPdo(), (string) ($connection['prefix'] ?? ''));
        $result = match ($mode) { 'apply' => $migration->apply((int) $batch), 'verify' => $migration->verify(), default => $migration->check() };
        echo json_encode(['ok' => true, 'mode' => $mode, 'result' => $result, 'read_only' => $mode !== 'apply'], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . PHP_EOL;
    } catch (Throwable $error) {
        // Never expose SQL, account data, credentials or the driver's full message.
        $known = ['unsupported_database_or_prefix', 'database_not_selected', 'unsupported_table_name', 'selected_database_changed', 'users_table_is_not_innodb', 'incompatible_public_id_column', 'incompatible_public_id_index', 'invalid_existing_public_id', 'duplicate_existing_public_id', 'invalid_batch_limit', 'migration_requires_no_active_transaction_ddl_implicitly_commits', 'incompatible_missing_index_on_nonnullable_column', 'public_id_collision_retry_exhausted', 'public_id_migration_incomplete', 'single_mysql_connection_required'];
        echo json_encode(['ok' => false, 'mode' => $mode, 'error_class' => get_class($error), 'reason' => in_array($error->getMessage(), $known, true) ? $error->getMessage() : 'public_id_migration_failed_without_exposing_database_details'], JSON_PRETTY_PRINT) . PHP_EOL;
        exit(1);
    }
}
