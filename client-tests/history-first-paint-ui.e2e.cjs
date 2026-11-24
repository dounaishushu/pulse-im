// Exercise the shipping chat renderers with authorized history and stalled enrichment.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=process.argv[2]||path.join(root,'.local/artifacts/history-first-paint');fs.mkdirSync(output,{recursive:true});
const timeoutCheck=process.env.PULSE_HISTORY_TIMEOUT_CHECK==='1',baseline=process.env.PULSE_HISTORY_BASELINE==='1';
const uid='11111111-1111-4111-8111-111111111111',peer='22222222-2222-4222-8222-222222222222',cid='33333333-3333-4333-8333-333333333333',media='55555555-5555-4555-8555-555555555555';
const wire=n=>'44444444-4444-4444-8444-'+String(n).padStart(12,'0');
const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}fs.readFile(baseline&&file===path.join(root,'pc/web/app.js')?process.env.PULSE_HISTORY_PREIMAGE:file,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port,browser=await chromium.launch({headless:true,channel:process.env.PULSE_BROWSER_CHANNEL||undefined}),results=[];
  try{
    for(const platform of (timeoutCheck?['pc']:['pc','web']))for(const kind of ['direct','group']){
      const page=await browser.newPage({viewport:{width:1100,height:760}}),errors=[],unknown=[],checks=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
      let release,mediaCalls=0,replyCalls=0,historyCalls=0;const stalled=new Promise(r=>release=r);
      const items=Array.from({length:50},(_,i)=>({id:wire(i+16),conversation_id:cid,sender_id:peer,seq:String(i+16),version:'1',kind:'text',body:'授权消息 '+(i+16),content:{},request_id:'request-'+i,sender:{name:'成员'},created_at:'2026-11-16T00:00:00Z',updated_at:'2026-11-16T00:00:00Z'}));
      items[46]={...items[46],kind:'image',body:'',content:{media:{id:media,bytes:'100',mime:'image/png',filename:'photo.png',width:320,height:240}}};items[47]={...items[47],reply_to_id:wire(1)};
      const row=()=>({id:cid,kind,title:'首屏加载测试',peer_id:peer,peer_name:'好友',my_role:'owner',membership_version:'1',preference_version:'1',state:{clear_seq:'0',read_seq:'0',delivered_seq:'0',personal_seq:'0',version:'1'},visible_from_seq:'1',message_seq:'65',event_seq:'65',unread_count:'0',can_send:true,member_count:2,updated_at:'2026-11-16T00:00:00Z'});
      await page.addInitScript(({base,desktop})=>{window.PULSE_API_BASE=base;window.pulseDesktop={isDesktop:desktop,production:false,apiBaseUrl:base,windowKind:'account'};},{base:origin+'/api/v2',desktop:platform==='pc'});
      await page.route('**/go-realtime.js',route=>route.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async options=>({close(){}})};'}));
      await page.route('**/api/v2/**',async route=>{
        const request=route.request(),u=new URL(request.url()),p=u.pathname.replace('/api/v2','');let result={};
        if(p==='/conversations'||p==='/client/conversation-page')result={items:[row()],total:1,page:1,size:30};
        else if(p==='/client/conversation-updates')result={items:[row()],removed_ids:[],incremental:true};
        else if(p==='/conversations/'+cid||p==='/conversations/'+cid+'/open')result=row();
        else if(p==='/groups/'+cid)result={...row(),owner_id:uid,member_limit:500};
        else if(p.endsWith('/history')){historyCalls++;result={items:[...items].reverse(),membership_version:'1',snapshot_max_seq:'65',next_after_seq:'0',has_more:false,visible_from_seq:'1',clear_seq:'0'};}
        else if(p.endsWith('/reply-contexts')){replyCalls++;await stalled;result={items:[{message_id:wire(63),reply_seq:'1',message:null}]};}
        else if(p==='/media/grants'){mediaCalls++;await stalled;result={items:[{id:media,access:{content_path:'/api/v2/media-grants/'+'a'.repeat(64)+'/content',expires_in:120}}]};}
        else if(p.startsWith('/media-grants/')){await route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')});return;}
        else if(p.endsWith('/read')||p.endsWith('/delivered'))result={read_seq:'65',delivered_seq:'65',clear_seq:'0',version:'1'};
        else if(p.endsWith('/unread'))result={count:0,truncated:false};
        else if(p==='/profiles/'+peer)result={id:peer,account:'fixture-peer',nickname:'fixture-peer',avatar_id:'',version:'1'};
        else if(p==='/client/conversation-presence'||p==='/client/network-observation')result={items:[]};
        else if(p==='/me')result={id:uid,user_id:uid,account:'fixture',nickname:'自己'};
        else if(p==='/client/config')result={releases:{pc:{latest:'2.4.168',minimum:'1.0.0'}},registration:{},display:{show_group_count:true}};
        else if(p==='/auth/captcha')result={id:'fixture',image:'',expires_in:120};
        else if(/contacts|folders|pins|invitation|requests|blocks|tasks|announcements|routes|notifications|friend-page|member-profiles|receipts/.test(p))result={items:[]};
        else unknown.push(p);
        await route.fulfill({json:result});
      });
      await page.goto(origin+(platform==='pc'?'/pc/web/index.html':'/web/index.html'));await page.waitForFunction(()=>typeof renderShell==='function'&&!!window.PulseGoUI);
      await page.evaluate(async({uid,cid,timeoutCheck})=>{GO.session('fixture');state.token='fixture';state.user={id:GO.local('user',uid),nickname:'自己'};state.page='messages';renderShell();await loadConversations();window.__started=performance.now();window.__opening=openConversation(GO.local('conversation',cid),{focusInput:false});if(timeoutCheck){const controller=state.initialHistory.controller;setTimeout(()=>controller.abort(new DOMException('Synthetic read deadline','TimeoutError')),12000);}},{uid,cid,timeoutCheck});
      await page.waitForSelector('#messages [data-message-id="65"]');
      const firstPaintMs=await page.evaluate(()=>performance.now()-__started);
      if(baseline)assert.equal(await page.evaluate(()=>!!state.initialHistory),true);else await page.waitForFunction(()=>!state.initialHistory&&state.historyReadyEpoch===state.historyEpoch);assert.equal(await page.locator('.message-media-pending').count(),1);checks.push('authorized text paints while media and reply requests are stalled');
      await page.evaluate(()=>{window.__row=document.querySelector('[data-message-id="65"]');});await page.waitForTimeout(300);
      assert.equal(await page.evaluate(()=>__row.isConnected),true);assert.equal(await page.locator('#messages > .empty').count(),0);checks.push('slow enrichment keeps the visible page without a loading flash');
      if(timeoutCheck){
        await page.fill('#message-input','超时不影响继续输入');
        await page.waitForTimeout(12500);
        const stateReport=await page.evaluate(()=>({failed:state.initialHistoryFailed,pending:!!state.initialHistory,ready:state.historyReadyEpoch===state.historyEpoch,hidden:document.hidden,accountVisible:state.desktopAccountVisible,sourceFixed:fetchInitialHistory.toString().includes('onHistoryEnriched'),message:document.getElementById('messages').textContent.slice(0,160)}));fs.writeFileSync(path.join(output,kind+'-state.json'),JSON.stringify(stateReport,null,2));if(baseline)assert.ok(stateReport.pending||stateReport.failed,JSON.stringify(stateReport));else{assert.equal(stateReport.failed,false);assert.equal(stateReport.pending,false);assert.equal(stateReport.ready,true);}
        if(!baseline)assert.equal(await page.locator('[data-initial-history-error]').count(),0);
        if(!baseline)assert.equal(await page.locator('#messages').textContent().then(x=>x.includes('PC-MSG-LOAD-TIMEOUT')),false);
        assert.equal(await page.inputValue('#message-input'),'超时不影响继续输入');
        assert.equal(await page.locator('#messages [data-message-id="65"]').count(),1);
        checks.push(baseline?'original renderer remains loading or fails after readable history':'optional enrichment timeout does not fail readable history or erase the draft');
        release();await page.evaluate(()=>__opening);await page.waitForTimeout(100);
        assert.deepEqual(errors,[]);assert.deepEqual(unknown,[]);
        results.push({platform,kind,baseline,firstPaintMs,historyCalls,mediaCalls,replyCalls,checks});await page.close();continue;
      }
      await page.locator('#messages').dispatchEvent('wheel',{deltaY:-300});
      const before=await page.evaluate(()=>{const box=document.querySelector('#messages');box.scrollTop=box.scrollHeight/3;const top=box.getBoundingClientRect().top;const row=[...box.querySelectorAll('[data-message-id]')].find(row=>row.getBoundingClientRect().bottom>top);return {top:box.scrollTop,id:row.dataset.messageId,offset:row.getBoundingClientRect().top-top};});
      await page.screenshot({path:path.join(output,platform+'-'+kind+'-pending.png')});
      release();await page.evaluate(()=>window.__opening);await page.waitForSelector('.message-media-pending',{state:'detached'});await page.waitForTimeout(150);
      assert.equal(await page.evaluate(()=>__row===document.querySelector('[data-message-id="65"]')),true);checks.push('unchanged text nodes survive enrichment');
      const after=await page.locator('#messages').evaluate((box,id)=>({top:box.scrollTop,offset:box.querySelector('[data-message-id="'+id+'"]').getBoundingClientRect().top-box.getBoundingClientRect().top}),before.id);
      assert.ok(Math.abs(after.offset-before.offset)<4,JSON.stringify({platform,kind,before,after}));checks.push('a reader position survives delayed enrichment');
      assert.equal(await page.locator('#messages img.message-image').count(),1);assert.match(await page.locator('[data-message-id="63"]').textContent(),/原消息|不可用/);checks.push('image and unavailable quote hydrate in place');
      assert.equal(historyCalls,1);assert.equal(mediaCalls,1);assert.equal(replyCalls,1);checks.push('a clean first open reads history once');
      await page.evaluate(async cid=>{window.__currentRow=document.querySelector('[data-message-id="65"]');await openConversation(GO.local('conversation',cid),{focusInput:false});},cid);
      await page.waitForTimeout(220);
      assert.equal(historyCalls,1);assert.equal(await page.evaluate(()=>__currentRow.isConnected),true);checks.push('clicking the loaded conversation does not blank or reload it');
      await page.evaluate(async cid=>{
        window.__loadingFlashes=0;
        const observer=new MutationObserver(()=>{if(document.querySelector('#messages > .empty')?.textContent.includes('正在加载消息'))window.__loadingFlashes++;});
        observer.observe(document.querySelector('#messages'),{childList:true,subtree:true});window.__loadingObserver=observer;
        state.historyReadyEpoch=null;await openConversation(GO.local('conversation',cid),{focusInput:false});
      },cid);
      await page.waitForTimeout(220);assert.equal(await page.evaluate(()=>{__loadingObserver.disconnect();return __loadingFlashes;}),0);assert.equal(historyCalls,2);checks.push('a fast authorized reopen does not flash a loading label');
      assert.deepEqual(errors,[]);assert.deepEqual(unknown,[]);results.push({platform,kind,firstPaintMs,historyCalls,mediaCalls,replyCalls,checks});await page.close();
    }
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({cases:results.length,checks:results.reduce((n,r)=>n+r.checks.length,0),results},null,2));console.log(JSON.stringify(results));
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
