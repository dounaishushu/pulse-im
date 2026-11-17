const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.argv[2]||'.local/artifacts/realtime-recovery');fs.mkdirSync(output,{recursive:true});
const uid='11111111-1111-4111-8111-111111111111',peer='22222222-2222-4222-8222-222222222222',cid='33333333-3333-4333-8333-333333333333';
const wire=n=>'44444444-4444-4444-8444-'+String(n).padStart(12,'0');
const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})}),results=[];
 try{for(const platform of ['pc','web']){
  const page=await browser.newPage({viewport:{width:1200,height:820}}),errors=[],checks=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  let seq=50,eventSeq=50,personalSeq=0,historyCalls=0,syncCalls=0,listCalls=0,failList=false,deleted=false;
  const events=[],personal=[];
  const message=n=>({id:wire(n),conversation_id:cid,sender_id:peer,seq:String(n),event_seq:String(n),version:n===1&&eventSeq>=53?'2':'1',kind:'text',body:n===1&&eventSeq>=53?'修改后的正文':'消息 '+n,content:{},request_id:'message-'+n,sender:{name:'好友'},created_at:'2026-11-17T00:00:00Z',updated_at:'2026-11-17T00:00:00Z'});
  const row=()=>({id:cid,kind:'group',title:'同步恢复验收',my_role:'owner',membership_version:'1',preference_version:'1',event_seq:String(eventSeq),state:{clear_seq:'0',read_seq:'0',delivered_seq:'0',version:'1',personal_seq:String(personalSeq)},visible_from_seq:'1',message_seq:String(seq),unread_count:'0',can_send:true,member_count:2,last_message:message(seq),updated_at:'2026-11-17T00:00:00Z'});
  await page.addInitScript(({base,desktop})=>{window.PULSE_API_BASE=base;window.pulseDesktop={isDesktop:desktop,production:false,apiBaseUrl:base,windowKind:'account'};const now=Date.now.bind(Date);window.__time=0;Date.now=()=>now()+window.__time;const interval=window.setInterval.bind(window);window.__ticks=[];window.setInterval=(fn,delay,...args)=>{if(delay===5000){window.__ticks.push(fn);return interval(()=>{},600000);}return interval(fn,delay,...args);};},{base:origin+'/api/v2',desktop:platform==='pc'});
  await page.route('**/go-realtime.js',route=>route.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async()=>({close(){}})};'}));
  await page.route('**/api/v2/**',async route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname.replace('/api/v2','');let value={};
   if(p==='/client/conversation-page'){listCalls++;if(failList){failList=false;await route.fulfill({status:503,json:{error:{code:'unavailable'}}});return;}value={items:[row()],total:1,page:1,size:30};}
   else if(p==='/client/conversation-updates')value={items:[row()],removed_ids:[],incremental:true};
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
  assert.equal(historyCalls,1);assert.equal(await page.evaluate(()=>state.goEventCursor.events),50);checks.push('首屏建立事件游标');
  await page.fill('#message-input','草稿保持可编辑');await page.evaluate(()=>window.__old=document.querySelector('[data-message-id="50"]'));
  seq=51;eventSeq=51;events.push({seq:'51',kind:'message.created',message:message(51)});
  await page.evaluate(()=>{__time+=16000;__ticks.forEach(fn=>fn());});await page.waitForSelector('[data-message-id="51"]');
  assert.equal(historyCalls,1);assert.equal(await page.evaluate(()=>__old===document.querySelector('[data-message-id="50"]')),true);checks.push('没有实时通知也能自动补齐新消息，保留旧节点');
  const before=historyCalls;await page.evaluate(()=>{__time+=16000;__ticks.forEach(fn=>fn());});await page.waitForTimeout(350);assert.equal(historyCalls,before);checks.push('空增量不重读历史');
  seq=52;eventSeq=52;events.push({seq:'52',kind:'message.created',message:message(52)});failList=true;
  await page.evaluate(()=>{__time+=16000;__ticks.forEach(fn=>fn());});await page.waitForSelector('[data-message-id="52"]');assert.equal(historyCalls,1);checks.push('一次503后自动重试，无需点击或重新进入');
  assert.equal(await page.inputValue('#message-input'),'草稿保持可编辑');await page.fill('#message-input','恢复后可以继续输入');checks.push('恢复期间输入和草稿保持可用');
  eventSeq=53;events.push({seq:'53',kind:'message.edited',message:message(1)});await page.evaluate(()=>{__time+=16000;__ticks.forEach(fn=>fn());});await page.waitForFunction(()=>document.querySelector('[data-message-id="1"]')?.textContent.includes('修改后的正文'));assert.equal(historyCalls,2);checks.push('编辑事件回退完整窗口并刷新旧正文');
  deleted=true;personalSeq=1;personal.push({seq:'1',kind:'message.deleted',message_id:wire(1)});await page.evaluate(()=>{__time+=16000;__ticks.forEach(fn=>fn());});await page.waitForSelector('[data-message-id="1"]',{state:'detached'});assert.equal(historyCalls,3);checks.push('个人删除回退授权窗口，不保留旧消息');
  await page.screenshot({path:path.join(output,platform+'-recovered.png')});assert.deepEqual(errors,[]);results.push({platform,checks,historyCalls,syncCalls,listCalls});await page.close();
 }}finally{await browser.close();server.close();}
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
