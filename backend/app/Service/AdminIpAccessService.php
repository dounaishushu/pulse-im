<?php
namespace app\Service;

use DateTimeImmutable;
use DateTimeZone;
use RuntimeException;
use Throwable;

/** Optional network gate, independent of ThinkPHP config, accounts and cache. */
final class AdminIpAccessService
{
    public const MAX_TTL = 31536000;
    private array $config;
    private string $directory;
    private \Closure $clock;

    public function __construct(?array $config = null, ?string $stateDir = null, ?callable $clock = null)
    {
        $this->config = $config ?? self::readConfig();
        $this->directory = rtrim($stateDir ?? dirname(__DIR__, 2) . '/runtime/admin-access', '/\\');
        $this->clock = $clock === null ? static fn (): int => time() : \Closure::fromCallable($clock);
    }

    public static function readConfig(?string $backendRoot = null): array
    {
        static $config = [];
        $file = rtrim($backendRoot ?? dirname(__DIR__, 2), '/\\') . '/.env';
        if (!array_key_exists($file, $config)) {
            $values = is_file($file) ? @parse_ini_file($file, false, INI_SCANNER_RAW) : false;
            $config[$file] = is_array($values) ? array_intersect_key($values, array_flip(['ADMIN_IP_CHECK_ENABLED', 'ADMIN_IP_ALLOWLIST', 'ADMIN_TRUSTED_PROXIES', 'ADMIN_IP_CONTROL_KEY', 'ADMIN_IP_CONTROL_WINDOW'])) : [];
        }
        return $config[$file];
    }

    public static function notFoundResponse(): array
    {
        return ['status' => 404, 'body' => "Not Found\n", 'headers' => ['Content-Type' => 'text/plain; charset=utf-8', 'Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff']];
    }

    /** Includes ThinkPHP's query-path compatibility and server fallback paths. */
    public static function isAdminRequest(array $server, array $query = []): bool
    {
        if (self::hasMalformedPathQuery($server, $query)) return true;
        foreach (self::requestPaths($server, $query) as $path) if (self::isAdminPath($path)) return true;
        return false;
    }

    public static function isControlRequest(array $server, array $query = []): bool
    {
        foreach (self::requestPaths($server, $query) as $path) if (self::isControlPath($path)) return true;
        return false;
    }

    public static function hasMalformedPathQuery(array $server, array $query = []): bool
    {
        $parsed = []; $raw = $server['QUERY_STRING'] ?? (explode('?', (string) ($server['REQUEST_URI'] ?? ''), 2)[1] ?? '');
        if (is_string($raw)) parse_str($raw, $parsed);
        foreach ([$query, $parsed] as $values) if (array_key_exists('s', $values) && !is_string($values['s'])) return true;
        return false;
    }

    public static function isAdminPath(string $uri): bool
    {
        foreach (self::pathForms($uri) as $path) if ($path === '/admin' || str_starts_with($path, '/admin/')) return true;
        return false;
    }

    public static function isControlPath(string $uri): bool { return in_array('/ops/admin-ip-allowlist', self::pathForms($uri), true); }

    public function allows(array $server): bool
    {
        // Only an explicit setting disables IP checks; account and control API authentication are separate.
        $enabled = $this->config['ADMIN_IP_CHECK_ENABLED'] ?? 'true';
        if ($enabled === false || (is_string($enabled) && strtolower(trim($enabled)) === 'false')) return true;
        try {
            $ip = $this->resolveClientIp($server);
            if ($ip === null) return false;
            foreach ($this->listEntries() as $entry) if ($entry['ip'] === $ip) return true;
        } catch (Throwable) { /* Unreadable/malformed configuration or store never disables the gate. */ }
        return false;
    }

    public function resolveClientIp(array $server): ?string
    {
        if (!is_string($server['REMOTE_ADDR'] ?? null)) return null;
        $peer = self::normalizeIp($server['REMOTE_ADDR']);
        if ($peer === null || !$this->trusted($peer)) return $peer;
        $forwarded = $server['HTTP_X_FORWARDED_FOR'] ?? '';
        if (!is_string($forwarded) || strlen($forwarded) > 4096) return null;
        // An explicitly trusted reverse proxy must always supply its client chain.
        // Falling back to an allowed loopback proxy would allow every remote user.
        if (trim($forwarded) === '') return null;
        $hops = explode(',', $forwarded);
        if (count($hops) > 64) return null;
        foreach (array_reverse($hops) as $hop) {
            if (!$this->trusted($peer)) break;
            $peer = self::normalizeIp(trim($hop));
            if ($peer === null) return null;
        }
        return $peer;
    }

    public static function normalizeIp(string $ip): ?string
    {
        $ip = trim($ip);
        if (!filter_var($ip, FILTER_VALIDATE_IP)) return null;
        $packed = inet_pton($ip);
        if (strlen($packed) === 16 && substr($packed, 0, 12) === str_repeat("\0", 10) . "\xff\xff") $packed = substr($packed, 12);
        return inet_ntop($packed) ?: null;
    }

    public function listEntries(): array
    {
        return $this->locked('allowlist', LOCK_SH, function (): array {
            $entries = $this->loadEntries(); $now = $this->now();
            $entries = array_values(array_filter($entries, fn (array $entry): bool => $entry['expires_at'] === null || $this->dateEpoch($entry['expires_at']) > $now));
            usort($entries, static fn (array $a, array $b): int => strcmp($a['ip'], $b['ip']));
            return $entries;
        });
    }

    public function add(string $ip, ?int $ttlSeconds = null, string $actor = 'control'): array
    {
        $ip = $this->entryIp($ip); $actor = $this->actor($actor);
        if ($ttlSeconds !== null && ($ttlSeconds < 1 || $ttlSeconds > self::MAX_TTL)) throw new RuntimeException('TTL must be between 1 and 31536000 seconds.');
        return $this->locked('allowlist', LOCK_EX, function () use ($ip, $ttlSeconds, $actor): array {
            $entries = $this->loadEntries(); $now = $this->now();
            $entry = ['ip' => $ip, 'expires_at' => $ttlSeconds === null ? null : $this->date($now + $ttlSeconds), 'created_at' => $this->date($now), 'actor' => $actor];
            foreach ($entries as $previous) if ($previous['ip'] === $ip) $entry['created_at'] = $previous['created_at'];
            $entries = array_values(array_filter($entries, fn (array $item): bool => $item['ip'] !== $ip && ($item['expires_at'] === null || $this->dateEpoch($item['expires_at']) > $now)));
            if (count($entries) >= 2048) throw new RuntimeException('Allowlist entry limit exceeded.');
            $entries[] = $entry; $this->write('allowlist', ['version' => 1, 'entries' => $entries]);
            return $entry;
        });
    }

    public function remove(string $ip, string $actor = 'control'): bool
    {
        $ip = $this->entryIp($ip); $this->actor($actor);
        return $this->locked('allowlist', LOCK_EX, function () use ($ip): bool {
            $entries = $this->loadEntries(); $remaining = array_values(array_filter($entries, static fn (array $item): bool => $item['ip'] !== $ip));
            $this->write('allowlist', ['version' => 1, 'entries' => $remaining]);
            return count($entries) !== count($remaining);
        });
    }

    /** Authentication consumes the nonce before any operation, including invalid payloads. */
    public function authenticateControl(array $server, string $body): bool
    {
        try {
            if (($server['REQUEST_METHOD'] ?? '') !== 'POST' || strlen($body) > 8192) return false;
            $key = trim((string) ($this->config['ADMIN_IP_CONTROL_KEY'] ?? ''));
            if (strlen($key) < 32 || strlen($key) > 256) return false;
            $window = $this->config['ADMIN_IP_CONTROL_WINDOW'] ?? 120;
            if (filter_var($window, FILTER_VALIDATE_INT) === false || (int) $window < 60 || (int) $window > 300) return false;
            $timestamp = $server['HTTP_X_ADMIN_IP_TIMESTAMP'] ?? ''; $nonce = $server['HTTP_X_ADMIN_IP_NONCE'] ?? ''; $signature = $server['HTTP_X_ADMIN_IP_SIGNATURE'] ?? '';
            if (!is_string($timestamp) || !preg_match('/^[0-9]{9,12}$/D', $timestamp) || !is_string($nonce) || !preg_match('/^[a-f0-9]{32}$/D', $nonce)
                || !is_string($signature) || !preg_match('/^[a-f0-9]{64}$/D', $signature) || abs($this->now() - (int) $timestamp) > (int) $window) return false;
            $expected = hash_hmac('sha256', $timestamp . "\n" . $nonce . "\n" . hash('sha256', $body), $key);
            if (!hash_equals($expected, $signature)) return false;
            return $this->locked('nonces', LOCK_EX, function () use ($nonce, $timestamp, $window): bool {
                $data = $this->read('nonces');
                if ($data !== null && (($data['version'] ?? null) !== 1 || !is_array($data['nonces'] ?? null))) throw new RuntimeException('Invalid nonce store.');
                $nonces = $data['nonces'] ?? []; $now = $this->now();
                foreach ($nonces as $hash => $expires) {
                    if (!is_string($hash) || !preg_match('/^[a-f0-9]{64}$/D', $hash) || !is_int($expires)) throw new RuntimeException('Invalid nonce record.');
                    if ($expires <= $now) unset($nonces[$hash]);
                }
                $hash = hash('sha256', $nonce);
                if (isset($nonces[$hash]) || count($nonces) >= 10000) return false;
                $nonces[$hash] = (int) $timestamp + (int) $window + 1;
                $this->write('nonces', ['version' => 1, 'nonces' => $nonces]);
                return true;
            });
        } catch (Throwable) { return false; }
    }

    private static function requestPaths(array $server, array $query): array
    {
        $paths = [];
        foreach (['REQUEST_URI', 'PATH_INFO', 'ORIG_PATH_INFO', 'REDIRECT_PATH_INFO', 'REDIRECT_URL', 'PHP_SELF'] as $name) if (is_string($server[$name] ?? null)) {
            $paths[] = $server[$name];
            if (is_string($server['SCRIPT_NAME'] ?? null) && $server['SCRIPT_NAME'] !== '' && str_starts_with($server[$name], $server['SCRIPT_NAME'])) $paths[] = substr($server[$name], strlen($server['SCRIPT_NAME']));
        }
        $rawQuery = $server['QUERY_STRING'] ?? (explode('?', (string) ($server['REQUEST_URI'] ?? ''), 2)[1] ?? '');
        $parsed = []; if (is_string($rawQuery)) parse_str($rawQuery, $parsed);
        foreach ([$query['s'] ?? null, $parsed['s'] ?? null] as $value) if (is_string($value)) $paths[] = $value;
        return $paths;
    }

    private static function pathForms(string $uri): array
    {
        if (preg_match('~^[a-z][a-z0-9+.-]*://~i', $uri)) $uri = (string) parse_url($uri, PHP_URL_PATH);
        $path = explode('?', $uri, 2)[0]; $forms = [];
        // A conservative extra decode covers server/framework decode differences.
        for ($pass = 0; $pass < 3; $pass++) {
            $path = rawurldecode($path); $path = str_replace('\\', '/', $path);
            $segments = array_values(array_filter(explode('/', strtolower($path)), static fn (string $item): bool => $item !== ''));
            $variants = [$segments]; $clean = [];
            foreach ($segments as $segment) { if ($segment === '.') continue; if ($segment === '..') array_pop($clean); else $clean[] = $segment; }
            $variants[] = $clean;
            foreach ($variants as $variant) {
                while (isset($variant[0]) && in_array($variant[0], ['index.php', 'api'], true)) array_shift($variant);
                $forms[] = '/' . implode('/', $variant);
            }
        }
        return array_values(array_unique($forms));
    }

    private function trusted(string $ip): bool
    {
        $ranges = [];
        // Validate the complete configuration before matching any peer. Silently
        // ignoring a malformed proxy declaration could turn an allowed proxy
        // address into an ordinary direct client and bypass its required XFF.
        foreach ($this->tokens($this->config['ADMIN_TRUSTED_PROXIES'] ?? '') as $range) {
            [$network, $prefix] = array_pad(explode('/', $range, 2), 2, null);
            $raw = @inet_pton($network); $normalized = self::normalizeIp($network);
            if ($raw === false || $normalized === null) throw new RuntimeException('Invalid trusted proxy network.');
            $packed = inet_pton($normalized); $bits = strlen($packed) * 8;
            if ($prefix === null) $prefix = $bits;
            else {
                if (!ctype_digit($prefix)) throw new RuntimeException('Invalid trusted proxy prefix.');
                $prefix = (int) $prefix;
                if (strlen($raw) === 16 && strlen($packed) === 4) {
                    if ($prefix < 97 || $prefix > 128) throw new RuntimeException('Invalid mapped trusted proxy prefix.');
                    $prefix -= 96;
                }
            }
            if ($prefix < 1 || $prefix > $bits) throw new RuntimeException('Invalid trusted proxy prefix range.');
            $ranges[] = [$packed, $prefix];
        }
        foreach ($ranges as [$packed, $prefix]) {
            if (strlen(inet_pton($ip)) !== strlen($packed)) continue;
            $address = inet_pton($ip); $bytes = intdiv($prefix, 8); $remaining = $prefix % 8;
            if (substr($address, 0, $bytes) === substr($packed, 0, $bytes) && ($remaining === 0 || ((ord($address[$bytes]) ^ ord($packed[$bytes])) & (0xff << (8 - $remaining))) === 0)) return true;
        }
        return false;
    }

    private function loadEntries(): array
    {
        $data = $this->read('allowlist');
        if ($data === null) {
            $entries = [];
            foreach ($this->tokens($this->config['ADMIN_IP_ALLOWLIST'] ?? '') as $ip) { $ip = $this->entryIp($ip); $entries[$ip] = ['ip' => $ip, 'expires_at' => null, 'created_at' => $this->date($this->now()), 'actor' => 'configuration']; }
            return array_values($entries);
        }
        // An existing file is authoritative. Corruption never falls back to .env.
        if (($data['version'] ?? null) !== 1 || !is_array($data['entries'] ?? null) || !array_is_list($data['entries']) || count($data['entries']) > 2048) throw new RuntimeException('Invalid allowlist store.');
        $seen = [];
        foreach ($data['entries'] as $entry) {
            if (!is_array($entry) || array_diff(array_keys($entry), ['ip', 'expires_at', 'created_at', 'actor']) !== [] || !is_string($entry['ip'] ?? null) || $this->entryIp($entry['ip']) !== $entry['ip'] || isset($seen[$entry['ip']])
                || !array_key_exists('expires_at', $entry) || ($entry['expires_at'] !== null && !is_string($entry['expires_at'])) || !is_string($entry['created_at'] ?? null) || !is_string($entry['actor'] ?? null)) throw new RuntimeException('Invalid allowlist entry.');
            $this->dateEpoch($entry['created_at']); if ($entry['expires_at'] !== null) $this->dateEpoch($entry['expires_at']); $this->actor($entry['actor']); $seen[$entry['ip']] = true;
        }
        return $data['entries'];
    }

    private function locked(string $name, int $mode, callable $action): mixed
    {
        if (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true) && !is_dir($this->directory)) throw new RuntimeException('Admin access storage unavailable.');
        @chmod($this->directory, 0700);
        $path = $this->directory . '/' . $name . '.lock';
        if (is_link($path)) throw new RuntimeException('Invalid admin access lock.');
        $handle = @fopen($path, 'c+b');
        if (!$handle) throw new RuntimeException('Admin access lock unavailable.');
        @chmod($path, 0600);
        try { if (!flock($handle, $mode)) throw new RuntimeException('Admin access lock failed.'); return $action(); }
        finally { flock($handle, LOCK_UN); fclose($handle); }
    }

    private function read(string $name): ?array
    {
        $path = $this->directory . '/' . $name . '.json';
        if (!file_exists($path) && !is_link($path)) return null;
        if (!is_file($path) || is_link($path) || !is_readable($path)) throw new RuntimeException('Admin access state unreadable.');
        $size = @filesize($path); if ($size === false || $size > 2 * 1024 * 1024) throw new RuntimeException('Admin access state too large.');
        $raw = @file_get_contents($path); if ($raw === false) throw new RuntimeException('Admin access state read failed.');
        $data = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
        if (!is_array($data)) throw new RuntimeException('Invalid admin access state.');
        return $data;
    }

    private function write(string $name, array $data): void
    {
        $path = $this->directory . '/' . $name . '.json'; $temporary = @tempnam($this->directory, '.access-');
        if ($temporary === false) throw new RuntimeException('Admin access write unavailable.');
        try {
            @chmod($temporary, 0600); $raw = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
            $handle = @fopen($temporary, 'wb');
            if (!$handle) throw new RuntimeException('Admin access write failed.');
            try {
                $offset = 0;
                while ($offset < strlen($raw)) { $written = fwrite($handle, substr($raw, $offset)); if ($written === false || $written === 0) throw new RuntimeException('Admin access write failed.'); $offset += $written; }
                if (!fflush($handle) || (function_exists('fsync') && !fsync($handle))) throw new RuntimeException('Admin access flush failed.');
            } finally { fclose($handle); }
            if (!@rename($temporary, $path)) throw new RuntimeException('Admin access atomic replace failed.');
            @chmod($path, 0600); clearstatcache(true, $path);
        } finally { if (is_file($temporary)) unlink($temporary); }
    }

    private function entryIp(string $ip): string
    {
        $ip = self::normalizeIp($ip) ?? throw new RuntimeException('An exact IPv4 or IPv6 address is required.'); $packed = inet_pton($ip);
        if ($ip === '0.0.0.0' || $ip === '::' || $ip === '255.255.255.255' || (strlen($packed) === 4 && ord($packed[0]) >= 224 && ord($packed[0]) <= 239)
            || (strlen($packed) === 16 && ord($packed[0]) === 255)) throw new RuntimeException('Unspecified, multicast and broadcast addresses are forbidden.');
        return $ip;
    }
    private function actor(string $actor): string { $actor = trim($actor); if ($actor === '' || strlen($actor) > 128 || preg_match('/[\x00-\x1f\x7f]/', $actor) || !mb_check_encoding($actor, 'UTF-8')) throw new RuntimeException('Invalid actor.'); return $actor; }
    private function tokens(mixed $value): array { if (!is_string($value)) throw new RuntimeException('Invalid IP configuration.'); return preg_split('/[\s,;]+/', trim($value), -1, PREG_SPLIT_NO_EMPTY) ?: []; }
    private function now(): int { return (int) ($this->clock)(); }
    private function date(int $time): string { return gmdate('Y-m-d\TH:i:s\Z', $time); }
    private function dateEpoch(string $date): int { $parsed = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s\Z', $date, new DateTimeZone('UTC')); if (!$parsed || $parsed->format('Y-m-d\TH:i:s\Z') !== $date) throw new RuntimeException('Invalid expiry date.'); return $parsed->getTimestamp(); }
}
