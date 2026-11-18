// Exercise the shipping sidebar, adapter, and privacy-filtered presence responses.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.local/pc-sidebar-presence-20261118/ui'),baseline=process.argv.includes('--baseline');
const uuid=n=>String(n).padStart(8,'0')+'-8888-4888-8888-888888888888',uid=uuid(1),cid=n=>uuid(100+n),peer=n=>uuid(500+n);
fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1100,height:820},timezoneId:'Asia/Shanghai'}),checks=[],errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-11-18T04:00:00Z')});
  const model={requests:[],online:new Map(),hidden:new Set([2]),hold:null,unavailable:false,batchUnsupported:false};
  const row=n=>({id:cid(n),kind:n===4?'group':'direct',title:n===4?'测试群':'',peer_id:n===4?'':peer(n),peer_name:'好友'+n,my_role:n===4?'owner':'member',can_send:true,membership_version:'1',preference_version:'1',visible_from_seq:'1',message_seq:'0',event_seq:'0',unread_count:'0',updated_at:new Date(Date.UTC(2026,10,18,0,0,48-n)).toISOString(),state:{clear_seq:'0',read_seq:'0',delivered_seq:'0',personal_seq:'0',version:'1'}});
  const presence=n=>({conversation_id:cid(n),peer_id:peer(n),online:!model.hidden.has(n)&&(model.online.get(n)??n%2===0),last_seen_hidden:model.hidden.has(n),last_seen:model.hidden.has(n)?null:'2026-11-18T03:59:50Z'});
  await page.addInitScript(({base})=>{window.pulseDesktop={isDesktop:true,production:false,apiBaseUrl:base,windowKind:'account'};localStorage.setItem('pulse_go_v2:'+encodeURIComponent(base)+':token','fixture');},{base:origin+'/api/v2'});
  await page.route('**/go-realtime.js',r=>r.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async()=>({close(){}})};'}));
  await page.route('**/api/v2/**',async route=>{
    const req=route.request(),u=new URL(req.url()),p=u.pathname.replace('/api/v2','');model.requests.push({p,body:req.postDataJSON()});let data={items:[]},status=200;
    if(p==='/me'||p==='/me/profile')data={id:uid,account:'fixture',nickname:'当前账号',version:'1'};
    else if(p==='/client/update')data={required:false};
    else if(p==='/client/config')data={registration:{},display:{},releases:{}};
    else if(p==='/client/friend-page')data={items:[],total:0,page:1,size:50};
    else if(p==='/client/conversation-page'||p==='/conversations'){
      const pageNo=Number(u.searchParams.get('page')||1),size=Number(u.searchParams.get('size')||30);
      data={items:Array.from({length:48},(_,n)=>row(n)).slice((pageNo-1)*size,pageNo*size),total:48,page:pageNo,size};
    }else if(p==='/client/conversation-presence'){
      const ids=req.postDataJSON().conversation_ids;data={items:ids.filter(id=>id!==cid(4)).map(id=>presence(Number(id.slice(0,8))-100)),removed_ids:ids.filter(id=>id===cid(4))};
      if(model.hold)await model.hold;
      if(model.unavailable){status=503;data={error:{code:'unavailable'}};}
      if(model.batchUnsupported){status=404;data={error:{code:'missing'}};}
    }else if(p==='/client/conversation-updates')data={items:req.postDataJSON().conversation_ids.map(id=>row(Number(id.slice(0,8))-100)),removed_ids:[],incremental:true};
    else if(p.startsWith('/profiles/')){const n=Number(p.split('/')[2].slice(0,8))-500,v=presence(n);data={id:peer(n),nickname:'好友'+n,is_contact:true,online:v.online,...(!v.last_seen_hidden?{last_seen:v.last_seen}:{})};}
    else if(p.startsWith('/conversations/')){
      const n=Number(p.split('/')[2]?.slice(0,8))-100;
      if(n>=0&&n<48){
        if(p.endsWith('/history'))data={items:[],membership_version:'1',snapshot_max_seq:'0',next_after_seq:'0',next_before_seq:'0',visible_from_seq:'1',clear_seq:'0',has_more:false};
        else if(p.endsWith('/personal-sync'))data={events:[],snapshot_max_seq:'0',next_after_seq:'0',has_more:false};
        else if(p.endsWith('/sync'))data={events:[],membership_version:'1',snapshot_max_seq:'0',next_after_seq:'0',visible_from_seq:'1',has_more:false};
        else data=row(n);
      }
    }
    try{await route.fulfill({status,json:data});}catch(error){if(!/Target.*closed|disposed/.test(error.message)&&!page.isClosed())throw error;}
  });
  const check=(name,passed)=>{checks.push({name,passed});if(!baseline)assert.equal(passed,true,name);};
  const selector=async n=>`#conversation-list .conversation[data-id="${await page.evaluate(id=>GO.local('conversation',id),cid(n))}"]`;
  const status=async n=>page.locator((await selector(n))+' .conversation-presence').getAttribute('aria-label').catch(()=>null);
  const refresh=()=>page.evaluate(()=>refreshConversationPresence());
  const batchReads=()=>model.requests.filter(r=>r.p==='/client/conversation-presence');
  try{
    await page.goto(origin+'/pc/web/index.html');await page.waitForFunction(()=>state.conversations.length===48&&!state.conversationListLoad);
    if(baseline)await page.clock.fastForward(31000);
    else {await page.clock.runFor(250);await page.waitForFunction(()=>document.querySelector('.conversation-presence.is-online'));}
    check('an online friend has a green status dot before any conversation is opened',await page.locator((await selector(0))+' .conversation-presence.is-online').count()===1);
    check('an offline friend is labelled offline instead of missing from the status display',await status(1)==='离线');
    check('a privacy-hidden friend has no inferred online or offline dot',await page.locator((await selector(2))+' .conversation-presence').count()===0);
    await page.screenshot({path:path.join(out,baseline?'before.png':'after.png')});
    if(baseline){fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({reproduced:checks.some(c=>!c.passed),checks,errors},null,2));return;}
    check('the initial status refresh is one batch for only the visible direct conversations',batchReads().length===1&&batchReads()[0].body.conversation_ids.length<20&&!batchReads()[0].body.conversation_ids.includes(cid(4)));
    check('sidebar status does not issue per-friend profile or staff metadata requests',!model.requests.some(r=>r.p.startsWith('/profiles/')||r.p.startsWith('/staff/users/')));
    const original=await page.locator('#conversation-list .conversation').evaluateAll(nodes=>nodes.map(n=>n.dataset.id));
    await page.evaluate(()=>{window.retainedSidebarRow=document.querySelector('#conversation-list .conversation');});
    const pageReads=()=>model.requests.filter(r=>r.p==='/client/conversation-page').length,readsBefore=pageReads();
    model.online.set(0,false);await page.clock.fastForward(31000);await page.waitForFunction(()=>document.querySelector('#conversation-list .conversation .conversation-presence')?.getAttribute('aria-label')==='离线');
    check('scheduled status refresh updates the dot without reloading conversation pages',await status(0)==='离线'&&pageReads()===readsBefore);
    check('status updates preserve both sidebar row identity and order',await page.evaluate(()=>retainedSidebarRow===document.querySelector('#conversation-list .conversation'))&&JSON.stringify(await page.locator('#conversation-list .conversation').evaluateAll(nodes=>nodes.map(n=>n.dataset.id)))===JSON.stringify(original));
    await page.evaluate(()=>loadConversations());
    check('full directory refresh cannot discard the known status',await status(0)==='离线');
    await page.evaluate(async id=>{refreshChangedConversations(GO.local('conversation',id));await conversationRefresh.flush();},cid(0));
    check('read and preference deltas cannot discard the known status',await status(0)==='离线');
    model.hidden.add(0);await page.clock.fastForward(31000);await page.waitForFunction(selector=>!document.querySelector(selector+' .conversation-presence'),await selector(0));
    check('a newly hidden status removes the previous online or offline dot',await page.locator((await selector(0))+' .conversation-presence').count()===0);
    await page.evaluate(()=>{document.getElementById('conversation-list').scrollTop=1200;});await page.clock.runFor(200);
    await page.waitForFunction(()=>[...document.querySelectorAll('.conversation-presence')].some(n=>n.closest('.conversation').getBoundingClientRect().top>100&&n.closest('.conversation').getBoundingClientRect().top<800));
    check('scrolling fetches newly visible friends rather than every friend',batchReads().at(-1).body.conversation_ids.some(id=>Number(id.slice(0,8))>=115)&&batchReads().at(-1).body.conversation_ids.length<20);
    await page.evaluate(()=>{state.desktopAccountVisible=false;cancelForegroundReads();});const hiddenReads=batchReads().length;
    await page.clock.fastForward(65000);
    check('hidden or inactive account windows stop presence requests',batchReads().length===hiddenReads);
    await page.evaluate(()=>{state.desktopAccountVisible=true;resumeForegroundReads();});await page.clock.runFor(250);await page.waitForFunction(()=>document.querySelector('.conversation-presence'));
    check('returning to the account immediately refreshes visible friend statuses',batchReads().length>hiddenReads);
    await page.evaluate(async id=>{document.getElementById('conversation-list').scrollTop=0;await openConversation(GO.local('conversation',id),{focusInput:false});},cid(1));
    await page.fill('#message-input','在线状态刷新保留输入草稿');await page.evaluate(()=>window.retainedMessages=document.getElementById('messages'));
    await page.clock.fastForward(31000);await refresh();
    check('presence refresh leaves the composer draft and chat view untouched',await page.inputValue('#message-input')==='在线状态刷新保留输入草稿'&&await page.evaluate(()=>retainedMessages===document.getElementById('messages')));
    await page.evaluate(()=>{document.body.classList.add('desktop-night-mode');});
    const colors=await page.locator((await selector(1))+' .conversation-presence').evaluate(n=>({dot:getComputedStyle(n).backgroundColor,ring:getComputedStyle(n).borderTopColor}));
    check('offline status remains distinguishable on the dark sidebar',colors.dot!=='rgb(0, 0, 0)'&&colors.ring!=='rgb(255, 255, 255)');
    await page.screenshot({path:path.join(out,'night.png')});
    model.unavailable=true;await page.clock.fastForward(95000);await refresh();
    check('expired statuses disappear after request failures instead of pretending friends remain online',await page.locator('#conversation-list .conversation-presence').count()===0);
    model.unavailable=false;model.batchUnsupported=true;await page.clock.fastForward(6000);await refresh();
    check('older servers still display status through their authorized lightweight profiles',await status(1)==='离线'&&model.requests.some(r=>r.p.startsWith('/profiles/')));
    assert.deepEqual(errors,[]);check('the status sequence has no unhandled browser errors',true);
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:checks.length,checks,errors,batchRequests:batchReads().map(r=>r.body.conversation_ids.length)},null,2));console.log(JSON.stringify({passed:checks.length,out}));
  }finally{await page.close();await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
