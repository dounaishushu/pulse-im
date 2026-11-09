<?php
namespace app\Service;

use RuntimeException;
use Throwable;

require_once __DIR__ . '/AdminEntryService.php';
require_once __DIR__ . '/TelegramGroupPinAccess.php';
require_once __DIR__ . '/TelegramBotRuntime.php';

/** Hidden signed operations endpoint, intentionally independent of admin sessions/IP gate. */
final class AdminIpControlApi
{
    private ?\Closure $taskCodes;
    private ?\Closure $adminAccounts;

    public function __construct(private AdminIpAccessService $access, ?callable $taskCodes = null, ?callable $adminAccounts = null, private ?array $groupPinConfig = null)
    {
        $this->taskCodes = $taskCodes === null ? null : \Closure::fromCallable($taskCodes);
        $this->adminAccounts = $adminAccounts === null ? null : \Closure::fromCallable($adminAccounts);
    }

    public function handle(array $server, string $rawBody): array
    {
        if (!AdminIpAccessService::isControlRequest($server) || !$this->access->authenticateControl($server, $rawBody)) return AdminIpAccessService::notFoundResponse();
        try {
            $payload = json_decode($rawBody, true, 5, JSON_THROW_ON_ERROR);
            if (!is_array($payload) || array_is_list($payload) || !is_string($payload['action'] ?? null)) throw new RuntimeException('Invalid operation payload.');
            $action = $payload['action']; $actor = $payload['actor'] ?? 'control';
            if (!is_string($actor)) throw new RuntimeException('Invalid actor.');
            $actor = trim($actor);
            if ($actor === '' || strlen($actor) > 128 || preg_match('/[\x00-\x1f\x7f]/', $actor) || !mb_check_encoding($actor, 'UTF-8')) throw new RuntimeException('Invalid actor.');
            $fields = match ($action) { 'add' => ['action', 'ip', 'ttl_seconds', 'actor'], 'remove' => ['action', 'ip', 'actor'], 'list' => ['action', 'actor'], 'task_codes', 'admin_entries' => ['action', 'actor', 'group_pin_proof'], 'admin_create' => ['action', 'actor', 'username', 'role', 'permissions', 'request_key', 'group_pin_proof'], default => throw new RuntimeException('Unknown operation.') };
            if (array_diff(array_keys($payload), $fields) !== []) throw new RuntimeException('Unknown payload field.');
            if (array_key_exists('group_pin_proof', $payload)) TelegramGroupPinAccess::verify($payload, $this->groupPinConfig ?? AdminEntryService::readConfig());
            if (in_array($action, ['add', 'remove'], true) && !is_string($payload['ip'] ?? null)) throw new RuntimeException('An exact IP address is required.');
            $data = match ($action) {
                'list' => ['items' => $this->access->listEntries()],
                'task_codes' => $this->dailyTaskCodes(),
                'admin_create', 'admin_entries' => $this->accounts($payload + ['actor' => $actor]),
                'add' => ['entry' => $this->access->add($payload['ip'], $this->ttl($payload), $actor)],
                'remove' => ['ip' => AdminIpAccessService::normalizeIp($payload['ip']), 'removed' => $this->access->remove($payload['ip'], $actor)],
            };
            return $this->json(200, ['ok' => true, 'data' => $data]);
        } catch (\JsonException | RuntimeException $error) {
            $number = TelegramBotRuntime::number($error);
            if (str_starts_with($number, 'TG-DB')) return $this->unavailable($error);
            return $this->json(400, ['ok' => false, 'error' => ['code' => 'INVALID_REQUEST', 'number' => 'TG-CONTROL-REQUEST', 'message' => 'Invalid operation payload or unavailable access store.']]);
        } catch (Throwable $error) { return $this->unavailable($error); }
    }

    private function unavailable(Throwable $error): array
    {
        $failure = TelegramBotRuntime::record($error, 'unknown');
        return $this->json(503, ['ok' => false, 'error' => ['code' => 'CONTROL_UNAVAILABLE', 'number' => $failure['number'],
            'message' => 'Control operation unavailable.']]);
    }

    private function accounts(array $payload): array
    {
        if (!preg_match('/^telegram:[1-9][0-9]{0,18}$/D', (string) ($payload['actor'] ?? ''))) throw new RuntimeException('Invalid Telegram actor.');
        if ($payload['action'] === 'admin_create' && (!is_string($payload['username'] ?? null) || !preg_match('/^[A-Za-z][A-Za-z0-9_.-]{2,63}$/D', $payload['username'])
            || !is_string($payload['role'] ?? null) || !in_array($payload['role'], ['admin', 'operator', 'auditor'], true)
            || !is_array($payload['permissions'] ?? null) || !array_is_list($payload['permissions']) || count($payload['permissions']) > 64
            || !is_string($payload['request_key'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D', $payload['request_key']))) throw new RuntimeException('Invalid account payload.');
        if ($this->adminAccounts !== null) return ($this->adminAccounts)($payload);
        // Also works on deployments with an older authoritative Composer class map.
        require_once __DIR__ . '/AdminTelegramAccountService.php';
        return (new AdminTelegramAccountService())->handle($payload);
    }

    private function dailyTaskCodes(): array
    {
        if ($this->taskCodes !== null) return $this->boundedTaskCodes(($this->taskCodes)());
        // The signed endpoint runs before the framework. Initialize DB configuration only
        // after authentication and strict payload validation, without dispatching a route.
        $application = \think\Container::getInstance();
        if (!$application instanceof \think\App) $application = new \think\App(dirname(__DIR__, 2) . DIRECTORY_SEPARATOR);
        if (!$application->initialized()) $application->initialize();
        return \think\facade\Db::transaction(function (): array {
            // Validate the complete wire payload before committing any lazily-created
            // daily codes. The bot rejects responses above its one-MiB transport bound.
            return $this->boundedTaskCodes((new WorkTaskService())->dailyTaskCodes());
        });
    }

    private function boundedTaskCodes(array $data): array
    {
        $encoded = json_encode(['ok' => true, 'data' => $data], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        if (strlen($encoded) > 1048576) throw new RuntimeException('Task code response exceeds the transport limit.');
        return $data;
    }

    private function ttl(array $payload): ?int
    {
        $ttl = $payload['ttl_seconds'] ?? null;
        if ($ttl !== null && (!is_int($ttl) || $ttl < 1 || $ttl > AdminIpAccessService::MAX_TTL)) throw new RuntimeException('Invalid TTL.');
        return $ttl;
    }
    private function json(int $status, array $body): array { return ['status' => $status, 'body' => json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), 'headers' => ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff']]; }
}
