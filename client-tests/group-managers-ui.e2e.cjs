const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=path.resolve(process.env.PULSE_TEST_OUTPUT||path.join(root,'.local/pc-group-managers-20261118/ui'));
fs.mkdirSync(output,{recursive:true});
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1040,height:820}}),errors=[],checks=[];
  page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.setContent('<!doctype html><html lang="zh-CN"><body class="desktop-mode"><aside id="panel" class="classic-info-panel" style="display:flex;position:relative;width:310px;height:780px"></aside></body></html>');
    for(const f of ['style.css','classic-pc.css','group-sidebar.css','group-manager.css'])await page.addStyleTag({path:path.join(root,'pc/web',f)});
    for(const f of ['go-v2.js','message-view.js','group-sidebar.js','group-manager.js'])await page.addScriptTag({path:path.join(root,'pc/web',f)});
    await page.evaluate(()=>{
      const uuid=n=>String(n).padStart(8,'0')+'-7777-4777-8777-777777777777';
      const model=window.model={role:'owner',count:476,admins:new Set(Array.from({length:20},(_,i)=>2+i*23)),block:false,fail:false,tag:'原群'};
      let gate=Promise.resolve(),release=()=>{};
      window.blockManagers=()=>{model.block=true;gate=new Promise(r=>release=r);};
      window.releaseManagers=()=>{model.block=false;release();};
      const roster=()=>Array.from({length:model.count},(_,i)=>({id:uuid(i+1),nickname:model.tag+'成员'+String(i+1).padStart(3,'0'),role:i===0?'owner':model.admins.has(i+1)?'admin':'member',is_contact:false}));
      const rawConversation=id=>({id,kind:'group',title:model.tag,my_role:model.role,membership_version:'1',preference_version:'1',visible_from_seq:'1',message_seq:'0',unread_count:0,updated_at:'2026-11-18T00:00:00Z',state:{clear_seq:'0'},member_count:model.count,can_send:true});
      const storage=new Map();
      const go=window.go=PulseGoV2.create({base:'https://fixture.invalid/api/v2',storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},fetch:async(raw,options)=>{
        const u=new URL(raw),p=u.pathname.replace('/api/v2',''),id=p.split('/')[2];
        if(p==='/groups/'+id)return Response.json({...rawConversation(id),owner_id:uuid(1),member_limit:10000,block_member_friend_requests:model.role==='member'});
        if(p==='/conversations/'+id)return Response.json(rawConversation(id));
        if(p.endsWith('/member-profiles')){
          if(!u.searchParams.has('q')){
            if(model.fail)return Response.json({error:{code:'unavailable'}},{status:503});
            if(model.block)await Promise.race([gate,new Promise((_,reject)=>options.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}))]);
          }
          options.signal?.throwIfAborted();
          const all=roster().filter(p=>model.role!=='member'||p.role!=='member'),after=u.searchParams.get('after')||'',remaining=all.filter(p=>p.id>after),items=remaining.slice(0,100);
          return Response.json({items,query:'',search_scope:model.role==='member'?'friends':'group',members_visibility:model.role==='member'?'managers':'all',next_after:remaining.length>100?items.at(-1).id:''});
        }
        throw Error('Unexpected fixture request '+p);
      }});
      go.session('fixture');
      const id=go.local('conversation',uuid(9000));
      const ctx=window.ctx={id,groupId:id,userId:go.local('user',uuid(1)),token:'fixture',scope:'fixture',base:go.base,conversation:{id,type:'group',name:'原群',member_count:476}};
      const escape=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const request=(route,options)=>go.request(route,options);
      window.sidebar=PulseGroupSidebar.create({context:()=>ctx,active:info=>info.id===ctx.id,request,icon:()=>'',escape,mediaUrl:x=>x,publicId:()=>'',presence:()=> '最近上线时间已隐藏',changed:()=>{},manage:()=>{},invite:()=>{},profile:()=>{},closePanel:()=>window.sidebar.close()});
      window.manager=PulseGroupManager.create({context:()=>ctx,request,mediaUrl:x=>x,changed:()=>{},upload:()=>{},exited:()=>{},openProfile:()=>{}});
      window.openSidebar=()=>sidebar.open({id:ctx.id},document.getElementById('panel'));
    });
    const check=name=>checks.push({name,passed:true});
    const adminCount=()=>page.locator('#panel .gs-role.admin').count();
    await page.evaluate(async()=>{blockManagers();await openSidebar();window.keptRow=[...document.querySelectorAll('#panel .gs-member')].find(p=>!p.querySelector('.gs-role'));});
    assert.equal(await adminCount(),5);assert.equal(await page.locator('#panel .gs-member').count(),100);
    check('initial member page remains visible while the complete manager request is held');
    await page.evaluate(()=>releaseManagers());await page.waitForFunction(()=>document.querySelectorAll('#panel .gs-role.admin').length===20);
    assert.equal(await page.locator('#panel .gs-role.owner').count(),1);
    assert.deepEqual(await page.locator('#panel .gs-member').evaluateAll(nodes=>nodes.slice(0,21).map(n=>n.querySelector('.gs-role')?.classList.contains('owner')?'owner':n.querySelector('.gs-role')?.classList.contains('admin')?'admin':'member')),['owner',...Array(20).fill('admin')]);
    assert.equal(await page.evaluate(()=>keptRow.isConnected&&document.getElementById(keptRow.id)===keptRow),true);
    check('all twenty admins follow the owner before ordinary members, without replacing existing rows');
    await page.evaluate(()=>document.querySelector('[data-gs-members-more]').click());
    await page.waitForFunction(()=>document.querySelectorAll('#panel .gs-member').length>=200);
    assert.equal(await adminCount(),20);
    assert.equal(await page.locator('#panel .gs-member').evaluateAll(nodes=>new Set(nodes.map(n=>n.id)).size===nodes.length),true);
    check('loading ordinary member pages keeps all administrators at the top without duplicates');
    await page.evaluate(()=>manager.open(ctx.conversation,true));
    await page.waitForSelector('[data-gm="admins"]');assert.equal(await page.locator('[data-gm="admins"] small').textContent(),'20');
    await page.click('[data-gm="admins"]');assert.equal(await page.locator('.gm-layer:last-child .gm-role.admin').count(),20);
    assert.equal(await page.locator('.gm-layer:last-child .gm-role.owner').count(),1);
    check('management count is twenty administrators and the owner remains separately labelled');
    await page.screenshot({path:path.join(output,'twenty-administrators.png')});
    await page.evaluate(()=>manager.close(false));
    await page.evaluate(async()=>{model.admins.add(3);await sidebar.reload();});await page.waitForFunction(()=>document.querySelectorAll('#panel .gs-role.admin').length===21);
    await page.evaluate(async()=>{model.admins.delete(2);model.admins.delete(25);await sidebar.reload();});await page.waitForFunction(()=>document.querySelectorAll('#panel .gs-role.admin').length===19);
    check('refresh reflects additions and removals instead of a fixed administrator count');
    await page.evaluate(async()=>{model.fail=true;await sidebar.reload();});
    await page.waitForSelector('[data-gs-managers-retry]');assert.ok(await page.locator('#panel .gs-member').count()>0);
    await page.evaluate(()=>{model.fail=false;document.querySelector('[data-gs-managers-retry]').click();});
    await page.waitForFunction(()=>document.querySelectorAll('#panel .gs-role.admin').length===19&&!document.querySelector('[data-gs-managers-retry]'));
    check('a failed completion preserves visible rows and an explicit retry fills the actual roster');
    await page.evaluate(async()=>{blockManagers();await sidebar.reload();sidebar.close();ctx.id=ctx.groupId=go.local('conversation','00009001-7777-4777-8777-777777777777');ctx.conversation={id:ctx.id,type:'group',name:'新群',member_count:3};model.count=3;model.admins=new Set([2]);model.tag='新群';releaseManagers();await openSidebar();});
    await page.waitForFunction(()=>document.querySelectorAll('#panel .gs-member').length===3);
    assert.ok((await page.locator('#panel .gs-member-copy strong').allTextContents()).every(x=>x.startsWith('新群')));
    check('late completion after a group switch cannot restore the previous group roster');
    await page.evaluate(async()=>{sidebar.close();model.role='member';model.count=476;model.admins=new Set(Array.from({length:120},(_,i)=>i+2));ctx.userId=go.local('user','00009002-7777-4777-8777-777777777777');await openSidebar();});
    await page.waitForFunction(()=>document.querySelectorAll('#panel .gs-role.admin').length===120);
    assert.equal(await page.locator('#panel .gs-member').count(),121);
    assert.equal(await page.locator('#panel .gs-member:not(:has(.gs-role))').count(),0);
    check('ordinary members can see more than one hundred managers without seeing ordinary strangers');
    await page.evaluate(async()=>{sidebar.close();model.role='owner';model.admins=new Set(Array.from({length:20},(_,i)=>2+i*23));blockManagers();await openSidebar();});
    assert.ok(await page.locator('#panel .gs-member:not(:has(.gs-role))').count()>0);
    await page.evaluate(()=>{model.role='member';releaseManagers();});
    await page.waitForFunction(()=>document.querySelectorAll('#panel .gs-role.admin').length===20&&document.querySelectorAll('#panel .gs-member').length===21);
    assert.equal(await page.locator('#panel .gs-member:not(:has(.gs-role))').count(),0);
    check('a viewer demotion during completion clears the old ordinary roster and reloads under the new privacy scope');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:checks.length,checks,pageErrors:errors},null,2));
    console.log(JSON.stringify({passed:checks.length,output}));
  }finally{await page.close();await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
