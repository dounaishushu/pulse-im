<?php
declare(strict_types=1);
namespace app\Service;

use RuntimeException;

/** A short-lived, operation-bound acknowledgement issued only after a group PIN succeeds. */
final class TelegramGroupPinAccess
{
    public static function enabled(array $config): bool
    {
        return in_array(strtolower((string) ($config['TELEGRAM_GROUP_PIN_ACCESS'] ?? '')), ['true', '1'], true);
    }

    /** Group task queries are available to every member with the configured PIN. */
    public static function taskCodesEnabled(array $config): bool
    {
        return (string) ($config['TELEGRAM_ADMIN_PIN'] ?? '') !== '';
    }

    private static function actionEnabled(string $action, array $config): bool
    {
        return self::enabled($config) || ($action === 'task_codes' && self::taskCodesEnabled($config));
    }

    private static function secret(array $config, string $action): string
    {
        $pin = (string) ($config['TELEGRAM_ADMIN_PIN'] ?? '');
        $key = trim((string) ($config['ADMIN_IP_CONTROL_KEY'] ?? ''));
        if (!self::actionEnabled($action, $config) || strlen($pin) < 6 || trim($pin) !== $pin || strlen($key) < 32 || strlen($key) > 256) {
            throw new RuntimeException('Group password access is unavailable.');
        }
        // Rotating the verification password invalidates an in-flight acknowledgement.
        return hash_hmac('sha256', 'telegram-group-pin-v1|' . $pin, $key, true);
    }

    private static function canonical(mixed $value): mixed
    {
        if (!is_array($value)) return $value;
        if (!array_is_list($value)) ksort($value, SORT_STRING);
        return array_map(self::canonical(...), $value);
    }

    private static function operationHash(array $operation): string
    {
        unset($operation['group_pin_proof']);
        return hash('sha256', json_encode(self::canonical($operation), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
    }

    private static function user(array $operation): string
    {
        if (!in_array($operation['action'] ?? '', ['task_codes', 'admin_create', 'admin_entries'], true)
            || !preg_match('/^telegram:([1-9][0-9]{0,18})$/D', (string) ($operation['actor'] ?? ''), $match)) {
            throw new RuntimeException('Invalid group password operation.');
        }
        return $match[1];
    }

    private static function signature(array $proof, array $config): string
    {
        unset($proof['signature']);
        return hash_hmac('sha256', json_encode(self::canonical($proof), JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), self::secret($config, (string) ($proof['action'] ?? '')));
    }

    public static function issue(array $operation, string $group, array $config, ?int $now = null): array
    {
        $user = self::user($operation);
        if (!preg_match('/^-[1-9][0-9]{0,18}$/D', $group)) throw new RuntimeException('Invalid group identity.');
        $now ??= time();
        $proof = ['version' => 1, 'user_id' => $user, 'group_id' => $group, 'action' => $operation['action'],
            'operation_hash' => self::operationHash($operation), 'issued_at' => $now, 'expires_at' => $now + 180];
        $proof['signature'] = self::signature($proof, $config);
        $operation['group_pin_proof'] = $proof;
        return $operation;
    }

    public static function verify(array $operation, array $config, ?int $now = null): string
    {
        $user = self::user($operation); $proof = $operation['group_pin_proof'] ?? null; $now ??= time();
        $fields = ['version', 'user_id', 'group_id', 'action', 'operation_hash', 'issued_at', 'expires_at', 'signature'];
        if (!is_array($proof) || array_is_list($proof) || count($proof) !== count($fields) || array_diff(array_keys($proof), $fields)
            || ($proof['version'] ?? null) !== 1 || ($proof['user_id'] ?? null) !== $user || ($proof['action'] ?? null) !== $operation['action']
            || !is_string($proof['group_id'] ?? null) || !preg_match('/^-[1-9][0-9]{0,18}$/D', $proof['group_id'])
            || !is_int($proof['issued_at'] ?? null) || !is_int($proof['expires_at'] ?? null)
            || $proof['issued_at'] > $now + 30 || $proof['issued_at'] < $now - 180
            || $proof['expires_at'] !== $proof['issued_at'] + 180 || $proof['expires_at'] < $now
            || !is_string($proof['operation_hash'] ?? null) || !hash_equals(self::operationHash($operation), $proof['operation_hash'])
            || !is_string($proof['signature'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D', $proof['signature'])
            || !hash_equals(self::signature($proof, $config), $proof['signature'])) {
            throw new RuntimeException('Group password acknowledgement is invalid or expired.');
        }
        return $user;
    }
}
