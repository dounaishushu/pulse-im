const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {create}=require('../client-shared/go-v2.js');
const cid='33333333-3333-4333-8333-333333333333',uid='11111111-1111-4111-8111-111111111111',mid='22222222-2222-4222-8222-222222222222';
function adapter(fetch){const values=new Map();const c=create({base:'https://chat.example.org/api/v2',fetch,storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)}});c.session('fixture');return c;}
function ui(overrides={}){
  const box={innerHTML:'messages',querySelectorAll:()=>[],getBoundingClientRect:()=>({top:0,bottom:10})};
  const state={token:'fixture',user:{id:1},active:{id:1},conversations:[{id:1}],historyEpoch:1,initialHistory:{},initialHistoryFailed:false};
  const no=()=>{};
  const c={console,AbortSignal,setTimeout,clearTimeout,setInterval:()=>0,clearInterval:no,window:{},document:{hidden:false,hasFocus:()=>false,addEventListener:no},state,
    GO:{local:()=>1,requireVersion:no},readPasscodeSettings:()=>({locked:false}),$:()=>box,
    openConversation:async()=>{},fetchInitialHistory:async()=>{},loadOlderMessages:async()=>{},loadConversations:async()=>true,visibleConversationMessages:()=>[],
    cancelConversationRecovery:no,conversationViews:{clear:no},syncPulseMessageCache:()=>({clear:no}),updateDesktopChat:no,syncChatInfoNotification:no,
    composerPermissions:{check:no},api:async()=>{},...overrides};
  let s=fs.readFileSync(path.join(__dirname,'../client-shared/go-v2-ui.js'),'utf8');
  s=s.slice(0,s.indexOf('  const originalClear='))+'window.probe={schedule,onPacket};})();';
  vm.runInNewContext(s,c);return {c,state,box};
}
test('其他会话的消息只更新摘要，不读取当前历史',async()=>{
  let full=0,history=0,delta=[];
  const {c,state}=ui({GO:{local:()=>2,requireVersion:()=>{}},
    conversationRefresh:{hint:ids=>{delta.push(...ids);},flush:async()=>{}},
    loadConversations:async()=>{full++;return true;},api:async()=>{history++;throw Error('不应读取');}});
  state.initialHistory=null;state.historyReadyEpoch=1;
  c.window.probe.onPacket({type:'message.changed',conversation_id:cid});
  await new Promise(r=>setTimeout(r,120));state.token='';
  assert.equal(full,0);assert.equal(history,0);assert.deepEqual(delta,[2]);
});
test('刷新期间收到的新提示保持增量范围，不被重新安排成整页加载',async()=>{
  let full=0,finish,loads=0;const hints=[];
  const {c,state}=ui({GO:{local:(_,value)=>Number(value),requireVersion:()=>{}},
    conversationRefresh:{hint:ids=>{hints.push([...ids]);},flush:async()=>{if(++loads===1)await new Promise(resolve=>{finish=resolve;});}},
    loadConversations:async()=>{full++;return true;}});
  c.window.probe.onPacket({type:'message.changed',conversation_id:'2'});
  await new Promise(r=>setTimeout(r,100));assert.ok(finish);
  c.window.probe.onPacket({type:'message.changed',conversation_id:'3'});finish();
  await new Promise(r=>setTimeout(r,120));state.token='';
  assert.equal(full,0);assert.deepEqual(hints,[[2],[3]]);
});
test('连续事件不能饿死已排队的刷新',async()=>{
  let calls=0;const {c,state}=ui({loadConversations:async()=>{calls++;return true;}});
  c.window.probe.schedule();
  const timer=setInterval(()=>c.window.probe.schedule(),10);
  await new Promise(r=>setTimeout(r,220));clearInterval(timer);
  assert.ok(calls>=2,'持续事件期间应已执行刷新');state.token='';await new Promise(r=>setTimeout(r,90));
});
test('旧会话的权限错误不能覆盖新会话',async()=>{
  let reject;const {c,state,box}=ui({fetchInitialHistory:()=>new Promise((_,r)=>{reject=r;})});
  const old=c.fetchInitialHistory({token:'fixture',conversationId:1,epoch:1});
  state.active={id:2};state.historyEpoch=2;box.innerHTML='new conversation';
  reject(Object.assign(new Error('denied'),{status:403}));await assert.rejects(old);
  assert.equal(box.innerHTML,'new conversation');
});
test('点击当前会话不强制重建历史，连接就绪不清空在途历史',async()=>{
  const {c,state,box}=ui();await c.openConversation(1);
  assert.equal(state.initialHistoryFailed,false);c.window.probe.onPacket({type:'ready'});
  assert.equal(box.innerHTML,'messages');state.token='';await new Promise(r=>setTimeout(r,90));
});
test('拒绝的图片短暂退避且手动重试和新登录可恢复',async()=>{
  let calls=0;const c=adapter(async()=>{calls++;return Response.json({error:{code:'forbidden'}},{status:403});});
  for(let i=0;i<20;i++)await assert.rejects(c.mediaGrant(mid,'fixture'));
  assert.equal(calls,1);await assert.rejects(c.mediaGrant(mid,'fixture',undefined,true));assert.equal(calls,2);
  c.session('new');await assert.rejects(c.mediaGrant(mid,'new'));assert.equal(calls,3);
});
test('已读状态只刷新会话摘要，不重复下载历史',async()=>{
  let history=0,directory=0;
  const {c,state}=ui({loadConversations:async()=>{directory++;return true;},api:async()=>{history++;throw Error('不应重载历史');}});
  state.initialHistory=null;state.historyReadyEpoch=1;
  c.window.probe.onPacket({type:'state.changed'});
  await new Promise(r=>setTimeout(r,120));
  assert.equal(directory,1);assert.equal(history,0);state.token='';
});
test('首屏读取期间的新消息提示保留补同步，干净首屏不会重复拉取',async()=>{
  let pages=0;
  const {c,state}=ui({fetchInitialHistory:async()=>({items:[],membership_version:1,cleared_before_message_id:0}),loadConversations:async()=>{pages++;return true;}});
  const first={token:'fixture',conversationId:1,epoch:1};state.initialHistory=first;
  await c.fetchInitialHistory(first);state.initialHistory=null;c.recoverConversation();
  await new Promise(r=>setTimeout(r,110));assert.equal(pages,0);
  const second={token:'fixture',conversationId:1,epoch:1};state.initialHistory=second;
  c.window.probe.schedule(false,true,1);assert.equal(second.goHistoryDirty,true);
  await c.fetchInitialHistory(second);state.initialHistory=null;c.recoverConversation();
  await new Promise(r=>setTimeout(r,110));assert.equal(pages,1);state.token='';
});
test('群成员首屏只请求一页且头像仅一次批量授权',async()=>{
  let pages=0,batches=0;
  const c=adapter(async(url,options)=>{
    const u=new URL(url),p=u.pathname;
    if(p.endsWith('/media/grants')){batches++;return Response.json({items:JSON.parse(options.body).media_ids.map(id=>({id,access:{content_path:'/api/v2/media-grants/'+'a'.repeat(64)+'/content',expires_in:120}}))});}
    if(p.endsWith('/member-profiles')){pages++;return Response.json({query:'',search_scope:'group',members_visibility:'all',next_after:uid,items:[{id:uid,avatar_id:mid,role:'owner'}]});}
    if(p.includes('/groups/'))return Response.json({id:cid,kind:'group',title:'group',my_role:'owner',owner_id:uid,member_count:512});
    return Response.json({id:cid,kind:'group',title:'group',message_seq:'0',event_seq:'0',membership_version:'1',visible_from_seq:'1',visible_from_event_seq:'1',my_role:'owner',can_send:true,unread_count:0,state:{read_seq:'0',delivered_seq:'0',clear_seq:'0',version:'1',personal_seq:'0'},preference_version:'1',updated_at:'2026-11-16T00:00:00Z'});
  });
  const result=await c.request('/conversations/members?conversation_id='+c.local('conversation',cid)+'&page=1');
  assert.equal(pages,1);assert.equal(batches,1);assert.equal(result.has_more,true);assert.equal(result.items.length,1);assert.ok(result.items[0].avatar_url);
});
