<?php

use Workerman\Connection\TcpConnection;
use Workerman\Connection\AsyncTcpConnection;
use Workerman\Lib\Timer;
use Workerman\Worker;

require dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/app/Service/RequestTrace.php';
Worker::$pidFile = dirname(__DIR__) . "/runtime/pulse-im-websocket.pid";
Worker::$logFile = dirname(__DIR__) . "/runtime/pulse-im-websocket.log";
TcpConnection::$defaultMaxPackageSize = 65536;

$worker = new Worker('websocket://0.0.0.0:8282');
$worker->name = 'pulse-im-websocket';
$worker->connections = [];
$worker->pdo = null;
$worker->eventCursor = 0;
$worker->pendingEvents = [];
$worker->eventQueueMayHaveMore = false;
$worker->eventDrainTimer = null;
$worker->bundledReads = wsEnv('WEBSOCKET_BUNDLE_READS', '0') === '1';
$worker->compactAuth = wsEnv('WEBSOCKET_COMPACT_AUTH', '0') === '1';
$worker->batchEvents = wsEnv('WEBSOCKET_BATCH_EVENTS', '0') === '1';
$worker->pumping = false;
$worker->lastPumpAt = 0;
$worker->redis = null;
$worker->redisBuffer = '';
$worker->presenceQueue = [];
$worker->redisEnabled = wsEnv('REALTIME_DRIVER', 'database') === 'redis';
$worker->asyncMetadata = $worker->redisEnabled && wsEnv('WEBSOCKET_ASYNC_METADATA', '0') === '1';
$worker->nodeId = '';
$worker->count = max(1, (int) wsEnv('WEBSOCKET_WORKERS', '1'));

$worker->onWorkerStart = static function () use ($worker): void {
    (new think\App(dirname(__DIR__) . '/'))->initialize();
    $worker->nodeId = bin2hex(random_bytes(12)) . '-' . getmypid();
    $worker->eventCursor = latestEventId($worker);
    $worker->lastPumpAt = time();
    $worker->metadataStartedAt = microtime(true);
    heartbeatWorker($worker);
    if ($worker->redisEnabled) connectRedis($worker);
    // HTTP sends must not wait half a second for their next delivery tick.
    // Redis still wakes this same durable reader immediately when configured.
    $pollSeconds = max(50, min(1000, (int) wsEnv('WEBSOCKET_POLL_INTERVAL_MS', '100'))) / 1000;
    Timer::add($pollSeconds, static function () use ($worker): void {
        // Redis is an acceleration hint. Always compensate through committed events.
        try { pumpEvents($worker); }
        catch (Throwable $error) { if (wsDatabaseFailure($error)) resetDatabaseConnections($worker); error_log('WebSocket event delivery failed; the cursor is retained for retry.'); }
    });
    Timer::add(5, static function () use ($worker): void {
        try { revalidateConnections($worker); if (time() - $worker->lastPumpAt <= 10) heartbeatWorker($worker); }
        catch (Throwable $error) { if (wsDatabaseFailure($error)) resetDatabaseConnections($worker); error_log('WebSocket heartbeat unavailable.'); }
    });
    // Preserve ping receipt times while grouping non-message presence writes.
    // Authentication and every delivery still check the current account state.
    Timer::add(5, static function () use ($worker): void {
        try { flushPresence($worker); }
        catch (Throwable $error) { if (wsDatabaseFailure($error)) resetDatabaseConnections($worker); error_log('WebSocket presence update deferred.'); }
    });
    if (!$worker->asyncMetadata) Timer::add(300, static function () use ($worker): void {
        try {
            // Retain a week of events, and never prune past a currently healthy reader.
            $query = db($worker)->query("SELECT MIN(event_cursor) FROM websocket_worker_health WHERE heartbeat_at >= DATE_SUB(NOW(), INTERVAL 15 SECOND)");
            $cursor = (int) $query->fetchColumn();
            $prune = db($worker)->prepare('DELETE FROM realtime_events WHERE id < ? AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY) LIMIT 10000');
            $prune->execute([$cursor]);
            db($worker)->exec('DELETE FROM websocket_worker_health WHERE heartbeat_at < DATE_SUB(NOW(), INTERVAL 1 DAY)');
        } catch (Throwable $error) { if (wsDatabaseFailure($error)) resetDatabaseConnections($worker); error_log('WebSocket event maintenance deferred.'); }
    });
};

$worker->onConnect = static function (TcpConnection $connection) use ($worker): void {
    $connection->userId = 0;
    $connection->tokenHash = '';
    $connection->clientPlatform = '';
    $connection->clientVersion = '';
    $connection->presenceAt = 0;
    $connection->receivedAt = time();
    $connection->connectedAt = time();
    $connection->rateStart = time();
    $connection->rateCount = 0;
    $connection->subscriptions = [];
    $connection->inboxCursor = null;
    // Workerman already registers by connection ID; object IDs are a different
    // counter and can collide with another live connection after repeated reconnects.
    $worker->connections[$connection->id] = $connection;
};

$worker->onMessage = static function (TcpConnection $connection, string $raw) use ($worker): void {
    $authAttempt = false;
    $authEstablished = false;
    try {
        $connection->receivedAt = time();
        if (strlen($raw) > 65536) throw new RuntimeException('消息内容过大。');
        if (time() - $connection->rateStart >= 60) { $connection->rateStart = time(); $connection->rateCount = 0; }
        if (++$connection->rateCount > max(30, (int) wsEnv('WEBSOCKET_RATE_LIMIT', '180'))) throw new RuntimeException('发送过于频繁，请稍后再试。');
        $data = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($data) || !is_string($data['type'] ?? null)) throw new RuntimeException('Invalid websocket payload.');
        $authAttempt = $data['type'] === 'auth';
        if ($authAttempt) {
            foreach (['token', 'client_platform', 'client_version'] as $key) if (array_key_exists($key, $data) && !is_string($data[$key])) throw new RuntimeException('认证参数格式无效。');
        }
        if ($data['type'] === 'message') {
            foreach (['message_type', 'request_id'] as $key) if (array_key_exists($key, $data) && !is_string($data[$key])) throw new RuntimeException('消息参数格式无效。');
        }
        $operationState=$connection->userId>0?readConnectionState($worker,$connection):null;
        if ($connection->userId > 0 && !($operationState!==null?$operationState['valid']:validConnection($worker, $connection))) { revokeConnection($connection); return; }
        if ($connection->userId > 0 && !versionAllowed($connection,$operationState['policy']??null)) return;
        if ($data['type'] === 'ping') {
            if ($connection->userId > 0 && time() - $connection->presenceAt >= 20) {
                queuePresence($worker, $connection->userId);
                $connection->presenceAt = time();
            }
            $connection->send(json_encode(['type' => 'pong', 'time' => time()]));
            return;
        }
        if ($data['type'] === 'auth') {
            $user = userByToken($worker, (string) ($data['token'] ?? ''));
            $connection->userId = (int) $user['id'];
            $connection->tokenHash = hash('sha256', (string) $data['token']);
            $connection->clientPlatform = strtolower(substr((string) ($data['client_platform'] ?? ''), 0, 20));
            $connection->clientVersion = substr((string) ($data['client_version'] ?? ''), 0, 40);
            $connection->subscriptions = [];
            $connection->inboxCursor = null;
            $authEstablished = true;
            if (!versionAllowed($connection)) return;
            touchPresence($worker, $connection->userId);
            $connection->presenceAt = time();
            $connection->send(json_encode(['type' => 'auth.ok', 'user_id' => $connection->userId]));
            return;
        }
        if ($connection->userId <= 0) throw new RuntimeException('Authentication required.');
        if ($data['type'] === 'inbox.subscribe') {
            // A lightweight account feed discovers conversations created after
            // the client loaded its list. Only IDs are delivered, never bodies.
            // Repeated subscriptions must not skip events waiting in the pump.
            if (!isset($connection->inboxCursor)) $connection->inboxCursor = latestEventId($worker);
            $connection->send(json_encode(['type' => 'inbox.subscribe.ok']));
            return;
        }
        if ($data['type'] === 'inbox.unsubscribe') {
            $connection->inboxCursor = null;
            $connection->send(json_encode(['type' => 'inbox.unsubscribe.ok']));
            return;
        }
        if ($data['type'] === 'subscribe') {
            $conversationId = (int) ($data['conversation_id'] ?? 0);
            assertMember($worker, $conversationId, $connection->userId);
            if (!array_key_exists($conversationId, $connection->subscriptions)) $connection->subscriptions[$conversationId] = latestEventId($worker);
            $connection->send(json_encode(['type' => 'subscribe.ok', 'conversation_id' => $conversationId]));
            return;
        }
        if ($data['type'] === 'unsubscribe') {
            $conversationId = (int) ($data['conversation_id'] ?? 0);
            unset($connection->subscriptions[$conversationId]);
            $connection->send(json_encode(['type' => 'unsubscribe.ok', 'conversation_id' => $conversationId]));
            return;
        }
        if ($data['type'] === 'message') {
            $message = saveMessage($worker, $connection->userId, $data);
            // Tell the sender the idempotent result even if it has not subscribed yet.
            $payload = (new app\Service\MediaAccessService())->transformPayload($message, $connection->tokenHash);
            $connection->send(json_encode(['type' => 'message.ack', 'data' => $payload], JSON_UNESCAPED_UNICODE));
            pumpEvents($worker);
            return;
        }
        throw new RuntimeException('Unsupported websocket event.');
    } catch (Throwable $exception) {
        $business = ($exception instanceof RuntimeException && !wsDatabaseFailure($exception)) || $exception instanceof JsonException;
        // Authentication is not complete until version/presence checks also succeed.
        // Unknown failures after the token lookup must not leave a half-authenticated OPEN socket.
        $infrastructure = !$business || $authEstablished;
        $payload = json_encode(['type' => 'error', 'code' => $infrastructure ? 'SERVER_UNAVAILABLE' : 'REQUEST_REJECTED',
            'retryable' => $infrastructure, 'message' => $infrastructure ? '服务暂时不可用，请重新连接。' : ($exception instanceof JsonException ? '消息格式无效。' : $exception->getMessage())], JSON_UNESCAPED_UNICODE);
        if ($infrastructure) resetDatabaseConnections($worker);
        if ($infrastructure || $authAttempt || $connection->userId <= 0) {
            $connection->userId = 0; $connection->tokenHash = ''; $connection->subscriptions = []; $connection->inboxCursor = null;
            $connection->close($payload);
        } else $connection->send($payload);
    }
};

$worker->onClose = static function (TcpConnection $connection) use ($worker): void {
    unset($worker->connections[$connection->id]);
};
$worker->onWorkerStop = static function () use ($worker): void {
    try {
        if ($worker->asyncMetadata) { enqueueWorkerMetadata($worker, ['type'=>'stop','node'=>$worker->nodeId]); return; }
        $query = db($worker)->prepare('DELETE FROM websocket_worker_health WHERE node_id = ?'); $query->execute([$worker->nodeId]);
    } catch (Throwable $error) {}
};

if ($worker->asyncMetadata) {
    // A single node-local consumer keeps durable bookkeeping off socket loops.
    // The queue contains presence/health metadata, never message bodies or tokens.
    $metadataWorker = new Worker();
    $metadataWorker->name = 'pulse-im-websocket-metadata';
    $metadataWorker->count = 1;
    $metadataWorker->pdo = null;
    $metadataWorker->onWorkerStart = static function () use ($metadataWorker): void {
        (new think\App(dirname(__DIR__) . '/'))->initialize();
        Timer::add(.5, static function () use ($metadataWorker): void {
            try { flushWorkerMetadata($metadataWorker); }
            catch (Throwable $error) { resetMetadataRedis($metadataWorker); if (wsDatabaseFailure($error)) resetDatabaseConnections($metadataWorker); error_log('WebSocket metadata persistence deferred.'); }
        });
        Timer::add(300, static function () use ($metadataWorker): void {
            try { maintainCommittedEvents($metadataWorker); }
            catch(Throwable $error){if(wsDatabaseFailure($error))resetDatabaseConnections($metadataWorker);error_log('WebSocket event maintenance deferred.');}
        });
    };
}

Worker::runAll();

function wsEnv(string $key, string $default = ''): string
{
    static $values;
    if ($values === null) $values = parse_ini_file(dirname(__DIR__) . '/.env', false, INI_SCANNER_RAW) ?: [];
    return (string) ($values[$key] ?? $default);
}

function connectRedis(object $worker): void
{
    $connection = new AsyncTcpConnection('tcp://' . wsEnv('REDIS_HOST', '127.0.0.1') . ':' . wsEnv('REDIS_PORT', '6379'));
    $connection->onConnect = static function (AsyncTcpConnection $connection) use ($worker): void {
        $password = wsEnv('REDIS_PASSWORD');
        if ($password !== '') $connection->send(redisCommand(['AUTH', $password]));
        $connection->send(redisCommand(['SUBSCRIBE', wsEnv('REALTIME_CHANNEL', 'pulse-im:messages')]));
    };
    $connection->onMessage = static function (AsyncTcpConnection $connection, string $data) use ($worker): void {
        $worker->redisBuffer .= $data;
        try {
            $wake = false;
            while (($frame = redisFrame($worker->redisBuffer)) !== null) {
                if (is_array($frame) && count($frame) >= 3 && $frame[0] === 'message') $wake = true;
            }
            if ($wake) pumpEvents($worker);
        } catch (Throwable $error) { if (wsDatabaseFailure($error)) resetDatabaseConnections($worker); $connection->close(); }
    };
    $connection->onClose = static function () use ($worker): void {
        $worker->redis = null;
        $worker->redisBuffer = '';
        Timer::add(2, static function () use ($worker): void { if ($worker->redisEnabled && $worker->redis === null) connectRedis($worker); }, [], false);
    };
    $connection->connect();
    $worker->redis = $connection;
}

function publishRedis(object $worker, array $message, string $source): void
{
    (new app\Service\RealtimePublisher())->publish($message);
}

function redisCommand(array $parts): string
{
    $request = '*' . count($parts) . "\r\n";
    foreach ($parts as $part) { $part = (string) $part; $request .= '$' . strlen($part) . "\r\n" . $part . "\r\n"; }
    return $request;
}

function redisFrame(string &$buffer): ?array
{
    $offset = 0; [$complete, $value] = redisParseAt($buffer, $offset);
    if (!$complete) return null;
    $buffer = substr($buffer, $offset);
    return is_array($value) ? $value : [$value];
}

function redisParseAt(string $buffer, int &$offset): array
{
    if (!isset($buffer[$offset])) return [false, null];
    $type = $buffer[$offset++]; $lineEnd = strpos($buffer, "\r\n", $offset);
    if ($lineEnd === false) return [false, null];
    $line = substr($buffer, $offset, $lineEnd - $offset); $offset = $lineEnd + 2;
    if ($type === '-') throw new RuntimeException('Redis command rejected.');
    if ($type === '$') {
        $length = (int) $line; if ($length < 0) return [true, null];
        if (strlen($buffer) - $offset < $length + 2) return [false, null];
        $value = substr($buffer, $offset, $length); $offset += $length + 2; return [true, $value];
    }
    if ($type === '*') {
        $items = []; for ($i = 0, $count = (int) $line; $i < $count; $i++) { [$complete, $item] = redisParseAt($buffer, $offset); if (!$complete) return [false, null]; $items[] = $item; }
        return [true, $items];
    }
    return [true, $line];
}

function db(object $worker): PDO
{
    if ($worker->pdo instanceof PDO) return $worker->pdo;
    $env = parse_ini_file(dirname(__DIR__) . '/.env', false, INI_SCANNER_RAW) ?: [];
    $host = $env['DB_HOST'] ?? '127.0.0.1';
    $port = $env['DB_PORT'] ?? '3306';
    $name = $env['DB_NAME'] ?? 'pulse_im';
    $user = $env['DB_USER'] ?? 'root';
    $password = $env['DB_PASSWORD'] ?? '';
    $options = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC];
    if (in_array(strtolower(trim((string) ($env['DB_COMPRESS'] ?? ''))), ['1', 'true', 'yes', 'on'], true)) $options[PDO::MYSQL_ATTR_COMPRESS] = true;
    $worker->pdo = new PDO("mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4", $user, $password, $options);
    return $worker->pdo;
}

function userByToken(object $worker, string $token): array
{
    if ($token === '') throw new RuntimeException('Authentication required.');
    $query = db($worker)->prepare('SELECT u.id, u.status FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.expires_at > NOW() LIMIT 1');
    $query->execute([hash('sha256', $token)]);
    $user = $query->fetch();
    if (!$user || $user['status'] !== 'active') throw new RuntimeException('Authentication token expired.');
    return $user;
}

function touchPresence(object $worker, int $userId): void
{
    if ($userId <= 0) return;
    $pdo = db($worker); $pdo->beginTransaction();
    try {
        $active = $pdo->prepare("SELECT id FROM users WHERE id = ? AND status = 'active' FOR UPDATE");
        $active->execute([$userId]);
        if (!$active->fetchColumn()) throw new RuntimeException('用户账号不可用。');
        if (!empty($worker->asyncMetadata)) {
            // Retain the same current account lock through authentication. This
            // transaction has no database writes and requires no durable fsync.
            enqueueWorkerMetadata($worker, ['type'=>'presence','seen'=>[['id'=>$userId,'at'=>time()]]]);
            $pdo->commit(); return;
        }
        $query = $pdo->prepare('INSERT INTO user_presence (user_id, last_seen_at) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)');
        $query->execute([$userId]); $pdo->commit();
    } catch (Throwable $error) { try { if ($pdo->inTransaction()) $pdo->rollBack(); } catch (Throwable) {} throw $error; }
}

/** Pings keep their authenticated receipt time; one account occupies one slot. */
function queuePresence(object $worker, int $userId): void
{
    if ($userId > 0) $worker->presenceQueue[$userId] = time();
}

/** Bound each database transaction, retaining pending values after any failure. */
function flushPresence(object $worker): void
{
    $pending = array_slice($worker->presenceQueue ?? [], 0, 200, true);
    if ($pending === []) return;
    if (!empty($worker->asyncMetadata)) {
        $seen=[];foreach($pending as $id=>$at)$seen[]=['id'=>(int)$id,'at'=>$at];
        enqueueWorkerMetadata($worker,['type'=>'presence','seen'=>$seen]);
        foreach(array_keys($pending)as $id)unset($worker->presenceQueue[$id]);
        return;
    }
    $ids = array_keys($pending); sort($ids, SORT_NUMERIC);
    $pdo = db($worker); $pdo->beginTransaction();
    try {
        // A current locking read prevents queued pings from resurrecting a frozen
        // account. Consistent account order also matches direct-conversation locks.
        $query = $pdo->prepare("SELECT id FROM users WHERE id IN (" . implode(',', array_fill(0, count($ids), '?')) . ") AND status = 'active' ORDER BY id FOR UPDATE");
        $query->execute($ids);
        $active = $query->fetchAll(PDO::FETCH_COLUMN);
        if ($active !== []) {
            $values = [];
            foreach ($active as $id) { $values[] = (int) $id; $values[] = $pending[(int) $id]; }
            $write = $pdo->prepare('INSERT INTO user_presence (user_id,last_seen_at) VALUES ' . implode(',', array_fill(0, count($active), '(?,FROM_UNIXTIME(?))'))
                . ' ON DUPLICATE KEY UPDATE last_seen_at = GREATEST(last_seen_at, VALUES(last_seen_at))');
            $write->execute($values);
        }
        $pdo->commit();
        foreach ($ids as $id) unset($worker->presenceQueue[$id]);
    } catch (Throwable $error) { try { if ($pdo->inTransaction()) $pdo->rollBack(); } catch (Throwable) {} throw $error; }
}

function assertMember(object $worker, int $conversationId, int $userId): void
{
    $query = db($worker)->prepare("SELECT 1 FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? AND m.user_id = ? AND c.status = 'active' AND u.status = 'active' LIMIT 1");
    $query->execute([$conversationId, $userId]);
    if (!$query->fetchColumn()) throw new RuntimeException('You are not a member of this conversation.');
}

function saveMessage(object $worker, int $userId, array $data): array
{
    return (new app\Service\MessageService())->send(
        (int) ($data['conversation_id'] ?? 0), $userId,
        (string) ($data['message_type'] ?? ''),
        is_array($data['body'] ?? null) ? $data['body'] : [],
        (string) ($data['request_id'] ?? '')
    );
}

function latestEventId(object $worker): int
{
    return (int) db($worker)->query('SELECT last_id FROM realtime_sequence WHERE id = 1')->fetchColumn();
}

function heartbeatWorker(object $worker): void
{
    if (!empty($worker->asyncMetadata)) {
        enqueueWorkerMetadata($worker,['type'=>'health','node'=>$worker->nodeId,'pid'=>getmypid(),'cursor'=>$worker->eventCursor,'at'=>microtime(true),'started'=>$worker->metadataStartedAt,'build'=>\app\Service\RequestTrace::BUILD_ID]);
        return;
    }
    $query = db($worker)->prepare('INSERT INTO websocket_worker_health (node_id,process_id,event_cursor,heartbeat_at,started_at,build_id) VALUES (?,?,?,NOW(6),NOW(6),?) ON DUPLICATE KEY UPDATE event_cursor = VALUES(event_cursor), heartbeat_at = NOW(6),build_id=VALUES(build_id)');
    $query->execute([$worker->nodeId, getmypid(), $worker->eventCursor, \app\Service\RequestTrace::BUILD_ID]);
}

function metadataRedis(object $worker): object
{
    if (!isset($worker->metadataRedis)) $worker->metadataRedis = think\facade\Cache::store('redis')->handler();
    return $worker->metadataRedis;
}

function maintainCommittedEvents(object $worker): void
{
    $query=db($worker)->query("SELECT MIN(event_cursor) FROM websocket_worker_health WHERE heartbeat_at >= DATE_SUB(NOW(), INTERVAL 15 SECOND)");
    $cursor=(int)$query->fetchColumn();
    $prune=db($worker)->prepare('DELETE FROM realtime_events WHERE id < ? AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY) LIMIT 10000');$prune->execute([$cursor]);
    db($worker)->exec('DELETE FROM websocket_worker_health WHERE heartbeat_at < DATE_SUB(NOW(), INTERVAL 1 DAY)');
}

function resetMetadataRedis(object $worker): void
{
    $worker->metadataRedis = null;
    try { think\facade\Cache::forgetDriver('redis'); } catch (Throwable) {}
}

function metadataQueueKey(object $worker): string
{
    return $worker->metadataKey ?? (wsEnv('REALTIME_CHANNEL','pulse-im:messages').':metadata:'.substr(hash('sha256',gethostname().dirname(__DIR__)),0,24));
}

function enqueueWorkerMetadata(object $worker, array $item): void
{
    $redis=metadataRedis($worker);$key=metadataQueueKey($worker);
    if ($redis->lLen($key)>=4096) throw new RuntimeException('WebSocket metadata queue is full.');
    $payload=json_encode($item,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
    if (strlen($payload)>32768 || $redis->rPush($key,$payload)===false) throw new RuntimeException('WebSocket metadata queue unavailable.');
}

/** Commit before acknowledging; replays preserve receipt times and cursors. */
function flushWorkerMetadata(object $worker): void
{
    $redis=metadataRedis($worker);$key=metadataQueueKey($worker);$items=$redis->lRange($key,0,49);
    if ($items===false) throw new RuntimeException('WebSocket metadata queue unavailable.');
    if ($items===[]) return;
    $presence=[];$health=[];$stops=[];$consumed=0;$now=microtime(true);
    foreach($items as $raw) {
        $item=json_decode($raw,true);$kind=is_array($item)?($item['type']??''):'';
        if ($kind==='presence' && is_array($item['seen']??null) && count($item['seen'])<=200) {
            $candidate=$presence;
            foreach($item['seen']as $seen) if(is_array($seen)&&is_int($seen['id']??null)&&$seen['id']>0&&is_int($seen['at']??null)&&$seen['at']>0&&$seen['at']<=$now+5) $candidate[$seen['id']]=max($candidate[$seen['id']]??0,$seen['at']);
            if (count($candidate)>512 && $consumed>0) break;
            $presence=$candidate;
        } elseif(in_array($kind,['health','stop'],true)&&is_string($item['node']??null)&&preg_match('/^[a-f0-9]{24}-[1-9][0-9]*$/D',$item['node'])) {
            $node=$item['node'];
            if ($kind==='stop') { $stops[$node]=true;unset($health[$node]); }
            elseif(is_int($item['pid']??null)&&$item['pid']>0&&str_ends_with($node,'-'.$item['pid'])&&is_int($item['cursor']??null)&&$item['cursor']>=0&&is_numeric($item['at']??null)&&$item['at']>0&&$item['at']<=$now+5&&is_numeric($item['started']??null)&&$item['started']>0&&$item['started']<=$item['at']) {
                if(isset($health[$node])){$item['cursor']=max($item['cursor'],$health[$node]['cursor']);$item['at']=max($item['at'],$health[$node]['at']);}
                $health[$node]=$item;unset($stops[$node]);
            }
        }
        $consumed++;
    }
    if ($consumed===0) return;
    $pdo=db($worker);$pdo->beginTransaction();
    try {
        if ($presence!==[]) {
            $ids=array_keys($presence);sort($ids,SORT_NUMERIC);
            $q=$pdo->prepare("SELECT id FROM users WHERE id IN (".implode(',',array_fill(0,count($ids),'?')).") AND status='active' ORDER BY id FOR UPDATE");$q->execute($ids);$active=$q->fetchAll(PDO::FETCH_COLUMN);
            if($active!==[]){$values=[];foreach($active as $id){$values[]=(int)$id;$values[]=$presence[(int)$id];}$q=$pdo->prepare('INSERT INTO user_presence(user_id,last_seen_at) VALUES '.implode(',',array_fill(0,count($active),'(?,FROM_UNIXTIME(?))')).' ON DUPLICATE KEY UPDATE last_seen_at=GREATEST(last_seen_at,VALUES(last_seen_at))');$q->execute($values);}
        }
        if($health!==[]){ksort($health);$values=[];foreach($health as $node=>$r){$build=is_string($r['build']??null)&&preg_match('/^[a-z0-9-]{1,64}$/D',$r['build'])?$r['build']:'';array_push($values,$node,$r['pid'],$r['cursor'],$r['at'],$r['started'],$build);}$q=$pdo->prepare('INSERT INTO websocket_worker_health(node_id,process_id,event_cursor,heartbeat_at,started_at,build_id) VALUES '.implode(',',array_fill(0,count($health),'(?,?,?,FROM_UNIXTIME(?),FROM_UNIXTIME(?),?)')).' ON DUPLICATE KEY UPDATE event_cursor=GREATEST(event_cursor,VALUES(event_cursor)),heartbeat_at=GREATEST(heartbeat_at,VALUES(heartbeat_at)),build_id=VALUES(build_id)');$q->execute($values);}
        if($stops!==[]){$q=$pdo->prepare('DELETE FROM websocket_worker_health WHERE node_id IN ('.implode(',',array_fill(0,count($stops),'?')).')');$q->execute(array_keys($stops));}
        $pdo->commit();
        if($redis->lTrim($key,$consumed,-1)===false)throw new RuntimeException('WebSocket metadata acknowledgement deferred.');
    }catch(Throwable $error){if($pdo->inTransaction())$pdo->rollBack();throw $error;}
}

function validConnection(object $worker, object $connection): bool
{
    if ($connection->userId <= 0 || $connection->tokenHash === '') return false;
    $query = db($worker)->prepare("SELECT 1 FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.user_id = ? AND t.expires_at > NOW() AND u.status = 'active' LIMIT 1");
    $query->execute([$connection->tokenHash, $connection->userId]);
    return (bool) $query->fetchColumn();
}

function revokeConnection(object $connection): void
{
    $connection->userId = 0; $connection->tokenHash = ''; $connection->subscriptions = []; $connection->inboxCursor = null;
    $connection->close(json_encode(['type' => 'auth.revoked', 'message' => '登录状态已失效，请重新登录。'], JSON_UNESCAPED_UNICODE));
}

function versionAllowed(object $connection, ?array $config = null): bool
{
    if (!in_array($connection->clientPlatform, ['android', 'ios', 'pc'], true)) return true;
    if (!(new app\Service\ClientConfigService())->requiresUpgrade($connection->clientPlatform, $connection->clientVersion, $config)) return true;
    $connection->subscriptions = [];
    $connection->inboxCursor = null;
    $connection->close(json_encode(['type' => 'client.update_required', 'message' => '请更新客户端后继续使用。'], JSON_UNESCAPED_UNICODE));
    return false;
}

/** A fresh authorization snapshot for one broadcast/timer, never a cross-event cache. */
function authorizedConnections(object $worker, array $clients): array
{
    if ($clients === []) return [];
    $hashes = [];
    foreach ($clients as $client) {
        if ($client->userId > 0 && $client->tokenHash !== '') $hashes[$client->tokenHash] = true;
    }
    $rows = [];
    // Bound SQL size even when a worker holds many thousands of connections.
    foreach (array_chunk(array_keys($hashes), 512) as $batch) {
        // Transfer all 256 hash bits as 32 bytes instead of 64 hex characters.
        // The lookup and account/expiry checks stay fresh for every event.
        $query = db($worker)->prepare("SELECT UNHEX(t.token_hash) AS token_hash_bytes,t.user_id FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash IN (" . implode(',', array_fill(0, count($batch), '?')) . ") AND t.expires_at > NOW() AND u.status='active'");
        $query->execute($batch);
        array_push($rows, ...$query->fetchAll());
    }
    return selectAuthorizedConnections($clients,$rows);
}

/** The caller supplies a fresh SQL result for this operation, never a cache. */
function selectAuthorizedConnections(array $clients,array $rows,?array $config=null): array
{
    $sessions=[];
    foreach($rows as $row){$bytes=$row['token_hash_bytes'];if(is_string($bytes)&&strlen($bytes)===32)$sessions[(int)$row['user_id'].':'.bin2hex($bytes)]=true;}
    $allowed = [];
    foreach ($clients as $client) {
        // Bind each hash to its authenticated account, including multiple devices.
        if (!isset($sessions[$client->userId . ':' . $client->tokenHash])) { revokeConnection($client); continue; }
        if ($config === null && in_array($client->clientPlatform, ['android', 'ios', 'pc'], true)) $config = (new app\Service\ClientConfigService())->upgradePolicy();
        if (versionAllowed($client, $config)) $allowed[] = $client;
    }
    return $allowed;
}

function revalidateConnections(object $worker): void
{
    try {
    $clients = [];
    foreach ($worker->connections as $client) {
        if (($client->userId <= 0 && time() - $client->connectedAt > 15) || time() - $client->receivedAt > 120) { revokeConnection($client); continue; }
        if ($client->userId > 0) $clients[] = $client;
    }
    authorizedConnections($worker, $clients);
    } catch (Throwable $error) { if (wsDatabaseFailure($error)) resetDatabaseConnections($worker); throw $error; }
}

/** Keep only bounded durable hints; message bodies and authority stay fresh. */
function refillEventQueue(object $worker): void
{
    if (!empty($worker->pendingEvents)) return;
    $query = db($worker)->prepare("SELECT id,event_type,CASE WHEN event_type IN ('message.new','message.updated','message.recalled') THEN JSON_OBJECT('id',COALESCE(message_id,CAST(JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.id')) AS UNSIGNED))) ELSE payload_json END AS payload_json FROM realtime_events WHERE id > ? ORDER BY id ASC LIMIT 100");
    $query->execute([$worker->eventCursor]);
    $worker->pendingEvents = $query->fetchAll();
    // A full page is not an empty queue. Continue across page boundaries after
    // yielding to socket I/O instead of adding another fallback-poll delay.
    $worker->eventQueueMayHaveMore = count($worker->pendingEvents) === 100;
    $query->closeCursor();
}

/** Yield to socket I/O, then continue the existing queue without a 100ms idle. */
function scheduleEventDrain(object $worker,bool $successful): void
{
    if(!$successful||(empty($worker->pendingEvents)&&empty($worker->eventQueueMayHaveMore))){
        if(!empty($worker->eventDrainTimer)){\Workerman\Lib\Timer::del($worker->eventDrainTimer);$worker->eventDrainTimer=null;}
        return;
    }
    if(!empty($worker->eventDrainTimer))return;
    $worker->eventDrainTimer=\Workerman\Lib\Timer::add(.001,static function()use($worker):void{
        $worker->eventDrainTimer=null;if(empty($worker->pendingEvents)&&empty($worker->eventQueueMayHaveMore))return;
        try{pumpEvents($worker);}catch(Throwable $error){if(wsDatabaseFailure($error))resetDatabaseConnections($worker);error_log('WebSocket queued event delivery deferred.');}
    },[],false);
}

function pumpEvents(object $worker): void
{
    if ($worker->pumping) return;
    $worker->pumping = true;
    $successful=false;
    try {
        $sliceStarted = hrtime(true);
        refillEventQueue($worker);
        // This snapshot belongs only to this pump invocation. Discard unused
        // rows when yielding, and re-read current authority on the next batch.
        $snapshots = readMessageBatchSnapshots($worker, $worker->pendingEvents);
        if ($snapshots !== null) $sliceStarted = hrtime(true);
        while (!empty($worker->pendingEvents)) {
            $event = $worker->pendingEvents[0];
            $message = json_decode($event['payload_json'], true, 512, JSON_THROW_ON_ERROR);
            broadcastMessage($worker, $message, $event['event_type'], (int) $event['id'], $snapshots[(int) ($message['id'] ?? 0)] ?? null);
            // Advance only after successful delivery. Redis never modifies this cursor.
            $worker->eventCursor = (int) $event['id'];
            array_shift($worker->pendingEvents);
            // A backlog must not monopolize this synchronous worker and starve
            // socket reads/pongs. The next tick resumes at the committed cursor.
            if (hrtime(true) - $sliceStarted >= 80000000) break;
        }
        $worker->lastPumpAt = time();
        $successful=true;
    } catch (Throwable $error) { if (wsDatabaseFailure($error)) resetDatabaseConnections($worker); throw $error; }
    finally { $worker->pumping = false;scheduleEventDrain($worker,$successful); }
}

function messageBroadcastSelect(): string
{
    return 'SELECT m.conversation_id,m.sender_id,m.type,m.body_json,m.created_at,m.edited_at,m.recalled_at,u.nickname AS author_name,u.avatar_url AS author_avatar_url FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.id = ? LIMIT 1';
}

/** Fresh token binding and version policy for this one incoming operation. */
function readConnectionState(object $worker,object $connection): ?array
{
    if(empty($worker->bundledReads)||$connection->userId<=0||$connection->tokenHash==='')return null;
    $pdo=db($worker);if($pdo->getAttribute(PDO::ATTR_DRIVER_NAME)!=='mysql'||!$pdo->getAttribute(PDO::ATTR_EMULATE_PREPARES))return null;
    $query=$pdo->prepare("SELECT 1 AS permitted FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.user_id=? AND t.expires_at>NOW() AND u.status='active' LIMIT 1;SELECT force_update,latest_version,platform_updates_json FROM client_app_config WHERE id=1");
    try{
        $query->execute([$connection->tokenHash,(int)$connection->userId]);$valid=(bool)$query->fetchColumn();
        if(!$query->nextRowset())throw new RuntimeException('Incomplete operation state.');$row=$query->fetch();
        if($query->nextRowset())throw new RuntimeException('Unexpected operation state result.');
    }finally{$query->closeCursor();}
    return ['valid'=>$valid,'policy'=>$row?\app\Service\ClientConfigService::policyFromRow($row):null];
}

/** Request-local ordinal projection; SQL still checks the full hash and account. */
function sessionProjection(array $clients): ?array
{
    $pairs=[];$seen=[];$parts=[];$parameters=[];
    foreach($clients as $client){
        if($client->userId<=0||!preg_match('/^[a-f0-9]{64}$/D',$client->tokenHash))continue;
        $key=$client->userId.':'.$client->tokenHash;if(isset($seen[$key]))continue;
        $index=count($pairs);if($index>=512)return null;
        $seen[$key]=true;$pairs[]=['user_id'=>(int)$client->userId,'token_hash_bytes'=>hex2bin($client->tokenHash)];
        $parts[]='SELECT '.$index.' AS session_no,CAST(? AS UNSIGNED) AS user_id,HEX(_binary ?) AS token_hash';
        $parameters[]=(int)$client->userId;$parameters[]=hex2bin($client->tokenHash);
    }
    $sql=$parts===[]?'SELECT 0 AS session_no FROM DUAL WHERE 1=0':
        'SELECT request.session_no FROM ('.implode(' UNION ALL ',$parts).") request STRAIGHT_JOIN auth_tokens t ON t.token_hash=request.token_hash AND t.user_id=request.user_id STRAIGHT_JOIN users u ON u.id=t.user_id WHERE t.expires_at>NOW() AND u.status='active'";
    return ['sql'=>$sql,'parameters'=>$parameters,'pairs'=>$pairs];
}

/** An ordinal only denotes the matching input of this exact completed query. */
function projectedSessions(array $rows,array $pairs): array
{
    $sessions=[];$seen=[];
    foreach($rows as $row){
        $index=filter_var($row['session_no']??null,FILTER_VALIDATE_INT);
        if($index===false||!isset($pairs[$index])||isset($seen[$index]))throw new RuntimeException('Invalid session projection.');
        $seen[$index]=true;$sessions[]=$pairs[$index];
    }
    return $sessions;
}

/** Keep the authoritative row, then batch its four fresh bound reads. */
function readMessageSnapshot(object $worker,int $messageId): ?array
{
    if(empty($worker->bundledReads))return null;
    $ids=[];$hashes=[];
    foreach($worker->connections as $client)if($client->userId>0&&$client->tokenHash!==''){$ids[(int)$client->userId]=true;$hashes[$client->tokenHash]=true;}
    if($ids===[]||count($ids)>512||count($hashes)>512)return null;
    $pdo=db($worker);
    if($pdo->getAttribute(PDO::ATTR_DRIVER_NAME)!=='mysql'||!$pdo->getAttribute(PDO::ATTR_EMULATE_PREPARES))return null;
    $ids=array_keys($ids);$hashes=array_keys($hashes);
    $projection=!empty($worker->compactAuth)?sessionProjection($worker->connections):null;
    if(!empty($worker->compactAuth)&&$projection===null)return null;
    $currentQuery=$pdo->prepare(messageBroadcastSelect());$currentQuery->execute([$messageId]);$current=$currentQuery->fetch();$currentQuery->closeCursor();
    if(!$current)return ['current'=>false,'members'=>[],'deletions'=>[],'sessions'=>[],'policy'=>null];
    $body=json_decode((string)$current['body_json'],true);$replyId=is_array($body)?(int)($body['reply_to_id']??0):0;
    $sql="SELECT m.user_id,m.role,m.cleared_before_message_id FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? AND m.user_id IN (".implode(',',array_fill(0,count($ids),'?')).") AND c.status='active' AND u.status='active';".
        'SELECT user_id,message_id FROM message_deletions WHERE message_id IN (?,?);'.
        ($projection!==null?$projection['sql']:"SELECT UNHEX(t.token_hash) AS token_hash_bytes,t.user_id FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash IN (".implode(',',array_fill(0,count($hashes),'?')).") AND t.expires_at>NOW() AND u.status='active'").';'.
        'SELECT force_update,latest_version,platform_updates_json FROM client_app_config WHERE id=1';
    $query=$pdo->prepare($sql);$sets=[];
    try{
        $query->execute([(int)$current['conversation_id'],...$ids,$messageId,$replyId,...($projection!==null?$projection['parameters']:$hashes)]);
        for($i=0;$i<4;$i++){if($i>0&&!$query->nextRowset())throw new RuntimeException('Incomplete message snapshot.');$sets[]=$query->fetchAll(PDO::FETCH_ASSOC);}
        if($query->nextRowset())throw new RuntimeException('Unexpected message snapshot result.');
    }finally{$query->closeCursor();}
    $row=$sets[3][0]??null;
    $policy=$row?\app\Service\ClientConfigService::policyFromRow($row):null;
    return ['current'=>$current,'members'=>$sets[0],'deletions'=>$sets[1],'sessions'=>$projection!==null?projectedSessions($sets[2],$projection['pairs']):$sets[2],'policy'=>$policy];
}

/** One bounded packet for a delivery batch; no authority survives the pump. */
function readMessageBatchSnapshots(object $worker,array $events): ?array
{
    if(empty($worker->batchEvents)||empty($worker->bundledReads)||count($events)>100)return null;
    $messages=[];
    foreach($events as$event){
        if(!in_array($event['event_type'],['message.new','message.updated','message.recalled'],true))continue;
        $hint=json_decode($event['payload_json'],true,512,JSON_THROW_ON_ERROR);$id=(int)($hint['id']??0);if($id>0)$messages[$id]=true;
    }
    if($messages===[])return [];
    $ids=[];$hashes=[];
    foreach($worker->connections as$client)if($client->userId>0&&$client->tokenHash!==''){$ids[(int)$client->userId]=true;$hashes[$client->tokenHash]=true;}
    if(count($ids)>512||count($hashes)>512)return null;
    $snapshots=[];
    foreach(array_keys($messages)as$id)$snapshots[$id]=['current'=>false,'members'=>[],'deletions'=>[],'sessions'=>[],'policy'=>null];
    if($ids===[])return $snapshots;
    $pdo=db($worker);
    if($pdo->getAttribute(PDO::ATTR_DRIVER_NAME)!=='mysql'||!$pdo->getAttribute(PDO::ATTR_EMULATE_PREPARES))return null;
    $projection=!empty($worker->compactAuth)?sessionProjection($worker->connections):null;
    if(!empty($worker->compactAuth)&&$projection===null)return null;
    $messages=array_keys($messages);$ids=array_keys($ids);$hashes=array_keys($hashes);
    $marks=implode(',',array_fill(0,count($messages),'?'));$users=implode(',',array_fill(0,count($ids),'?'));
    $sql='SELECT m.id AS __message_id,m.conversation_id,m.sender_id,m.type,m.body_json,m.created_at,m.edited_at,m.recalled_at,u.nickname AS author_name,u.avatar_url AS author_avatar_url FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.id IN ('.$marks.');'.
        'SELECT m.conversation_id,m.user_id,m.role,m.cleared_before_message_id FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id JOIN users u ON u.id=m.user_id WHERE m.conversation_id IN (SELECT conversation_id FROM messages WHERE id IN ('.$marks.')) AND m.user_id IN ('.$users.") AND c.status='active' AND u.status='active';".
        "SELECT m.id AS __message_id,d.user_id,d.message_id FROM messages m JOIN message_deletions d ON (d.message_id=m.id OR d.message_id=CAST(JSON_UNQUOTE(JSON_EXTRACT(m.body_json,'$.reply_to_id')) AS UNSIGNED)) WHERE m.id IN (".$marks.') AND d.user_id IN ('.$users.');'.
        ($projection!==null?$projection['sql']:"SELECT UNHEX(t.token_hash) AS token_hash_bytes,t.user_id FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash IN (".implode(',',array_fill(0,count($hashes),'?')).") AND t.expires_at>NOW() AND u.status='active'").';'.
        'SELECT force_update,latest_version,platform_updates_json FROM client_app_config WHERE id=1';
    $query=$pdo->prepare($sql);$sets=[];
    try{
        $query->execute([...$messages,...$messages,...$ids,...$messages,...$ids,...($projection!==null?$projection['parameters']:$hashes)]);
        for($i=0;$i<5;$i++){if($i>0&&!$query->nextRowset())throw new RuntimeException('Incomplete event batch snapshot.');$sets[]=$query->fetchAll(PDO::FETCH_ASSOC);}
        if($query->nextRowset())throw new RuntimeException('Unexpected event batch snapshot result.');
    }finally{$query->closeCursor();}
    $members=[];
    foreach($sets[1]as$row){$cid=(int)$row['conversation_id'];unset($row['conversation_id']);$members[$cid][]=$row;}
    $sessions=$projection!==null?projectedSessions($sets[3],$projection['pairs']):$sets[3];
    $row=$sets[4][0]??null;$policy=$row?\app\Service\ClientConfigService::policyFromRow($row):null;
    foreach($sets[0]as$row){$id=(int)$row['__message_id'];unset($row['__message_id']);$snapshots[$id]=['current'=>$row,'members'=>$members[(int)$row['conversation_id']]??[],'deletions'=>[],'sessions'=>$sessions,'policy'=>$policy];}
    foreach($sets[2]as$row){$id=(int)$row['__message_id'];unset($row['__message_id']);if(isset($snapshots[$id]))$snapshots[$id]['deletions'][]=$row;}
    // Rule lookup is shared by this bounded pump, like a history-page format.
    // It is discarded before yielding; membership/token checks remain fresh.
    $bodies=[];
    foreach($snapshots as$id=>$snapshot){
        $current=$snapshot['current'];
        if(!$current||$snapshot['members']===[]||$current['type']==='red_packet')continue;
        $body=json_decode((string)$current['body_json'],true,512,JSON_THROW_ON_ERROR);
        $bodies[$id]=!empty($current['recalled_at'])?[]:(new app\Service\MessagePrivacyService())->sanitize((string)$current['type'],is_array($body)?$body:[]);
    }
    if($bodies!==[]){
        $bodies=(new app\Service\SensitiveWordService())->filterBody($bodies);
        foreach($bodies as$id=>$body)$snapshots[$id]['filtered_body']=$body;
    }
    return $snapshots;
}

function broadcastUserNotification(object $worker, int $userId, int $eventId): void
{
    if ($userId <= 0) return;
    foreach ($worker->connections as $client) {
        if ($client->userId !== $userId || ($eventId > 0 && $eventId <= (int) ($client->notificationCursor ?? 0))) continue;
        if (!validConnection($worker, $client)) { revokeConnection($client); continue; }
        if (!versionAllowed($client)) continue;
        $client->send(json_encode(['type' => 'notification.updated', 'event_id' => $eventId], JSON_UNESCAPED_UNICODE));
        $client->notificationCursor = $eventId;
    }
}

/** Fresh membership for this worker's recipients, rather than every group member. */
function currentMessageMembers(object $worker, int $conversationId, array $userIds): array
{
    $ids = array_values(array_unique(array_filter(array_map('intval', $userIds), static fn (int $id): bool => $id > 0)));
    $members = [];
    foreach (array_chunk($ids, 512) as $batch) {
        $query = db($worker)->prepare("SELECT m.user_id,m.role,m.cleared_before_message_id FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? AND m.user_id IN (" . implode(',', array_fill(0, count($batch), '?')) . ") AND c.status='active' AND u.status='active'");
        $query->execute([$conversationId, ...$batch]);
        foreach ($query->fetchAll() as $member) $members[] = $member;
    }
    return $members;
}

function broadcastMessage(object $worker, array $message, string $eventType = 'message.new', int $eventId = 0, ?array $snapshot = null): void
{
    if ($eventType === 'notification.updated') { broadcastUserNotification($worker, (int) ($message['user_id'] ?? 0), $eventId); return; }
    if ($eventType === 'message.deleted') { broadcastPersonalDeletion($worker, $message, $eventId); return; }
    if ($eventType === 'conversation.pins') { broadcastPins($worker, (int) ($message['conversation_id'] ?? 0), $eventId); return; }
    if (($message['type'] ?? '') === 'red_packet') return;
    // The event log is durable transport, not an independent copy of readable
    // history. Never replay deleted, recalled or superseded message contents.
    $snapshot??=readMessageSnapshot($worker,(int)$message['id']);
    if($snapshot!==null)$current=$snapshot['current'];
    else{$currentQuery=db($worker)->prepare(messageBroadcastSelect());$currentQuery->execute([(int)$message['id']]);$current=$currentQuery->fetch();}
    if (!$current || $current['type'] === 'red_packet') return;
    if ($eventType !== 'message.recalled' && !empty($current['recalled_at'])) return;
    if ($eventType === 'message.recalled' && empty($current['recalled_at'])) return;
    $message['conversation_id'] = (int) $current['conversation_id'];
    $message['sender_id'] = (int) $current['sender_id'];
    $message['sender_name'] = app\Service\MessageSenderService::name($current['author_name'] ?? null);
    $message['sender_avatar_url'] = app\Service\MessageSenderService::avatar($current['author_avatar_url'] ?? null);
    $message['type'] = $current['type'];
    $message['created_at'] = $current['created_at'];
    $message['body'] = json_decode((string) $current['body_json'], true, 512, JSON_THROW_ON_ERROR) ?: [];
    $message['edited_at'] = $current['edited_at'];
    $message['recalled_at'] = $current['recalled_at'];
    $message['status'] = $eventType === 'message.recalled' ? 'recalled' : (!empty($current['edited_at']) ? 'edited' : 'sent');
    $localIds = [];
    foreach ($worker->connections as $client) {
        if ($client->userId > 0 && (array_key_exists($message['conversation_id'], $client->subscriptions) || isset($client->inboxCursor))) $localIds[$client->userId] = true;
    }
    if ($localIds === []) return;
    $members = []; $memberRoles = [];
    foreach ($snapshot!==null?$snapshot['members']:currentMessageMembers($worker, (int) $message['conversation_id'], array_keys($localIds)) as $member) {
        $members[(int) $member['user_id']] = (int) $member['cleared_before_message_id'];
        $memberRoles[(int) $member['user_id']] = $member['role'];
    }
    if($members===[]){
        foreach($worker->connections as$client)if($client->userId>0)unset($client->subscriptions[$message['conversation_id']]);
        return;
    }
    if($snapshot!==null)$deletions=$snapshot['deletions'];
    else{$deletedQuery=db($worker)->prepare('SELECT user_id,message_id FROM message_deletions WHERE message_id IN (?,?)');$deletedQuery->execute([(int)$message['id'],(int)($message['body']['reply_to_id']??0)]);$deletions=$deletedQuery->fetchAll();}
    $deletedFor = []; $hiddenReplies = [];
    foreach ($deletions as $deletion) {
        if ((int) $deletion['message_id'] === (int) $message['id']) $deletedFor[(int) $deletion['user_id']] = true;
        else $hiddenReplies[(int) $deletion['user_id']] = true;
    }
    $message['body'] = $eventType === 'message.recalled' ? [] : (new app\Service\MessagePrivacyService())->sanitize((string) $message['type'], is_array($message['body'] ?? null) ? $message['body'] : []);
    $message['body'] = array_key_exists('filtered_body',$snapshot??[]) ? $snapshot['filtered_body'] : (new app\Service\SensitiveWordService())->filterBody($message['body']);
    unset($message['body']['reply_to']);
    $replyTarget = null;
    $replyId = $message['body']['reply_to_id'] ?? null;
    if (is_int($replyId) && $replyId > 0) {
        $replyQuery = db($worker)->prepare('SELECT m.id,m.conversation_id,m.sender_id,m.type,m.body_json,m.recalled_at,u.nickname AS reply_sender_name FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.id=? LIMIT 1');
        $replyQuery->execute([$replyId]); $replyTarget = $replyQuery->fetch() ?: null;
    }
    $recipients = [];
    foreach ($worker->connections as $client) {
        if ($client->userId <= 0 || (!array_key_exists($message['conversation_id'], $client->subscriptions) && !isset($client->inboxCursor))) continue;
        if (!array_key_exists($client->userId, $members)) { unset($client->subscriptions[$message['conversation_id']]); continue; }
        $recipients[] = $client;
    }
    $eligible=$snapshot!==null?selectAuthorizedConnections($recipients,$snapshot['sessions'],$snapshot['policy']):authorizedConnections($worker,$recipients);
    foreach ($eligible as $client) {
        $subscribed = array_key_exists($message['conversation_id'], $client->subscriptions);
        if ($client->userId > 0 && ($subscribed || isset($client->inboxCursor))) {
            // Most connected users are not members of this conversation. Avoid
            // per-token database queries for every unrelated inbox connection.
            if (!array_key_exists($client->userId, $members)) { unset($client->subscriptions[$message['conversation_id']]); continue; }
            // Check the current database row and current role even when replaying
            // an older durable event; ordinary members receive no inbox hint either.
            if (!app\Service\GroupInviteNoticeService::allowsRole($current, $memberRoles[$client->userId])) continue;
            if (isset($deletedFor[$client->userId])) continue;
            $cursor = $subscribed ? $client->subscriptions[$message['conversation_id']] : $client->inboxCursor;
            if ($eventId > 0 && $eventId <= (int) $cursor) continue;
            if ((int) $message['id'] > $members[$client->userId]) {
                if ($subscribed) {
                    $readableReply = $replyTarget && app\Service\GroupInviteNoticeService::allowsRole($replyTarget, $memberRoles[$client->userId]) && !isset($hiddenReplies[$client->userId]) ? $replyTarget : null;
                    $delivery = array_key_exists('reply_to_id', $message['body']) ? (new app\Service\MessageReplyService())->apply($message, $readableReply, $members[$client->userId]) : $message;
                    $data = (new app\Service\MediaAccessService())->transformPayload($delivery, $client->tokenHash);
                    if (($data['body'] ?? null) === []) $data['body'] = (object) [];
                    $frame = ['type' => $eventType, 'event_id' => $eventId, 'data' => $data];
                } else {
                    $frame = ['type' => 'conversation.updated', 'event_id' => $eventId, 'data' => [
                        'conversation_id' => (int) $message['conversation_id'], 'message_id' => (int) $message['id'], 'event_type' => $eventType,
                    ]];
                }
                $payload = json_encode($frame, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
                $sent = $client->send($payload);
                if ($sent === false) { $client->close(); continue; }
                // Per-subscription cursor prevents repeats if another subscriber
                // fails and the whole durable event is retried.
                if ($eventId > 0) {
                    if ($subscribed) $client->subscriptions[$message['conversation_id']] = $eventId;
                    else $client->inboxCursor = $eventId;
                }
            }
        }
    }
}

/** Only the deleting account receives this event, including its other devices. */
function broadcastPersonalDeletion(object $worker, array $data, int $eventId): void
{
    $conversationId = (int) ($data['conversation_id'] ?? 0); $userId = (int) ($data['user_id'] ?? 0);
    $ids = $data['message_ids'] ?? [];
    if ($conversationId <= 0 || $userId <= 0 || !is_array($ids) || count($ids) < 1 || count($ids) > 100) return;
    foreach ($ids as $id) if (!is_int($id) || $id <= 0) return;
    $query = db($worker)->prepare("SELECT m.user_id FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? AND m.user_id=? AND c.status='active' AND u.status='active'");
    $query->execute([$conversationId, $userId]); if (!$query->fetch()) return;
    foreach ($worker->connections as $client) {
        if ($client->userId !== $userId) continue;
        $subscribed = array_key_exists($conversationId, $client->subscriptions);
        if (!$subscribed && !isset($client->inboxCursor)) continue;
        if (!validConnection($worker, $client)) { revokeConnection($client); continue; }
        if (!versionAllowed($client)) continue;
        $cursor = $subscribed ? $client->subscriptions[$conversationId] : $client->inboxCursor;
        if ($eventId > 0 && $eventId <= (int) $cursor) continue;
        $sent = $client->send(json_encode(['type' => 'message.deleted', 'event_id' => $eventId, 'data' => $data], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
        if ($sent === false) { $client->close(); continue; }
        if ($eventId > 0) {
            if ($subscribed) $client->subscriptions[$conversationId] = $eventId;
            else $client->inboxCursor = $eventId;
        }
    }
}

function broadcastPins(object $worker, int $conversationId, int $eventId): void
{
    if ($conversationId <= 0) return;
    $query = db($worker)->prepare("SELECT m.user_id,m.cleared_before_message_id FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? AND c.status='active' AND u.status='active'");
    $query->execute([$conversationId]); $members = []; $snapshots = [];
    foreach ($query->fetchAll() as $member) $members[(int) $member['user_id']] = (int) $member['cleared_before_message_id'];
    foreach ($worker->connections as $client) {
        if ($client->userId <= 0 || !array_key_exists($conversationId, $client->subscriptions)) continue;
        if (!array_key_exists($client->userId, $members)) { unset($client->subscriptions[$conversationId]); continue; }
        if (!validConnection($worker, $client)) { revokeConnection($client); continue; }
        if (!versionAllowed($client) || ($eventId > 0 && $eventId <= (int) $client->subscriptions[$conversationId])) continue;
        // Personal deletion makes visibility different even at equal cutoffs.
        $snapshot = $snapshots[$client->userId] ??= (new app\Service\MessagePinService())->snapshot($conversationId, $client->userId);
        $data = (new app\Service\MediaAccessService())->transformPayload($snapshot, $client->tokenHash);
        $sent = $client->send(json_encode(['type' => 'conversation.pins', 'event_id' => $eventId, 'data' => $data], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
        if ($sent === false) { $client->close(); continue; }
        if ($eventId > 0) $client->subscriptions[$conversationId] = $eventId;
    }
}

function wsDatabaseFailure(Throwable $error): bool
{
    // ORM failures can be surfaced as a TypeError after a stale PDO statement.
    return $error instanceof PDOException || $error instanceof think\db\exception\DbException
        || $error instanceof Error || app\Service\DispatchDatabaseFailure::connectionLost($error);
}

function resetDatabaseConnections(object $worker): void
{
    if ($worker->pdo instanceof PDO) { try { if ($worker->pdo->inTransaction()) $worker->pdo->rollBack(); } catch (Throwable) {} }
    $worker->pdo = null;
    // Close cached ORM PDO/statement and reset transaction depth as well. Never
    // retry the current callback: a write might already have committed.
    try { app\Service\DispatchDatabaseFailure::invalidateConnection(); } catch (Throwable) {}
}
