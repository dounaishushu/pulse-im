<?php
namespace app\Service;

use RuntimeException;
use think\facade\Db;

/** Retired public operations; explicit legacy cancellation preserves settlement compatibility. */
final class WalletRequestService
{
    public function create(int $userId, array $payload): array
    {
        throw new RuntimeException('FEATURE_REMOVED: 钱包与红包功能已停用。');
    }

    public function review(int $id, string $decision, string $note, int $operatorId, string $ip): array
    {
        throw new RuntimeException('FEATURE_REMOVED: 钱包与红包功能已停用。');
    }

    public function cancel(int $id, int $userId): array { return $this->finish($id, 'cancelled', '用户撤销', 0, '', $userId); }

    private function finish(int $id, string $decision, string $note, int $operatorId, string $ip, ?int $owner): array
    {
        return Db::transaction(function () use ($id, $decision, $note, $operatorId, $ip, $owner): array {
            $row = Db::name('wallet_requests')->where('id', $id)->find();
            if (!$row || ($owner !== null && (int) $row['user_id'] !== $owner)) throw new RuntimeException('申请不存在');
            $wallet = $this->wallet((int) $row['user_id']);
            $this->lockUser((int) $row['user_id'], false);
            $row = Db::name('wallet_requests')->where('id', $id)->lock(true)->find();
            if ($row['status'] === $decision) return $row; // Retry never posts a second movement.
            if ($row['status'] !== 'pending') throw new RuntimeException('该申请已处理，请刷新列表');
            if ($decision === 'approved' && $row['kind'] === 'withdrawal' && $note === '') throw new RuntimeException('请填写线下处理凭据或说明后再确认提现');
            $amount = (int) $row['amount_fen'];
            if ($row['kind'] === 'withdrawal') {
                if ((int) $wallet['frozen_fen'] < $amount) throw new RuntimeException('冻结余额异常，不能处理');
                $paid = $decision === 'approved';
                $this->movement($wallet, $id, $paid ? 0 : $amount, -$amount, $paid ? 'withdrawal_paid' : 'withdrawal_release', $paid ? '提现后台已处理' : '提现解冻退回', $operatorId);
            } elseif ($decision === 'approved') {
                $this->movement($wallet, $id, $amount, 0, 'request_top_up', '内部充值审核通过', $operatorId);
            }
            Db::name('wallet_requests')->where('id', $id)->update([
                'status' => $decision, 'review_note' => $note, 'operator_id' => $operatorId ?: null, 'reviewed_at' => date('Y-m-d H:i:s'),
            ]);
            if ($owner === null) (new AuditService())->log($operatorId, 'wallet.request_review', 'wallet', $id, 'wallet-review-' . $id, $ip, ['decision' => $decision, 'amount_fen' => $amount, 'user_id' => $row['user_id']]);
            return Db::name('wallet_requests')->where('id', $id)->find();
        });
    }

    private function lockUser(int $id, bool $active = true): void
    {
        $user = Db::name('users')->where('id', $id)->lock(true)->find();
        if (!$user || ($active && $user['status'] !== 'active')) throw new RuntimeException('用户不存在或已被停用');
    }
    private function wallet(int $id): array
    {
        $row = Db::name('wallets')->where('user_id', $id)->lock(true)->find();
        if (!$row) {
            Db::name('wallets')->insert(['user_id' => $id, 'available_fen' => 0, 'frozen_fen' => 0, 'updated_at' => date('Y-m-d H:i:s')]);
            $row = Db::name('wallets')->where('user_id', $id)->lock(true)->find();
        }
        return $row;
    }
    private function movement(array $wallet, int $id, int $change, int $frozen, string $type, string $remark, int $operator): void
    {
        $available = (int) $wallet['available_fen'] + $change;
        Db::name('wallets')->where('user_id', $wallet['user_id'])->update(['available_fen' => $available, 'frozen_fen' => (int) $wallet['frozen_fen'] + $frozen, 'updated_at' => date('Y-m-d H:i:s')]);
        Db::name('wallet_ledgers')->insert(['user_id' => $wallet['user_id'], 'change_fen' => $change, 'balance_after_fen' => $available, 'type' => $type,
            'request_id' => 'wallet-request-' . $id . '-' . $type, 'operator_id' => $operator ?: null, 'remark' => $remark, 'created_at' => date('Y-m-d H:i:s')]);
    }
}
