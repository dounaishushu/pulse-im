<?php
declare(strict_types=1);
require dirname(__DIR__).'/vendor/autoload.php';
require_once dirname(__DIR__).'/app/Service/RealtimeSequencerService.php';
(new think\App(dirname(__DIR__).'/'))->initialize();
$once=in_array('--once',$argv,true);
$sequencer=new app\Service\RealtimeSequencerService();
$stopping=false;
if(function_exists('pcntl_async_signals')){
    pcntl_async_signals(true);
    foreach([SIGTERM,SIGINT]as$signal)pcntl_signal($signal,static function()use(&$stopping):void{$stopping=true;});
}
do{
    try{
        $processed=$sequencer->tick();
        if($once)echo json_encode(['ok'=>true,'processed'=>$processed]),PHP_EOL;
    }catch(Throwable $error){
        // SQL/body text and private payloads must never enter worker logs.
        fwrite(STDERR,"Realtime sequencing stopped; committed pending rows remain available for retry.\n");
        try{think\facade\Db::connect()->close();}catch(Throwable){}
        exit(75);
    }
    if(!$once && $processed===0 && !$stopping)usleep(50000);
}while(!$once && !$stopping);
