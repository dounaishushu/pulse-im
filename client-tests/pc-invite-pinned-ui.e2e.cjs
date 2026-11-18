// Real PC page, pin preference save, Go adapter and invitation dialog; isolated HTTP fixtures only.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.local/pc-invite-pinned-20261118/ui'),baseline=process.argv.includes('--baseline');
const uuid=n=>String(n).padStart(8,'0')+'-7777-4777-8777-777777777777',uid=uuid(1),gid=uuid(9000),chat=n=>uuid(10000+n);
fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1180,height:840}}),errors=[],checks=[];page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  const model={role:'owner',user:uid,pins:new Set([4,5,650]),preference:1,requests:[],writes:[],deny:false,holdNext:false,gate:null};
  const candidates=[2,3,...Array.from({length:551},(_,i)=>100+i)].map(n=>({id:uuid(n),account:'peer'+n,nickname:n<4?'同名好友':'成员'+n,public_id:'ID'+String(n).padStart(14,'0'),remark:n===2?'测试备注甲':n===3?'测试备注乙':''}));
  const row=(n=0)=>({id:n?chat(n):gid,kind:n?'direct':'group',title:n?'':'批改36群',peer_id:n?uuid(n):undefined,peer_name:n?'同名好友':undefined,my_role:'owner',can_send:true,
    pinned:n?model.pins.has(n):true,preference_version:String(model.preference),membership_version:'1',visible_from_seq:'1',message_seq:'0',event_seq:'0',unread_count:'0',member_count:n?2:477,
    updated_at:'2026-11-18T01:00:00Z',state:{clear_seq:'0',read_seq:'0',delivered_seq:'0',personal_seq:'0',version:'1'}});
  const rows=()=>[row(),...Array.from([2,3,4,5,650],row)];
  await page.addInitScript(({base})=>{window.pulseDesktop={isDesktop:true,production:false,apiBaseUrl:base,windowKind:'account'};localStorage.setItem('pulse_go_v2:'+encodeURIComponent(base)+':token','fixture');},{base:origin+'/api/v2'});
  await page.route('**/go-realtime.js',route=>route.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async()=>({close(){}})};'}));
  await page.route('**/api/v2/**',async route=>{
    const req=route.request(),u=new URL(req.url()),p=u.pathname.replace('/api/v2',''),method=req.method();model.requests.push({p,method});let data={items:[]},status=200;
    if(p==='/me'||p==='/me/profile')data={id:model.user,account:'fixture',nickname:'当前账号',version:'1'};
    else if(p==='/client/update')data={required:false};
    else if(p==='/client/config')data={registration:{},display:{},releases:{}};
    else if(p==='/client/friend-page')data={items:candidates.filter(x=>[uuid(2),uuid(3)].includes(x.id)),total:2,page:1,size:50};
    else if(p==='/client/conversation-page'||p==='/conversations')data={items:rows(),total:6,page:1,size:30};
    else if(p==='/client/conversation-updates')data={items:req.postDataJSON().conversation_ids.map(id=>rows().find(r=>r.id===id)).filter(Boolean),removed_ids:[],incremental:true};
    else if(p==='/groups/'+gid)data={...row(),my_role:model.role,owner_id:model.user,member_limit:1000,block_member_friend_requests:false};
    else if(p==='/groups/'+gid+'/invite-candidates'){
      const remaining=candidates.filter(x=>x.id>(u.searchParams.get('after')||'')),limit=Number(u.searchParams.get('limit')||100),items=remaining.slice(0,limit);
      data={items,next_after:remaining.length>limit?items.at(-1).id:''};
      if(model.deny){status=403;data={error:{code:'forbidden'}};}
      if(model.holdNext){model.holdNext=false;await model.gate;}
    }else if(p.startsWith('/conversations/')){
      const id=p.split('/')[2],n=id===gid?0:[2,3,4,5,650].find(x=>chat(x)===id);
      if(n!==undefined){
        if(p.endsWith('/preferences')&&method==='PATCH'){
          const input=req.postDataJSON();assert.equal(input.expected_version,String(model.preference));assert.equal(typeof input.pinned,'boolean');
          model.pins[input.pinned?'add':'delete'](n);model.preference++;model.writes.push({id,...input});data={preference_version:String(model.preference),pinned:input.pinned};
        }else if(p.endsWith('/history'))data={items:[],membership_version:'1',snapshot_max_seq:'0',next_after_seq:'0',next_before_seq:'0',visible_from_seq:'1',clear_seq:'0',has_more:false};
        else if(p.endsWith('/personal-sync'))data={events:[],snapshot_max_seq:'0',next_after_seq:'0',has_more:false};
        else if(p.endsWith('/sync'))data={events:[],membership_version:'1',snapshot_max_seq:'0',next_after_seq:'0',visible_from_seq:'1',has_more:false};
        else data=row(n);
      }
    }
    try{await route.fulfill({status,json:data});}catch(error){if(!/Target.*closed|disposed/.test(error.message)&&!page.isClosed())throw error;}
  });
  const check=(name,passed)=>{checks.push({name,passed});if(!baseline)assert.equal(passed,true,name);};
  const list=kind=>page.locator(`[data-group-list="${kind}"] [data-group-user]`);
  const ids=kind=>list(kind).evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.groupUser)));
  const localUser=n=>page.evaluate(id=>GO.local('user',id),uuid(n));
  async function pin(n){
    const pinned=!model.pins.has(n),id=await page.evaluate(id=>GO.local('conversation',id),chat(n));
    await page.locator(`.conversation[data-id="${id}"]`).click({button:'right'});await page.click('[data-conversation-action="pin"]');
    await page.waitForFunction(({id,pinned})=>!state.conversationListLoad&&state.conversations.find(row=>row.id===id)?.is_pinned===pinned,{id,pinned});
  }
  async function open(){await page.evaluate(id=>groupCreator.openInvite(state.conversations.find(row=>row.id===GO.local('conversation',id))),gid);await page.waitForFunction(()=>{const retry=document.querySelector('[data-group-retry]');return retry&&(!retry.hidden||!document.querySelector('[data-group-all="recent"]').disabled);});}
  const close=()=>page.evaluate(()=>groupCreator.close(false));
  try{
    await page.goto(origin+'/pc/web/index.html');await page.waitForFunction(()=>state.user?.id&&state.conversations.length===6&&!state.conversationListLoad);
    await pin(2);const peer=await localUser(2),other=await localUser(3),late=await localUser(650);
    check('pinning a friend is confirmed by the real preference write and displayed in the sidebar',model.writes.some(w=>w.id===chat(2)&&w.pinned===true)&&await page.locator(`.conversation[data-id="${await page.evaluate(id=>GO.local('conversation',id),chat(2))}"].is-pinned`).count()===1);
    const before=model.requests.length;await open();
    check('the invitation left column contains the pinned friend even though the server candidate has no pin field',(await ids('pinned')).includes(peer));
    await page.screenshot({path:path.join(out,baseline?'before.png':'after.png')});
    if(baseline){fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({reproduced:checks.some(x=>!x.passed),checks,errors},null,2));console.log(JSON.stringify({reproduced:checks.some(x=>!x.passed),checks}));return;}
    check('pin classification uses the user identity rather than a shared nickname',!(await ids('pinned')).includes(other)&&(await ids('recent')).includes(other));
    check('a pinned friend beyond five hundred privacy-filtered candidates is also visible',(await ids('pinned')).includes(late));
    const all=[...await ids('pinned'),...await ids('recent')];
    check('only server-approved candidates appear once; existing members and private or blocked users are never added',all.length===553&&new Set(all).size===553&&!all.includes(await localUser(4))&&!all.includes(await localUser(5)));
    check('reading pin flags adds no contact directory or conversation history requests',!model.requests.slice(before).some(r=>/friend-page|conversation-page|history|member-profiles/.test(r.p)));
    for(const [query,expected] of [['备注甲',peer],['同名',peer],['peer2',peer],['ID00000000000002',peer]]){
      await page.fill('[data-group-search="pinned"]',query);assert.deepEqual(await ids('pinned'),[expected]);
    }
    check('the restored pinned column supports fuzzy remark, nickname, account and public ID searches',true);
    await page.check('[data-group-all="pinned"]');await page.fill('[data-group-search="pinned"]','');
    check('selecting search results preserves the selected friend after clearing the filter',await page.locator(`[data-group-list="pinned"] [data-group-user="${peer}"]`).isChecked()&&(await page.locator('[data-group-selected]').textContent()).includes('1'));
    await close();await pin(2);await open();
    check('unpinning a friend moves them to the recent column on reopening instead of retaining a cached pin',!(await ids('pinned')).includes(peer)&&(await ids('recent')).includes(peer));
    await close();await pin(3);await open();
    check('a newly pinned friend with no messages appears immediately in the left column',(await ids('pinned')).includes(other)&&!(await ids('recent')).includes(other));
    await close();model.deny=true;await open();
    check('a forbidden invitation endpoint shows an error without falling back to a full friend directory',await list('pinned').count()===0&&await list('recent').count()===0&&!(await page.locator('[data-group-retry]').isHidden()));
    await close();model.deny=false;
    let release;model.gate=new Promise(resolve=>release=resolve);model.holdNext=true;
    const pending=page.waitForRequest(request=>request.url().includes('/invite-candidates?'));
    await page.evaluate(id=>groupCreator.openInvite(state.conversations.find(row=>row.id===GO.local('conversation',id))),gid);await pending;
    await page.evaluate(()=>{groupCreator.close(false);state.token='second-fixture';GO.session(state.token);state.user.id=GO.local('user','00000009-7777-4777-8777-777777777777');for(const row of state.conversations)row.is_pinned=false;});
    model.user=uuid(9);model.pins.clear();await open();release();
    await page.waitForFunction(()=>document.querySelectorAll('[data-group-list="recent"] [data-group-user]').length===553);
    check('switching accounts rejects late results and never inherits the previous account pin classification',await list('pinned').count()===0&&await list('recent').count()===553);
    await close();assert.deepEqual(errors,[]);check('the production page and invitation dialog finish without unhandled browser errors',true);
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:checks.length,checks,errors},null,2));console.log(JSON.stringify({passed:checks.length,out}));
  }finally{await page.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1;});
