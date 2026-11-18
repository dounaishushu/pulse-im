// Reproduce the filmed PC row jumping with real read receipts and same-second activity timestamps.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.local/chat-jump-video-20261118/ui'),baseline=process.argv.includes('--baseline');
const uuid=n=>String(n).padStart(8,'0')+'-7777-4777-8777-777777777777',uid=uuid(1),cid=n=>uuid(100+n),peer=n=>uuid(500+n);
fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1100,height:1000},timezoneId:'Asia/Shanghai'}),errors=[],checks=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  const model={reads:new Map(),stamps:Array.from({length:12},(_,n)=>'2026-11-17T09:58:00.'+String(900000-n*10000).padStart(6,'0')+'Z'),seqs:Array(12).fill(1),requests:[]};
  const msg=n=>({id:uuid(10000+n*10+model.seqs[n]),conversation_id:cid(n),sender_id:peer(n),sender:{id:peer(n),name:'好友'+n},seq:String(model.seqs[n]),event_seq:String(model.seqs[n]),version:'1',request_id:'fixture-'+n,kind:'text',body:'消息'+n,content:{},created_at:model.stamps[n],updated_at:model.stamps[n]});
  const row=n=>({id:cid(n),kind:'direct',peer_id:peer(n),peer_name:'好友'+n,my_role:'member',can_send:true,pinned:n<2,preference_version:'1',membership_version:'1',visible_from_seq:'1',message_seq:String(model.seqs[n]),event_seq:String(model.seqs[n]),
    unread_count:String((model.reads.get(n)||0)<model.seqs[n]?1:0),updated_at:model.stamps[n],last_message:msg(n),state:{clear_seq:'0',read_seq:String(model.reads.get(n)||0),delivered_seq:'0',personal_seq:'0',version:String(model.reads.has(n)?2:1)}});
  const sorted=()=>Array.from({length:12},(_,n)=>row(n)).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updated_at.localeCompare(a.updated_at)||b.id.localeCompare(a.id));
  await page.addInitScript(({base})=>{window.pulseDesktop={isDesktop:true,production:false,apiBaseUrl:base,windowKind:'account'};localStorage.setItem('pulse_go_v2:'+encodeURIComponent(base)+':token','fixture');},{base:origin+'/api/v2'});
  await page.route('**/go-realtime.js',route=>route.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async()=>({close(){}})};'}));
  await page.route('**/api/v2/**',async route=>{
    const req=route.request(),u=new URL(req.url()),p=u.pathname.replace('/api/v2','');model.requests.push(p);let data={items:[]};
    if(p==='/me'||p==='/me/profile')data={id:uid,account:'fixture',nickname:'当前账号',version:'1'};
    else if(p==='/client/update')data={required:false};
    else if(p==='/client/config')data={registration:{},display:{},releases:{}};
    else if(p==='/client/friend-page')data={items:[],total:0,page:1,size:50};
    else if(p==='/client/conversation-page'||p==='/conversations')data={items:sorted(),total:12,page:1,size:30};
    else if(p==='/client/conversation-updates')data={items:req.postDataJSON().conversation_ids.map(id=>row(Number(id.slice(0,8))-100)),removed_ids:[],incremental:true};
    else if(p.startsWith('/profiles/'))data={id:p.split('/')[2],nickname:'好友',is_contact:true,online:false};
    else if(p.startsWith('/conversations/')){
      const n=Number(p.split('/')[2]?.slice(0,8))-100;
      if(n>=0&&n<12){
        if(p.endsWith('/history'))data={items:[msg(n)],membership_version:'1',snapshot_max_seq:String(model.seqs[n]),next_after_seq:String(model.seqs[n]),next_before_seq:'1',visible_from_seq:'1',clear_seq:'0',has_more:false};
        else if(p.endsWith('/read')){model.reads.set(n,Number(req.postDataJSON().seq));data={read_seq:String(model.reads.get(n)),version:'2',reminder:false};}
        else if(p.endsWith('/unread'))data={count:String((model.reads.get(n)||0)<model.seqs[n]?1:0),truncated:false};
        else if(p.endsWith('/personal-sync'))data={events:[],snapshot_max_seq:'0',next_after_seq:'0',has_more:false};
        else if(p.endsWith('/sync'))data={events:[],membership_version:'1',snapshot_max_seq:String(model.seqs[n]),next_after_seq:String(model.seqs[n]),visible_from_seq:'1',has_more:false};
        else data=row(n);
      }
    }
    try{await route.fulfill({json:data});}catch(error){if(!/Target.*closed|disposed/.test(error.message)&&!page.isClosed())throw error;}
  });
  const check=(name,passed)=>{checks.push({name,passed});if(!baseline)assert.equal(passed,true,name);};
  const order=()=>page.locator('#conversation-list .conversation').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.id)));
  const local=n=>page.evaluate(id=>GO.local('conversation',id),cid(n));
  const refresh=n=>page.evaluate(async id=>{refreshChangedConversations(GO.local('conversation',id));await conversationRefresh.flush();},cid(n));
  async function openAndRead(n){const revision=await page.evaluate(()=>conversationDataRevision),id=await local(n);await page.click(`#conversation-list .conversation[data-id="${id}"]`);await page.waitForFunction(revision=>conversationDataRevision>revision,revision);}
  try{
    await page.goto(origin+'/pc/web/index.html');await page.waitForFunction(()=>state.conversations.length===12&&!state.conversationListLoad);
    const initial=await order(),selected=await local(5),target=page.locator(`#conversation-list .conversation[data-id="${selected}"]`),box=await target.boundingBox(),point={x:box.x+box.width/2,y:box.y+box.height/2};
    await page.evaluate(id=>window.keptConversation=document.querySelector(`#conversation-list .conversation[data-id="${id}"]`),selected);
    await openAndRead(5);
    check('opening the conversation reaches a real read acknowledgment',model.reads.get(5)===1);
    check('a read-only incremental update never reshuffles same-second conversations',JSON.stringify(await order())===JSON.stringify(initial));
    check('a stationary pointer remains over the same friend after the read update',await page.evaluate(point=>Number(document.elementFromPoint(point.x,point.y)?.closest('.conversation')?.dataset.id),point)===selected);
    await page.screenshot({path:path.join(out,baseline?'before.png':'after.png')});
    if(baseline){fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({reproduced:checks.some(c=>!c.passed),checks,errors},null,2));console.log(JSON.stringify({reproduced:checks.some(c=>!c.passed),checks}));return;}
    check('updating the unread badge retains the same conversation DOM node',await page.evaluate(()=>keptConversation.isConnected&&keptConversation===document.querySelector(`[data-id="${keptConversation.dataset.id}"]`)));
    for(const n of [3,7]){await openAndRead(n);assert.deepEqual(await order(),initial);}
    check('repeatedly reading different conversations leaves the sidebar order unchanged',true);
    for(let i=0;i<3;i++){await page.evaluate(()=>loadConversations());assert.deepEqual(await order(),initial);await refresh(3);assert.deepEqual(await order(),initial);}
    check('full reloads and incremental updates use identical ordering',true);
    model.stamps[10]='2026-11-17T09:58:00.999999Z';model.seqs[10]=2;await refresh(10);
    const advanced=await order(),newest=await local(10);
    check('a real newer message still advances its conversation within the recent section',advanced[2]===newest&&JSON.stringify(advanced.slice(0,2))===JSON.stringify(initial.slice(0,2)));
    await page.evaluate(()=>loadConversations());assert.deepEqual(await order(),advanced);await refresh(10);assert.deepEqual(await order(),advanced);
    check('new message order stays stable across later reads and full snapshots',true);
    const tied='2026-11-17T09:58:00Z';for(let n=2;n<12;n++)model.stamps[n]=tied;await page.evaluate(()=>loadConversations());
    const same=await order();await refresh(4);check('exactly equal timestamps share the same server UUID tie-break rule',JSON.stringify(await order())===JSON.stringify(same));
    check('pinned positions survive both activity changes and tied snapshots',JSON.stringify(same.slice(0,2))===JSON.stringify(initial.slice(0,2)));
    assert.deepEqual(errors,[]);check('no unhandled browser errors occur during the read and update sequence',true);
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:checks.length,checks,errors},null,2));console.log(JSON.stringify({passed:checks.length,out}));
  }finally{await page.close();await browser.close();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1;});
