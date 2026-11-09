<?php
namespace app\Service;

use Throwable;

/** Infrastructure failures must escape task-level error handling, never become business failures. */
final class DispatchDatabaseFailure
{
    public static function connectionLost(Throwable $error): bool
    {
        do {
            $state = ''; $driver = (int) $error->getCode();
            if ($error instanceof \PDOException && is_array($error->errorInfo ?? null)) { $state = (string) ($error->errorInfo[0] ?? ''); $driver = (int) ($error->errorInfo[1] ?? $driver); }
            if ($error instanceof \think\db\exception\PDOException) {
                $info = $error->getData()['PDO Error Info'] ?? [];
                $state = (string) ($info['SQLSTATE'] ?? $state); $driver = (int) ($info['Driver Error Code'] ?? $driver);
            }
            if (str_starts_with($state, '08') || in_array($driver, [2002, 2003, 2006, 2013, 2014, 2055], true)
                || preg_match('/SQLSTATE\[08[A-Z0-9]{3}\]|server has gone away|lost connection|error while sending QUERY packet|connection (?:refused|reset)|actively refused|communication link failure|packets out of order/i', $error->getMessage())) return true;
            $error = $error->getPrevious();
        } while ($error !== null);
        return false;
    }

    public static function invalidateConnection(): void
    {
        // Discard PDO plus ORM transaction depth. A new process reconstructs the
        // connection; no callback or partially completed write is replayed here.
        \think\facade\Db::connect()->close();
    }
}
