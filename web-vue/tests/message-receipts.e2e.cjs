// Real Vue message rendering, chat state, receipt events and Go-v2 adapter.
// Only isolated HTTP data and the realtime delivery are substituted.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),repo=path.dirname(root);
const output=process.env.PULSE_RECEIPT_TEST_OUTPUT||path.join(repo,'.local/message-receipts-ui');
const uuid=n=>String(n).padStart(8,'0')+'-eeee-4eee-8eee-eeeeeeeeeeee';
const self=uuid(1),peer=uuid(2),cid=n=>uuid(9000+n),mid=(c,n)=>uuid(c*10000+n);
const model={counts:new Map(),calls:[],reject:false,invalid:false,delay:0,large:false};
const checks=[],errors=[];
let server,browser,page;
const pass=name=>{checks.push(name);console.log('PASS '+name);};
async function waitFor(test){for(let n=0;n<300;n++){if(await test())return;await new Promise(r=>setTimeout(r,30));}throw Error('condition did not become true');}
const summary=n=>({id:cid(n),kind:n===1?'direct':n===3?'channel':n===4?'saved':'group',title:n===1?'私聊回执':'群聊回执',peer_id:n===1?peer:undefined,peer_name:'对方',my_role:'owner',can_send:true,visible_from_seq:'1',message_seq:'6',event_seq:'6',membership_version:'1',unread_count:'0',member_count:4,state:{clear_seq:'0',read_seq:'0',delivered_seq:'0',personal_seq:'0',version:'1'},updated_at:'2026-11-24T04:00:00Z'});
const message=(c,n,extra={})=>({id:mid(c,n),conversation_id:cid(c),seq:String(n),event_seq:String(n),sender_id:self,sender:{name:'我'},kind:'text',body:'测试消息 '+n,content:{},version:'1',created_at:'2026-11-24T04:00:00Z',updated_at:'2026-11-24T04:00:00Z',...extra});
const messages=c=>model.large?Array.from({length:50},(_,i)=>message(c,i+1)):[
  message(c,1,{body:'等待对方阅读'}),message(c,2,{body:'已经阅读的消息'}),
  message(c,3,{sender_id:peer,sender:{name:'对方'},body:'收到的消息不显示我的发送回执'}),
  message(c,4,{body:'',revoked:true}),message(c,5,{kind:'system',body:'系统提示'}),
  message(c,6,{kind:'image',body:'图片说明',content:{media:{id:uuid(50000),filename:'receipt.png',mime:'image/png',bytes:'68',width:1,height:1}}}),
];
(async()=>{
  fs.mkdirSync(output,{recursive:true});process.chdir(root);
  const {createServer}=await import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')).href);
  server=await createServer({root,configFile:path.join(root,'vite.config.ts'),logLevel:'error',cacheDir:path.join(output,'vite-cache'),server:{host:'127.0.0.1',port:0,strictPort:false,open:false},
    plugins:[{name:'receipt-fixture',configureServer(vite){vite.middlewares.use('/__receipt-test',(_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/message-receipts-fixture.ts"></script></html>');});}}]});
  await server.listen();const origin='http://127.0.0.1:'+server.httpServer.address().port;
  browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{channel:'chrome'})});
  page=await browser.newPage({viewport:{width:900,height:740}});page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/v2/**',async route=>{
    const request=route.request(),url=new URL(request.url()),p=url.pathname.replace('/api/v2',''),body=request.postDataJSON();
    model.calls.push({path:p,method:request.method(),body,time:Date.now()});
    const match=p.match(/^\/conversations\/([^/]+)(.*)$/);const c=match?Number(match[1].slice(0,8))-9000:0;let data={items:[]};
    if(p.startsWith('/media-grants/')){await route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSs4AAAAASUVORK5CYII=','base64')});return;}
    if(p==='/media/grants')data={items:body.media_ids.map(id=>({id,access:{content_path:'/api/v2/media-grants/'+'a'.repeat(64)+'/content',expires_in:120}}))};
    else if(p==='/me'||p==='/me/profile')data={id:self,user_id:self,account:'me',nickname:'我',version:'1',internal_staff:true};
    else if(p==='/client/conversation-page'||p==='/conversations')data={items:[1,2,3,4].map(summary),total:4,page:1,size:100};
    else if(p==='/client/friend-page')data={items:[],total:0,page:1,size:100};
    else if(p==='/client/config')data={registration:{},display:{},releases:{}};
    else if(p==='/client/update')data={required:false};
    else if(p==='/notifications')data={items:[],unread_count:0};
    else if(p.endsWith('/unread'))data={count:'0',truncated:false};
    else if(match&&(!match[2]||match[2]==='/open'))data=summary(c);
    else if(match&&match[2]==='/history')data={items:messages(c),membership_version:'1',snapshot_max_seq:model.large?'50':'6',next_after_seq:model.large?'50':'6',next_before_seq:'0',visible_from_seq:'1',clear_seq:'0',has_more:false};
    else if(match&&match[2]==='/sync')data={events:[],membership_version:'1',snapshot_max_seq:model.large?'50':'6',next_after_seq:model.large?'50':'6',visible_from_seq:'1',clear_seq:'0',has_more:false};
    else if(match&&match[2]==='/personal-sync')data={events:[],snapshot_max_seq:'0',next_after_seq:'0',has_more:false};
    else if(match&&match[2]==='/message-receipts'){
      assert.equal(request.method(),'POST');assert.ok(body.message_ids.length>0&&body.message_ids.length<=100);
      const source=new Map(messages(c).map(row=>[row.id,row]));
      for(const id of body.message_ids){const row=source.get(id);assert.ok(row&&row.sender_id===self&&!row.revoked&&row.kind!=='system','only visible outgoing messages may be queried');}
      const items=body.message_ids.map(id=>{const n=Number(id.slice(0,8))%10000,count=model.counts.get(c+':'+n)??(n===2?(c===1?1:2):0);return {message_id:id,recipient_count:c===1?1:4,delivered_count:c===1?1:4,read_count:model.invalid?-1:count};});
      const delay=model.delay,reject=model.reject;if(delay)await new Promise(r=>setTimeout(r,delay));
      await route.fulfill(reject?{status:503,json:{error:{code:'busy'}}}:{json:{items}}).catch(()=>{});return;
    } else if(/\/(read|delivered)$/.test(p))data={version:'1',reminder:false};
    await route.fulfill({json:data}).catch(()=>{});
  });
  const badge=n=>page.locator(`[data-message-id="${n}"] .vue-message-receipt`);
  const calls=c=>model.calls.filter(row=>row.path==='/conversations/'+cid(c)+'/message-receipts');
  const open=async c=>{await page.evaluate(async id=>{const f=window.receiptFixture;await f.chat.choose(f.client.local('conversation',id));},cid(c));await page.locator('[data-message-id="1"]').waitFor();};
  const frame=async c=>page.evaluate(id=>window.receiptFixture.receive({type:'receipts.changed',conversation_id:id}),cid(c));
  try{
    await page.goto(origin+'/__receipt-test');await badge(1).waitFor();
    await waitFor(async()=>await badge(1).textContent()==='未读'&&await badge(2).textContent()==='已读');
    assert.equal(await badge(6).textContent(),'未读');
    for(const id of [3,4,5])assert.equal(await badge(id).count(),0);
    assert.equal(calls(1).length,1);assert.deepEqual(calls(1)[0].body.message_ids,[mid(1,1),mid(1,2),mid(1,6)]);
    await page.screenshot({path:path.join(output,'direct-read-unread.png')});
    pass('outgoing private text and image messages show real read/unread beside the time in one batch; incoming, revoked and system messages have no indicator');
    model.counts.set('1:1',1);const historyBefore=model.calls.filter(row=>row.path.endsWith('/history')||row.path.endsWith('/sync')).length;
    await frame(1);await waitFor(async()=>await badge(1).textContent()==='已读');
    assert.deepEqual(calls(1).at(-1).body.message_ids,[mid(1,1),mid(1,6)]);
    assert.equal(model.calls.filter(row=>row.path.endsWith('/history')||row.path.endsWith('/sync')).length,historyBefore);
    pass('a peer-read realtime hint changes unread to read without refetching message history or requerying final private reads');
    await open(2);await waitFor(async()=>await badge(1).textContent()==='0人已读'&&await badge(2).textContent()==='2人已读');
    model.counts.set('2:1',3);const groupBefore=calls(2).length;
    await page.evaluate(id=>{for(let n=0;n<5;n++)window.receiptFixture.receive({type:'receipts.changed',conversation_id:id});},cid(2));
    await waitFor(async()=>await badge(1).textContent()==='3人已读');assert.equal(calls(2).length,groupBefore+1);
    await page.screenshot({path:path.join(output,'group-read-counts.png')});
    pass('group messages show the read count, update on realtime hints and coalesce bursts into one visible-page batch');
    model.counts.set('2:1',4);model.delay=240;const sustained=calls(2).length;
    const duringHints=await page.evaluate(async id=>{let visible='';for(let n=0;n<30;n++){window.receiptFixture.receive({type:'receipts.changed',conversation_id:id});await new Promise(r=>setTimeout(r,60));if(n===26)visible=document.querySelector('[data-message-id="1"] .vue-message-receipt').textContent;}return visible;},cid(2));
    model.delay=0;assert.equal(duringHints,'4人已读','slow responses must still update the display while new hints keep arriving');
    await waitFor(async()=>await badge(1).textContent()==='4人已读');
    const steady=calls(2).slice(sustained);assert.ok(steady.length>=1&&steady.length<=2);
    for(let n=1;n<steady.length;n++)assert.ok(steady[n].time-steady[n-1].time>=900);
    model.counts.set('2:1',3);await frame(2);await waitFor(async()=>await badge(1).textContent()==='3人已读');
    pass('continuous group hints refresh current counts while limiting requests to at most one visible batch per second');
    const activeBefore=calls(2).length;await frame(1);await new Promise(r=>setTimeout(r,250));assert.equal(calls(2).length,activeBefore);
    pass('receipt hints for another conversation do not trigger a request for the active chat');
    await open(3);await new Promise(r=>setTimeout(r,250));assert.equal(await page.locator('.vue-message-receipt').count(),0);assert.equal(calls(3).length,0);
    await open(4);await new Promise(r=>setTimeout(r,250));assert.equal(await page.locator('.vue-message-receipt').count(),0);assert.equal(calls(4).length,0);
    pass('channels and saved messages do not fabricate recipient read indicators or query unsupported receipt endpoints');
    model.delay=450;await open(2);const delayed=calls(2).length;await waitFor(()=>calls(2).length>delayed);
    model.delay=0;await open(1);await waitFor(async()=>await badge(1).textContent()==='已读');await new Promise(r=>setTimeout(r,500));
    assert.equal(await badge(1).textContent(),'已读');assert.doesNotMatch(await badge(2).textContent(),/人/);
    pass('delayed group responses cannot overwrite the new private conversation after switching chats');
    model.reject=true;await open(2);await waitFor(async()=>await badge(1).textContent()==='待确认');
    assert.notEqual(await badge(1).textContent(),'0人已读');
    model.reject=false;await frame(2);await waitFor(async()=>await badge(1).textContent()==='3人已读');
    pass('a failed read-status request stays unconfirmed instead of being treated as unread, and a later hint retries successfully');
    await open(1);model.invalid=true;await open(2);await waitFor(async()=>await badge(1).textContent()==='待确认');
    model.invalid=false;await frame(2);await waitFor(async()=>await badge(1).textContent()==='3人已读');
    pass('invalid receipt counts are rejected before any indicator is updated');
    await page.evaluate(()=>window.receiptFixture.foreground.value=false);const background=calls(2).length;
    model.counts.set('2:1',4);await frame(2);await new Promise(r=>setTimeout(r,250));assert.equal(calls(2).length,background);
    await page.evaluate(()=>window.receiptFixture.foreground.value=true);await waitFor(async()=>await badge(1).textContent()==='4人已读');
    await page.evaluate(()=>window.receiptFixture.locked.value=true);await new Promise(r=>setTimeout(r,100));assert.equal(await page.locator('.vue-message-receipt').count(),0);
    const locked=calls(2).length;await frame(2);await new Promise(r=>setTimeout(r,250));assert.equal(calls(2).length,locked);
    await page.evaluate(()=>window.receiptFixture.locked.value=false);await waitFor(async()=>await badge(1).textContent()==='4人已读');
    pass('background and locked views stop receipt requests; returning or unlocking refreshes current status without exposing locked indicators');
    model.large=true;await open(1);await open(2);await waitFor(()=>calls(2).at(-1).body.message_ids.some(id=>id===mid(2,50)));
    const visibleBatch=calls(2).at(-1).body.message_ids;assert.ok(visibleBatch.length<25&&visibleBatch.length>0);
    const beforeScroll=calls(2).length;
    await page.locator('.vue-messages').evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event('scroll'));});
    await waitFor(()=>calls(2).length>beforeScroll);assert.ok(calls(2).at(-1).body.message_ids.includes(mid(2,1)));
    assert.ok(calls(2).every(row=>row.body.message_ids.length<=100));
    pass('long histories query only visible outgoing messages in bounded batches and fetch newly visible status after scrolling');
    await page.setViewportSize({width:900,height:6000});await frame(2);
    await waitFor(()=>calls(2).at(-1).body.message_ids.length===50);
    await new Promise(r=>setTimeout(r,100));
    // Evict the transport's 500-message cache while the visible rows remain.
    await page.evaluate(({conversation,self})=>{
      const client=window.receiptFixture.client;
      for(let n=1001;n<=1600;n++)client.message({id:String(n+50000).padStart(8,'0')+'-eeee-4eee-8eee-eeeeeeeeeeee',conversation_id:conversation,
        sender_id:self,seq:String(n),event_seq:String(n),version:'1',kind:'text',body:'cache eviction',content:{},created_at:'2026-11-24T04:00:00Z'});
    },{conversation:cid(2),self});
    const coldStart=model.calls.length,coldReceipt=calls(2).length;
    await frame(2);await waitFor(()=>calls(2).length>coldReceipt);await new Promise(r=>setTimeout(r,100));
    const coldCalls=model.calls.slice(coldStart);
    assert.equal(coldCalls.filter(row=>row.path.endsWith('/history')).length,0,'receipt rendering must not refetch evicted message bodies');
    assert.equal(calls(2).length,coldReceipt+1);
    assert.equal(calls(2).at(-1).body.message_ids.length,50);
    pass('50 evicted transport messages use one receipt batch and zero per-message history requests');
    await page.setViewportSize({width:390,height:600});await page.locator('.vue-messages').evaluate(node=>{node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event('scroll'));});
    await page.screenshot({path:path.join(output,'narrow-read-status.png')});
    const widths=await page.locator('.vue-message-meta').evaluateAll(nodes=>nodes.map(node=>({right:node.getBoundingClientRect().right,width:node.getBoundingClientRect().width})));
    assert.ok(widths.every(row=>row.right<=390&&row.width<=390));
    pass('read indicators remain inside the message layout in a narrow window');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,calls:model.calls},null,2));console.log(JSON.stringify({passed:checks.length,output}));
  }catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error.stack,errors,calls:model.calls},null,2));throw error;}
  finally{await browser?.close();await server?.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
