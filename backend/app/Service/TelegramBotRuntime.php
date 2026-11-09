<?php
declare(strict_types=1);
namespace app\Service;

use RuntimeException;
use Throwable;

final class TelegramBotFailure extends RuntimeException
{
    public function __construct(public readonly string $number, public readonly array $context = [])
    {
        parent::__construct($number);
    }
}

/** Request boundaries for a CLI worker; no code/PIN/token/SQL is written to logs. */
final class TelegramBotRuntime
{
    private const NUMBERS = ['TG-DB-CONNECTION', 'TG-DB-SCHEMA', 'TG-DB', 'TG-CONTROL-AUTH',
        'TG-CONTROL-HTTP', 'TG-CONTROL-NETWORK', 'TG-CONTROL-JSON', 'TG-CONTROL-DATA', 'TG-CONTROL-REQUEST', 'TG-SERVICE'];

    public static function databaseOperation(callable $operation): array
    {
        // A long-poll worker otherwise retains the same PDO session across days.
        // Close before each operation to discard an idle connection/snapshot, and
        // after it to avoid keeping one throughout Telegram's next long poll.
        $connection = \think\facade\Db::connect();
        $connection->close();
        try { return $operation(); }
        finally { $connection->close(); }
        // Deliberately do not replay an operation: account creation can commit
        // before a network failure makes its outcome uncertain.
    }

    public static function number(Throwable $error): string
    {
        if ($error instanceof TelegramBotFailure && in_array($error->number, self::NUMBERS, true)) return $error->number;
        for ($depth = 0, $cause = $error; $cause !== null && $depth < 8; $cause = $cause->getPrevious(), $depth++) {
            if ($cause instanceof \PDOException || str_starts_with(get_class($cause), 'think\\db\\exception\\')) {
                $state = (string) $cause->getCode(); $driver = 0;
                if ($cause instanceof \PDOException) { $state = (string) ($cause->errorInfo[0] ?? $state); $driver = (int) ($cause->errorInfo[1] ?? 0); }
                elseif (method_exists($cause, 'getData')) {
                    $data = $cause->getData(); $info = $data['PDO Error Info'] ?? [];
                    $state = (string) ($info['SQLSTATE'] ?? $state); $driver = (int) ($info['Driver Error Code'] ?? 0);
                }
                if (str_starts_with($state, '08') || in_array($driver, [1040, 1045, 2002, 2003, 2006, 2013], true)) return 'TG-DB-CONNECTION';
                if (in_array($state, ['42S02', '42S22'], true) || in_array($driver, [1054, 1146], true)) return 'TG-DB-SCHEMA';
                return 'TG-DB';
            }
        }
        return 'TG-SERVICE';
    }

    public static function remoteFailure(?array $body, int $status): TelegramBotFailure
    {
        $number = $body['error']['number'] ?? null;
        if (!is_string($number) || !in_array($number, self::NUMBERS, true)) {
            $number = in_array($status, [401, 403, 404], true) ? 'TG-CONTROL-AUTH' : 'TG-CONTROL-HTTP';
        }
        return new TelegramBotFailure($number, ['http_status' => $status]);
    }

    public static function record(Throwable $error, string $action): array
    {
        $number = self::number($error); $reference = bin2hex(random_bytes(6));
        $event = ['event' => 'telegram.control_failure', 'error_number' => $number, 'reference' => $reference,
            'action' => in_array($action, ['task_codes', 'admin_entries', 'admin_create', 'add', 'remove', 'list'], true) ? $action : 'unknown',
            'time' => (new \DateTimeImmutable('now', new \DateTimeZone('Asia/Shanghai')))->format('c')];
        if ($error instanceof TelegramBotFailure) foreach (['http_status', 'curl_errno'] as $key) {
            if (is_int($error->context[$key] ?? null)) $event[$key] = $error->context[$key];
        }
        error_log(json_encode($event, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
        return ['number' => $number, 'reference' => $reference];
    }
}
