<?php

namespace app\Service;

use RuntimeException;

/** Small RESP client with bounded reads and verified AUTH/PING replies. */
final class RedisTransport
{
    public function ping(): bool
    {
        $socket = null;
        try { $socket = $this->connect(); return $this->command($socket, ['PING']) === 'PONG'; }
        catch (\Throwable $error) { return false; }
        finally { if (is_resource($socket)) fclose($socket); }
    }

    public function publish(string $channel, string $payload): bool
    {
        $socket = null;
        try { $socket = $this->connect(); return is_int($this->command($socket, ['PUBLISH', $channel, $payload])); }
        catch (\Throwable $error) { return false; }
        finally { if (is_resource($socket)) fclose($socket); }
    }

    private function connect()
    {
        $host = (string) env('REDIS_HOST', '127.0.0.1');
        $port = (int) env('REDIS_PORT', 6379);
        $socket = @stream_socket_client("tcp://{$host}:{$port}", $code, $error, 0.25, STREAM_CLIENT_CONNECT);
        if (!$socket) throw new RuntimeException('Redis connection unavailable.');
        stream_set_timeout($socket, 0, 250000);
        $password = (string) env('REDIS_PASSWORD', '');
        try {
            if ($password !== '' && $this->command($socket, ['AUTH', $password]) !== 'OK') throw new RuntimeException('Redis authentication failed.');
            return $socket;
        } catch (\Throwable $error) { fclose($socket); throw $error; }
    }

    public static function encode(array $parts): string
    {
        $request = '*' . count($parts) . "\r\n";
        foreach ($parts as $part) { $part = (string) $part; $request .= '$' . strlen($part) . "\r\n" . $part . "\r\n"; }
        return $request;
    }

    public function command($socket, array $parts): string|int
    {
        $request = self::encode($parts);
        for ($offset = 0, $length = strlen($request); $offset < $length;) {
            $written = @fwrite($socket, substr($request, $offset));
            if (!$written) throw new RuntimeException('Redis write failed.');
            $offset += $written;
        }
        $reply = @fgets($socket, 4096);
        if (!is_string($reply) || !str_ends_with($reply, "\r\n")) throw new RuntimeException('Redis reply missing.');
        $value = substr($reply, 1, -2);
        return match ($reply[0]) {
            '+' => $value,
            ':' => preg_match('/^-?[0-9]+$/D', $value) ? (int) $value : throw new RuntimeException('Invalid Redis integer.'),
            default => throw new RuntimeException('Redis command rejected.'),
        };
    }
}
