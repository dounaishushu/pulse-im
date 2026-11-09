<?php

namespace app\command;

use app\Service\AccountRetentionService;
use think\console\Command;
use think\console\Input;
use think\console\Output;

/**
 * 清理超过用户保留期限仍未上线的账号。
 *
 * 建议在宝塔计划任务中每天执行：php think account:retention
 */
final class ProcessAccountRetention extends Command
{
    protected function configure()
    {
        $this->setName('account:retention')
            ->setDescription('执行长期未上线账号的自动清理');
    }

    protected function execute(Input $input, Output $output)
    {
        $result = (new AccountRetentionService())->process();
        $output->writeln(sprintf(
            '账号自动清理完成：检查 %d 个，清理 %d 个，执行时间 %s',
            $result['checked'],
            $result['deleted'],
            $result['processed_at']
        ));

        foreach ($result['users'] as $user) {
            $output->writeln(sprintf(
                '已清理用户 #%d，最后活跃时间 %s，保留期限 %d 天',
                $user['user_id'],
                $user['last_active_at'],
                $user['retention_days']
            ));
        }

        return 0;
    }
}
