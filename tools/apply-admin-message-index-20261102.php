<?php
declare(strict_types=1);
$root=rtrim($argv[1]??dirname(__DIR__).'/backend','/\\');
require $root.'/vendor/autoload.php';(new think\App($root.'/'))->initialize();
use think\facade\Db;
$indexNames=[];foreach(Db::query('SHOW INDEX FROM messages') as $row)if((int)$row['Seq_in_index']===1&&$row['Column_name']==='sender_id')$indexNames[]=$row['Key_name'];
$created=false;
if($indexNames===[]&&in_array('--apply',$argv,true)) {
    Db::execute('SET SESSION lock_wait_timeout = 5');Db::execute('SET SESSION innodb_lock_wait_timeout = 5');
    Db::execute('ALTER TABLE messages ADD INDEX idx_message_sender_id (sender_id, id), ALGORITHM=INPLACE, LOCK=NONE');
    $indexNames=['idx_message_sender_id'];$created=true;
}
echo json_encode(['ok'=>true,'index_available'=>$indexNames!==[],'indexes'=>$indexNames,'created'=>$created,'online_only'=>true,'message_rows_modified'=>false],JSON_PRETTY_PRINT).PHP_EOL;
