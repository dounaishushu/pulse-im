// Shipping PC UI: ordinary users retain copy/reply/forward/select but cannot delete history.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.local/history-delete-policy-20261119/ui'),baseline=process.argv.includes('--baseline');
const uuid=n=>String(n).padStart(8,'0')+'-bbbb-4bbb-8bbb-bbbbbbbbbbbb',uid=uuid(1),peer=uuid(2),cid=uuid(100),gid=uuid(101),mid=uuid(300);
fs.mkdirSync(out,{recursive:true});
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),relative=decodeURIComponent(url.pathname),file=path.resolve(root,'.'+relative);
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  const source=baseline&&['/pc/web/app.js','/pc/web/message-actions.js'].includes(relative)?path.join(root,'.local/history-delete-policy-20261119/baseline',relative.slice(1)):file;
  fs.readFile(source,(e,data)=>{if(e){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1120,height:780}}),checks=[],errors=[],requests=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  const msg=id=>({id:mid,conversation_id:id,sender_id:peer,sender:{id:peer,name:'好友'},kind:'text',body:'保留的聊天消息',content:{},seq:'1',event_seq:'1',version:'1',created_at:'2026-11-19T00:00:00Z'});
  const row=id=>({id,kind:id===gid?'group':'direct',title:id===gid?'测试群':'',peer_id:id===cid?peer:'',peer_name:'好友',can_send:true,my_role:id===gid?'owner':'member',owner_id:uid,message_seq:'1',event_seq:'1',visible_from_seq:'1',membership_version:'1',preference_version:'1',updated_at:'2026-11-19T00:00:00Z',unread_count:'0',last_message:msg(id),state:{clear_seq:'0',read_seq:'1',delivered_seq:'1',personal_seq:'0',version:'1'}});
  await page.addInitScript(({base})=>{window.pulseDesktop={isDesktop:true,production:false,apiBaseUrl:base,windowKind:'account'};localStorage.setItem('pulse_go_v2:'+encodeURIComponent(base)+':token','fixture');},{base:origin+'/api/v2'});
  await page.route('**/go-realtime.js',r=>r.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async()=>({close(){}})};'}));
  await page.route('**/api/v2/**',async route=>{
    const req=route.request(),u=new URL(req.url()),p=u.pathname.replace('/api/v2','');requests.push({p,method:req.method()});let data={items:[]};
    if(p==='/me'||p==='/me/profile')data={id:uid,account:'fixture',nickname:'当前账号',internal_staff:false,version:'1'};
    else if(p==='/client/update')data={required:false};
    else if(p==='/client/config')data={registration:{},display:{},releases:{}};
    else if(p==='/client/friend-page')data={items:[],total:0,page:1,size:50};
    else if(p==='/client/conversation-page'||p==='/conversations')data={items:[row(cid),row(gid)],total:2,page:1,size:30};
    else if(p==='/client/conversation-updates')data={items:req.postDataJSON().conversation_ids.map(row),removed_ids:[],incremental:true};
    else if(p.startsWith('/profiles/'))data={id:peer,nickname:'好友',is_contact:true,online:false,last_seen:'2026-11-19T00:00:00Z'};
    else if(p==='/groups/'+gid)data={id:gid,kind:'group',title:'测试群',my_role:'owner',owner_id:uid,member_count:2,member_limit:500};
    else if(p.startsWith('/conversations/')){
      const id=p.split('/')[2];
      if(p.endsWith('/history'))data={items:[msg(id)],membership_version:'1',snapshot_max_seq:'1',next_after_seq:'1',next_before_seq:'1',visible_from_seq:'1',clear_seq:'0',has_more:false};
      else if(p.endsWith('/personal-sync'))data={events:[],snapshot_max_seq:'0',next_after_seq:'0',has_more:false};
      else if(p.endsWith('/sync'))data={events:[],membership_version:'1',snapshot_max_seq:'1',next_after_seq:'1',visible_from_seq:'1',has_more:false};
      else if(p.split('/').length===3||p.endsWith('/open'))data=row(id);
    }
    try{await route.fulfill({json:data});}catch(e){if(!/Target.*closed|disposed/.test(e.message)&&!page.isClosed())throw e;}
  });
  const check=(name,value)=>{checks.push({name,passed:value});if(!baseline)assert.equal(value,true,name);};
  const open=async id=>{await page.evaluate(id=>openConversation(GO.local('conversation',id),{focusInput:false}),id);await page.waitForFunction(()=>!state.initialHistory);await page.waitForSelector('.bubble[data-message-id]');};
  const menu=async()=>{await page.locator('.bubble[data-message-id]').first().click({button:'right'});await page.waitForSelector('.message-action-menu');};
  try{
    await page.goto(origin+'/pc/web/index.html');await page.waitForFunction(()=>state.conversations.length===2&&!state.conversationListLoad);await open(cid);
    const keys=await page.evaluate(()=>conversationContextActions(state.active).map(r=>r[0]));
    check('ordinary private conversations have no clear-history or delete-conversation entry',!keys.includes('clear')&&!keys.includes('hide'));
    await menu();check('ordinary message menus contain no personal-delete button',await page.locator('.message-action-menu [data-action="delete"]').count()===0);
    check('ordinary users keep copy, reply, forward, and selection actions',(await page.locator('.message-action-menu [data-action="copy"]').count())===1&&(await page.locator('[data-action="forward"]').count())===1&&(await page.locator('[data-action="select"]').count())===1);
    await page.locator('.message-action-menu [data-action="select"]').click();
    check('ordinary multi-select has forward and cancel but no batch-delete button',await page.locator('#message-selection-bar [data-selection-delete]').count()===0&&await page.locator('#message-selection-bar [data-selection-forward]').count()===1);
    if(baseline){fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({reproduced:checks.some(c=>!c.passed),checks,errors},null,2));return;}
    await page.locator('[data-selection-cancel]').click();
    await page.evaluate(()=>{clearActiveChatHistory();clearConversationHistory(state.active);hideConversationFromList(state.active);});
    check('ordinary direct handler calls cannot open deletion dialogs',await page.locator('[data-conversation-hide],#group-action-confirm,[data-message-delete]').count()===0);
    await open(gid);check('an ordinary group owner still cannot clear personal chat history',!(await page.evaluate(()=>conversationContextActions(state.active).map(r=>r[0]))).includes('clear'));
    await page.evaluate(()=>openGroupInfoDialog());await page.waitForSelector('#group-info-more');await page.waitForFunction(()=>state.groupInfoDialog?.loaded);await page.click('#group-info-more');
    check('ordinary group info has no history-clear menu entry',await page.locator('[data-group-info-action="clear"]').count()===0);
    await page.evaluate(()=>closeFeatureModal());await open(cid);
    await page.evaluate(()=>{state.user.internal_staff=true;bindMessageActions();});
    const staffKeys=await page.evaluate(()=>conversationContextActions(state.active).map(r=>r[0]));check('internal staff retain their existing clear and hide actions',staffKeys.includes('clear')&&staffKeys.includes('hide'));
    await menu();check('internal staff retain the personal-message delete action',await page.locator('.message-action-menu [data-action="delete"]').count()===1);
    await page.locator('.message-action-menu [data-action="delete"]').click();await page.waitForSelector('[data-delete-confirm]');
    await page.evaluate(()=>{state.user.internal_staff=false;});await page.click('[data-delete-confirm]');
    check('a role downgrade while confirmation is open blocks deletion',!requests.some(r=>r.p.endsWith('/personal-deletions')||r.p.endsWith('/clear')));
    await menu();await page.locator('[data-action="select"]').click();
    await page.evaluate(()=>{state.user.internal_staff=true;bindMessageActions();});
    check('selection controls reflect a newly authorized staff account',await page.locator('[data-selection-delete]').count()===1);
    await page.evaluate(()=>{state.user.internal_staff=false;bindMessageActions();});
    check('selection controls remove stale deletion buttons after a role downgrade',await page.locator('[data-selection-delete]').count()===0);
    check('ordinary users retain the original messages',await page.locator('#messages').innerText().then(t=>t.includes('保留的聊天消息')));
    await page.screenshot({path:path.join(out,'ordinary.png')});assert.deepEqual(errors,[]);check('the permission transitions have no browser errors',true);
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:checks.length,checks,errors},null,2));console.log(JSON.stringify({passed:checks.length,out}));
  }finally{await page.close();await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
