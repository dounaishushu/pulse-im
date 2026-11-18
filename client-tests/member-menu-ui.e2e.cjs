// Isolated browser fixture: production member menu + Go adapter, no live accounts.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.env.PULSE_TEST_OUTPUT||'.local/pc-member-menu-20261118/ui');
fs.mkdirSync(output,{recursive:true});
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1000,height:740}}),errors=[],checks=[];
  page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.setContent('<!doctype html><html lang="zh-CN"><body class="desktop-mode"><header id="chat-head">群聊测试</header><div id="messages" style="height:550px;overflow:auto"></div><form id="composer"><textarea id="message-input"></textarea></form><button id="roster-person">成员476</button></body></html>');
    await page.addStyleTag({path:path.join(root,'pc/web/message-actions.css')});
    await page.addScriptTag({path:path.join(root,'pc/web/go-v2.js')});
    await page.evaluate(()=>{
      const uuid=n=>String(n).padStart(8,'0')+'-7777-4777-8777-777777777777';
      const cid=uuid(9000),peer=uuid(476),other=uuid(475),owner=uuid(1),storage=new Map();
      window.model={role:'owner',targetRole:'member',muted:false,removed:false,denied:false,hold:false,requests:[],writes:[],active:0};
      let gate=Promise.resolve(),release=()=>{};
      window.holdLookup=()=>{model.hold=true;gate=new Promise(r=>release=r);};
      window.releaseLookup=()=>{model.hold=false;release();};
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const rows=()=>Array.from({length:476},(_,i)=>({id:uuid(i+1),nickname:'成员'+(i+1),avatar_id:uuid(10000+i),role:i===0?'owner':i===475?model.targetRole:'member',muted:i===475&&model.muted,muted_permanent:i===475&&model.muted})).filter(row=>!model.removed||row.id!==peer);
      window.go=PulseGoV2.create({base:'https://fixture.invalid/api/v2',storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},fetch:async(raw,options)=>{
        const u=new URL(raw),p=u.pathname.replace('/api/v2','');model.requests.push({p,method:options.method,after:u.searchParams.get('after'),limit:u.searchParams.get('limit')});model.active++;
        try{
          if(model.denied)return Response.json({error:{code:'forbidden'}},{status:403});
          if(p===`/groups/${cid}`)return Response.json({id:cid,kind:'group',status:'active',title:'菜单测试群',my_role:model.role,owner_id:owner,member_count:476,block_member_friend_requests:true});
          if(p===`/conversations/${cid}`)return Response.json({id:cid,kind:'group',title:'菜单测试群',my_role:model.role,membership_version:'1',preference_version:'1',visible_from_seq:'1',message_seq:'2',unread_count:0,state:{clear_seq:'0'},updated_at:'2026-11-18T00:00:00Z'});
          if(p.endsWith('/member-profiles')){
            if(model.hold)await new Promise((resolve,reject)=>{
              const abort=()=>reject(options.signal.reason);options.signal.addEventListener('abort',abort,{once:true});
              gate.then(()=>{options.signal.removeEventListener('abort',abort);resolve();});if(options.signal.aborted)abort();
            });
            options.signal.throwIfAborted();
            await wait(120);
            const after=u.searchParams.get('after')||'',limit=Number(u.searchParams.get('limit')||100),all=rows().filter(row=>row.id>after&&(model.role!=='member'||row.role!=='member')),items=all.slice(0,limit);
            return Response.json({items,query:'',search_scope:model.role==='member'?'friends':'group',members_visibility:model.role==='member'?'managers':'all',next_after:all.length>limit?items.at(-1).id:''});
          }
          if(p==='/media/grants'){
            await wait(400);
            return Response.json({items:JSON.parse(options.body).media_ids.map(id=>({id,access:{content_path:'/api/v2/media-grants/'+'a'.repeat(64)+'/content',expires_in:120}}))});
          }
          if(p===`/groups/${cid}/members/${peer}/muted`){
            const body=JSON.parse(options.body);model.writes.push({p,body});model.muted=body.minutes!==0;return new Response(null,{status:204});
          }
          if(p===`/groups/${cid}/members/${peer}`&&options.method==='DELETE'){model.writes.push({p});model.removed=true;return new Response(null,{status:204});}
          if(p.endsWith('/pins'))return Response.json({items:[]});
          throw Error('Unexpected fixture request '+p);
        }finally{model.active--;}
      }});go.session('fixture');
      const id=go.local('conversation',cid),sender=go.local('user',peer),second=go.local('user',other);
      window.state={token:'fixture',user:{id:go.local('user',owner),nickname:'群主'},active:{id,type:'group',status:'active',my_role:'owner',owner_id:go.local('user',owner),can_publish:true},page:'messages',historyEpoch:1};
      window.desktop={isDesktop:true};window.api=(p,o)=>go.request(p,o);
      window.escapeHtml=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.contactDisplayName=(id,fallback)=>fallback;window.messageVersionCache=()=>new Map();
      window.messageHtml=m=>`<article class="bubble text-message" data-message-id="${m.id}" style="margin:15px;padding:12px;background:#e9f3e6"><span class="message-text-content">${escapeHtml(m.body.text)}</span></article>`;
      window.bindMessageActions=()=>{};window.restoreRecoveryScroll=()=>{};window.updateDesktopChat=()=>{};
      window.openConversation=id=>{state.active={...state.active,id};};window.switchPage=p=>{state.page=p;};window.renderShell=()=>{};
      window.handleSocketPacket=()=>{};window.updateInternalMessage=()=>{};window.canEditMessage=()=>false;
      window.PulseGroupMentions={refresh(){},remember(p){window.mentioned=p;}};
      window.fixtureMessages=[{id:1,conversation_id:id,sender_id:sender,sender_name:'成员476',type:'text',body:{text:'右键头像测试'},status:'sent'},{id:2,conversation_id:id,sender_id:second,sender_name:'成员475',type:'text',body:{text:'第二位成员'},status:'sent'}];
      window.rosterMember={user_id:sender,nickname:'成员476',role:'member',is_muted:false};
      window.openRoster=()=>{window.rosterAbort=new AbortController();PulseMessageActions.memberMenu({member:rosterMember,current:()=>rosterMember,signal:rosterAbort.signal,opener:document.getElementById('roster-person'),x:500,y:80,changed:()=>{window.rosterChanges=(window.rosterChanges||0)+1;}});};
    });
    await page.addScriptTag({path:path.join(root,'pc/web/message-actions.js')});
    await page.evaluate(()=>{document.getElementById('messages').innerHTML=fixtureMessages.map(messageHtml).join('');bindMessageActions();});
    await page.waitForFunction(()=>model.active===0);
    const check=name=>checks.push({name,passed:true});
    const open=async(n=1)=>page.evaluate(n=>{
      const avatar=document.querySelector(`[data-group-avatar-message="${n}"]`),started=performance.now();window.menuStart=started;
      avatar.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:140,clientY:100}));
      return {present:!!document.querySelector('.group-member-menu'),openMS:performance.now()-started};
    },n);
    const ready=()=>page.waitForFunction(()=>document.querySelector('[data-member-action="mute"]')?.disabled===false&&document.querySelector('[data-member-action="mute"]').title==='');
    const close=async()=>{await page.keyboard.press('Escape');await page.waitForFunction(()=>model.active===0);};
    await page.evaluate(()=>model.requests=[]);
    const opening=await open();await ready();
    const probe=await page.evaluate(()=>({readyMS:Math.round(performance.now()-menuStart),requests:model.requests}));
    fs.writeFileSync(path.join(output,'latency.json'),JSON.stringify({...opening,...probe},null,2));
    if(process.env.PULSE_MENU_PROBE_ONLY==='1'){console.log(JSON.stringify({...opening,...probe}));return;}
    assert.equal(opening.present,true);assert.ok(opening.openMS<100);
    assert.ok(probe.readyMS<700,'bounded lookup should not wait for full-roster and avatar delays');
    assert.equal(probe.requests.filter(r=>r.p.endsWith('/member-profiles')).length,1);
    assert.equal(probe.requests.find(r=>r.p.endsWith('/member-profiles')).limit,'1');
    assert.equal(probe.requests.filter(r=>r.p.includes('/media')||r.p.startsWith('/conversations/')).length,0);
    check('right-click immediately paints the menu and checks one far-page member without media or conversation requests');
    await page.screenshot({path:path.join(output,'member-menu.png')});
    await page.click('[data-member-action="mute"]');await page.waitForSelector('.group-member-menu',{state:'detached'});
    assert.deepEqual(await page.evaluate(()=>model.writes.map(r=>r.body.minutes)),[-1]);
    await open();await page.waitForFunction(()=>document.querySelector('[data-member-action="mute"]')?.textContent==='解除禁言');
    await page.click('[data-member-action="mute"]');await page.waitForSelector('.group-member-menu',{state:'detached'});
    assert.deepEqual(await page.evaluate(()=>model.writes.map(r=>r.body.minutes)),[-1,0]);
    check('permanent mute and unmute retain their displayed intent with bounded confirmation');
    await page.evaluate(()=>{model.writes=[];holdLookup();});await open();
    assert.equal(await page.locator('[data-member-action="mute"]').isEnabled(),true);
    await page.click('[data-member-action="mute"]');
    assert.match(await page.locator('[data-member-action="mute"]').textContent(),/正在/);
    await page.evaluate(()=>document.querySelector('[data-member-action="mute"]').click());
    assert.equal(await page.evaluate(()=>model.writes.length),0);
    await page.evaluate(()=>releaseLookup());await page.waitForSelector('.group-member-menu',{state:'detached'});
    assert.equal(await page.evaluate(()=>model.writes.length),1);
    check('a click during a slow permission lookup responds immediately and cannot submit duplicate mutes');
    await page.evaluate(()=>{model.writes=[];holdLookup();});await open();
    assert.equal(await page.locator('[data-member-action="mute"]').textContent(),'禁言');
    await page.click('[data-member-action="mute"]');await page.evaluate(()=>releaseLookup());
    await page.waitForSelector('.group-member-menu',{state:'detached'});
    assert.deepEqual(await page.evaluate(()=>model.writes.map(r=>r.body.minutes)),[-1]);
    assert.equal(await page.evaluate(()=>model.muted),true);
    check('a click before mute status arrives preserves the displayed mute intent instead of unmuting');
    await open();await ready();await page.evaluate(()=>{model.writes=[];model.role='member';});
    await page.click('[data-member-action="mute"]');await page.waitForSelector('.group-member-menu',{state:'detached'});
    assert.equal(await page.evaluate(()=>model.writes.length),0);
    assert.match(await page.locator('#message-action-toast').textContent(),/仅群主或管理员/);
    check('demotion after opening the menu blocks the write using fresh permissions');
    await page.evaluate(()=>{model.role=state.active.my_role='admin';model.targetRole='admin';});await open();
    await page.waitForFunction(()=>document.querySelector('[data-member-action="mute"]')?.title==='管理员不能管理其他管理员');
    assert.equal(await page.locator('[data-member-action="mute"]').isDisabled(),true);await close();
    check('administrators cannot mute other administrators');
    await page.evaluate(()=>{model.role=state.active.my_role='owner';model.targetRole='member';model.removed=true;});await open();
    await page.waitForFunction(()=>document.querySelector('[data-member-action="mute"]')?.title==='该成员已不在群内');
    assert.equal(await page.locator('[data-member-action="mute"]').isDisabled(),true);await close();
    check('departed members never turn into a neighboring member in the directory');
    await page.evaluate(()=>{model.removed=false;holdLookup();});await open();await page.keyboard.press('Escape');
    await page.waitForFunction(()=>model.active===0);await page.evaluate(()=>releaseLookup());
    assert.equal(await page.locator('.group-member-menu').count(),0);
    check('closing the menu cancels the pending permission lookup');
    await page.evaluate(()=>holdLookup());await open();await open(2);await page.evaluate(()=>releaseLookup());await ready();
    await page.click('[data-member-action="mention"]');await page.waitForSelector('.group-member-menu',{state:'detached'});
    assert.equal(await page.inputValue('#message-input'),'@成员475 ');
    assert.equal(await page.evaluate(()=>mentioned.user_id),await page.evaluate(()=>fixtureMessages[1].sender_id));
    check('rapid right-clicks on different senders keep the selected mention identity');
    await page.evaluate(()=>{rosterMember.is_muted=true;openRoster();});
    await ready();await page.click('[data-member-action="mute"]');await page.waitForSelector('.group-member-menu',{state:'detached'});
    assert.equal(await page.evaluate(()=>rosterChanges),1);
    check('the member sidebar shares the fast menu and still refreshes after a successful action');
    await page.evaluate(()=>{model.denied=true;});await open();
    await page.waitForFunction(()=>document.querySelector('#message-action-toast')?.textContent.includes('没有操作权限'));
    assert.equal(await page.locator('[data-member-action="mute"]').isDisabled(),true);await close();
    await page.evaluate(()=>{model.denied=false;});
    check('failed authorization leaves moderation disabled');
    await open();await ready();await page.click('[data-member-action="remove"]');
    assert.equal(await page.locator('[data-group-member-dialog="remove"]').isVisible(),true);
    await page.click('[data-member-confirm]');await page.waitForSelector('[data-group-member-dialog]',{state:'detached'});
    assert.equal(await page.evaluate(()=>model.removed),true);
    check('kick confirmation remains available and checks permissions again before removing');
    await page.evaluate(()=>{model.removed=false;holdLookup();});await open();
    await page.evaluate(()=>{openConversation(9001);releaseLookup();});await page.waitForFunction(()=>model.active===0);
    assert.equal(await page.locator('.group-member-menu').count(),0);
    check('switching conversations discards a late menu response');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:checks.length,checks,pageErrors:errors,latency:{...opening,...probe}},null,2));
    console.log(JSON.stringify({passed:checks.length,output,opening,readyMS:probe.readyMS}));
  }finally{await page.close();await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
