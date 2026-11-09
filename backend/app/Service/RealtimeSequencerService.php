<?php
declare(strict_types=1);
namespace app\Service;

use PDO;
use RuntimeException;
use think\facade\Db;

final class RealtimeSequencerService
{
    private float $lastIdleHeartbeatAt = 0;

    public function tick(int $limit=250): int
    {
        $routine=(string)env('REALTIME_QUEUE_ROUTINE','');
        if(!preg_match('/^(?:pulse_realtime_sequence_batch_v2|capacity_realtime_batch_test_[a-f0-9]{12})$/D',$routine)) throw new RuntimeException('Invalid realtime queue routine configuration.');
        $connection=Db::connect();$pdo=$connection->getPdo();
        if(!$pdo instanceof PDO){$connection->query('SELECT 1');$pdo=$connection->getPdo();}
        if(!$pdo instanceof PDO || $pdo->inTransaction())throw new RuntimeException('Sequencer requires an independent connection.');
        $discover=$pdo->query('SELECT id FROM realtime_outbox ORDER BY id LIMIT '.max(1,min(500,$limit)));
        $ids=array_map('intval',$discover->fetchAll(PDO::FETCH_COLUMN));$discover->closeCursor();
        if($ids===[]){
            // An empty committed queue needs no cursor allocation or global
            // sequence lock. Pending work arriving now is seen on the next tick.
            $now=hrtime(true)/1e9;
            if($now-$this->lastIdleHeartbeatAt>=2){
                $pdo->exec('UPDATE realtime_sequencer_health SET heartbeat_at=NOW(6),last_batch_count=0 WHERE id=1');
                $this->lastIdleHeartbeatAt=$now;
            }
            return 0;
        }
        $statement=$pdo->prepare('CALL `'.$routine.'`(?)');
        try{
            $statement->execute([json_encode($ids,JSON_THROW_ON_ERROR)]);
            $row=$statement->fetch(PDO::FETCH_ASSOC);
            while($statement->nextRowset())$statement->fetchAll(PDO::FETCH_ASSOC);
        }finally{$statement->closeCursor();}
        if(!$row || !isset($row['processed']) || $pdo->inTransaction())throw new RuntimeException('Invalid sequencer response.');
        return (int)$row['processed'];
    }
}
