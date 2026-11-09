<?php
namespace app\Service;

use RuntimeException;
use Throwable;

require_once __DIR__ . '/TelegramGroupPinAccess.php';
require_once __DIR__ . '/TelegramBotRuntime.php';

/** Private long-poll worker. It never reads or writes the allowlist directly. */
final class AdminIpTelegramBot
{
    private array $state;
    private $lock;
    private \Closure $telegram;
    private \Closure $control;
    private \Closure $clock;
    private \Closure $http;
    private \Closure $localApi;
    private ?string $username = null;
    private const FLOW_TTL = 300;
    private const MESSAGE_UNITS = 3500;

    public function __construct(private array $config, private string $directory, ?callable $telegram = null, ?callable $control = null, ?callable $clock = null, ?callable $http = null, ?callable $localApi = null)
    {
        $errors = self::configErrors($config);
        if ($errors !== []) throw new RuntimeException('Invalid bot configuration: ' . implode(', ', $errors));
        $this->config['ADMIN_IP_CONTROL_KEY'] = trim($config['ADMIN_IP_CONTROL_KEY']);
        $this->config['users'] = self::ids($config['TELEGRAM_ADMIN_USER_IDS'] ?? '', false);
        $this->config['chats'] = self::ids($config['TELEGRAM_ADMIN_CHAT_IDS'] ?? '', true);
        $this->clock = $clock === null ? static fn (): int => time() : \Closure::fromCallable($clock);
        $dnsProvider = self::dnsProvider($config);
        $this->http = $http === null ? static fn (string $url, string $raw, array $headers, int $timeout): array => self::jsonHttp($url, $raw, $headers, $timeout, $dnsProvider) : \Closure::fromCallable($http);
        $this->localApi = $localApi === null ? static function (array $server, string $raw): array {
            $operation = static fn (): array => (new AdminIpControlApi(new AdminIpAccessService()))->handle($server, $raw);
            $action = json_decode($raw, true, 16, JSON_THROW_ON_ERROR)['action'] ?? '';
            return in_array($action, ['task_codes', 'admin_entries', 'admin_create'], true) ? TelegramBotRuntime::databaseOperation($operation) : $operation();
        } : \Closure::fromCallable($localApi);
        $this->telegram = $telegram === null ? fn (string $method, array $body): array => $this->telegramRequest($method, $body) : \Closure::fromCallable($telegram);
        $this->control = $control === null ? fn (array $body): array => $this->controlRequest($body) : \Closure::fromCallable($control);
        if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) throw new RuntimeException('Bot state directory unavailable.');
        @chmod($directory, 0700);
        $this->lock = @fopen($directory . '/worker.lock', 'c');
        if (!$this->lock || !flock($this->lock, LOCK_EX | LOCK_NB)) { $this->close(); throw new RuntimeException('Bot worker is already running or state is unavailable.'); }
        @chmod($directory . '/worker.lock', 0600);
        // Token rotation keeps the same bot ID and must not reset its cursor.
        $identity = hash('sha256', strstr($config['TELEGRAM_BOT_TOKEN'], ':', true));
        $authRevision = hash_hmac('sha256', json_encode([$this->config['users'], $this->config['chats'], $config['TELEGRAM_ADMIN_PIN'] ?? '', $config['TELEGRAM_ADMIN_ACCOUNTS_ENABLED'] ?? '', $config['ADMIN_ENTRY_BASE_URL'] ?? '', $config['TELEGRAM_GROUP_PIN_ACCESS'] ?? ''], JSON_THROW_ON_ERROR), $this->config['ADMIN_IP_CONTROL_KEY']);
        $file = $directory . '/state.json';
        try {
            if (is_file($file)) {
                if (filesize($file) > 1048576) throw new RuntimeException('Invalid bot state.');
                $state = json_decode((string) file_get_contents($file), true, 16, JSON_THROW_ON_ERROR);
                if (!is_array($state) || !is_int($state['offset'] ?? null) || $state['offset'] < 0 || !is_array($state['flows'] ?? null) || !is_array($state['pins'] ?? null)) throw new RuntimeException('Invalid bot state.');
                $this->state = ($state['identity'] ?? '') === $identity ? $state : ['identity' => $identity, 'offset' => 0, 'flows' => [], 'pins' => []];
            } else $this->state = ['identity' => $identity, 'offset' => 0, 'flows' => [], 'pins' => []];
            if (($this->state['auth_revision'] ?? '') !== $authRevision) { $this->state['flows'] = []; $this->state['pins'] = []; }
            $this->state['auth_revision'] = $authRevision;
            $this->save();
        } catch (Throwable) { $this->close(); throw new RuntimeException('Bot state cannot be safely loaded.'); }
    }

    public static function environment(): array
    {
        $config = [];
        foreach (['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_USER_IDS', 'TELEGRAM_ADMIN_CHAT_IDS', 'TELEGRAM_ADMIN_PIN', 'TELEGRAM_DNS_PROVIDER', 'TELEGRAM_CONTROL_MODE', 'ADMIN_IP_CONTROL_URL', 'ADMIN_IP_CONTROL_KEY', 'TELEGRAM_ADMIN_ACCOUNTS_ENABLED', 'ADMIN_ENTRY_BASE_URL', 'TELEGRAM_GROUP_PIN_ACCESS', 'APP_ENV'] as $name) $config[$name] = (string) env($name, $name === 'APP_ENV' ? 'production' : '');
        return $config;
    }

    public static function configErrors(array $config): array
    {
        $errors = [];
        $provider = self::dnsProvider($config);
        if (!in_array($provider, ['system', 'cloudflare', 'google'], true)) $errors[] = 'TELEGRAM_DNS_PROVIDER';
        elseif ($provider !== 'system' && (!defined('CURLOPT_DOH_URL') || !function_exists('curl_version') || (curl_version()['version_number'] ?? 0) < 0x073e00)) $errors[] = 'PHP_cURL_DOH';
        if (!preg_match('/^[1-9][0-9]*:[A-Za-z0-9_-]{20,}$/D', (string) ($config['TELEGRAM_BOT_TOKEN'] ?? ''))) $errors[] = 'TELEGRAM_BOT_TOKEN';
        try { if (self::ids($config['TELEGRAM_ADMIN_USER_IDS'] ?? '', false) === [] && !TelegramGroupPinAccess::enabled($config) && !TelegramGroupPinAccess::taskCodesEnabled($config)) $errors[] = 'TELEGRAM_ADMIN_PIN'; } catch (Throwable) { $errors[] = 'TELEGRAM_ADMIN_USER_IDS'; }
        try { self::ids($config['TELEGRAM_ADMIN_CHAT_IDS'] ?? '', true); } catch (Throwable) { $errors[] = 'TELEGRAM_ADMIN_CHAT_IDS'; }
        $pin = (string) ($config['TELEGRAM_ADMIN_PIN'] ?? '');
        if (TelegramGroupPinAccess::enabled($config) && strlen($pin) < 6) $errors[] = 'TELEGRAM_ADMIN_PIN';
        if ($pin !== '' && (strlen($pin) < 6 || strlen($pin) > 128 || trim($pin) !== $pin || preg_match('/[\x00-\x1f\x7f]/', $pin) || in_array($pin, ['取消', '后台加白', '任务验证码', '菜单', '创建后台', '创建后台账号', '我的后台入口'], true) || str_starts_with($pin, '/'))) $errors[] = 'TELEGRAM_ADMIN_PIN';
        if (in_array(strtolower((string) ($config['TELEGRAM_ADMIN_ACCOUNTS_ENABLED'] ?? '')), ['true', '1'], true)) {
            $base = rtrim((string) ($config['ADMIN_ENTRY_BASE_URL'] ?? ''), '/'); $entry = parse_url($base);
            if ($pin === '') $errors[] = 'TELEGRAM_ADMIN_PIN';
            if (!filter_var($base, FILTER_VALIDATE_URL) || !$entry || ($entry['scheme'] ?? '') !== 'https' || isset($entry['user']) || isset($entry['pass']) || isset($entry['query']) || isset($entry['fragment']) || !empty($entry['path'])) $errors[] = 'ADMIN_ENTRY_BASE_URL';
        }
        $keyLength = strlen(trim((string) ($config['ADMIN_IP_CONTROL_KEY'] ?? '')));
        if ($keyLength < 32 || $keyLength > 256) $errors[] = 'ADMIN_IP_CONTROL_KEY';
        $mode = (string) ($config['TELEGRAM_CONTROL_MODE'] ?? '') ?: 'http';
        if (!in_array($mode, ['http', 'local'], true)) $errors[] = 'TELEGRAM_CONTROL_MODE';
        $url = (string) ($config['ADMIN_IP_CONTROL_URL'] ?? ''); $parts = parse_url($url);
        $local = is_array($parts) && in_array(strtolower((string) ($parts['host'] ?? '')), ['localhost', '127.0.0.1', '[::1]', '::1'], true);
        $development = in_array(strtolower((string) ($config['APP_ENV'] ?? 'production')), ['local', 'development', 'dev', 'testing', 'test'], true);
        if ($mode !== 'local' && (!filter_var($url, FILTER_VALIDATE_URL) || !$parts || isset($parts['user'], $parts['pass']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])
            || !(strtolower((string) ($parts['scheme'] ?? '')) === 'https' || (strtolower((string) ($parts['scheme'] ?? '')) === 'http' && $local && $development)))) $errors[] = 'ADMIN_IP_CONTROL_URL';
        return array_values(array_unique($errors));
    }

    private static function dnsProvider(array $config): string
    {
        $value = strtolower(trim((string) ($config['TELEGRAM_DNS_PROVIDER'] ?? '')));
        return $value === '' ? 'system' : $value;
    }

    /** Only Telegram uses optional DoH. The bot URL, TLS checks and signed control API stay intact. */
    public static function telegramDnsOptions(string $url, string $provider = 'system'): array
    {
        $provider = self::dnsProvider(['TELEGRAM_DNS_PROVIDER' => $provider]);
        if (!in_array($provider, ['system', 'cloudflare', 'google'], true)) throw new RuntimeException('Invalid TELEGRAM_DNS_PROVIDER.');
        if ($provider === 'system' || parse_url($url, PHP_URL_SCHEME) !== 'https' || strtolower((string) parse_url($url, PHP_URL_HOST)) !== 'api.telegram.org') return [];
        if (!defined('CURLOPT_DOH_URL') || !function_exists('curl_version') || (curl_version()['version_number'] ?? 0) < 0x073e00) throw new RuntimeException('PHP cURL DoH support is required.');
        // Bootstrap only the public DNS resolver. Telegram IPs are resolved dynamically.
        [$endpoint, $bootstrap] = $provider === 'cloudflare'
            ? ['https://cloudflare-dns.com/dns-query', 'cloudflare-dns.com:443:1.1.1.1,1.0.0.1']
            : ['https://dns.google/dns-query', 'dns.google:443:8.8.8.8,8.8.4.4'];
        $options = [CURLOPT_DOH_URL => $endpoint, CURLOPT_RESOLVE => [$bootstrap]];
        // Older supported cURL releases verify DoH TLS by default but lack these explicit options.
        if (defined('CURLOPT_DOH_SSL_VERIFYPEER')) $options[CURLOPT_DOH_SSL_VERIFYPEER] = true;
        if (defined('CURLOPT_DOH_SSL_VERIFYHOST')) $options[CURLOPT_DOH_SSL_VERIFYHOST] = 2;
        return $options;
    }

    public function pollOnce(): int
    {
        if ($this->username === null) {
            $me = ($this->telegram)('getMe', []);
            if (($me['is_bot'] ?? false) !== true || !preg_match('/^[A-Za-z0-9_]{5,32}$/D', (string) ($me['username'] ?? ''))) throw new RuntimeException('Telegram bot identity unavailable.');
            $this->username = strtolower($me['username']);
        }
        $updates = ($this->telegram)('getUpdates', ['offset' => $this->state['offset'], 'limit' => 50, 'timeout' => 25, 'allowed_updates' => ['message']]);
        return $this->processUpdates($updates);
    }

    /** Offset is durably consumed before any API mutation: uncertain operations are never replayed. */
    public function processUpdates(array $updates): int
    {
        usort($updates, static fn ($a, $b): int => (int) ($a['update_id'] ?? -1) <=> (int) ($b['update_id'] ?? -1)); $processed = 0;
        foreach ($updates as $update) {
            $id = $update['update_id'] ?? null;
            if (!is_int($id) || $id < $this->state['offset'] || $id >= PHP_INT_MAX) continue;
            $this->state['offset'] = $id + 1; $this->expire(); $this->save(); $processed++;
            $message = $update['message'] ?? null;
            if (!is_array($message) || !$this->authorized($message)) continue;
            // Never revive an old queued authorization after downtime. All user
            // input, including PIN replies, must belong to a recent real message.
            $date = $message['date'] ?? null; $now = ($this->clock)();
            if (!is_int($date) || $date < $now - self::FLOW_TTL || $date > $now + 60) continue;
            // PIN acceptance consumes its flow before sending the result. Keep the
            // originating group/topic routing captured while that flow exists.
            $groupPinReply = $this->groupPinMessage($message);
            $plan = $this->plan($message); $this->save();
            if ($plan === null) continue;
            $reply = $plan['reply'] ?? '';
            if (isset($plan['operation'])) {
                try { $reply = $this->perform($plan['operation']); }
                catch (Throwable $error) {
                    $failure = TelegramBotRuntime::record($error, $plan['operation']['action']);
                    $reply = match ($plan['operation']['action']) {
                    'task_codes' => '任务验证码查询失败，请重新发送“任务验证码”并验证后重试。',
                    'admin_create' => '创建结果未确认。请先发送“我的后台入口”核对；如已有该账号但未收到密码，请由超级管理员在后台重置密码，勿重复创建。',
                    'admin_entries' => '后台入口查询失败，请重新发送“我的后台入口”并验证后重试。',
                    default => '操作结果未确认，请先用 /listips 核对，再发送一条新命令。' };
                    $reply .= "\n错误编号：" . $failure['number'] . '；记录号：' . $failure['reference'];
                }
            }
            $credentials = is_array($reply) && isset($reply['credential_text']) ? $reply : null;
            foreach ($credentials !== null ? [$credentials['credential_text']] : (is_array($reply) ? $reply : self::splitMessage($reply, self::MESSAGE_UNITS)) as $part) {
                $body = ['chat_id' => (string) $message['chat']['id'], 'text' => $part, 'protect_content' => false, 'link_preview_options' => ['is_disabled' => true]];
                if ($credentials !== null) {
                    // Credential replies retain their dedicated copy buttons.
                    // All replies have already passed the sender/chat checks.
                    $body['parse_mode'] = 'HTML';
                    $body['reply_markup'] = ['inline_keyboard' => $credentials['copy_keyboard']];
                } elseif ($groupPinReply) {
                    // A targeted reply also works with Telegram group privacy mode.
                    $flowKey = (string) $message['from']['id'] . ':' . (string) $message['chat']['id'];
                    if (isset($this->state['flows'][$flowKey]) || !empty($plan['group_menu'])) $body['reply_markup'] = ['force_reply' => true, 'selective' => true];
                    if (isset($plan['keyboard'])) {
                        $choices = [];
                        foreach ($plan['keyboard'] as $row) foreach ($row as $label) if (is_string($label)) $choices[] = $label;
                        $body['text'] .= "\n可回复：" . implode('、', $choices);
                    }
                } elseif ($this->accountsEnabled() && ($message['chat']['type'] ?? '') === 'private') $body['reply_markup'] = ['keyboard' => $plan['keyboard'] ?? [['创建后台账号', '我的后台入口'], ['任务验证码', '菜单']], 'resize_keyboard' => true, 'is_persistent' => true];
                if ($groupPinReply) {
                    if (is_int($message['message_id'] ?? null) && $message['message_id'] > 0) $body['reply_parameters'] = ['message_id' => $message['message_id'], 'allow_sending_without_reply' => true];
                    if (is_int($message['message_thread_id'] ?? null) && $message['message_thread_id'] > 0) $body['message_thread_id'] = $message['message_thread_id'];
                }
                try { ($this->telegram)('sendMessage', $body); }
                catch (Throwable) { error_log('Telegram bot reply delivery failed; consumed update will not be replayed.'); break; }
            }
        }
        return $processed;
    }

    private function authorized(array $message): bool
    {
        if (!is_array($message['from'] ?? null) || ($message['from']['is_bot'] ?? false) !== false || !is_array($message['chat'] ?? null) || !is_string($message['text'] ?? null)) return false;
        foreach (['forward_origin', 'forward_from', 'forward_from_chat', 'forward_sender_name', 'forward_date', 'sender_chat', 'via_bot'] as $field) if (isset($message[$field])) return false;
        if (!empty($message['is_automatic_forward'])) return false;
        $user = self::numericId($message['from']['id'] ?? null, false); $chat = self::numericId($message['chat']['id'] ?? null, true);
        if ($user === null || $chat === null) return false;
        return $this->legacyAuthorized($message) || $this->groupPinMessage($message);
    }

    private function legacyAuthorized(array $message): bool
    {
        $user = self::numericId($message['from']['id'] ?? null, false); $chat = self::numericId($message['chat']['id'] ?? null, true);
        if ($user === null || $chat === null || !in_array($user, $this->config['users'], true)) return false;
        $type = $message['chat']['type'] ?? '';
        if ($this->config['chats'] === []) return $type === 'private' && $user === $chat;
        return in_array($type, ['private', 'group', 'supergroup'], true) && in_array($chat, $this->config['chats'], true);
    }

    private function groupPinMessage(array $message): bool
    {
        if (!in_array($message['chat']['type'] ?? '', ['group', 'supergroup'], true)
            || preg_match('/^-[1-9][0-9]{0,18}$/D', (string) ($message['chat']['id'] ?? '')) !== 1) return false;
        if (TelegramGroupPinAccess::enabled($this->config)) return true;
        if (!TelegramGroupPinAccess::taskCodesEnabled($this->config)) return false;
        $text = trim((string) ($message['text'] ?? ''));
        $key = (string) ($message['from']['id'] ?? '') . ':' . (string) $message['chat']['id'];
        return $text === '任务验证码' || ($this->state['flows'][$key]['operation']['action'] ?? '') === 'task_codes';
    }

    private function pinKey(string $key): string
    {
        [$user, $chat] = explode(':', $key, 2);
        return (TelegramGroupPinAccess::enabled($this->config) || TelegramGroupPinAccess::taskCodesEnabled($this->config)) && str_starts_with($chat, '-') ? 'group-user:' . $user : $key;
    }

    private function plan(array $message): ?array
    {
        $user = (string) $message['from']['id']; $key = $user . ':' . (string) $message['chat']['id']; $text = trim($message['text']); $now = ($this->clock)();
        $pinKey = $this->pinKey($key);
        $groupPin = $this->groupPinMessage($message);
        $taskOnlyGroup = $groupPin && !TelegramGroupPinAccess::enabled($this->config) && !$this->legacyAuthorized($message);
        if ($groupPin) {
            if (preg_match('/^\/(start|menu|createadmin|adminentry)(?:@([A-Za-z0-9_]+))?$/D', $text, $command)) {
                if (!empty($command[2]) && ($this->username === null || strtolower($command[2]) !== $this->username)) return null;
                $text = '/' . $command[1];
            }
            if ($text === '创建后台') $text = '创建后台账号';
            if (!$this->legacyAuthorized($message)) {
                if ($text === '后台加白' || preg_match('/^\/(addip|removeip|listips)(?:@|\s|$)/D', $text)) return ['reply' => '群成员入口提供任务验证码、创建后台账号和本人后台入口，后台IP管理仍需原管理员授权。'];
                $commands = ['菜单', '/start', '/menu', '创建后台账号', '/createadmin', '我的后台入口', '/adminentry', '任务验证码', '取消', '/cancel'];
                if (!isset($this->state['flows'][$key]) && !in_array($text, $commands, true) && !preg_match('/^\/taskcodes(?:@|\s|$)/D', $text)) return null;
            }
        }
        if ($text === '取消' || $text === '/cancel') { unset($this->state['flows'][$key]); return ['reply' => '已取消。']; }
        if ($this->accountsEnabled() && !$taskOnlyGroup) {
            if (in_array($text, ['菜单', '/start', '/menu', '创建后台账号', '/createadmin', '我的后台入口', '/adminentry'], true)) {
                if (!$groupPin && (($message['chat']['type'] ?? '') !== 'private' || (string) $message['chat']['id'] !== $user)) return ['reply' => '后台账号和专属入口操作请私聊机器人。'];
                unset($this->state['flows'][$key]);
                if (in_array($text, ['菜单', '/start', '/menu'], true)) return ['reply' => '请选择：创建后台账号、我的后台入口、任务验证码。后台账号创建和入口查询均需验证管理员验证码。', 'group_menu' => $groupPin];
                if (in_array($text, ['我的后台入口', '/adminentry'], true)) return $this->begin($key, ['action' => 'admin_entries', 'actor' => 'telegram:' . $user], true);
                $this->state['flows'][$key] = ['stage' => 'account_name', 'expires' => $now + self::FLOW_TTL];
                return ['reply' => '请输入后台账号名：3至64位，以字母开头，支持字母、数字、点、横线和下划线；也可点“自动生成”。', 'keyboard' => [['自动生成', '取消']]];
            }
            $flow = $this->state['flows'][$key] ?? null;
            if ($flow && str_starts_with($flow['stage'], 'account_')) return $this->accountStep($key, $text, $user, $flow);
        }
        if ($text === '/listips') return ['operation' => ['action' => 'list', 'actor' => 'telegram:' . $user]];
        if (preg_match('/^\/(addip|removeip|listips|taskcodes)(?:@([A-Za-z0-9_]+))?(?:\s+(.*))?$/sD', $text, $match)) {
            if (!empty($match[2]) && ($this->username === null || strtolower($match[2]) !== $this->username)) return null;
            if ($match[1] === 'taskcodes') {
                if (trim($match[3] ?? '') !== '') return ['reply' => '格式：/taskcodes，无需附加日期或参数；也可发送“任务验证码”。'];
                return $this->begin($key, ['action' => 'task_codes', 'actor' => 'telegram:' . $user], true);
            }
            if ($match[1] === 'listips') return ['operation' => ['action' => 'list', 'actor' => 'telegram:' . $user]];
            $operation = $this->operation($match[1] === 'addip' ? 'add' : 'remove', trim($match[3] ?? ''), $user);
            if ($operation === null) return ['reply' => '格式：/addip IP [小时]，或 /removeip IP。小时为正数，默认24小时，最多8760小时。'];
            return $this->begin($key, $operation);
        }
        if ($text === '任务验证码') return $this->begin($key, ['action' => 'task_codes', 'actor' => 'telegram:' . $user], true);
        if ($text === '后台加白') return $this->begin($key, null);
        $flow = $this->state['flows'][$key] ?? null;
        if ($flow && $flow['stage'] === 'pin') {
            if (($this->state['pins'][$pinKey]['blocked_until'] ?? 0) > $now) return ['reply' => '验证次数已达限制，请稍后重新请求。'];
            if (!hash_equals((string) $this->config['TELEGRAM_ADMIN_PIN'], $text)) {
                $attempts = (int) ($this->state['pins'][$pinKey]['attempts'] ?? 0) + 1;
                $this->state['pins'][$pinKey] = ['attempts' => $attempts, 'expires' => $now + self::FLOW_TTL, 'blocked_until' => $attempts >= 3 ? $now + self::FLOW_TTL : 0];
                if ($attempts >= 3) { unset($this->state['flows'][$key]); return ['reply' => '验证次数已达限制，请稍后重新请求。']; }
                return ['reply' => ($flow['operation']['action'] ?? '') === 'task_codes'
                    ? '验证未通过，请重新输入验证密码，或发送“取消”。'
                    : '验证未通过，请重新输入验证码，或发送“取消”。'];
            }
            unset($this->state['pins'][$pinKey]);
            $operation = $flow['operation'];
            if ($operation !== null) {
                unset($this->state['flows'][$key]);
                if ($groupPin && in_array($operation['action'] ?? '', ['task_codes', 'admin_create', 'admin_entries'], true)) {
                    $operation = TelegramGroupPinAccess::issue($operation, (string) $message['chat']['id'], $this->config, $now);
                }
                return ['operation' => $operation];
            }
            $this->state['flows'][$key] = ['stage' => 'ip', 'operation' => null, 'expires' => $now + self::FLOW_TTL];
            return ['reply' => '请输入要放行的IPv4或IPv6，可附加小时（默认24小时）。'];
        }
        if ($flow && $flow['stage'] === 'ip') {
            $operation = $this->operation('add', $text, $user);
            if ($operation === null) return ['reply' => '请输入有效IPv4或IPv6，可附加正数小时；也可发送“取消”。'];
            unset($this->state['flows'][$key]); return ['operation' => $operation];
        }
        return ['reply' => '命令：/addip IP [小时]、/removeip IP、/listips；或发送“后台加白”“任务验证码”（/taskcodes）。'];
    }

    private function accountsEnabled(): bool { return in_array(strtolower((string) ($this->config['TELEGRAM_ADMIN_ACCOUNTS_ENABLED'] ?? '')), ['true', '1'], true); }

    private function accountStep(string $key, string $text, string $user, array $flow): array
    {
        $flow['expires'] = ($this->clock)() + self::FLOW_TTL;
        if ($flow['stage'] === 'account_name') {
            $name = $text === '自动生成' ? 'tg_' . bin2hex(random_bytes(6)) : $text;
            if (!preg_match('/^[A-Za-z][A-Za-z0-9_.-]{2,63}$/D', $name)) return ['reply' => '账号格式无效，请重新输入，或点“自动生成”。', 'keyboard' => [['自动生成', '取消']]];
            $flow['username'] = $name; $flow['stage'] = 'account_role'; $this->state['flows'][$key] = $flow;
            return ['reply' => '账号：' . $name . "\n请选择角色：超级管理员拥有全部权限和后台账号管理权；普通运营可分配页面查看/操作权限；只读账号只能查看。", 'keyboard' => [['超级管理员', '普通运营', '只读账号'], ['取消']]];
        }
        if ($flow['stage'] === 'account_role') {
            $role = ['超级管理员' => 'admin', '普通运营' => 'operator', '只读账号' => 'auditor'][$text] ?? null;
            if ($role === null) return ['reply' => '请点击选择一个角色。', 'keyboard' => [['超级管理员', '普通运营', '只读账号'], ['取消']]];
            $flow['role'] = $role; $flow['permissions'] = []; $flow['stage'] = 'account_permissions';
            $this->state['flows'][$key] = $flow;
            return $this->permissionMenu($flow);
        }
        if ($flow['stage'] !== 'account_permissions') { unset($this->state['flows'][$key]); return ['reply' => '创建流程已失效，请重新发送“创建后台账号”。']; }
        if ($text === '确认创建') {
            $operation = ['action' => 'admin_create', 'actor' => 'telegram:' . $user, 'username' => $flow['username'], 'role' => $flow['role'],
                'permissions' => $flow['role'] === 'admin' ? [] : AdminPermissionService::normalize($flow['permissions'], $flow['role']), 'request_key' => bin2hex(random_bytes(32))];
            return $this->begin($key, $operation, true);
        }
        if ($flow['role'] !== 'admin') {
            if ($text === '全选权限') $flow['permissions'] = $flow['role'] === 'auditor' ? array_column(AdminPermissionService::catalog(), 'view') : AdminPermissionService::all();
            elseif ($text === '全部只读') $flow['permissions'] = array_column(AdminPermissionService::catalog(), 'view');
            elseif ($text === '清空权限') $flow['permissions'] = [];
            else foreach (AdminPermissionService::catalog() as $page) if ($text === '权限：' . $page['title']) {
                $view = in_array($page['view'], $flow['permissions'], true); $manage = $page['manage'] !== null && in_array($page['manage'], $flow['permissions'], true);
                $flow['permissions'] = array_values(array_diff($flow['permissions'], [$page['view'], $page['manage']]));
                if (!$view) $flow['permissions'][] = $page['view'];
                elseif (!$manage && $page['manage'] !== null && $flow['role'] !== 'auditor') { $flow['permissions'][] = $page['view']; $flow['permissions'][] = $page['manage']; }
                break;
            }
        }
        $this->state['flows'][$key] = $flow; return $this->permissionMenu($flow);
    }

    private function permissionMenu(array $flow): array
    {
        $lines = ['账号：' . $flow['username'], '角色：' . ['admin' => '超级管理员', 'operator' => '普通运营', 'auditor' => '只读账号'][$flow['role']]];
        $keyboard = [['确认创建', '取消']];
        if ($flow['role'] === 'admin') $lines[] = '全部页面和后台账号管理权限。确认后输入管理员验证码完成创建。';
        else {
            $lines[] = $flow['role'] === 'auditor' ? '点击页面切换：无权限 → 只读 → 无权限。' : '点击页面切换：无权限 → 只读 → 可操作 → 无权限。';
            $keyboard[] = ['全选权限', '全部只读', '清空权限']; $buttons = [];
            foreach (AdminPermissionService::catalog() as $page) {
                $level = $page['manage'] !== null && in_array($page['manage'], $flow['permissions'], true) ? '可操作' : (in_array($page['view'], $flow['permissions'], true) ? '只读' : '无权限');
                $lines[] = $page['title'] . '：' . $level; $buttons[] = '权限：' . $page['title'];
            }
            array_push($keyboard, ...array_chunk($buttons, 2));
        }
        return ['reply' => implode("\n", $lines), 'keyboard' => $keyboard];
    }

    private function begin(string $key, ?array $operation, bool $requirePin = false): array
    {
        $pinKey = $this->pinKey($key);
        if ($requirePin && ($this->config['TELEGRAM_ADMIN_PIN'] ?? '') === '') {
            unset($this->state['flows'][$key]);
            return ['reply' => '请先在服务器配置 TELEGRAM_ADMIN_PIN 管理员验证码，再查询任务验证码。'];
        }
        $now = ($this->clock)();
        if (($this->state['pins'][$pinKey]['blocked_until'] ?? 0) > $now) { unset($this->state['flows'][$key]); return ['reply' => '验证次数已达限制，请稍后重新请求。']; }
        if (($this->config['TELEGRAM_ADMIN_PIN'] ?? '') !== '') {
            $this->state['flows'][$key] = ['stage' => 'pin', 'operation' => $operation, 'expires' => $now + self::FLOW_TTL];
            return ['reply' => $operation !== null && ($operation['action'] ?? '') === 'task_codes'
                ? '请输入验证密码（管理员验证码），或发送“取消”。'
                : '请输入管理员验证码，或发送“取消”。'];
        }
        if ($operation !== null) { unset($this->state['flows'][$key]); return ['operation' => $operation]; }
        $this->state['flows'][$key] = ['stage' => 'ip', 'operation' => null, 'expires' => $now + self::FLOW_TTL];
        return ['reply' => '请输入要放行的IPv4或IPv6，可附加小时（默认24小时）。'];
    }

    private function operation(string $action, string $input, string $user): ?array
    {
        $parts = preg_split('/\s+/', $input);
        if (!filter_var($parts[0] ?? '', FILTER_VALIDATE_IP) || count($parts) > ($action === 'add' ? 2 : 1)) return null;
        $normalized = AdminIpAccessService::normalizeIp($parts[0]);
        if ($normalized === null) return null;
        $operation = ['action' => $action, 'ip' => $normalized, 'actor' => 'telegram:' . $user];
        if ($action === 'add') {
            $hours = $parts[1] ?? '24';
            if (!preg_match('/^[0-9]+(?:\.[0-9]{1,3})?$/D', $hours)) return null;
            $seconds = round((float) $hours * 3600);
            if (!is_finite($seconds) || $seconds < 1 || $seconds > 31536000) return null;
            $operation['ttl_seconds'] = (int) $seconds;
        }
        return $operation;
    }

    private function perform(array $operation): string|array
    {
        $result = ($this->control)($operation);
        if ($operation['action'] === 'admin_create') {
            if (($result['created'] ?? null) === false) return ($result['reason'] ?? '') === 'username_exists' ? '账号名已存在，未修改原账号。请重新创建并换一个账号名。' : '此创建请求已处理，未重复创建。请发送“我的后台入口”查询；未收到密码请由超级管理员在后台重置。';
            if (($result['created'] ?? false) !== true || ($result['username'] ?? '') !== $operation['username'] || ($result['role'] ?? '') !== $operation['role']
                || !is_string($result['password'] ?? null) || !preg_match('/^[A-Za-z0-9!_-]{14,128}$/D', $result['password']) || !$this->validEntryUrl($result['entry_url'] ?? null)) throw new RuntimeException('Invalid account acknowledgement.');
            $escape = static fn (string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
            return [
                'credential_text' => '后台账号已创建' . "\n账号：<code>" . $escape($result['username']) . "</code>\n角色：" . ['admin' => '超级管理员', 'operator' => '普通运营', 'auditor' => '只读账号'][$result['role']]
                    . "\n初始密码：\n<code>" . $escape($result['password']) . "</code>\n专属入口：" . $escape($result['entry_url']) . "\n点击下方按钮可复制账号或密码。请保存密码和入口，打开入口后仍需登录。",
                'copy_keyboard' => [
                    [['text' => '复制账号', 'copy_text' => ['text' => $result['username']]], ['text' => '复制密码', 'copy_text' => ['text' => $result['password']]]],
                    [['text' => '打开专属入口', 'url' => $result['entry_url']]],
                ],
            ];
        }
        if ($operation['action'] === 'admin_entries') {
            if (!is_array($result['items'] ?? null) || count($result['items']) > 100) throw new RuntimeException('Invalid entry acknowledgement.');
            $pages = ['你的后台专属入口（打开后仍需账号密码）：'];
            foreach ($result['items'] as $item) {
                if (!is_array($item) || !is_string($item['username'] ?? null) || !preg_match('/^[A-Za-z][A-Za-z0-9_.-]{2,63}$/D', $item['username']) || !$this->validEntryUrl($item['entry_url'] ?? null)) throw new RuntimeException('Invalid entry acknowledgement.');
                $pages[] = $item['username'] . "\n" . $item['entry_url'];
            }
            if (count($pages) === 1) $pages[] = '暂无已绑定的后台账号，请先创建。';
            return self::splitMessage(implode("\n\n", $pages), self::MESSAGE_UNITS);
        }
        if ($operation['action'] === 'add') {
            if (($result['entry']['ip'] ?? '') !== $operation['ip']) throw new RuntimeException('Invalid control acknowledgement.');
            return '已放行 ' . $operation['ip'] . '，有效期 ' . $operation['ttl_seconds'] . ' 秒。';
        }
        if ($operation['action'] === 'remove') {
            if (!is_bool($result['removed'] ?? null)) throw new RuntimeException('Invalid control acknowledgement.');
            return $result['removed'] ? '已移除 ' . $operation['ip'] . '。' : '未找到该IP的动态白名单记录。';
        }
        if ($operation['action'] === 'task_codes') return $this->taskCodePages($result);
        if ($operation['action'] !== 'list') throw new RuntimeException('Invalid control action.');
        if (!is_array($result['items'] ?? null)) throw new RuntimeException('Invalid control acknowledgement.');
        $lines = ['当前后台IP白名单：'];
        foreach (array_slice(is_array($result['items'] ?? null) ? $result['items'] : [], 0, 40) as $item) {
            if (!is_array($item) || !filter_var($item['ip'] ?? '', FILTER_VALIDATE_IP)) continue;
            $expires = is_string($item['expires_at'] ?? null) ? preg_replace('/[^0-9TtZz:+.\- ]/', '', $item['expires_at']) : '永久';
            $lines[] = $item['ip'] . ' · ' . $expires;
        }
        if (count($lines) === 1) $lines[] = '暂无记录。';
        if (count($result['items'] ?? []) > 40) $lines[] = '仅展示前40条。';
        return implode("\n", $lines);
    }

    private function validEntryUrl(mixed $url): bool
    {
        $prefix = rtrim((string) ($this->config['ADMIN_ENTRY_BASE_URL'] ?? ''), '/') . '/entry/#';
        return is_string($url) && str_starts_with($url, $prefix) && preg_match('/^[a-f0-9]{64}$/D', substr($url, strlen($prefix))) === 1;
    }

    /** Validate the complete response before sending any page; codes stay strings. */
    private function taskCodePages(array $result): array
    {
        $date = $result['date'] ?? null; $items = $result['items'] ?? null;
        if (!is_string($date) || !preg_match('/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/D', $date)
            || !is_array($items) || !array_is_list($items) || !is_int($result['total'] ?? null) || $result['total'] !== count($items)) throw new TelegramBotFailure('TG-CONTROL-DATA');
        $parsed = \DateTimeImmutable::createFromFormat('!Y-m-d', $date, new \DateTimeZone('Asia/Shanghai'));
        if (!$parsed || $parsed->format('Y-m-d') !== $date) throw new TelegramBotFailure('TG-CONTROL-DATA');
        $header = '今日任务验证码（' . $date . '）'; $lines = []; $ids = [];
        foreach ($items as $item) {
            if (!is_array($item) || !is_int($item['task_id'] ?? null) || $item['task_id'] < 1 || isset($ids[$item['task_id']])
                || !is_string($item['task_name'] ?? null) || !mb_check_encoding($item['task_name'], 'UTF-8')
                || !is_string($item['code'] ?? null) || !preg_match('/^[0-9]{6}$/D', $item['code'])
                || (isset($item['status']) && !in_array($item['status'], ['enabled', 'disabled'], true))) throw new TelegramBotFailure('TG-CONTROL-DATA');
            $ids[$item['task_id']] = true;
            // Include Unicode line/bidi controls as well as CR/LF: a task name
            // must never create or reorder apparent task/code rows in a chat.
            $name = trim((string) preg_replace('/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/u', ' ', $item['task_name']));
            $lines[] = ($name === '' ? '（未命名任务）' : $name) . ' | ' . $item['code'];
        }
        if ($lines === []) $lines[] = '暂无已创建任务';
        $pages = []; $page = $header;
        $rowLimit = self::MESSAGE_UNITS - self::utf16Units($header) - 1;
        foreach ($lines as $line) foreach (self::splitMessage($line, $rowLimit) as $part) {
            if (self::utf16Units($page . "\n" . $part) > self::MESSAGE_UNITS) { $pages[] = $page; $page = $header; }
            $page .= "\n" . $part;
        }
        $pages[] = $page;
        return $pages;
    }

    private static function utf16Units(string $text): int { return intdiv(strlen(mb_convert_encoding($text, 'UTF-16LE', 'UTF-8')), 2); }

    /** Split without cutting a surrogate pair or discarding any text. */
    private static function splitMessage(string $text, int $limit): array
    {
        if ($text === '') return [];
        if (self::utf16Units($text) <= $limit) return [$text];
        $parts = []; $part = ''; $units = 0;
        foreach (mb_str_split($text, 1, 'UTF-8') as $character) {
            $size = self::utf16Units($character);
            if ($units + $size > $limit) { $parts[] = $part; $part = ''; $units = 0; }
            $part .= $character; $units += $size;
        }
        if ($part !== '') $parts[] = $part;
        return $parts;
    }

    private function expire(): void
    {
        foreach (['flows', 'pins'] as $kind) foreach ($this->state[$kind] as $key => $value) if (!is_array($value) || ($value['expires'] ?? 0) <= ($this->clock)()) unset($this->state[$kind][$key]);
    }

    private function save(): void
    {
        $file = $this->directory . '/state.json'; $temp = tempnam($this->directory, '.state-');
        if ($temp === false) throw new RuntimeException('Bot state cannot be saved.');
        try {
            @chmod($temp, 0600); $stream = @fopen($temp, 'wb');
            if (!$stream) throw new RuntimeException('Bot state cannot be saved.');
            try {
                $raw = json_encode($this->state, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
                if (fwrite($stream, $raw) !== strlen($raw) || !fflush($stream) || (function_exists('fsync') && !fsync($stream))) throw new RuntimeException('Bot state cannot be saved.');
            } finally { fclose($stream); }
            if (!@rename($temp, $file)) throw new RuntimeException('Bot state cannot be saved.');
            @chmod($file, 0600);
        } finally { if (is_file($temp)) @unlink($temp); }
    }

    public function close(): void { if (is_resource($this->lock)) { flock($this->lock, LOCK_UN); fclose($this->lock); } $this->lock = null; }
    public function __destruct() { $this->close(); }

    private static function ids(mixed $raw, bool $signed): array
    {
        if (!is_string($raw)) throw new RuntimeException('Invalid numeric allowlist.');
        if (trim($raw) === '') return [];
        $result = [];
        foreach (preg_split('/[\s,]+/', trim($raw)) as $input) { $id = self::numericId($input, $signed); if ($id === null) throw new RuntimeException('Invalid numeric allowlist.'); $result[$id] = $id; }
        return array_values($result);
    }
    private static function numericId(mixed $id, bool $signed): ?string
    {
        if ((!is_int($id) && !is_string($id)) || !preg_match($signed ? '/^-?[1-9][0-9]{0,18}$/D' : '/^[1-9][0-9]{0,18}$/D', (string) $id) || filter_var($id, FILTER_VALIDATE_INT) === false) return null;
        return (string) $id;
    }

    private function telegramRequest(string $method, array $body): array
    {
        if (!in_array($method, ['getMe', 'getUpdates', 'sendMessage'], true)) throw new RuntimeException('Invalid Telegram method.');
        $result = ($this->http)('https://api.telegram.org/bot' . $this->config['TELEGRAM_BOT_TOKEN'] . '/' . $method, json_encode($body, JSON_THROW_ON_ERROR), ['Content-Type: application/json'], $method === 'getUpdates' ? 30 : 10);
        if (($result['ok'] ?? false) !== true || !is_array($result['result'] ?? null)) throw new RuntimeException('Telegram request was not accepted.');
        return $result['result'];
    }
    private function controlRequest(array $body): array
    {
        $raw = json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        $timestamp = (string) ($this->clock)(); $nonce = bin2hex(random_bytes(16));
        $signature = hash_hmac('sha256', $timestamp . "\n" . $nonce . "\n" . hash('sha256', $raw), $this->config['ADMIN_IP_CONTROL_KEY']);
        if (($this->config['TELEGRAM_CONTROL_MODE'] ?? '') === 'local') {
            $response = ($this->localApi)(['REQUEST_METHOD' => 'POST', 'REQUEST_URI' => '/ops/admin-ip-allowlist',
                'HTTP_X_ADMIN_IP_TIMESTAMP' => $timestamp, 'HTTP_X_ADMIN_IP_NONCE' => $nonce, 'HTTP_X_ADMIN_IP_SIGNATURE' => $signature], $raw);
            if (!is_string($response['body'] ?? null) || strlen($response['body']) > 1048576) throw new TelegramBotFailure('TG-CONTROL-DATA');
            $result = json_decode($response['body'], true, 32);
            if (($response['status'] ?? null) !== 200) throw TelegramBotRuntime::remoteFailure(is_array($result) ? $result : null, (int) ($response['status'] ?? 0));
            if (!is_array($result) || json_last_error() !== JSON_ERROR_NONE) throw new TelegramBotFailure('TG-CONTROL-JSON');
        } else $result = ($this->http)($this->config['ADMIN_IP_CONTROL_URL'], $raw, ['Content-Type: application/json', 'Cache-Control: no-store', 'Pragma: no-cache', 'X-Admin-IP-Timestamp: ' . $timestamp, 'X-Admin-IP-Nonce: ' . $nonce, 'X-Admin-IP-Signature: ' . $signature], 10);
        if (($result['ok'] ?? false) !== true || !is_array($result['data'] ?? null)) throw new TelegramBotFailure('TG-CONTROL-DATA');
        return $result['data'];
    }
    private static function jsonHttp(string $url, string $raw, array $headers, int $timeout, string $dnsProvider = 'system'): array
    {
        if (!function_exists('curl_init')) throw new RuntimeException('cURL is unavailable.');
        $curl = curl_init($url); $response = '';
        try {
            $dnsOptions = self::telegramDnsOptions($url, $dnsProvider);
            if (!curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $raw, CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CONNECTTIMEOUT => $dnsOptions === [] ? 4 : 8, CURLOPT_TIMEOUT => $timeout, CURLOPT_NOSIGNAL => true, CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$response): int { if (strlen($response) + strlen($chunk) > 1048576) return 0; $response .= $chunk; return strlen($chunk); }]
                + $dnsOptions)) throw new RuntimeException('Remote transport options unavailable.');
            if (PHP_OS_FAMILY === 'Windows' && defined('CURLSSLOPT_NATIVE_CA')) curl_setopt($curl, CURLOPT_SSL_OPTIONS, CURLSSLOPT_NATIVE_CA);
            if (curl_exec($curl) === false) throw new TelegramBotFailure('TG-CONTROL-NETWORK', ['curl_errno' => curl_errno($curl)]);
            $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            $result = json_decode($response, true, 32);
            if ($status !== 200) throw TelegramBotRuntime::remoteFailure(is_array($result) ? $result : null, $status);
            if (!is_array($result) || json_last_error() !== JSON_ERROR_NONE) throw new TelegramBotFailure('TG-CONTROL-JSON');
            return $result;
        } catch (TelegramBotFailure $error) { throw $error; }
        catch (Throwable) { throw new TelegramBotFailure('TG-CONTROL-NETWORK'); }
        finally { curl_close($curl); }
    }
}
