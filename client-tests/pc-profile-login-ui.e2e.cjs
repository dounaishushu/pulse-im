// Production PC profile + Go adapter against local fixtures; no real audit data.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.local/pc-profile-login-20261119/ui'),baseline=process.argv.includes('--baseline');
const uuid=n=>String(n).padStart(8,'0')+'-9999-4999-8999-999999999999',uid=uuid(1),peer=uuid(2),other=uuid(3),cid=uuid(100),gid=uuid(101);
fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{
  const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+relative);
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  const source=baseline&&relative==='/pc/web/app.js'?path.join(root,'.local/pc-profile-login-20261119/baseline',relative.slice(1)):file;
  fs.readFile(source,(e,data)=>{if(e){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})});
  const checks=[],errors=[],check=(name,passed)=>{checks.push({name,passed});assert.equal(passed,true,name);};
  const fields=['最近登录','登录设备','IP 地址','IP 归属地','注册IP地址','注册IP归属地'];
  async function fixture(staff=true){
    const page=await browser.newPage({viewport:{width:1120,height:840},timezoneId:'Asia/Shanghai'});page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
    const model={staff,denied:false,failed:false,hold:null,wrongIdentity:false,empty:false,location:'中国 广东 深圳',status:'resolved',device:'iPhone 16',platform:'ios',requests:[],publicAudit:false};
    const row=()=>({id:cid,kind:'direct',peer_id:peer,peer_name:'测试好友',my_role:'member',can_send:true,message_seq:'0',event_seq:'0',visible_from_seq:'1',membership_version:'1',preference_version:'1',updated_at:'2026-11-19T00:00:00Z',unread_count:'0',state:{clear_seq:'0',read_seq:'0',delivered_seq:'0',personal_seq:'0',version:'1'}});
    await page.addInitScript(({base})=>{window.pulseDesktop={isDesktop:true,production:false,apiBaseUrl:base,windowKind:'account'};localStorage.setItem('pulse_go_v2:'+encodeURIComponent(base)+':token','fixture');},{base:origin+'/api/v2'});
    await page.route('**/go-realtime.js',r=>r.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async()=>({close(){}})};'}));
    await page.route('**/api/v2/**',async route=>{
      const req=route.request(),u=new URL(req.url()),p=u.pathname.replace('/api/v2','');model.requests.push({p,query:u.search});let data={items:[]},status=200;
      if(p==='/me'||p==='/me/profile')data={id:uid,account:'fixture',nickname:'当前账号',internal_staff:model.staff,version:'1'};
      else if(p==='/client/update')data={required:false};
      else if(p==='/client/config')data={registration:{},display:{},releases:{}};
      else if(p==='/client/friend-page')data={items:[],total:0,page:1,size:50};
      else if(p==='/client/conversation-page'||p==='/conversations')data={items:[row()],total:1,page:1,size:30};
      else if(p==='/client/conversation-updates')data={items:[row()],removed_ids:[],incremental:true};
      else if(p.startsWith('/profiles/'))data={id:p.split('/')[2],account:'peer',nickname:p.endsWith(other)?'另一位好友':'测试好友',is_contact:true,remark:'测试备注',contact_version:'0',version:'1',...(model.publicAudit?{last_login_at:'private-audit',last_login_ip:'private-ip',last_login_device:'private-device',ip_location:'private-location'}:{})};
      else if(p.startsWith('/staff/users/')){
        const id=p.split('/')[3];data={id:model.wrongIdentity?other:id,nickname:'测试好友',registration_ip:'192.0.2.10',registration_ip_location:'中国 北京',registration_ip_location_status:'resolved',lookup_available:true,
          logins:model.empty?[]:[{ip:id===peer?'192.0.2.20':'192.0.2.30',created_at:'2026-11-19T02:03:04Z',device_name:model.device,platform:model.platform,location:model.location,location_status:model.status}]};
        if(model.denied||!model.staff){status=403;data={error:{code:'forbidden'}};}
        else if(model.failed){status=503;data={error:{code:'unavailable'}};}
        if(model.hold&&id===peer)await model.hold;
      }else if(p.startsWith('/conversations/')){
        if(p.endsWith('/history'))data={items:[],membership_version:'1',snapshot_max_seq:'0',next_after_seq:'0',next_before_seq:'0',visible_from_seq:'1',clear_seq:'0',has_more:false};
        else if(p.endsWith('/personal-sync'))data={events:[],snapshot_max_seq:'0',next_after_seq:'0',has_more:false};
        else if(p.endsWith('/sync'))data={events:[],membership_version:'1',snapshot_max_seq:'0',next_after_seq:'0',visible_from_seq:'1',has_more:false};
        else data=row();
      }
      try{await route.fulfill({status,json:data});}catch(e){if(!/Target.*closed|disposed/.test(e.message)&&!page.isClosed())throw e;}
    });
    await page.goto(origin+'/pc/web/index.html');await page.waitForFunction(()=>state.conversations.length===1&&!state.conversationListLoad);
    const open=async(id=peer,context=null)=>{await page.evaluate(({id,context})=>openContactProfile(GO.local('user',id),context?GO.local('conversation',context):null),{id,context});await page.waitForSelector('#profile-remark');};
    const close=()=>page.evaluate(()=>closeFeatureModal());
    const ready=()=>page.waitForFunction(()=>{const n=document.querySelector('[data-profile-register-ip]');return n&&n.textContent!=='加载中…';});
    const values=()=>page.locator('.profile-details').evaluate(el=>Object.fromEntries([...el.querySelectorAll('dt')].map(n=>[n.textContent,n.nextElementSibling.textContent])));
    return {page,model,open,close,ready,values};
  }
  try{
    let f=await fixture();await f.open();await f.ready();let values=await f.values();
    if(baseline){const reproduced=fields.slice(0,4).every(k=>values[k]==='未公开');assert.equal(reproduced,true);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({reproduced,fields:values},null,2));await f.page.screenshot({path:path.join(out,'before.png')});await f.page.close();return;}
    check('the four login rows use the existing authorized audit response',values['最近登录']==='2026/11/19 10:03:04'&&values['登录设备']==='iPhone 16'&&values['IP 地址']==='192.0.2.20'&&values['IP 归属地']==='中国 广东 深圳');
    check('registration details continue to display their own IP and location',values['注册IP地址']==='192.0.2.10'&&values['注册IP归属地']==='中国 北京');
    check('opening the profile uses one staff request to fill all six private fields',f.model.requests.filter(r=>r.p.startsWith('/staff/users/')).length===1);
    await f.page.fill('#profile-remark','输入中保持备注');await f.page.screenshot({path:path.join(out,'login-details.png')});await f.close();
    f.model.device='';f.model.platform='android';await f.open();await f.ready();check('an absent device name falls back to the recorded login platform',(await f.values())['登录设备']==='安卓端');await f.close();
    f.model.device='<img src=x onerror="window.profileInjection=true">';await f.open();await f.ready();
    check('device names are rendered as text without executing HTML',(await f.values())['登录设备']===f.model.device&&await f.page.locator('[data-profile-login-device] img').count()===0&&await f.page.evaluate(()=>!window.profileInjection));await f.close();
    f.model.device='pc';f.model.location='';f.model.status='unknown';await f.open();await f.ready();check('an uncached location is distinguished from hidden data',(await f.values())['IP 归属地']==='暂未查到归属地'&&(await f.values())['登录设备']==='电脑端');await f.close();
    for(const [status,label] of [['failed','归属地查询失败'],['unconfigured','归属地暂不可用']]){f.model.status=status;await f.open();await f.ready();check('lookup status '+status+' has a meaningful label',(await f.values())['IP 归属地']===label);await f.close();}
    f.model.empty=true;await f.open();await f.ready();values=await f.values();check('a user with no login records shows no-record labels without inventing login data',fields.slice(0,4).every(k=>values[k]==='暂无记录')&&values['注册IP地址']==='192.0.2.10');await f.close();f.model.empty=false;
    f.model.denied=true;await f.open();await f.ready();values=await f.values();check('a denied staff request leaves all protected values undisclosed',fields.every(k=>values[k]==='未公开'));await f.close();f.model.denied=false;
    f.model.failed=true;await f.open();await f.ready();values=await f.values();check('a temporary network failure displays unavailable instead of pretending the data is private',fields.every(k=>values[k]==='暂不可用'));await f.close();f.model.failed=false;
    f.model.wrongIdentity=true;await f.open();await f.ready();values=await f.values();check('metadata for a different identity cannot be displayed in the current profile',fields.every(k=>values[k]==='暂不可用'));await f.close();f.model.wrongIdentity=false;
    await f.open(peer,gid);await f.ready();check('a profile opened from a group retains the group context on the audit request',f.model.requests.some(r=>r.p==='/staff/users/'+peer&&r.query==='?conversation_id='+gid));await f.close();
    let release;f.model.hold=new Promise(r=>release=r);const started=f.page.waitForRequest(r=>r.url().includes('/staff/users/'+peer));await f.open();await started;
    await f.close();await f.open(other);await f.ready();release();f.model.hold=null;
    await f.page.waitForFunction(()=>document.querySelector('[data-profile-login-ip]')?.textContent==='192.0.2.30');
    check('a late response from the previous contact cannot replace the current contact data',(await f.values())['IP 地址']==='192.0.2.30');await f.close();
    f.model.hold=new Promise(r=>release=r);const pending=f.page.waitForRequest(r=>r.url().includes('/staff/users/'+peer));await f.open();await pending;
    await f.page.evaluate(()=>{state.user.internal_staff=false;});release();f.model.hold=null;await f.ready();values=await f.values();
    check('a role downgrade while loading prevents displaying the protected result',fields.every(k=>values[k]==='未公开'));await f.page.close();
    f=await fixture(false);f.model.publicAudit=true;await f.open();await f.ready();values=await f.values();
    check('ordinary accounts do not request staff metadata or render incidental audit fields in a public DTO',fields.every(k=>values[k]==='未公开')&&!f.model.requests.some(r=>r.p.startsWith('/staff/users/')));
    await f.page.close();assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:checks.length,checks,errors},null,2));console.log(JSON.stringify({passed:checks.length,out}));
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
