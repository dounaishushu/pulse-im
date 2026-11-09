<?php
namespace app\Service;
use think\facade\Db;

final class PushQueueService
{
    public function enqueue(int $limit = 200): int
    {
        return Db::transaction(function () use ($limit): int {
            $cursor = Db::name('push_cursor')->where('id', 1)->lock(true)->find();
            $events = Db::name('realtime_events')->where('id', '>', (int) ($cursor['last_event_id'] ?? 0))->order('id')->limit($limit)->select()->toArray();
            $count = 0;
            foreach ($events as $event) {
                if ($event['event_type'] === 'message.new' && strtotime($event['created_at']) >= time() - 86400) {
                    $message = Db::name('messages')->where('id', $event['message_id'])->whereNull('recalled_at')->find();
                    if ($message && $message['type'] !== 'red_packet') {
                        $devices = Db::name('notification_devices')->alias('d')->join('conversation_members cm', 'cm.user_id=d.user_id')->join('conversations c', 'c.id=cm.conversation_id')->join('users u', 'u.id=d.user_id')
                            ->where('cm.conversation_id', $message['conversation_id'])->where('cm.notifications_muted', 0)->where('c.status', 'active')->where('u.status', 'active')->where('d.enabled', 1)->where('d.user_id', '<>', $message['sender_id'])->field('d.id,d.user_id,cm.role')->select()->toArray();
                        $devices = array_filter($devices, static fn (array $device): bool => GroupInviteNoticeService::allowsRole($message, $device['role']));
                        foreach ($devices as $device) { if (MessageDeletionService::hidden((int) $device['user_id'], (int) $message['id'])) continue; $now = date('Y-m-d H:i:s'); $count += (int) Db::name('push_jobs')->extra('IGNORE')->insert(['message_id' => $message['id'], 'user_id' => $device['user_id'], 'device_id' => $device['id'], 'status' => 'pending', 'attempts' => 0, 'next_attempt_at' => $now, 'created_at' => $now, 'updated_at' => $now]); }
                    }
                }
                Db::name('push_cursor')->where('id', 1)->update(['last_event_id' => $event['id']]);
            }
            return $count;
        });
    }

    public function deliver(callable $sender, int $limit = 50): array
    {
        $result = ['sent' => 0, 'cancelled' => 0, 'retry' => 0, 'failed' => 0];
        for ($index = 0; $index < $limit; $index++) {
            $job = Db::transaction(function (): ?array {
                $now = date('Y-m-d H:i:s');
                $row = Db::name('push_jobs')->whereIn('status', ['pending', 'retry', 'sending'])->where('next_attempt_at', '<=', $now)->where(function ($q) use ($now): void { $q->whereNull('lease_until')->whereOr('lease_until', '<', $now); })->order('id')->lock(true)->find();
                if (!$row) return null;
                $lease = date('Y-m-d H:i:s', time() + 60);
                Db::name('push_jobs')->where('id', $row['id'])->update(['status' => 'sending', 'lease_until' => $lease, 'attempts' => (int) $row['attempts'] + 1, 'updated_at' => $now]);
                return $row + ['lease' => $lease];
            });
            if (!$job) break;
            $device = Db::name('notification_devices')->where('id', $job['device_id'])->where('user_id', $job['user_id'])->where('enabled', 1)->find();
            $message = Db::name('messages')->where('id', $job['message_id'])->whereNull('recalled_at')->find();
            $valid = $device && $message && $message['type'] !== 'red_packet' && strtotime($job['created_at']) >= time() - 86400;
            if ($valid && MessageDeletionService::hidden((int) $job['user_id'], (int) $message['id'])) $valid = false;
            if ($valid) {
                $valid = (bool) Db::name('auth_tokens')->alias('t')->join('users u', 'u.id=t.user_id')->where('t.token_hash', $device['auth_token_hash'] ?? '')->where('t.user_id', $job['user_id'])->where('t.expires_at', '>', date('Y-m-d H:i:s'))->where('u.status', 'active')->find();
                $member = Db::name('conversation_members')->alias('m')->join('conversations c', 'c.id=m.conversation_id')->where('m.user_id', $job['user_id'])->where('m.conversation_id', $message['conversation_id'])->where('m.notifications_muted', 0)->where('c.status', 'active')->field('m.cleared_before_message_id,m.role,c.type')->find();
                $valid = $valid && $member && GroupInviteNoticeService::allowsRole($message, $member['role']) && (int) $message['id'] > (int) $member['cleared_before_message_id'];
                if ($valid && $member['type'] === 'direct') $valid = !(new BlockService())->isBlocked((int) $job['user_id'], (int) $message['sender_id']) && !(new BlockService())->isBlocked((int) $message['sender_id'], (int) $job['user_id']);
            }
            $status = 'cancelled'; $error = null;
            if ($valid) {
                $data = ['type' => 'message.new', 'user_id' => (string) $job['user_id'], 'conversation_id' => (string) $message['conversation_id'], 'message_id' => (string) $message['id'], 'sender_id' => (string) $message['sender_id'], 'title' => '小猿答疑', 'body' => '你有一条新消息'];
                try { $delivery = $sender($device, $data); } catch (\Throwable) { $delivery = ['ok' => false, 'permanent' => false, 'error' => 'PUSH_TRANSPORT_ERROR']; }
                if (!empty($delivery['ok'])) $status = 'sent';
                else { $error = substr((string) ($delivery['error'] ?? 'PUSH_FAILED'), 0, 255); $status = !empty($delivery['permanent']) || (int) $job['attempts'] >= 7 ? 'failed' : 'retry'; if (!empty($delivery['permanent'])) Db::name('notification_devices')->where('id', $device['id'])->where('device_token', $device['device_token'])->update(['enabled' => 0]); }
            }
            Db::name('push_jobs')->where('id', $job['id'])->where('lease_until', $job['lease'])->update(['status' => $status, 'lease_until' => null, 'next_attempt_at' => date('Y-m-d H:i:s', time() + min(3600, 30 * (2 ** min(7, (int) $job['attempts'])))), 'last_error' => $error, 'updated_at' => date('Y-m-d H:i:s')]);
            $result[$status]++;
        }
        return $result;
    }
}
