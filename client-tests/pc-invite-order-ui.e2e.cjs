// Shipping PC invitation dialog + Go adapter; no live accounts or invitations.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.local/invite-recent-order-20261119/ui'),baseline=process.argv.includes('--baseline');
const uuid=n=>String(n).padStart(8,'0')+'-eeee-4eee-8eee-eeeeeeeeeeee',uid=uuid(1),gid=uuid(9000),chat=n=>uuid(10000+n);
fs.mkdirSync(out,{recursive:true});
const model={times:new Map([[2,'2026-11-19T00:00:02.000000010Z'],[3,'2026-11-19T00:00:02.000000090Z'],[100,'2026-11-19T12:00:00Z'],[110,'2026-11-19T08:00:00+08:00'],[120,'invalid'],[600,'2026-11-19T10:00:00Z'],[650,'2026-11-19T11:00:00Z']]),omitActivity:false,requests:[]};
const candidates=[2,3,...Array.from({length:551},(_,i)=>100+i)].map(n=>({id:uuid(n),account:'peer'+n,nickname:n<4?'同名用户':'用户'+n,remark:n===2?'备注二':n===3?'备注三':''}));
const server=http.createServer((req,res)=>{
  const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+relative);
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  const source=baseline&&relative==='/pc/web/group-create.js'?path.join(root,'.local/invite-recent-order-20261119/baseline',relative.slice(1)):file;
  fs.readFile(source,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1180,height:840}}),checks=[],errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  const row=(n=0)=>({id:n?chat(n):gid,kind:n?'direct':'group',title:n?'':'排序测试群',peer_id:n?uuid(n):undefined,peer_name:n?'用户'+n:undefined,my_role:'owner',can_send:true,pinned:n===100,preference_version:'1',membership_version:'1',visible_from_seq:'1',message_seq:'0',event_seq:'0',unread_count:'0',member_count:n?2:9,updated_at:n===2?'2026-11-19T18:00:00Z':'2026-11-19T09:00:00Z',state:{clear_seq:'0',read_seq:'0',delivered_seq:'0',personal_seq:'0',version:'1'}});
  const rows=()=>[row(),...Array.from([2,3,4,100],row)];
  await page.addInitScript(({base})=>{window.pulseDesktop={isDesktop:true,production:false,apiBaseUrl:base,windowKind:'account'};localStorage.setItem('pulse_go_v2:'+encodeURIComponent(base)+':token','fixture');},{base:origin+'/api/v2'});
  await page.route('**/go-realtime.js',r=>r.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async()=>({close(){}})};'}));
  await page.route('**/api/v2/**',async route=>{
    const req=route.request(),u=new URL(req.url()),p=u.pathname.replace('/api/v2','');model.requests.push(p);let data={items:[]};
    if(p==='/me'||p==='/me/profile')data={id:uid,account:'fixture',nickname:'群主',version:'1'};
    else if(p==='/client/update')data={required:false};
    else if(p==='/client/config')data={registration:{},display:{},releases:{}};
    else if(p==='/client/friend-page')data={items:[],total:0,page:1,size:50};
    else if(p==='/client/conversation-page'||p==='/conversations')data={items:rows(),total:5,page:1,size:30};
    else if(p==='/client/conversation-updates')data={items:rows(),removed_ids:[],incremental:true};
    else if(p==='/groups/'+gid)data={...row(),my_role:'owner',owner_id:uid,member_limit:1000,block_member_friend_requests:false};
    else if(p==='/groups/'+gid+'/invite-candidates'){
      const all=candidates.filter(x=>x.id>(u.searchParams.get('after')||'')),limit=Number(u.searchParams.get('limit')||100),items=all.slice(0,limit).map(p=>({...p,...(model.omitActivity?{}:{last_activity:model.times.get(Number(p.account.slice(4)))||''})}));
      data={items,next_after:all.length>limit?items.at(-1).id:''};
    }else if(p.startsWith('/conversations/')){
      if(p.endsWith('/history'))data={items:[],membership_version:'1',snapshot_max_seq:'0',next_after_seq:'0',next_before_seq:'0',visible_from_seq:'1',clear_seq:'0',has_more:false};
      else if(p.endsWith('/personal-sync'))data={events:[],snapshot_max_seq:'0',next_after_seq:'0',has_more:false};
      else if(p.endsWith('/sync'))data={events:[],membership_version:'1',snapshot_max_seq:'0',next_after_seq:'0',visible_from_seq:'1',has_more:false};
      else data=row();
    }
    try{await route.fulfill({json:data});}catch(e){if(!/Target.*closed|disposed/.test(e.message)&&!page.isClosed())throw e;}
  });
  const check=(name,value)=>{checks.push({name,passed:value});assert.equal(value,true,name);};
  const ids=kind=>page.locator(`[data-group-list="${kind}"] [data-group-user]`).evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.groupUser)));
  const local=n=>page.evaluate(id=>GO.local('user',id),uuid(n));
  const open=async()=>{await page.evaluate(id=>groupCreator.openInvite(state.conversations.find(r=>r.id===GO.local('conversation',id))),gid);await page.waitForFunction(()=>document.querySelector('[data-group-all="recent"]')?.disabled===false);};
  const close=()=>page.evaluate(()=>groupCreator.close(false));
  try{
    await page.goto(origin+'/pc/web/index.html');await page.waitForFunction(()=>state.conversations.length===5&&!state.conversationListLoad);
    const before=model.requests.length;await open();
    const newest=await local(650),next=await local(600),two=await local(2),three=await local(3),pin=await local(100),offset=await local(110),none=await local(101),invalid=await local(120),initial=await ids('recent');
    if(baseline){fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({reproduced:initial[0]!==newest,initialFirst:initial[0],expectedFirst:newest},null,2));assert.notEqual(initial[0],newest);return;}
    check('a newest conversation from beyond five hundred candidates sorts first even when absent from the loaded sidebar',initial[0]===newest&&initial[1]===next);
    check('precise same-second message timestamps override user ID and stale conversation metadata order',initial.indexOf(three)<initial.indexOf(two)&&initial.indexOf(two)<initial.indexOf(offset));
    check('contacts without message history and invalid activity timestamps follow real conversations',initial.indexOf(none)>initial.indexOf(offset)&&initial.indexOf(invalid)>initial.indexOf(offset));
    check('the pinned column retains its own classification despite the newest pinned timestamp',(await ids('pinned')).length===1&&(await ids('pinned'))[0]===pin&&!initial.includes(pin));
    check('sorting only rearranges server-approved candidates without duplicating or adding local-only users',initial.length===552&&new Set([...initial,pin]).size===553&&!initial.includes(await local(4)));
    check('sorting adds no conversation history, contact directory or all-conversation requests',!model.requests.slice(before).some(p=>/history|friend-page|conversation-page|member-profiles/.test(p)));
    await page.fill('[data-group-search="recent"]','同名');check('fuzzy search preserves recent-first order across same-named users',JSON.stringify(await ids('recent'))===JSON.stringify([three,two]));
    await page.check(`[data-group-list="recent"] [data-group-user="${three}"]`);await page.fill('[data-group-search="recent"]','');
    check('clearing search retains the global order and selected user identity',(await ids('recent'))[0]===newest&&await page.locator(`[data-group-list="recent"] [data-group-user="${three}"]`).isChecked());
    const stable=JSON.stringify(await ids('recent'));await page.fill('[data-group-search="recent"]','用户');await page.fill('[data-group-search="recent"]','');
    check('repeated searches do not shuffle equal-time contacts',JSON.stringify(await ids('recent'))===stable);
    await page.screenshot({path:path.join(out,'recent-order.png')});await close();model.times.set(2,'2026-11-19T13:00:00Z');await open();
    check('reopening after a new message picks up the fresh message activity',(await ids('recent'))[0]===two);await close();
    model.omitActivity=true;await open();check('older servers fall back to the current account conversation timestamps',(await ids('recent'))[0]===two);await close();
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:checks.length,checks,errors},null,2));console.log(JSON.stringify({passed:checks.length,out}));
  }finally{await page.close();await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
