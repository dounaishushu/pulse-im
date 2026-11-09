<?php

namespace app\Service;

use RuntimeException;
use think\facade\Db;

require_once __DIR__ . '/ContactNameService.php';

final class ContactService
{
    private static array $ipLocations = [];

    public function search(string $keyword, int $page = 1, int $size = 20, int $viewerId = 0): array
    {
        $keyword = trim($keyword);
        if ($keyword === '') {
            throw new RuntimeException('Search keyword cannot be empty.');
        }
        $size = min(50, max(1, $size));
        // Friend discovery accepts a complete account name only. In particular,
        // nicknames, phone numbers and internal IDs must not enumerate accounts.
        $query = Db::name('users')->alias('u')->where('u.status', 'active')
            ->where('u.username', $keyword);
        $rows = $query->field('u.id,u.public_id,u.nickname,u.username,u.phone,u.avatar_url,u.status,u.created_at')
            ->paginate(['list_rows' => $size, 'page' => max(1, $page)]);

        $settingsService = new UserSettingsService();
        $items = array_map(function (array $row) use ($settingsService, $viewerId): array {
            $isContact = $viewerId > 0 && (bool) Db::name('contacts')->where('user_id', (int) $row['id'])->where('contact_user_id', $viewerId)->find();
            $privacy = $settingsService->get((int) $row['id']);
            $phoneVisible = (int) $row['id'] === $viewerId || $settingsService->canView($privacy, 'phone_visibility', $viewerId, $isContact);
            return $this->publicUser($row, $phoneVisible ? $row['phone'] : null) + [
                'is_contact' => $viewerId > 0 && (bool) Db::name('contacts')->where('user_id', $viewerId)->where('contact_user_id', (int) $row['id'])->find(),
            ];
        }, $rows->items());
        return [
            'items' => $items,
            'total' => $rows->total(),
            'page' => $rows->currentPage(),
            'size' => $size,
        ];
    }

    /** QR resolution is exclusive and case-sensitive; it never falls back to q. */
    public function searchPublicId(mixed $publicId, int $viewerId): array
    {
        if (!PublicUserIdService::valid($publicId)) throw new RuntimeException('公开用户ID格式不正确。');
        $row = Db::name('users')->where('status', 'active')->where('public_id', $publicId)
            ->field('id,public_id,nickname,username,phone,avatar_url')->find();
        $items = [];
        if ($row) {
            $isContact = $viewerId > 0 && (bool) Db::name('contacts')->where('user_id', (int) $row['id'])->where('contact_user_id', $viewerId)->find();
            $privacy = (new UserSettingsService())->get((int) $row['id']);
            $visible = (int) $row['id'] === $viewerId || (new UserSettingsService())->canView($privacy, 'phone_visibility', $viewerId, $isContact);
            $items[] = $this->publicUser($row, $visible ? $row['phone'] : null);
        }
        return ['items' => $items, 'total' => count($items), 'page' => 1, 'size' => 1];
    }

    public function sendRequest(int $fromUserId, int $toUserId, string $message = '', ?int $contextConversationId = null): array
    {
        $this->assertDifferentUsers($fromUserId, $toUserId);
        $this->assertActiveUser($toUserId);
        // Group policy belongs to the entry used for this request. Sharing an
        // unrelated restricted group must not block account/QR discovery.
        if ($contextConversationId !== null) {
            if ($contextConversationId <= 0) throw new RuntimeException('来源群参数无效。');
            $sourceGroup = Db::name('conversations')->alias('c')
                ->join('conversation_members m1', 'm1.conversation_id = c.id')
                ->join('conversation_members m2', 'm2.conversation_id = c.id')
                ->where('c.id', $contextConversationId)->where('c.type', 'group')->where('c.status', 'active')
                ->where('m1.user_id', $fromUserId)->where('m2.user_id', $toUserId)
                ->field('c.allow_member_add_friend')->find();
            if (!$sourceGroup) throw new RuntimeException('来源群不存在或群成员关系已失效。');
            if (!(int) $sourceGroup['allow_member_add_friend']) throw new RuntimeException('该群已禁止群成员互相添加好友。');
        }
        $permission = Db::name('user_permissions')->where('user_id', $toUserId)->find();
        if ($permission && !(int) $permission['allow_add_friend']) throw new RuntimeException('This user does not accept friend requests.');
        if (Db::name('user_blocks')->where(function ($q) use ($fromUserId, $toUserId): void { $q->where('blocker_id', $fromUserId)->where('blocked_id', $toUserId)->whereOr(function ($nested) use ($fromUserId, $toUserId): void { $nested->where('blocker_id', $toUserId)->where('blocked_id', $fromUserId); }); })->find()) {
            throw new RuntimeException('Contact request is blocked.');
        }
        if (Db::name('contacts')->where('user_id', $fromUserId)->where('contact_user_id', $toUserId)->find()) {
            throw new RuntimeException('User is already a contact.');
        }

        return Db::transaction(function () use ($fromUserId, $toUserId, $message): array {
            $reverse = Db::name('contact_requests')->where('from_user_id', $toUserId)
                ->where('to_user_id', $fromUserId)->where('status', 'pending')->lock(true)->find();
            if ($reverse) {
                return $this->acceptRequest((int) $reverse['id'], $fromUserId, $reverse);
            }

            $existing = Db::name('contact_requests')->where('from_user_id', $fromUserId)
                ->where('to_user_id', $toUserId)->lock(true)->find();
            if ($existing && $existing['status'] === 'pending') {
                return ['status' => 'pending', 'request_id' => (int) $existing['id'], 'created' => false];
            }

            $now = date('Y-m-d H:i:s');
            $data = [
                'from_user_id' => $fromUserId,
                'to_user_id' => $toUserId,
                'message' => $this->friendshipGreeting($fromUserId, $message),
                'status' => 'pending',
                'created_at' => $now,
                'updated_at' => $now,
            ];
            // The pair is unique. Renew a handled request instead of inserting
            // another row for the same people and triggering a duplicate key.
            if ($existing) {
                $id = (int) $existing['id'];
                // A request handled by an old PHP worker during rollout may
                // still have a pending notice. Finish it before reusing the pair.
                (new UserNotificationService())->resolveRequest($id, $existing['status']);
                Db::name('contact_requests')->where('id', $id)->update($data);
            } else {
                $id = Db::name('contact_requests')->insertGetId($data);
            }
            (new UserNotificationService())->friendRequest($toUserId, $fromUserId, (int) $id, $data['message']);
            return ['status' => 'pending', 'request_id' => (int) $id, 'created' => true];
        });
    }

    public function forceAdd(int $fromUserId, int $toUserId): array
    {
        (new AuthService())->assertInternalStaff($fromUserId);
        $this->assertDifferentUsers($fromUserId, $toUserId);
        $this->assertActiveUser($toUserId);
        return Db::transaction(function () use ($fromUserId, $toUserId): array {
            $now = date('Y-m-d H:i:s');
            $wasContact = (bool) Db::name('contacts')->where('user_id', $toUserId)->where('contact_user_id', $fromUserId)->find();
            foreach ([[$fromUserId, $toUserId], [$toUserId, $fromUserId]] as $pair) {
                if (!Db::name('contacts')->where('user_id', $pair[0])->where('contact_user_id', $pair[1])->find()) {
                    Db::name('contacts')->insert(['user_id' => $pair[0], 'contact_user_id' => $pair[1], 'created_at' => $now, 'source_type' => 'internal_staff']);
                }
            }
            $pending = Db::name('contact_requests')->where(function ($query) use ($fromUserId, $toUserId): void {
                $query->where(function ($nested) use ($fromUserId, $toUserId): void {
                    $nested->where('from_user_id', $fromUserId)->where('to_user_id', $toUserId);
                })->whereOr(function ($nested) use ($fromUserId, $toUserId): void {
                    $nested->where('from_user_id', $toUserId)->where('to_user_id', $fromUserId);
                });
            })->where('status', 'pending')->lock(true)->select()->toArray();
            $notifications = new UserNotificationService();
            foreach ($pending as $request) {
                Db::name('contact_requests')->where('id', $request['id'])->update(['status' => 'accepted', 'updated_at' => $now]);
                $notifications->resolveRequest((int) $request['id'], 'accepted');
            }
            $conversation = (new ConversationService())->createDirect($fromUserId, $toUserId);
            if (!$wasContact) {
                Db::name('conversation_members')->where('conversation_id', (int) $conversation['id'])->whereIn('user_id', [$fromUserId, $toUserId])->update(['hidden_at' => null, 'is_archived' => 0]);
                $notifications->friendAdded($toUserId, $fromUserId, (int) $conversation['id']);
            }
            return ['status' => 'accepted', 'user_id' => $toUserId, 'forced' => true];
        });
    }

    public function handleRequest(int $userId, int $requestId, string $action, int $notificationId = 0): array
    {
        if (!in_array($action, ['accept', 'reject'], true) || $requestId <= 0) {
            throw new RuntimeException('Invalid contact request action.');
        }
        return Db::transaction(function () use ($userId, $requestId, $action, $notificationId): array {
            $request = Db::name('contact_requests')->where('id', $requestId)
                ->where('to_user_id', $userId)->lock(true)->find();
            if (!$request) {
                throw new RuntimeException('Contact request not found.');
            }
            if ($request['status'] !== 'pending') {
                (new UserNotificationService())->resolveRequest($requestId, $request['status']);
                return ['status' => $request['status'], 'request_id' => $requestId];
            }
            if ($notificationId > 0) (new UserNotificationService())->assertPendingRequest($userId, $notificationId, $requestId);
            if ($action === 'accept') {
                return $this->acceptRequest($requestId, $userId, $request);
            }
            Db::name('contact_requests')->where('id', $requestId)->update([
                'status' => 'rejected', 'updated_at' => date('Y-m-d H:i:s'),
            ]);
            (new UserNotificationService())->resolveRequest($requestId, 'rejected');
            return ['status' => 'rejected', 'request_id' => $requestId];
        });
    }

    public function requestSummary(int $userId): array
    {
        if ($userId <= 0) throw new RuntimeException('Invalid user.');
        return ['pending_count' => (int) Db::name('contact_requests')->where('to_user_id', $userId)->where('status', 'pending')->count()];
    }

    public function requests(int $userId, string $direction = 'received', int $page = 1, int $size = 20, string $status = ''): array
    {
        if (!in_array($direction, ['received', 'sent'], true)) {
            throw new RuntimeException('Invalid request direction.');
        }
        if (!in_array($status, ['', 'pending'], true)) throw new RuntimeException('Invalid request status filter.');
        $size = min(50, max(1, $size));
        $field = $direction === 'received' ? 'to_user_id' : 'from_user_id';
        $other = $direction === 'received' ? 'from_user_id' : 'to_user_id';
        $query = Db::name('contact_requests')->alias('r')->leftJoin('users u', 'u.id = r.' . $other)->where('r.' . $field, $userId);
        if ($status !== '') $query->where('r.status', $status);
        $rows = $query->field('r.*,u.public_id,u.nickname,u.avatar_url')->order('r.id', 'desc')
            ->paginate(['list_rows' => $size, 'page' => max(1, $page)]);
        $items = array_map(static fn (array $row): array => [
            'id' => (int) $row['id'], 'user_id' => (int) $row[$other], 'public_id' => $row['public_id'] ?? null, 'nickname' => $row['nickname'],
            'avatar_url' => $row['avatar_url'], 'message' => $row['message'], 'status' => $row['status'],
            'created_at' => $row['created_at'],
        ], $rows->items());
        return ['items' => $items, 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    public function list(int $userId, int $page = 1, int $size = 50): array
    {
        $size = min(100, max(1, $size));
        $rows = Db::name('contacts')->alias('c')->leftJoin('users u', 'u.id = c.contact_user_id')->leftJoin('user_presence p', 'p.user_id = c.contact_user_id')->leftJoin('user_permissions up', 'up.user_id = c.contact_user_id')
            ->where('c.user_id', $userId)->where('u.status', 'active')->field('c.*,u.public_id,u.nickname,u.username,u.phone,u.avatar_url,u.status,up.internal_staff,p.last_seen_at AS presence_seen_at')
            ->order('c.created_at', 'desc')->paginate(['list_rows' => $size, 'page' => max(1, $page)]);
        $settingsService = new UserSettingsService();
        $items = array_map(function (array $row) use ($settingsService, $userId): array {
            $privacy = $settingsService->get((int) $row['contact_user_id']);
            $phoneVisible = $settingsService->canView($privacy, 'phone_visibility', $userId, true);
            $lastSeenVisible = !(new BlockService())->isBlocked((int) $row['contact_user_id'], $userId) && $settingsService->canView($privacy, 'last_seen_visibility', $userId, true);
            return [
                'user_id' => (int) $row['contact_user_id'], 'public_id' => $row['public_id'] ?? null, 'nickname' => $row['nickname'],
                'username' => $row['username'],
                'phone' => $phoneVisible ? $row['phone'] : null,
                'avatar_url' => $row['avatar_url'], 'remark' => $row['remark'], 'group_name' => $row['group_name'] ?? null, 'created_at' => $row['created_at'],
                'internal_staff' => (bool) ($row['internal_staff'] ?? false),
                'online' => $lastSeenVisible && !empty($row['presence_seen_at']) && strtotime($row['presence_seen_at']) >= time() - 60,
                'last_seen_at' => $lastSeenVisible ? $row['presence_seen_at'] : null,
                'last_seen_hidden' => !$lastSeenVisible,
            ];
        }, $rows->items());
        return ['items' => $items, 'total' => $rows->total(), 'page' => $rows->currentPage(), 'size' => $size];
    }

    public function remark(int $userId, int $contactUserId, ?string $remark = null, ?string $groupName = null): array
    {
        return Db::transaction(function () use ($userId, $contactUserId, $remark, $groupName): array {
            $contact = Db::name('contacts')->where('user_id', $userId)->where('contact_user_id', $contactUserId)->lock(true)->find();
            if (!$contact) {
                throw new RuntimeException('联系人不存在。');
            }
            $updates = [];
            if ($remark !== null) $updates['remark'] = mb_substr(trim($remark), 0, 64);
            if ($groupName !== null) { $groupName = mb_substr(trim($groupName), 0, 64); $updates['group_name'] = $groupName === '' ? null : $groupName; }
            if ($updates === []) throw new RuntimeException('没有需要保存的备注或分组。');
            $changed = array_filter($updates, static fn($value, $key): bool => $value !== ($contact[$key] ?? null), ARRAY_FILTER_USE_BOTH);
            if ($changed !== []) {
                Db::name('contacts')->where('user_id', $userId)->where('contact_user_id', $contactUserId)->update($changed);
                ContactNameService::changed($userId);
            }
            return ['user_id' => $contactUserId, 'remark' => $updates['remark'] ?? $contact['remark'], 'group_name' => array_key_exists('group_name', $updates) ? $updates['group_name'] : $contact['group_name']];
        });
    }

    public function remove(int $userId, int $contactUserId): array
    {
        if ($userId <= 0 || $contactUserId <= 0 || $userId === $contactUserId) {
            throw new RuntimeException('Invalid contact target.');
        }
        if (!Db::name('contacts')->where('user_id', $userId)->where('contact_user_id', $contactUserId)->find()) {
            throw new RuntimeException('Contact not found.');
        }
        Db::transaction(function () use ($userId, $contactUserId): void {
            Db::name('contacts')->where(function ($query) use ($userId, $contactUserId): void {
                $query->where('user_id', $userId)->where('contact_user_id', $contactUserId)
                    ->whereOr(function ($nested) use ($userId, $contactUserId): void {
                        $nested->where('user_id', $contactUserId)->where('contact_user_id', $userId);
                    });
            })->delete();
            ContactNameService::changed($userId);
            ContactNameService::changed($contactUserId);
        });
        return ['user_id' => $contactUserId, 'status' => 'removed'];
    }

    public function profile(int $userId, int $contactUserId, ?int $contextConversationId = null): array
    {
        $context = new GroupProfileContextService();
        $public = (new ContactDetailsService())->profile($userId, $contactUserId, $contextConversationId);
        if (!(new AuthService())->isInternalStaff($userId)) {
            $context->assertAllowed($userId, $contactUserId, $contextConversationId);
            return $public;
        }
        $context->assertAllowed($userId, $contactUserId, $contextConversationId);
        $contact = Db::name('contacts')->alias('c')->leftJoin('users u', 'u.id = c.contact_user_id')
            ->where('c.user_id', $userId)->where('c.contact_user_id', $contactUserId)
            ->field('c.remark,c.group_name,c.created_at AS added_at,u.id,u.nickname,u.phone,u.avatar_url,u.status')
            ->find();
        if (!$contact) {
            $context->assertAllowed($userId, $contactUserId, $contextConversationId);
            return $public;
        }
        $login = Db::name('login_logs')->where('user_id', $contactUserId)->where('success', 1)->order('id', 'desc')->find();
        $presence = Db::name('user_presence')->where('user_id', $contactUserId)->find();
        $permission = Db::name('user_permissions')->where('user_id', $contactUserId)->field('internal_staff')->find();
        $settingsService = new UserSettingsService();
        $privacy = $settingsService->get($contactUserId);
        $ip = (string) ($login['ip'] ?? '');
        if (!(new AuthService())->isInternalStaff($userId)) $ip = '';
        $showPhone = $settingsService->canView($privacy, 'phone_visibility', $userId, true);
        $showLastSeen = !$public['last_seen_hidden'];
        $location = $showLastSeen ? $this->ipLocationDetails($ip) : ['location' => '已隐藏', 'status' => 'hidden'];
        $profile = array_merge($public, [
            'user_id' => (int) $contact['id'],
            'nickname' => $contact['nickname'],
            'phone' => $showPhone ? $contact['phone'] : null,
            'avatar_url' => $contact['avatar_url'],
            'internal_staff' => (bool) ($permission['internal_staff'] ?? false),
            'remark' => $contact['remark'],
            'group_name' => $contact['group_name'] ?? null,
            'added_at' => $contact['added_at'],
            'status' => $contact['status'],
            'online' => $showLastSeen && !empty($presence['last_seen_at']) && strtotime($presence['last_seen_at']) >= time() - 60,
            'last_seen_at' => $showLastSeen ? ($presence['last_seen_at'] ?? null) : null,
            'last_login_at' => $showLastSeen ? ($login['created_at'] ?? null) : null,
            'last_login_device' => $showLastSeen ? ($login['device_type'] ?? null) : null,
            'last_login_ip' => $showLastSeen && $ip !== '' ? $ip : null,
            'ip_location' => $location['location'],
            'ip_location_status' => $location['status'],
            'ip_location_error_code' => $location['error_code'] ?? null,
            'ip_location_error_number' => $location['error_number'] ?? null,
        ]);
        $context->assertAllowed($userId, $contactUserId, $contextConversationId);
        return $profile;
    }

    public function internalProfile(int $viewerId, int $targetId, ?int $contextConversationId = null): array
    {
        $context = new GroupProfileContextService();
        $context->assertAllowed($viewerId, $targetId, $contextConversationId, true);
        (new AuthService())->assertInternalStaff($viewerId);
        if ($targetId <= 0 || $viewerId === $targetId) throw new RuntimeException('用户资料参数无效。');
        $context->assertAllowed($viewerId, $targetId, $contextConversationId, true);
        $user = Db::name('users')->where('id', $targetId)->where('status', 'active')->field('id,public_id,nickname,username,phone,avatar_url,status,register_ip,created_at')->find();
        if (!$user) throw new RuntimeException('用户不存在。');
        $logs = Db::name('login_logs')->where('user_id', $targetId)->where('success', 1)->order('id', 'desc')->limit(20)->select()->toArray();
        $login = $logs[0] ?? null;
        $this->primeIpLocations(array_merge([(string) ($user['register_ip'] ?? ''), (string) ($login['ip'] ?? '')], array_column($logs, 'ip')));
        $registerLocation = $this->ipLocationDetails((string) ($user['register_ip'] ?? ''));
        $loginLocation = $this->ipLocationDetails((string) ($login['ip'] ?? ''));
        $profile = [
            'user_id' => (int) $user['id'],
            'public_id' => $user['public_id'] ?? null,
            'nickname' => $user['nickname'],
            'username' => $user['username'] ?? null,
            'phone' => $user['phone'] ?? null,
            'avatar_url' => $user['avatar_url'] ?? null,
            'status' => $user['status'],
            'register_ip' => $user['register_ip'] ?? null,
            'register_ip_location' => $registerLocation['location'],
            'register_ip_location_status' => $registerLocation['status'],
            'register_ip_location_error_code' => $registerLocation['error_code'] ?? null,
            'register_ip_location_error_number' => $registerLocation['error_number'] ?? null,
            'last_login_ip' => $login['ip'] ?? null,
            'last_login_location' => $loginLocation['location'],
            'last_login_location_status' => $loginLocation['status'],
            'last_login_location_error_code' => $loginLocation['error_code'] ?? null,
            'last_login_location_error_number' => $loginLocation['error_number'] ?? null,
            'last_login_at' => $login['created_at'] ?? null,
            'last_login_device' => $login['device_type'] ?? null,
            'login_history' => array_map(function (array $row): array {
                $location = $this->ipLocationDetails((string) ($row['ip'] ?? ''), true);
                return [
                    'ip' => $row['ip'] ?? null,
                    'location' => $location['location'],
                    'location_status' => $location['status'],
                    'location_error_code' => $location['error_code'] ?? null,
                    'location_error_number' => $location['error_number'] ?? null,
                    'device_type' => $row['device_type'] ?? null,
                    'created_at' => $row['created_at'] ?? null,
                ];
            }, $logs),
        ];
        $context->assertAllowed($viewerId, $targetId, $contextConversationId, true);
        return $profile;
    }

    private function ipLocation(string $ip): string
    {
        return $this->ipLocationDetails($ip)['location'];
    }

    /** One provider batch per profile, prioritizing registration and latest login. */
    private function primeIpLocations(array $ips): void
    {
        $service = new AdminIpLocationService(); $pending = [];
        foreach (array_unique($ips) as $ip) {
            if (!is_string($ip) || !filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) continue;
            $ip = inet_ntop(inet_pton($ip));
            if (isset(self::$ipLocations[$ip]) || isset($pending[$ip])) continue;
            $item = $service->cached($ip);
            if ($item['status'] !== 'pending') self::$ipLocations[$ip] = $item;
            elseif (count($pending) < AdminIpLocationService::BATCH_SIZE) $pending[$ip] = $ip;
        }
        foreach ($pending === [] ? [] : $service->resolve(array_values($pending)) as $item) self::$ipLocations[$item['ip']] = $item;
    }

    private function ipLocationDetails(string $ip, bool $cacheOnly = false): array
    {
        if ($ip === '' || !filter_var($ip, FILTER_VALIDATE_IP)) return ['location' => '暂无记录', 'status' => 'ready'];
        $ip = inet_ntop(inet_pton($ip));
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) return ['location' => '本机或内网地址', 'status' => 'ready'];
        if (isset(self::$ipLocations[$ip])) return self::$ipLocations[$ip];
        $service = new AdminIpLocationService();
        // Older uncached history entries continue on a later profile refresh;
        // they must not create twenty sequential provider timeouts in one request.
        if ($cacheOnly) return $service->cached($ip);
        $items = $service->resolve([$ip]);
        return self::$ipLocations[$ip] = $items[0] ?? ['status' => 'unavailable'] + IpLocationFailure::describe('provider_unavailable');
    }

    private function acceptRequest(int $requestId, int $userId, ?array $lockedRequest = null): array
    {
        $request = $lockedRequest ?? Db::name('contact_requests')->where('id', $requestId)->lock(true)->find();
        if (!$request || (int) $request['to_user_id'] !== $userId) {
            throw new RuntimeException('Contact request not found.');
        }
        if ($request['status'] !== 'pending') return ['status' => $request['status'], 'request_id' => $requestId];
        $peerId = (int) $request['from_user_id'];
        // Acquire the ordered account locks before contact inserts take foreign
        // key locks on the same accounts. Only the conversation ID is needed.
        $conversation = (new ConversationService())->createDirect($userId, $peerId, false);
        $conversationId = (int) $conversation['id'];
        $now = date('Y-m-d H:i:s');
        Db::name('contact_requests')->where('id', $requestId)->update(['status' => 'accepted', 'updated_at' => $now]);
        foreach ([[(int) $request['from_user_id'], $userId], [$userId, (int) $request['from_user_id']]] as $pair) {
            $exists = Db::name('contacts')->where('user_id', $pair[0])->where('contact_user_id', $pair[1])->find();
            if (!$exists) {
                Db::name('contacts')->insert(['user_id' => $pair[0], 'contact_user_id' => $pair[1], 'created_at' => $now, 'source_type' => 'friend_request', 'source_request_id' => $requestId]);
            }
        }

        Db::name('conversations')->where('id', $conversationId)->update(['updated_at' => $now]);
        // Re-adding a previously hidden/archived friend restores both lists.
        Db::name('conversation_members')->where('conversation_id', $conversationId)->whereIn('user_id', [$userId, $peerId])->update(['hidden_at' => null, 'is_archived' => 0]);
        $notifications = new UserNotificationService();
        // Finish reads and notification writes before the message trigger takes
        // the global event-sequence lock. Both users receive one durable hint at
        // the very end of this same transaction, including the resolved request.
        $notifications->resolveRequest($requestId, 'accepted', false);
        $notifications->friendAccepted($peerId, $userId, $conversationId, false);
        $eventId = $notifications->friendAdded($userId, $peerId, $conversationId, false);
        $this->appendFriendshipMessages($request, $conversationId, $now);
        $notifications->signalUsers([$peerId, $userId]);
        return ['status' => 'accepted', 'request_id' => $requestId, 'conversation_id' => $conversationId,
            'friend_chat' => ['id' => $eventId, 'conversation_id' => $conversationId, 'peer_user_id' => $peerId]];
    }

    private function friendshipGreeting(int $applicantId, string $message): string
    {
        $message = mb_substr(trim($message), 0, 255);
        // Existing PC, Web, Android and iOS builds submit these fixed defaults.
        // Keep personalized verification text, and use only the public nickname
        // for the default introduction, never a private contact remark or phone.
        if (!in_array($message, ['', '你好', '你好，想和你成为好友', '请求添加您为好友'], true)) return $message;
        $nickname = trim((string) Db::name('users')->where('id', $applicantId)->value('nickname'));
        $nickname = trim(preg_replace('/[\p{Cc}]/u', '', $nickname) ?? '');
        return '我是' . ($nickname === '' ? '新朋友' : mb_substr($nickname, 0, 80));
    }

    private function appendFriendshipMessages(array $request, int $conversationId, string $now): void
    {
        // Only the locked pending -> accepted transition calls this writer. Both
        // contact edges, messages and durable realtime events share its outer
        // transaction; a failed write rolls back acceptance as well. A fresh
        // nonce also permits a later re-add when the same request row is reused.
        $key = 'friendship.' . bin2hex(random_bytes(16));
        $texts = [
            [(int) $request['from_user_id'], $this->friendshipGreeting((int) $request['from_user_id'], (string) $request['message']), 'greeting'],
            [(int) $request['to_user_id'], '我已通过你的朋友验证请求，现在我们可以开始聊天了', 'accepted'],
        ];
        $rows = [];
        foreach ($texts as [$senderId, $text, $kind]) {
            $requestId = $key . '.' . $kind;
            $rows[] = ['conversation_id' => $conversationId, 'sender_id' => $senderId, 'type' => 'text',
                'request_id' => $requestId, 'body_json' => json_encode(['text' => $text, 'request_id' => $requestId], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
                'created_at' => $now];
        }
        // Ordinary text rows use the existing history, unread, sender-avatar and
        // database event triggers, so all existing clients display both bubbles.
        if (Db::name('messages')->insertAll($rows) !== 2) throw new RuntimeException('好友通过提示保存失败，请稍后重试。');
    }

    private function assertActiveUser(int $userId): void
    {
        if ($userId <= 0 || !Db::name('users')->where('id', $userId)->where('status', 'active')->find()) {
            throw new RuntimeException('User not found.');
        }
    }

    private function assertDifferentUsers(int $fromUserId, int $toUserId): void
    {
        if ($fromUserId <= 0 || $fromUserId === $toUserId) {
            throw new RuntimeException('Invalid contact target.');
        }
        $this->assertActiveUser($fromUserId);
    }

    private function publicUser(array $row, ?string $phone = null): array
    {
        return ['id' => (int) $row['id'], 'public_id' => $row['public_id'] ?? null, 'nickname' => $row['nickname'], 'username' => $row['username'] ?? null, 'phone' => $phone, 'avatar_url' => $row['avatar_url']];
    }
}
