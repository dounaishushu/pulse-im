<?php
declare(strict_types=1);

namespace app\Service;

use Closure;
use RuntimeException;
use Throwable;
use think\facade\Db;

/** Public identity is additive: internal user IDs and all relations stay numeric. */
final class PublicUserIdService
{
    public const UNIQUE_INDEX = 'uk_users_public_id';
    public const MAX_ATTEMPTS = 8;
    private const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    // The optional source is an internal test seam, never accepted from a request.
    public function __construct(private readonly ?Closure $candidateSource = null) {}

    public static function valid(mixed $value): bool
    {
        return is_string($value) && preg_match('/^[A-Za-z0-9]{16}$/D', $value) === 1
            && preg_match('/[A-Z]/', $value) === 1 && preg_match('/[a-z]/', $value) === 1 && preg_match('/[0-9]/', $value) === 1;
    }

    public function generate(): string
    {
        if ($this->candidateSource !== null) {
            $value = ($this->candidateSource)();
            if (!self::valid($value)) throw new RuntimeException('公开用户ID生成结果无效。');
            return $value;
        }
        do {
            $value = '';
            for ($index = 0; $index < 16; $index++) $value .= self::ALPHABET[random_int(0, 61)];
        } while (!self::valid($value));
        return $value;
    }

    /** Caller owns the user/permissions/token transaction; retry only this INSERT. */
    public function insertUser(array $data): array
    {
        for ($attempt = 0; $attempt < self::MAX_ATTEMPTS; $attempt++) {
            $publicId = $this->generate();
            try {
                $id = (int) Db::name('users')->insertGetId(array_replace($data, ['public_id' => $publicId]));
                return ['id' => $id, 'public_id' => $publicId];
            } catch (Throwable $error) {
                if (!self::isPublicIdCollision($error)) throw $error;
                if ($attempt + 1 === self::MAX_ATTEMPTS) throw new RuntimeException('公开用户ID生成失败，请重试。', 0, $error);
            }
        }
        throw new RuntimeException('公开用户ID生成失败，请重试。');
    }

    public static function isPublicIdCollision(Throwable $error): bool
    {
        $info = method_exists($error, 'getData') ? ($error->getData()['PDO Error Info'] ?? []) : [];
        $code = $info['Driver Error Code'] ?? ($error instanceof \PDOException ? ($error->errorInfo[1] ?? 0) : 0);
        $message = $info['Driver Error Message'] ?? ($error instanceof \PDOException ? ($error->errorInfo[2] ?? '') : '');
        return (int) $code === 1062
            && preg_match('/for key [\'"`](?:[^\'"`]+\.)?' . self::UNIQUE_INDEX . '[\'"`]/i', (string) $message) === 1;
    }
}
