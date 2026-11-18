// Shipping PC view and adapter against isolated HTTP responses; no real accounts.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.argv[2]||'.local/pc-presence-location-20261118/ui'),baseline=process.argv.includes('--baseline');
const uuid=n=>String(n).padStart(8,'0')+'-7777-4777-8777-777777777777';
const uid=uuid(1),peer=uuid(2),other=uuid(3),cid=uuid(100),otherCid=uuid(101);
fs.mkdirSync(output,{recursive:true});
const server=http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})});
  const checks=[],errors=[];const check=(name,passed)=>{checks.push({name,passed});if(!baseline)assert.equal(passed,true,name);};
  async function fixture(staff=true){
    const page=await browser.newPage({viewport:{width:1120,height:760},timezoneId:'Asia/Shanghai'});page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install({time:new Date('2026-11-18T03:00:00Z')});
    const model={staff,online:true,hidden:false,location:'中国 广东 深圳',locationStatus:'resolved',hold:null,requests:[],denyStaff:false,failPresence:false};
    const row=id=>({id,kind:'direct',peer_id:id===cid?peer:other,peer_name:id===cid?'测试联系人':'另一位联系人',can_send:true,my_role:'member',message_seq:'0',event_seq:'0',visible_from_seq:'1',membership_version:'1',preference_version:'1',unread_count:'0',updated_at:'2026-11-18T00:00:00Z',state:{clear_seq:'0',read_seq:'0',delivered_seq:'0',personal_seq:'0',version:'1'}});
    await page.addInitScript(({base})=>{window.pulseDesktop={isDesktop:true,production:false,apiBaseUrl:base,windowKind:'account'};localStorage.setItem('pulse_go_v2:'+encodeURIComponent(base)+':token','fixture');},{base:origin+'/api/v2'});
    await page.route('**/go-realtime.js',route=>route.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async()=>({close(){}})};'}));
    await page.route('**/api/v2/**',async route=>{
      const req=route.request(),u=new URL(req.url()),p=u.pathname.replace('/api/v2','');model.requests.push(p);let data={items:[]},status=200;
      if(p==='/me'||p==='/me/profile')data={id:uid,account:'fixture',nickname:'当前账号',internal_staff:model.staff,version:'1'};
      else if(p==='/client/update')data={required:false};
      else if(p==='/client/config')data={registration:{},display:{},releases:{}};
      else if(p==='/client/friend-page')data={items:[],page:Number(u.searchParams.get('page')||1),size:Number(u.searchParams.get('size')||100),total:0};
      else if(p==='/client/conversation-page'||p==='/conversations')data={items:[row(cid),row(otherCid)],total:2,page:1,size:30};
      else if(p==='/client/conversation-updates')data={items:req.postDataJSON().conversation_ids.map(row),removed_ids:[],incremental:true};
      else if(p.startsWith('/conversations/')&&[cid,otherCid].includes(p.split('/')[2])){
        if(p.endsWith('/history'))data={items:[],membership_version:'1',snapshot_max_seq:'0',next_after_seq:'0',next_before_seq:'0',visible_from_seq:'1',clear_seq:'0',has_more:false};
        else if(p.endsWith('/personal-sync'))data={events:[],snapshot_max_seq:'0',next_after_seq:'0',has_more:false};
        else if(p.endsWith('/sync'))data={events:[],membership_version:'1',snapshot_max_seq:'0',next_after_seq:'0',visible_from_seq:'1',has_more:false};
        else if(p.split('/').length===3||p.endsWith('/open'))data=row(p.split('/')[2]);
      }else if(p.startsWith('/profiles/')){
        const id=p.split('/')[2];data={id,nickname:id===peer?'测试联系人':'另一位联系人',is_contact:true,online:!model.hidden&&model.online,...(!model.hidden?{last_seen:'2026-11-18T02:12:34Z'}:{}),contact_version:'0'};
        if(model.failPresence){status=503;data={error:{code:'unavailable'}};}
        if(model.hold&&id===peer)await model.hold;
      }else if(p.startsWith('/staff/users/')){
        const id=p.split('/')[3];data={id,registration_ip:'192.0.2.10',registration_ip_location:'中国 北京',registration_ip_location_status:'resolved',lookup_available:true,
          logins:[{ip:id===peer?'192.0.2.20':'192.0.2.30',created_at:'2000-01-01T00:00:00Z',device_name:'phone',location:id===peer?model.location:'中国 浙江 杭州',location_status:model.locationStatus}]};
        if(model.denyStaff||!model.staff){status=403;data={error:{code:'forbidden'}};}
      }
      try{await route.fulfill({status,json:data});}catch(error){if(!/Target.*closed|disposed/.test(error.message)&&!page.isClosed())throw error;}
    });
    await page.goto(origin+'/pc/web/index.html');await page.waitForFunction(()=>state.user?.id&&state.token==='fixture');
    const open=async id=>{await page.evaluate(async id=>{await openConversation(GO.local('conversation',id),{focusInput:false});},id);await page.waitForFunction(()=>!state.initialHistory);};
    const refresh=()=>page.evaluate(async()=>{await refreshChatHeaderProfile(Number(state.active.id));});
    await open(cid);await refresh();return {page,model,open,refresh};
  }
  try{
    let f=await fixture();const text=()=>f.page.locator('#chat-subtitle').textContent();
    check('the header reads the authorized live activity profile instead of showing unknown', /^在线(?: ·|$)/.test(await text()));
    check('the staff header includes cached login IP location', (await text()).includes('192.0.2.20')&&(await text()).includes('中国 广东 深圳'));
    await f.page.screenshot({path:path.join(output,baseline?'before.png':'after.png')});
    f.model.online=false;await f.refresh();
    check('offline header shows the authorized last-seen time in the current timezone', (await text()).includes('最近在线：2026/11/18 10:12')&&!(await text()).includes('2000'));
    f.model.hidden=true;await f.refresh();
    check('privacy-hidden activity is labelled hidden and clears the old timestamp', (await text()).includes('最后上线时间已隐藏')&&!(await text()).includes('10:12'));
    if(baseline){await f.page.close();fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({reproduced:checks.some(c=>!c.passed),checks,errors},null,2));console.log(JSON.stringify({reproduced:true,checks,errors}));return;}
    f.model.location='';f.model.locationStatus='unknown';await f.refresh();
    check('an unresolved IP location displays an honest missing-data status', (await text()).includes('归属地暂无数据'));
    f.model.denyStaff=true;await f.refresh();
    check('a rejected staff request removes previously visible login IP metadata', !(await text()).includes('192.0.2.20'));
    f.model.denyStaff=false;f.model.hidden=false;f.model.failPresence=true;await f.refresh();
    check('presence failure does not hide the separately authorized IP result or invent offline status', (await text()).includes('在线状态暂不可用')&&(await text()).includes('192.0.2.20'));
    f.model.failPresence=false;f.model.online=true;
    let release;f.model.hold=new Promise(r=>release=r);
    const started=f.page.waitForRequest(r=>r.url().endsWith('/profiles/'+peer)),pending=f.refresh();await started;
    await f.open(otherCid);release();f.model.hold=null;await pending;await f.refresh();
    check('a delayed profile from another chat cannot replace the current peer metadata', (await text()).includes('192.0.2.30')&&!(await text()).includes('192.0.2.20'));
    await f.page.fill('#message-input','在线状态刷新时保留这段草稿');
    await f.page.evaluate(()=>window.presenceMessages=document.getElementById('messages'));await f.refresh();
    check('header refresh preserves the chat view and composer draft',await f.page.inputValue('#message-input')==='在线状态刷新时保留这段草稿'&&await f.page.evaluate(()=>presenceMessages===document.getElementById('messages')));
    await f.page.close();f=await fixture(false);
    check('ordinary accounts receive activity data without requesting staff IP metadata', (await f.page.locator('#chat-subtitle').textContent()).startsWith('在线')&&!f.model.requests.some(p=>p.startsWith('/staff/users/')));
    f.model.online=false;await f.page.clock.fastForward(31000);
    await f.page.waitForFunction(()=>document.getElementById('chat-subtitle').textContent.startsWith('离线'));
    check('scheduled refresh updates the visible peer without reopening the conversation',(await f.page.locator('#chat-subtitle').textContent()).includes('最近在线：'));
    await f.page.evaluate(()=>{state.desktopAccountVisible=false;cancelForegroundReads();});
    const reads=f.model.requests.filter(p=>p.startsWith('/profiles/')||p.startsWith('/staff/users/')).length;
    await f.page.clock.fastForward(65000);
    check('hidden account windows do not poll activity or internal IP metadata',f.model.requests.filter(p=>p.startsWith('/profiles/')||p.startsWith('/staff/users/')).length===reads);
    f.model.online=true;await f.page.evaluate(()=>{state.desktopAccountVisible=true;resumeForegroundReads();});
    await f.page.waitForFunction(()=>document.getElementById('chat-subtitle').textContent==='在线');
    check('returning to a visible account refreshes activity immediately',(await f.page.locator('#chat-subtitle').textContent())==='在线');
    await f.page.close();assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:checks.length,checks,errors},null,2));console.log(JSON.stringify({passed:checks.length,output}));
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
