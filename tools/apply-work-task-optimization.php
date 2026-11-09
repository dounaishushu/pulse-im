<?php
require dirname(__DIR__) . '/backend/vendor/autoload.php';
(new think\App(dirname(__DIR__) . '/backend/'))->initialize();
foreach (preg_split('/;\s*(?:\r?\n|$)/', file_get_contents(dirname(__DIR__) . '/database/migrations/20261015_work_task_optimization.sql')) as $statement) {
    if (trim($statement) !== '') think\facade\Db::execute($statement);
}
echo "作业批改幂等与工资校验迁移已完成。\n";
