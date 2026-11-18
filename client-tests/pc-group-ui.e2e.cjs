// Run with an installed Playwright module; PULSE_PLAYWRIGHT_MODULE may specify its path.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'pc/web');
const output=process.argv[2] || path.join(root,'.local/artifacts/pc-group-settings-'+new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(output,{recursive:true});
const gid='33333333-3333-4333-8333-333333333333',uid='11111111-1111-4111-8111-111111111111',peer='22222222-2222-4222-8222-222222222222';
const server=http.createServer((req,res)=>{
  const filename=path.resolve(web,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(!filename.startsWith(web+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(filename,(error,data)=>{if(error){res.writeHead(404).end();return;}const ext=path.extname(filename);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[ext]||'application/octet-stream');res.end(data);});
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})});
  const results=[],muteBadgeChecks=[];
  try{
    for(const role of ['owner','admin','member']){
      const model={role,muted:false,allMuted:false,preference:1,denied:false,membership:1,memberMuted:false,permanentMuted:false,mutedUntil:''};
      const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[],unknown=[],requests=[];
      page.setDefaultTimeout(8000);
      page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(({base})=>{window.__notifications=[];window.pulseDesktop={isDesktop:true,production:false,apiBaseUrl:base,windowKind:'account',notify:(...args)=>window.__notifications.push(args)};},{base:origin+'/api/v2'});
      await page.route('**/go-realtime.js',route=>route.fulfill({contentType:'text/javascript',body:'window.PulseGoRealtime={connect:async options=>{window.__onPacket=options.onPacket;return {close(){}}}};'}));
      const row=()=>({id:gid,kind:'group',title:'测试群',my_role:model.role,membership_version:String(model.membership),event_seq:'1',preference_version:String(model.preference),muted_notifications:model.muted,pinned:false,state:{clear_seq:'0',read_seq:'0',delivered_seq:'0',version:'1',personal_seq:'0'},visible_from_seq:'1',message_seq:'1',unread_count:'3',updated_at:'2026-11-16T00:00:00Z',mute_all:model.allMuted,can_send:!model.allMuted||model.role!=='member',member_count:3});
      const message={id:'44444444-4444-4444-8444-444444444444',conversation_id:gid,sender_id:peer,seq:'1',version:'1',kind:'text',body:'用于检查通知切换时消息是否闪烁',created_at:'2026-11-16T00:00:00Z',updated_at:'2026-11-16T00:00:00Z',content:{},sender:{name:'测试成员'}};
      const roster=()=>[
        {id:model.role==='owner'?uid:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',nickname:'群主',role:'owner',is_contact:false},
        {id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',nickname:'群管理员',role:'admin',is_contact:false},
        {id:peer,nickname:'好友人才',remark:'工作伙伴',account:'wenwen3',public_id:'778899',role:'member',is_contact:true,muted:model.memberMuted,muted_permanent:model.permanentMuted,muted_until:model.mutedUntil},
        {id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',nickname:'普通陌生人',account:'stranger',role:'member',is_contact:false}
      ];
      await page.route('**/api/v2/**',async route=>{
        const request=route.request(),url=new URL(request.url()),p=url.pathname.replace('/api/v2',''),body=request.postDataJSON();let result={};
        requests.push(p);
        if(p===`/conversations/${gid}`&&model.denied){await route.fulfill({status:403,json:{error:{code:'forbidden'}}});return;}
        if(p===`/groups/${gid}/mute-all`){model.allMuted=body.muted;}
        else if(p===`/conversations/${gid}/preferences`){model.muted=body.muted_notifications??model.muted;model.preference++;result={muted_notifications:model.muted,preference_version:String(model.preference)};}
        else if(p==='/client/conversation-updates')result={incremental:true,items:body.conversation_ids.includes(gid)&&!model.denied?[row()]:[],removed_ids:body.conversation_ids.filter(id=>id!==gid||model.denied)};
        else if(p==='/conversations'||p==='/client/conversation-page')result={items:[row()],total:1,page:1,size:30};
        else if(p===`/conversations/${gid}`||p===`/conversations/${gid}/open`)result=row();
        else if(p===`/groups/${gid}`)result={id:gid,kind:'group',title:'测试群',my_role:model.role,owner_id:uid,member_limit:500,member_count:3,mute_all:model.allMuted,block_member_friend_requests:false};
        else if(p.endsWith('/member-profiles')){
          const query=url.searchParams.get('q')||'',manager=model.role!=='member';
          const items=roster().filter(row=>(manager||query?manager||row.is_contact:['owner','admin'].includes(row.role))&&(!query||[row.nickname,row.remark,row.account,row.public_id].some(value=>String(value||'').toLowerCase().includes(query.toLowerCase()))));
          result={items,query,next_after:'',search_scope:manager?'group':'friends',members_visibility:manager?'all':'managers'};
        }
        else if(p.endsWith('/personal-sync'))result={events:[],snapshot_max_seq:'0',next_after_seq:'0',has_more:false};
        else if(p.endsWith('/sync'))result={events:[],membership_version:String(model.membership),snapshot_max_seq:'1',next_after_seq:'1',visible_from_seq:'1',has_more:false};
        else if(p.endsWith('/history'))result={items:[message],membership_version:String(model.membership),snapshot_max_seq:'1',next_before_seq:'0',next_after_seq:'1',visible_from_seq:'1',clear_seq:'0',has_more:false};
        else if(p==='/client/config')result={releases:{pc:{latest:'2.4.160',minimum:'1.0.0'}},registration:{},display:{show_group_count:true}};
        else if(p==='/auth/captcha')result={id:'fixture-captcha',image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZV8AAAAASUVORK5CYII=',expires_in:120};
        else if(p.endsWith('/receipts')||p.endsWith('/read')||p.endsWith('/delivered'))result={user_id:uid,read_seq:'1',delivered_seq:'1',clear_seq:'0',version:'2'};
        else if(p.endsWith('/unread'))result={count:0,truncated:false};
        else if(/contacts|folders|pins|invitation|requests|blocks|tasks|announcements|routes|notifications|friend-page/.test(p))result={items:[]};
        else unknown.push(p);
        await route.fulfill({json:result});
      });
      await page.goto(origin+'/index.html');await page.waitForFunction(()=>typeof renderShell==='function'&&!!window.PulseGoUI);
      await page.evaluate(async({uid,gid})=>{
        GO.session('fixture-session');state.token='fixture-session';state.user={id:GO.local('user',uid),nickname:'测试账户',account:'fixture'};state.page='messages';localStorage.setItem(GO.tokenKey,state.token);
        renderShell();await loadConversations();await openConversation(GO.local('conversation',gid),{focusInput:false});connectSocket();
      },{uid,gid});
      await page.screenshot({path:path.join(output,role+'-initial.png')});
      await page.waitForSelector('#messages .bubble');await page.waitForFunction(()=>document.querySelector('#chat-info-notifications')?.disabled===false);
      await page.waitForFunction(()=>document.querySelectorAll('[data-gs-person]').length>0);
      if(role==='member'){
        assert.deepEqual(await page.locator('.gs-member-copy strong').allTextContents(),['群主','群管理员']);
        assert.match(await page.inputValue('#chat-info-member-search'),/^$/);
      }
      for(const query of ['才','工作','WENW','8899']){
        await page.fill('#chat-info-member-search',query);
        await page.waitForFunction(()=>document.querySelector('.gs-search-count')?.textContent==='找到 1 位成员');
        assert.deepEqual(await page.locator('.gs-member-copy strong').allTextContents(),['工作伙伴']);
        assert.equal(await page.locator('[data-gs-search-retry]').count(),0,'valid fuzzy searches must not show permission errors');
      }
      await page.screenshot({path:path.join(output,role+'-member-search.png')});
      await page.fill('#chat-info-member-search','陌生');
      if(role==='member')await page.waitForFunction(()=>document.querySelector('.gs-empty')?.textContent==='没有找到匹配的群内好友');
      else await page.waitForFunction(()=>document.querySelector('.gs-member-copy strong')?.textContent==='普通陌生人');
      if(role==='member')assert.equal(await page.locator('[data-gs-person]').count(),0);
      await page.fill('#chat-info-member-search','');
      await page.waitForFunction(()=>document.querySelectorAll('[data-gs-person]').length>0&&!document.querySelector('.gs-search-count'));
      if(role==='member')assert.deepEqual(await page.locator('.gs-member-copy strong').allTextContents(),['群主','群管理员']);
      const peerRow=page.locator('#gs-member-'+await page.evaluate(gid=>GO.local('conversation',gid),gid)+'-'+await page.evaluate(peer=>GO.local('user',peer),peer));
      const badgeCheck=name=>muteBadgeChecks.push({role,name,passed:true});
      const refreshMembers=async()=>{await page.click('#chat-info-members-refresh');await page.waitForFunction(()=>!document.querySelector('#chat-info-members-refresh').disabled);};
      if(role!=='member'){
        assert.equal(await page.locator('.gs-member-muted').count(),0);badgeCheck('unmuted members have no mute badge');
        model.memberMuted=model.permanentMuted=true;await refreshMembers();
        assert.equal(await peerRow.locator('.gs-member-muted').textContent(),'已禁言');
        assert.equal(await peerRow.locator('.gs-member-muted svg').count(),1);badgeCheck('permanent mute displays both icon and text');
        const fits=await peerRow.evaluate(row=>{const copy=row.querySelector('.gs-member-copy').getBoundingClientRect(),badge=row.querySelector('.gs-member-labels').getBoundingClientRect();return copy.right<=badge.left&&badge.right<=row.getBoundingClientRect().right;});
        assert.equal(fits,true);badgeCheck('the status stays to the right of the member name and presence');
        await page.locator('#chat-info-panel').screenshot({path:path.join(output,role+'-member-badge-light.png')});
        await page.evaluate(()=>document.body.classList.add('desktop-night-mode'));
        assert.equal(await peerRow.locator('.gs-member-muted').evaluate(node=>getComputedStyle(node).color),'rgb(255, 173, 175)');
        await page.locator('#chat-info-panel').screenshot({path:path.join(output,role+'-member-badge-dark.png')});
        await page.evaluate(()=>document.body.classList.remove('desktop-night-mode'));badgeCheck('mute badge remains readable in the dark theme');
        await page.fill('#chat-info-member-search','工作');await page.waitForFunction(()=>document.querySelector('.gs-search-count')?.textContent==='找到 1 位成员');
        assert.equal(await peerRow.locator('.gs-member-muted').count(),1);badgeCheck('friend fuzzy search retains the mute badge');
        await page.fill('#chat-info-member-search','');await page.waitForFunction(()=>!document.querySelector('.gs-search-count'));
        model.memberMuted=model.permanentMuted=false;await refreshMembers();assert.equal(await peerRow.locator('.gs-member-muted').count(),0);badgeCheck('unmuting and refreshing removes the badge');
        model.memberMuted=true;model.mutedUntil=new Date(Date.now()+2000).toISOString();await refreshMembers();
        await peerRow.locator('.gs-member-muted').waitFor();
        await peerRow.locator('.gs-member-muted').waitFor({state:'detached'});badgeCheck('a timed mute expires without refreshing the page');
        model.memberMuted=false;model.mutedUntil='';
      }else{
        model.memberMuted=model.permanentMuted=true;await page.fill('#chat-info-member-search','工作');
        await page.waitForFunction(()=>document.querySelector('.gs-search-count')?.textContent==='找到 1 位成员');
        assert.equal(await peerRow.locator('.gs-member-muted').count(),1);badgeCheck('ordinary members only see mute badges within their existing friend-search scope');
        await page.fill('#chat-info-member-search','');await page.waitForFunction(()=>!document.querySelector('.gs-search-count'));
        model.memberMuted=model.permanentMuted=false;
      }
      assert.equal(await page.locator('[data-go-group-controls]').count(),0);
      const positions=await page.evaluate(()=>({head:document.querySelector('#chat-head').getBoundingClientRect().toJSON(),tools:document.querySelector('.chat-head-tools').getBoundingClientRect().toJSON()}));
      assert.ok(positions.head.right-positions.tools.right<30,'header tools must align at the right edge');
      await page.evaluate(()=>{window.__bubble=document.querySelector('#messages .bubble');window.__messages=document.querySelector('#messages');window.__blanked=false;const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');Object.defineProperty(window.__messages,'innerHTML',{get(){return descriptor.get.call(this)},set(value){window.__blanked=true;descriptor.set.call(this,value)}});});
      await page.click('#chat-info-notifications');await page.waitForFunction(()=>document.querySelector('#chat-info-notifications')?.getAttribute('aria-checked')==='false'&&!document.querySelector('#chat-info-notifications').disabled);
      assert.equal(model.muted,true);
      await page.evaluate(gid=>window.__onPacket({type:'membership.changed',conversation_id:gid}),gid);await page.waitForTimeout(450);
      assert.equal(await page.evaluate(()=>__bubble===document.querySelector('#messages .bubble')&&__bubble.isConnected&&!__blanked),true,'notification toggle and realtime echo must retain the message DOM');
      const beforeHint=requests.length;
      await page.evaluate(()=>window.__onPacket({type:'messages.changed',conversation_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}));
      await page.waitForTimeout(300);
      const hintRequests=requests.slice(beforeHint);
      assert.ok(hintRequests.includes('/client/conversation-updates'));
      assert.equal(hintRequests.filter(p=>p==='/client/conversation-page'||p.endsWith('/history')).length,0);
      assert.equal(await page.evaluate(()=>__bubble===document.querySelector('#messages .bubble')&&__bubble.isConnected&&!__blanked),true);
      await page.evaluate(()=>{document.hasFocus=()=>false;const conversation=state.conversations[0];conversation.unread_count=3;renderConversationList();notifyDesktopMessage({id:77,sender_id:state.user.id+1,type:'text',body:{text:'test'}},conversation);});
      assert.equal(await page.evaluate(()=>window.__notifications.length),0,'muted conversations must not notify');
      assert.equal(await page.locator('.conversation .unread.is-muted').count(),1);
      assert.equal(await page.locator('.conversation .unread.is-muted').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(156, 165, 174)');
      for(const theme of ['classic','day','color','night']){
        await page.evaluate(theme=>{document.body.dataset.theme=theme;document.body.classList.toggle('desktop-night-mode',theme==='night');},theme);
        assert.equal(await page.locator('.conversation .unread.is-muted').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(156, 165, 174)',theme+' must keep muted unread counts gray');
      }
      await page.evaluate(()=>{document.body.dataset.theme='classic';document.body.classList.remove('desktop-night-mode');});
      await page.screenshot({path:path.join(output,role+'-notifications-muted.png')});
      await page.evaluate(()=>groupSidebar.reload());await page.waitForFunction(()=>document.querySelector('#chat-info-notifications')?.getAttribute('aria-checked')==='false'&&!document.querySelector('#chat-info-notifications').disabled);
      await page.click('#chat-info-notifications');await page.waitForFunction(()=>document.querySelector('#chat-info-notifications')?.getAttribute('aria-checked')==='true'&&!document.querySelector('#chat-info-notifications').disabled);
      assert.equal(model.muted,false);
      await page.evaluate(()=>notifyDesktopMessage({id:78,sender_id:state.user.id+1,type:'text',body:{text:'test'}},state.conversations[0]));
      assert.equal(await page.evaluate(()=>window.__notifications.length),1,'notifications must resume after enabling');
      if(role!=='member'){
        await page.click('#chat-info-mute');await page.waitForFunction(()=>document.querySelector('#chat-info-mute')?.textContent.includes('解除禁言')&&!document.querySelector('#chat-info-mute').disabled);
        assert.equal(await page.locator('.gs-member-muted').count(),2);
        assert.equal(await page.locator('.gs-member').filter({has:page.locator('.gs-role')}).locator('.gs-member-muted').count(),0);badgeCheck('group-wide mute marks ordinary members and exempts the owner and admins');
        assert.equal(model.allMuted,true);assert.equal(await page.locator('#message-input').isEnabled(),true);
        await page.screenshot({path:path.join(output,role+'-muted.png')});
        await page.click('#chat-info-mute');await page.waitForFunction(()=>document.querySelector('#chat-info-mute')?.textContent.includes('开启禁言')&&!document.querySelector('#chat-info-mute').disabled);
        assert.equal(model.allMuted,false);
        assert.equal(await page.locator('.gs-member-muted').count(),0);badgeCheck('disabling group-wide mute clears its member badges');
      }else{
        assert.equal(await page.locator('#chat-info-mute').count(),0);await page.fill('#message-input','切换禁言后保留这段草稿');model.allMuted=true;
        await page.evaluate(gid=>window.__onPacket({type:'membership.changed',conversation_id:gid}),gid);
        await page.waitForFunction(()=>document.querySelector('#message-input')?.disabled&&document.querySelector('#composer-send-restriction')?.textContent==='已开启禁言');
        assert.equal(await page.locator('.gs-member-muted').count(),0);badgeCheck('the restricted directory does not mark exempt managers or expose hidden ordinary members');
        await page.screenshot({path:path.join(output,'member-muted.png')});
        model.allMuted=false;await page.evaluate(gid=>window.__onPacket({type:'membership.changed',conversation_id:gid}),gid);await page.waitForFunction(()=>!document.querySelector('#message-input').disabled);
        assert.equal(await page.inputValue('#message-input'),'切换禁言后保留这段草稿');
      }
      await page.evaluate(()=>{window.__blanked=false;});model.membership++;
      await page.evaluate(gid=>window.__onPacket({type:'membership.changed',conversation_id:gid}),gid);await page.waitForFunction(()=>window.__blanked===true);
      await page.waitForFunction(()=>state.historyReadyEpoch===state.historyEpoch&&state.initialHistoryFailed===false);
      await page.evaluate(()=>{window.__blanked=false;});
      model.denied=true;await page.evaluate(gid=>window.__onPacket({type:'membership.changed',conversation_id:gid}),gid);await page.waitForFunction(()=>window.__blanked===true);
      assert.deepEqual(errors,[]);results.push({role,checks:'passed',unknownRequests:[...new Set(unknown)]});await page.close();
    }
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
    fs.writeFileSync(path.join(output,'mute-badge-results.json'),JSON.stringify({passed:muteBadgeChecks.length,checks:muteBadgeChecks},null,2));
    console.log(JSON.stringify({output,results,muteBadgeChecks:muteBadgeChecks.length}));
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error.stack);server.close();process.exitCode=1;});
