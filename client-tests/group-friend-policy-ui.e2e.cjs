// Production PC menu, profile and Go adapter against an isolated HTTP fixture.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.local/group-friend-policy-20261119/ui'),baseline=process.argv.includes('--baseline');
const uuid=n=>String(n).padStart(8,'0')+'-cccc-4ccc-8ccc-cccccccccccc',uid=uuid(1),peer=uuid(2),owner=uuid(3),gid=uuid(100),mid=uuid(300);
fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{
  const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+relative);
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  const source=baseline&&relative==='/pc/web/message-actions.js'?path.join(root,'.local/group-friend-policy-20261119/baseline',relative.slice(1)):file;
  fs.readFile(source,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1120,height:780}}),checks=[],errors=[],requests=[];
  const model={blocked:false,role:'member',isContact:false,targetActive:true,canAdd:true};page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  const message={id:mid,conversation_id:gid,sender_id:peer,sender:{id:peer,name:'普通群成员'},kind:'text',body:'从这条消息添加好友',content:{},seq:'1',event_seq:'1',version:'1',created_at:'2026-11-19T00:00:00Z'};
  const row=()=>({id:gid,kind:'group',title:'群加好友测试',my_role:model.role,owner_id:owner,can_send:true,message_seq:'1',event_seq:'1',visible_from_seq:'1',membership_version:'1',preference_version:'1',updated_at:'2026-11-19T00:00:00Z',unread_count:'0',last_message:message,state:{clear_seq:'0',read_seq:'1',delivered_seq:'1',personal_seq:'0',version:'1'}});
  await page.addInitScript(({base})=>{window.pulseDesktop={isDesktop:true,production:false,apiBaseUrl:base,windowKind:'account'};localStorage.setItem('pulse_go_v2:'+encodeURIComponent(base)+':token','fixture');},{base:origin+'/api/v2'});
  await page.route('**/go-realtime.js',r=>r.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async()=>({close(){}})};'}));
  await page.route('**/api/v2/**',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname.replace('/api/v2',''),body=req.postDataJSON();requests.push({p,method:req.method(),query:url.search,body});let data={items:[]},status=200;
    if(p==='/me'||p==='/me/profile')data={id:uid,account:'fixture',nickname:'普通用户',internal_staff:false,version:'1'};
    else if(p==='/client/update')data={required:false};
    else if(p==='/client/config')data={registration:{},display:{},releases:{}};
    else if(p==='/client/friend-page')data={items:[],total:0,page:1,size:50};
    else if(p==='/client/conversation-page'||p==='/conversations')data={items:[row()],total:1,page:1,size:30};
    else if(p==='/client/conversation-updates')data={items:[row()],removed_ids:[],incremental:true};
    else if(p==='/groups/'+gid)data={id:gid,kind:'group',title:'群加好友测试',status:'active',my_role:model.role,owner_id:owner,member_count:3,member_limit:500,block_member_friend_requests:model.blocked};
    else if(p.endsWith('/member-profiles')){
      const all=[{id:owner,nickname:'群主',role:'owner'},...(model.role!=='member'&&model.targetActive?[{id:peer,nickname:'普通群成员',role:'member'}]:[])].sort((a,b)=>a.id.localeCompare(b.id));
      data={items:all.filter(r=>r.id>(url.searchParams.get('after')||'')).slice(0,Number(url.searchParams.get('limit')||100)),query:'',next_after:'',search_scope:model.role==='member'?'friends':'group',members_visibility:model.role==='member'?'managers':'all'};
    }else if(p==='/profiles/'+peer){
      if(!model.targetActive||model.blocked&&model.role==='member'){status=403;data={error:{code:'forbidden'}};}
      else data={id:peer,account:'peer',nickname:'普通群成员',is_contact:model.isContact,can_add_friend:!model.blocked&&model.canAdd&&!model.isContact,online:false,version:'1',contact_version:'0'};
    }else if(p==='/friend-requests'&&req.method()==='POST'){
      assert.equal(body.context_conversation_id,gid);assert.equal(body.target_id,peer);
      status=model.blocked||!model.canAdd||!model.targetActive?403:201;
      data=status===201?{id:uuid(400),status:'pending'}:{error:{code:'forbidden'}};
    }else if(p.startsWith('/conversations/')){
      if(p.endsWith('/history'))data={items:[message],membership_version:'1',snapshot_max_seq:'1',next_after_seq:'1',next_before_seq:'1',visible_from_seq:'1',clear_seq:'0',has_more:false};
      else if(p.endsWith('/personal-sync'))data={events:[],snapshot_max_seq:'0',next_after_seq:'0',has_more:false};
      else if(p.endsWith('/sync'))data={events:[],membership_version:'1',snapshot_max_seq:'1',next_after_seq:'1',visible_from_seq:'1',has_more:false};
      else if(p.split('/').length===3||p.endsWith('/open'))data=row();
    }
    try{await route.fulfill({status,json:data});}catch(e){if(!/Target.*closed|disposed/.test(e.message)&&!page.isClosed())throw e;}
  });
  const check=(name,value)=>{checks.push({name,passed:value});assert.equal(value,true,name);};
  const menu=async()=>{await page.locator('[data-group-avatar-message="1"]').click({button:'right'});await page.waitForSelector('.group-member-menu');await page.waitForFunction(()=>!document.querySelector('[data-member-action="friend"]').title.includes('正在检查'));};
  const close=async()=>{await page.keyboard.press('Escape');await page.evaluate(()=>closeFeatureModal());};
  const writes=()=>requests.filter(r=>r.p==='/friend-requests'&&r.method==='POST').length;
  try{
    await page.goto(origin+'/pc/web/index.html');await page.waitForFunction(()=>state.conversations.length===1&&!state.conversationListLoad);
    await page.evaluate(id=>openConversation(GO.local('conversation',id),{focusInput:false}),gid);await page.waitForSelector('[data-group-avatar-message="1"]');
    await menu();const enabled=!(await page.locator('[data-member-action="friend"]').isDisabled());
    if(baseline){fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({reproduced:!enabled,reason:await page.locator('[data-member-action="friend"]').getAttribute('title')},null,2));assert.equal(enabled,false);return;}
    check('ordinary visible senders can be added with the ban off despite being absent from the private roster',enabled);
    check('enabling friendship does not enable ordinary moderation',await page.locator('[data-member-action="mute"]').isDisabled()&&await page.locator('[data-member-action="remove"]').isDisabled());
    await page.click('[data-member-action="friend"]');await page.waitForSelector('#profile-send-message');
    check('the real profile enables its add-friend button from the server capability',!(await page.locator('#profile-send-message').isDisabled())&&(await page.locator('#profile-send-message').textContent()).includes('添加好友'));
    await page.click('#profile-send-message');await page.waitForFunction(()=>document.querySelector('#profile-send-message')?.textContent.includes('好友申请已发送'));
    check('a group-origin friend request carries the exact group and target IDs',writes()===1);await close();
    await menu();model.blocked=true;await page.click('[data-member-action="friend"]');await page.waitForSelector('.group-member-menu',{state:'detached'});
    check('turning the ban on after opening a menu prevents opening the add flow',await page.locator('[data-contact-profile]').count()===0&&writes()===1);
    await menu();check('the ban on disables group add-friend',await page.locator('[data-member-action="friend"]').isDisabled());await close();
    model.blocked=false;await menu();check('turning the ban off takes effect without rejoining',!(await page.locator('[data-member-action="friend"]').isDisabled()));
    await page.click('[data-member-action="friend"]');await page.waitForSelector('#profile-send-message');model.blocked=true;
    await page.click('#profile-send-message');await page.waitForFunction(()=>document.querySelector('#profile-feedback')?.textContent.includes('没有操作权限'));
    check('an already opened profile cannot send after the group ban changes',writes()===1);await close();
    model.blocked=false;model.canAdd=false;await menu();await page.click('[data-member-action="friend"]');await page.waitForSelector('#profile-send-message');
    check('account restrictions remain effective even while the group ban is off',await page.locator('#profile-send-message').isDisabled());await close();
    model.canAdd=true;model.targetActive=false;await menu();await page.click('[data-member-action="friend"]');await page.waitForFunction(()=>document.querySelector('[data-profile-content]')?.textContent.includes('没有操作权限'));
    check('the authenticated profile still rejects departed targets',await page.locator('#profile-send-message').count()===0&&writes()===1);await close();
    model.targetActive=true;model.role='owner';await page.evaluate(()=>{state.active.my_role='owner';});await menu();
    check('known group managers retain their existing moderation actions',!(await page.locator('[data-member-action="mute"]').isDisabled()));await close();
    assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,'group-friend-policy.png')});
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:checks.length,checks,errors},null,2));console.log(JSON.stringify({passed:checks.length,out}));
  }finally{await page.close();await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
