// Real PC renderer and refresh paths. Selection is inspected without replacing
// the user's OS clipboard or connecting to a production account.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.local/pc-header-selection-20261119/ui'),baseline=process.argv.includes('--baseline');
const uuid=n=>String(n).padStart(8,'0')+'-8888-4888-8888-888888888888',uid=uuid(1),peer=uuid(2),other=uuid(3),cid=uuid(100),otherCID=uuid(101),gid=uuid(102);
fs.mkdirSync(out,{recursive:true});
const model={online:true,remark:'长备注 100 测试项目 南平顶山 工作资料 '+ '用于复制姓名和备注的完整长名称 '.repeat(8),groupName:'群聊资料 南平顶山 '+ '群名称用于复制 '.repeat(15),seq:1,requests:[]};
const server=http.createServer((req,res)=>{
  const relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+relative);
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  const source=baseline&&['/pc/web/app.js','/pc/web/classic-pc.css'].includes(relative)?path.join(root,'.local/pc-header-selection-20261119/baseline',relative.slice(1)):file;
  fs.readFile(source,(e,data)=>{if(e){res.writeHead(404).end();return;}res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1120,height:840},timezoneId:'Asia/Shanghai'}),checks=[],errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-11-19T04:00:00Z')});
  const message=id=>({id:uuid(300+model.seq),conversation_id:id,sender_id:peer,sender:{name:'原昵称'},kind:'text',body:'保留聊天内容 '+model.seq,content:{},seq:String(model.seq),event_seq:String(model.seq),version:'1',request_id:'fixture-'+model.seq,created_at:'2026-11-19T03:00:00Z'});
  const row=id=>({id,kind:id===gid?'group':'direct',title:id===gid?model.groupName:'',peer_id:id===gid?'':id===cid?peer:other,peer_name:id===cid?'原昵称':'另一位好友',can_send:true,my_role:id===gid?'owner':'member',owner_id:uid,member_count:9,message_seq:String(model.seq),event_seq:String(model.seq),visible_from_seq:'1',membership_version:'1',preference_version:'1',updated_at:'2026-11-19T03:00:00Z',unread_count:'0',last_message:message(id),state:{clear_seq:'0',read_seq:String(model.seq),delivered_seq:String(model.seq),personal_seq:'0',version:'1'}});
  await page.addInitScript(({base})=>{window.pulseDesktop={isDesktop:true,production:false,apiBaseUrl:base,windowKind:'account'};localStorage.setItem('pulse_go_v2:'+encodeURIComponent(base)+':token','fixture');},{base:origin+'/api/v2'});
  await page.route('**/go-realtime.js',r=>r.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async()=>({close(){}})};'}));
  await page.route('**/api/v2/**',async route=>{
    const req=route.request(),u=new URL(req.url()),p=u.pathname.replace('/api/v2','');model.requests.push(p);let data={items:[]};
    if(p==='/me'||p==='/me/profile')data={id:uid,account:'fixture',nickname:'当前账号',internal_staff:true,version:'1'};
    else if(p==='/client/update')data={required:false};
    else if(p==='/client/config')data={registration:{},display:{},releases:{}};
    else if(p==='/client/friend-page')data={items:[{id:peer,account:'peer',nickname:'原昵称',remark:model.remark}],total:1,page:1,size:Number(u.searchParams.get('size')||100)};
    else if(p==='/client/conversation-page'||p==='/conversations')data={items:[row(cid),row(otherCID),row(gid)],total:3,page:1,size:30};
    else if(p==='/client/conversation-updates')data={items:req.postDataJSON().conversation_ids.map(row),removed_ids:[],incremental:true};
    else if(p.startsWith('/profiles/'))data={id:p.split('/')[2],account:'peer',nickname:'原昵称',is_contact:true,remark:model.remark,online:model.online,last_seen:'2026-11-19T03:00:00Z',version:'1'};
    else if(p.startsWith('/staff/users/'))data={id:p.split('/')[3],registration_ip:'192.0.2.10',logins:[{ip:'192.0.2.20',platform:'pc',device_name:'pc',created_at:'2026-11-19T02:00:00Z',location:'中国 广东 深圳',location_status:'resolved'}]};
    else if(p==='/groups/'+gid)data={id:gid,kind:'group',title:model.groupName,status:'active',my_role:'owner',owner_id:uid,member_count:9,member_limit:500,block_member_friend_requests:false};
    else if(p.endsWith('/member-profiles'))data={items:[],query:'',next_after:'',search_scope:'group',members_visibility:'all'};
    else if(p.startsWith('/conversations/')){
      const id=p.split('/')[2];
      if(p.endsWith('/history'))data={items:[message(id)],membership_version:'1',snapshot_max_seq:String(model.seq),next_after_seq:String(model.seq),next_before_seq:'1',visible_from_seq:'1',clear_seq:'0',has_more:false};
      else if(p.endsWith('/personal-sync'))data={events:[],snapshot_max_seq:'0',next_after_seq:'0',has_more:false};
      else if(p.endsWith('/sync'))data={events:[],membership_version:'1',snapshot_max_seq:String(model.seq),next_after_seq:String(model.seq),visible_from_seq:'1',has_more:false};
      else if(p.split('/').length===3||p.endsWith('/open'))data=row(id);
    }
    try{await route.fulfill({json:data});}catch(e){if(!/Target.*closed|disposed/.test(e.message)&&!page.isClosed())throw e;}
  });
  const check=(name,passed)=>{checks.push({name,passed});assert.equal(passed,true,name);};
  const open=async id=>{await page.evaluate(id=>openConversation(GO.local('conversation',id),{focusInput:false}),id);await page.waitForFunction(()=>!state.initialHistory);};
  const select=()=>page.evaluate(()=>{
    document.activeElement?.blur();const title=document.getElementById('chat-title'),node=title.firstChild,needle='南平顶山',start=node.data.indexOf(needle),range=document.createRange();
    if(start<0)throw Error('Fixture name not ready');range.setStart(node,start);range.setEnd(node,start+needle.length);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    title.scrollLeft=100;window.keptTitleNode=node;window.keptTitleScroll=title.scrollLeft;
    window.keptTitleText=title.textContent;window.titleWrites=[];window.titleObserver?.disconnect();window.titleObserver=new MutationObserver(changes=>titleWrites.push(...changes.map(c=>c.type)));titleObserver.observe(title,{childList:true,characterData:true,subtree:true});
    return {selection:selection.toString(),scrollLeft:title.scrollLeft,overflow:title.scrollWidth>title.clientWidth};
  });
  const kept=()=>page.evaluate(()=>({text:getSelection().toString(),sameNode:keptTitleNode===document.getElementById('chat-title').firstChild,scrollSame:keptTitleScroll===document.getElementById('chat-title').scrollLeft,writes:titleWrites.length,inputFocused:document.activeElement===document.getElementById('message-input')}));
  const refresh=()=>page.evaluate(()=>refreshChatHeaderProfile(Number(state.active.id)));
  try{
    await page.goto(origin+'/pc/web/index.html');await page.waitForFunction(()=>state.conversations.length===3&&!state.conversationListLoad);await open(cid);await page.evaluate(()=>contactNames.refresh({force:true}));await refresh();
    await page.locator('#chat-title').evaluate(el=>{el.style.maxWidth='420px';});
    const selection=await select();assert.equal(selection.selection,'南平顶山');assert.equal(selection.overflow,true);assert.ok(selection.scrollLeft>0);
    model.online=false;await refresh();const after=await kept();
    if(baseline){model.remark='后台同步后的新备注 南平顶山 工作资料';await page.evaluate(()=>contactNames.refresh({force:true}));const renamed=await kept();assert.notEqual(renamed.text,'南平顶山');assert.ok(renamed.writes>0);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({reproduced:true,trigger:'Background contact-name synchronization changes the selected title',selectionBefore:selection,unchangedRefresh:after,renamed},null,2));await page.screenshot({path:path.join(out,'before.png')});return;}
    check('presence and internal-profile responses retain the selected name text and its original text node',after.text==='南平顶山'&&after.sameNode&&after.writes===0);
    check('a long selected remark retains its horizontal text position and does not focus the composer',after.scrollSame&&!after.inputFocused);
    check('preserving the selection does not stop fresh presence and IP information from updating',(await page.locator('#chat-subtitle').textContent()).includes('离线')&&(await page.locator('#chat-subtitle').textContent()).includes('192.0.2.20'));
    await page.evaluate(()=>contactNames.refresh({force:true}));let result=await kept();check('a repeated contact-name snapshot does not reset the current copy selection',result.text==='南平顶山'&&result.sameNode&&result.writes===0);
    model.seq++;await page.evaluate(async id=>{refreshChangedConversations(GO.local('conversation',id));await conversationRefresh.flush();},cid);
    result=await kept();check('new message summary and read-state refreshes leave the header copy selection intact',result.text==='南平顶山'&&result.sameNode&&result.writes===0);
    model.online=true;const timerRequest=page.waitForRequest(r=>r.url().includes('/profiles/'+peer));await page.clock.fastForward(31000);await timerRequest;await page.waitForFunction(()=>document.getElementById('chat-subtitle').textContent.startsWith('在线'));
    result=await kept();check('the actual scheduled thirty-second presence refresh preserves the title selection',result.text==='南平顶山'&&result.sameNode&&result.writes===0);
    await page.evaluate(()=>{for(let i=0;i<20;i++)renderDesktopChatHeader(state.active);});result=await kept();check('unchanged repeated renders perform no title text mutations',result.sameNode&&result.writes===0);
    model.remark='后台同步后的新备注 南平顶山 工作资料';await page.evaluate(()=>contactNames.refresh({force:true}));result=await kept();
    check('a background remark change is deferred while its previous text is selected for copying',result.text==='南平顶山'&&result.sameNode&&result.writes===0&&await page.evaluate(()=>document.getElementById('chat-title').textContent===keptTitleText));
    model.remark='后台第二次同步的最新备注 南平顶山';await page.evaluate(()=>contactNames.refresh({force:true}));result=await kept();check('multiple background changes keep the selected text stable and retain only the latest pending name',result.text==='南平顶山'&&result.sameNode&&result.writes===0);
    await page.screenshot({path:path.join(out,'selected-remark.png')});await page.evaluate(()=>getSelection().removeAllRanges());await page.waitForFunction(name=>document.getElementById('chat-title').textContent===name,model.remark);
    check('the latest pending remark is displayed after selection is cancelled',(await page.locator('#chat-title').textContent())===model.remark);
    await page.evaluate(()=>{window.dragTitle=document.getElementById('chat-title').textContent;document.getElementById('chat-title').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,isPrimary:true}));});
    model.remark='拖选期间同步的新备注 南平顶山';await page.evaluate(()=>contactNames.refresh({force:true}));
    check('a pointer drag is protected before the browser has established a text selection',await page.evaluate(()=>document.getElementById('chat-title').textContent===dragTitle));
    await select();await page.evaluate(()=>document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,isPrimary:true})));result=await kept();
    check('releasing the mouse retains selected text until the user finishes copying',result.text==='南平顶山'&&await page.evaluate(()=>document.getElementById('chat-title').textContent===dragTitle));
    await page.evaluate(()=>getSelection().removeAllRanges());await page.waitForFunction(name=>document.getElementById('chat-title').textContent===name,model.remark);
    model.remark='新的备注名称 南平顶山';await page.evaluate(()=>contactNames.refresh({force:true}));check('a genuine remark change outside a copy operation updates immediately',(await page.locator('#chat-title').textContent())===model.remark);
    await select();model.remark='准备切换前的待更新备注 南平顶山';await page.evaluate(()=>contactNames.refresh({force:true}));
    await open(otherCID);check('explicit conversation navigation updates the title immediately even while the previous title was selected',(await page.locator('#chat-title').textContent())==='另一位好友');
    await page.evaluate(()=>getSelection().removeAllRanges());check('a pending title from the previous conversation cannot reappear after selection is cleared',(await page.locator('#chat-title').textContent())==='另一位好友');
    await open(gid);await select();await refresh();result=await kept();check('group profile refreshes also preserve an unchanged selected group name',result.text==='南平顶山'&&result.sameNode&&result.writes===0);
    model.groupName='后台更新的群名称 南平顶山';await refresh();result=await kept();check('group renames are deferred only while their current name is selected',result.text==='南平顶山'&&result.sameNode&&result.writes===0);
    await page.evaluate(()=>getSelection().removeAllRanges());await page.waitForFunction(name=>document.getElementById('chat-title').textContent===name,model.groupName);
    await page.evaluate(()=>{document.body.classList.add('conversation-window');});const style=await page.locator('#chat-title').evaluate(el=>({region:getComputedStyle(el).getPropertyValue('-webkit-app-region'),select:getComputedStyle(el).userSelect}));
    check('the detached-window title is a selectable text region instead of a native window drag target',style.region==='no-drag'&&style.select==='text');
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:checks.length,checks,errors,selectionBefore:selection,scope:'Production renderer/refresh paths in Chromium; native Electron window dragging not exercised'},null,2));console.log(JSON.stringify({passed:checks.length,out}));
  }finally{await page.close();await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
