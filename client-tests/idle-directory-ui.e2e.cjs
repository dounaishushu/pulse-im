const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.argv[2]||'.local/artifacts/idle-directory');fs.mkdirSync(output,{recursive:true});
const uid='11111111-1111-4111-8111-111111111111',peer='22222222-2222-4222-8222-222222222222',cid='33333333-3333-4333-8333-333333333333';
const wire=n=>'44444444-4444-4444-8444-'+String(n).padStart(12,'0');
const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})}),results=[];
 try{for(const platform of ['pc','web']){
  const page=await browser.newPage({viewport:{width:1200,height:820}}),errors=[],checks=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  let seq=50,eventSeq=50,personalSeq=0,historyCalls=0,syncCalls=0,listCalls=0,failList=false,deleted=false;
  const events=[],personal=[];let probes=0,updates=0,extra=false;const extraID='77777777-7777-4777-8777-777777777777';
  const message=n=>({id:wire(n),conversation_id:cid,sender_id:peer,seq:String(n),event_seq:String(n),version:n===1&&eventSeq>=53?'2':'1',kind:'text',body:n===1&&eventSeq>=53?'修改后的正文':'消息 '+n,content:{},request_id:'message-'+n,sender:{name:'好友'},created_at:'2026-11-17T00:00:00Z',updated_at:'2026-11-17T00:00:00Z'});
  const row=()=>({id:cid,kind:'group',title:'同步恢复验收',my_role:'owner',membership_version:'1',preference_version:'1',event_seq:String(eventSeq),state:{clear_seq:'0',read_seq:'0',delivered_seq:'0',version:'1',personal_seq:String(personalSeq)},visible_from_seq:'1',message_seq:String(seq),unread_count:'0',can_send:true,member_count:2,last_message:message(seq),updated_at:'2026-11-17T00:00:00Z'});
  const allRows=()=>[row(),...(extra?[{...row(),id:extraID,title:'漏通知的新群',last_message:{...message(1),conversation_id:extraID}}]:[])].sort((a,b)=>a.id.localeCompare(b.id));
  await page.addInitScript(({base,desktop})=>{window.PULSE_API_BASE=base;window.pulseDesktop={isDesktop:desktop,production:false,apiBaseUrl:base,windowKind:'account'};const now=Date.now.bind(Date);window.__time=0;Date.now=()=>now()+window.__time;const interval=window.setInterval.bind(window);window.__ticks=[];window.setInterval=(fn,delay,...args)=>{if(delay===5000){window.__ticks.push(fn);return interval(()=>{},600000);}return interval(fn,delay,...args);};},{base:origin+'/api/v2',desktop:platform==='pc'});
  await page.route('**/go-realtime.js',route=>route.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async()=>({close(){}})};'}));
  await page.route('**/api/v2/**',async route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname.replace('/api/v2','');let value={};
   if(p==='/client/conversation-page'){listCalls++;if(failList){failList=false;await route.fulfill({status:503,json:{error:{code:'unavailable'}}});return;}value={items:allRows(),total:allRows().length,page:1,size:30};}
   else if(p==='/conversations'){probes++;value={items:allRows(),next_after:''};}
   else if(p==='/client/conversation-updates'){updates++;const ids=JSON.parse(req.postData()).conversation_ids;value={items:allRows().filter(row=>ids.includes(row.id)),removed_ids:ids.filter(id=>!allRows().some(row=>row.id===id)),incremental:true};}
   else if(p==='/conversations/'+cid||p==='/conversations/'+cid+'/open')value=row();
   else if(p==='/groups/'+cid)value={...row(),owner_id:uid,member_limit:500};
   else if(p.endsWith('/history')){historyCalls++;value={items:Array.from({length:seq},(_,i)=>message(i+1)).filter(r=>!deleted||r.seq!=='1').reverse(),membership_version:'1',snapshot_max_seq:String(seq),next_after_seq:'0',has_more:false,visible_from_seq:'1',clear_seq:'0'};}
   else if(p.endsWith('/personal-sync')){const after=Number(u.searchParams.get('after'));value={events:personal.filter(x=>Number(x.seq)>after),snapshot_max_seq:String(personalSeq),next_after_seq:String(personalSeq),has_more:false};}
   else if(p.endsWith('/sync')){syncCalls++;const after=Number(u.searchParams.get('after'));value={events:events.filter(x=>Number(x.seq)>after),membership_version:'1',visible_from_seq:'1',snapshot_max_seq:String(eventSeq),next_after_seq:String(eventSeq),has_more:false};}
   else if(p==='/me')value={id:uid,user_id:uid,account:'fixture',nickname:'自己'};
   else if(p==='/client/config')value={protocol:'pulse-v2',releases:{},registration:{},display:{show_group_count:true},routes:[]};
   else if(p==='/client/update')value={required:false};
   else if(p.endsWith('/unread'))value={count:0,truncated:false};
   else if(p.endsWith('/read')||p.endsWith('/delivered'))value={read_seq:String(seq),delivered_seq:String(seq),clear_seq:'0',version:'1'};
   else if(p==='/auth/captcha')value={id:'fixture',image:'',expires_in:120};
   else value={items:[]};
   await route.fulfill({json:value});
  });
  await page.goto(origin+(platform==='pc'?'/pc/web/index.html':'/web/index.html'));await page.waitForFunction(()=>!!window.PulseGoUI);
  await page.evaluate(async uid=>{GO.session('fixture');state.token='fixture';state.user={id:GO.local('user',uid),nickname:'自己'};state.page='messages';renderShell();await loadConversations();},uid);
  await page.evaluate(cid=>openConversation(GO.local('conversation',cid),{focusInput:false}),cid);await page.waitForFunction(()=>!state.initialHistory);
  assert.equal(historyCalls,1);
  await page.waitForTimeout(250); // Let the initial read acknowledgement update its summary.
  const baseline={lists:listCalls,updates,probes,syncs:syncCalls};
  for(let i=0;i<4;i++){await page.evaluate(()=>{__time+=16000;__ticks.forEach(fn=>fn());});await page.waitForTimeout(220);}
  const idle={seconds:64,fullLists:listCalls-baseline.lists,summaryBatches:updates-baseline.updates,probes:probes-baseline.probes,eventSyncs:syncCalls-baseline.syncs};
  assert.equal(idle.fullLists,0);assert.equal(idle.summaryBatches,0);assert.equal(idle.probes,4);assert.equal(idle.eventSyncs,4);
  checks.push('空闲64秒：4次轻量探测，0次全量列表，0次摘要重读');
  await page.fill('#message-input','保留草稿');await page.evaluate(()=>window.__old=document.querySelector('[data-message-id="50"]'));
  seq=51;eventSeq=51;events.push({seq:'51',kind:'message.created',message:message(51)});
  await page.evaluate(()=>{__time+=16000;__ticks.forEach(fn=>fn());});await page.waitForSelector('[data-message-id="51"]');await page.waitForTimeout(200);
  assert.equal(listCalls,baseline.lists);assert.ok(updates>baseline.updates);assert.equal(historyCalls,1);
  assert.equal(await page.evaluate(()=>__old===document.querySelector('[data-message-id="50"]')),true);
  assert.equal(await page.inputValue('#message-input'),'保留草稿');checks.push('漏通知仍补新消息，仅刷新变化摘要并保留旧节点、草稿');
  extra=true;await page.evaluate(()=>{__time+=16000;__ticks.forEach(fn=>fn());});
  await page.waitForFunction(id=>state.conversations.some(row=>row.id===GO.local('conversation',id)),extraID);
  assert.equal(listCalls,baseline.lists);checks.push('没有实时提示的新会话也能通过轻量探测出现');
  extra=false;await page.evaluate(()=>{__time+=16000;__ticks.forEach(fn=>fn());});
  await page.waitForFunction(id=>!state.conversations.some(row=>row.id===GO.local('conversation',id)),extraID);
  assert.equal(listCalls,baseline.lists);checks.push('没有实时提示的退群也会移除会话');
  const beforeHidden={probes,syncCalls,listCalls};
  await page.evaluate(()=>{state.desktopAccountVisible=false;__time+=16000;__ticks.forEach(fn=>fn());});await page.waitForTimeout(200);
  assert.deepEqual({probes,syncCalls,listCalls},beforeHidden);checks.push('后台账号不继续探测或刷新');
  await page.evaluate(()=>{state.desktopAccountVisible=true;__time+=301000;__ticks.forEach(fn=>fn());});await page.waitForTimeout(250);
  assert.equal(listCalls,baseline.lists+1);checks.push('五分钟全量核对仍保留，以补偿头像、分组和偏好变化');
  await page.screenshot({path:path.join(output,platform+'-recovered.png')});assert.deepEqual(errors,[]);results.push({platform,checks,idle,historyCalls,syncCalls,listCalls,probes,updates});await page.close();
 }}finally{await browser.close();server.close();}
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
