// Exercise foreground recovery on the shipping PC page with stalled enrichment.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.argv[2]||path.join(root,'.local/artifacts/pc-foreground-ui'));
fs.mkdirSync(output,{recursive:true});
const uid='11111111-1111-4111-8111-111111111111',peer='22222222-2222-4222-8222-222222222222';
const cid='33333333-3333-4333-8333-333333333333',other='66666666-6666-4666-8666-666666666666',media='55555555-5555-4555-8555-555555555555';
const wire=n=>'44444444-4444-4444-8444-'+String(n).padStart(12,'0');
const server=http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})}),results=[];
  try{for(const kind of ['direct','group']){
    const page=await browser.newPage({viewport:{width:1200,height:820}}),errors=[],unknown=[],checks=[];
    page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
    let holdMedia=true,holdList=false,holdHistory=false,denied=false,historyCalls=0,listCalls=0;
    const releases=new Set();
    const hold=()=>new Promise(resolve=>releases.add(resolve));
    const release=()=>{for(const resolve of releases)resolve();releases.clear();};
    const row=id=>({id,kind,title:id===cid?'前台恢复测试':'第二个会话',peer:{id:peer,name:'好友'},my_role:'owner',membership_version:'1',preference_version:'1',
      state:{clear_seq:'0',read_seq:'0',delivered_seq:'0',version:'1'},visible_from_seq:'1',message_seq:id===cid?'50':'1',unread_count:'0',can_send:true,member_count:2,updated_at:'2026-11-17T00:00:00Z'});
    const messages=Array.from({length:50},(_,i)=>({id:wire(i+1),conversation_id:cid,sender_id:peer,seq:String(i+1),version:'1',kind:'text',body:'已有授权消息 '+(i+1),content:{},sender:{name:'好友'},created_at:'2026-11-17T00:00:00Z',updated_at:'2026-11-17T00:00:00Z'}));
    messages[0]={...messages[0],kind:'image',body:'',content:{media:{id:media,bytes:'100',mime:'image/png',filename:'photo.png',width:320,height:240}}};
    await page.addInitScript(base=>{
      window.__hidden=false;
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__hidden});
      window.pulseDesktop={isDesktop:true,production:false,apiBaseUrl:base,windowKind:'account',onAccountVisibilityChanged:fn=>window.__accountVisibility=fn};
    },origin+'/api/v2');
    await page.route('**/go-realtime.js',route=>route.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async options=>({close(){}})};'}));
    if(process.env.PULSE_TEST_BASELINE==='1')await page.route('**/app.js?*',async route=>{
      let text=fs.readFileSync(path.join(root,'pc/web/app.js'),'utf8');
      text=text.replace(/  if \(state\.initialHistory\) \{\r?\n    \/\/ The authorized first page[\s\S]*?\r?\n  \}/,"  if (state.initialHistory) state.initialHistoryFailed = true;");
      await route.fulfill({contentType:'text/javascript',body:text});
    });
    await page.route('**/api/v2/**',async route=>{
      const request=route.request(),url=new URL(request.url()),p=url.pathname.replace('/api/v2',''),body=request.postDataJSON();let result={};
      if(denied&&p.startsWith('/conversations/'+cid)){await route.fulfill({status:403,json:{error:{code:'forbidden'}}}).catch(()=>{});return;}
      if(p==='/conversations'||p==='/client/conversation-page'){listCalls++;if(holdList)await hold();result={items:[row(cid),row(other)],total:2,page:1,size:30};}
      else if(p==='/client/conversation-updates')result={incremental:true,items:body.conversation_ids.map(row),removed_ids:[]};
      else if(p==='/conversations/'+cid||p==='/conversations/'+cid+'/open')result=row(cid);
      else if(p==='/conversations/'+other||p==='/conversations/'+other+'/open')result=row(other);
      else if(p.startsWith('/groups/')&&!p.endsWith('/member-profiles'))result={...row(p.split('/')[2]),owner_id:uid,member_limit:500};
      else if(p.endsWith('/history')){
        historyCalls++;if(holdHistory)await hold();
        const items=p.includes(other)?[{...messages[1],conversation_id:other,seq:'1',body:'第二会话立即可见'}]:[...messages].reverse();
        result={items,membership_version:'1',snapshot_max_seq:p.includes(other)?'1':'50',next_after_seq:'0',has_more:false,visible_from_seq:'1',clear_seq:'0'};
      }else if(p==='/media/grants'){if(holdMedia)await hold();result={items:[{id:media,access:{content_path:'/api/v2/media-grants/'+'a'.repeat(64)+'/content',expires_in:120}}]};}
      else if(p.startsWith('/media-grants/')){await route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZV8AAAAASUVORK5CYII=','base64')}).catch(()=>{});return;}
      else if(p.endsWith('/read')||p.endsWith('/delivered'))result={user_id:uid,read_seq:body?.seq||'0',delivered_seq:body?.seq||'0',clear_seq:'0',version:'1'};
      else if(p.endsWith('/unread'))result={count:0,truncated:false};
      else if(p==='/client/config')result={releases:{pc:{latest:'2.4.180',minimum:'1.0.0'}},registration:{},display:{show_group_count:true}};
      else if(p==='/auth/captcha')result={id:'fixture',image:'',expires_in:120};
      else if(/contacts|folders|pins|invitation|requests|blocks|tasks|announcements|routes|notifications|friend-page|friend-chats|member-profiles|receipts/.test(p))result={items:[]};
      else unknown.push(p);
      await route.fulfill({json:result}).catch(()=>{});
    });
    try{
      await page.goto(origin+'/pc/web/index.html');await page.waitForFunction(()=>typeof renderShell==='function'&&window.PulseGoUI);
      await page.evaluate(async uid=>{GO.session('fixture');state.token='fixture';state.user={id:GO.local('user',uid),nickname:'自己'};state.page='messages';renderShell();await loadConversations();},uid);
      await page.evaluate(cid=>{window.__opening=openConversation(GO.local('conversation',cid),{focusInput:false});},cid);
      await page.waitForSelector('#messages [data-message-id="50"]');
      assert.equal(await page.evaluate(()=>state.initialHistory?.previewed),true);checks.push('authorized text is interactive before stalled image enrichment');
      await page.fill('#message-input','保留我的草稿');await page.locator('#messages').dispatchEvent('wheel',{deltaY:-400});
      await page.evaluate(()=>{const box=document.getElementById('messages');box.scrollTop=box.scrollHeight/3;window.__row=box.querySelector('[data-message-id="25"]');window.__top=box.scrollTop;window.__epoch=state.historyEpoch;});
      await page.evaluate(()=>{window.__hidden=true;document.dispatchEvent(new Event('visibilitychange'));});
      assert.equal(await page.evaluate(()=>state.initialHistory),null);
      assert.equal(await page.evaluate(()=>state.initialHistoryFailed),false);checks.push('backgrounding cancels enrichment without declaring visible history failed');
      holdList=true;
      await page.evaluate(()=>{window.__hidden=false;document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));});
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(()=>__row.isConnected),true);
      assert.equal(await page.evaluate(()=>state.historyEpoch===__epoch),true);
      assert.equal(await page.locator('#messages > .empty').count(),0);checks.push('foreground recovery keeps existing rows and does not reopen or blank the chat');
      assert.equal(await page.inputValue('#message-input'),'保留我的草稿');
      assert.ok(await page.evaluate(()=>Math.abs(document.getElementById('messages').scrollTop-__top)<4));checks.push('draft and history reading position survive the return');
      const calls=historyCalls;
      await page.evaluate(()=>{for(let i=0;i<5;i++)window.dispatchEvent(new Event('focus'));});
      await page.locator('.conversation[data-id="'+await page.evaluate(id=>GO.local('conversation',id),other)+'"]').click();
      await page.waitForFunction(id=>Number(state.active?.id)===GO.local('conversation',id),other);
      await page.waitForFunction(()=>document.getElementById('messages').textContent.includes('第二会话立即可见'));
      await page.fill('#message-input','返回后可输入');checks.push('one click switches chats and accepts input while foreground list refresh is stalled');
      assert.ok(historyCalls<=calls+1);checks.push('repeated focus does not multiply history reloads');
      holdMedia=false;holdList=false;release();await page.waitForTimeout(250);
      assert.equal(await page.evaluate(id=>Number(state.active?.id)===GO.local('conversation',id),other),true);
      assert.equal(await page.inputValue('#message-input'),'返回后可输入');checks.push('late previous responses cannot override the selected chat or its draft');
      await page.screenshot({path:path.join(output,kind+'-returned.png')});
      holdHistory=true;
      await page.evaluate(cid=>{window.__cold=openConversation(GO.local('conversation',cid),{focusInput:false});},cid);
      await page.waitForFunction(()=>!!state.initialHistory&&!state.initialHistory.previewed);
      await page.evaluate(()=>{window.__hidden=true;document.dispatchEvent(new Event('visibilitychange'));});
      assert.equal(await page.evaluate(()=>state.initialHistoryFailed),true);checks.push('a request with no authorized first page still requires a fresh load');
      const before=historyCalls;
      await page.evaluate(()=>{window.__hidden=false;window.dispatchEvent(new Event('focus'));});
      await page.waitForFunction(()=>!!state.initialHistory);
      holdHistory=false;release();await page.waitForSelector('#messages [data-message-id="50"]');
      assert.ok(historyCalls>before);checks.push('returning retries a cold interrupted request');
      await page.waitForFunction(()=>!state.initialHistory);
      await page.evaluate(()=>__accountVisibility({active:false}));
      await page.evaluate(()=>__accountVisibility({active:true}));
      await page.waitForTimeout(200);assert.equal(await page.locator('#messages [data-message-id="50"]').count(),1);checks.push('retained account switching also keeps the recovered page usable');
      denied=true;await page.evaluate(()=>PulseGoUI.refresh());
      await page.waitForFunction(()=>!document.querySelector('#messages [data-message-id]'));
      checks.push('an authoritative access denial still clears retained messages');
      assert.deepEqual(errors,[]);assert.deepEqual(unknown,[]);results.push({kind,checks,historyCalls,listCalls});
    }finally{holdMedia=false;holdList=false;holdHistory=false;release();await page.close();}
  }
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks:results.reduce((n,r)=>n+r.checks.length,0),results},null,2));console.log(JSON.stringify(results));
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
