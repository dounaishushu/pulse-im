const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../client-shared/go-v2.js');
const refresh=require('../pc/web/conversation-refresh.js');
const uuid=n=>String(n).padStart(8,'0')+'-3333-4333-8333-333333333333';
function conversation(id){return {id,kind:'group',title:'group',message_seq:'0',event_seq:'0',membership_version:'1',visible_from_seq:'1',visible_from_event_seq:'1',my_role:'member',can_send:true,unread_count:0,state:{read_seq:'0',delivered_seq:'0',clear_seq:'0',version:'1',personal_seq:'0'},preference_version:'1',updated_at:'2026-11-16T00:00:00Z'};}
function adapter(fetch){const data=new Map();const c=create({base:'https://chat.example.org/api/v2',fetch,storage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)}});c.session('fixture');return c;}

test('会话摘要只批量授权实际显示的会话头像',async()=>{
  const batches=[];
  const c=adapter(async(url,options)=>{
    if(url.includes('/client/conversation-page'))return Response.json({items:[{...conversation(uuid(1)),avatar_id:uuid(3),last_message:{
      id:uuid(4),conversation_id:uuid(1),sender_id:uuid(2),seq:'1',version:'1',kind:'image',body:'',request_id:'fixture',
      created_at:'2026-11-16T00:00:00Z',updated_at:'2026-11-16T00:00:00Z',sender:{avatar_id:uuid(5)},content:{media:{id:uuid(6),bytes:24}}
    }}]});
    assert.ok(url.endsWith('/media/grants'));
    const ids=JSON.parse(options.body).media_ids;batches.push(ids);
    return Response.json({items:ids.map(id=>({id,access:{content_path:'/api/v2/media-grants/'+'a'.repeat(64)+'/content',expires_in:120}}))});
  });
  const result=await c.request('/conversations');
  assert.equal(batches.length,1);assert.deepEqual(batches[0],[uuid(3)]);
  assert.ok(result.items[0].avatar_url);assert.equal(result.items[0].last_message.type,'image');
});

test('多个会话提示只请求一次批量摘要，不退回整页加载',async()=>{
  let calls=0,full=0,applied;
  const c=adapter(async(url,options)=>{
    calls++;assert.ok(url.endsWith('/client/conversation-updates'));
    const ids=JSON.parse(options.body).conversation_ids;
    return Response.json({incremental:true,items:ids.slice(0,-1).map(conversation),removed_ids:ids.slice(-1)});
  });
  const ids=Array.from({length:8},(_,i)=>c.local('conversation',uuid(i+1)));
  const queue=refresh.create({account:()=>({base:'test',token:'fixture',userId:1}),
    load:values=>c.request('/conversations/updates?ids='+values.join(',')),apply:r=>{applied=r;},full:async()=>{full++;}});
  try{queue.hint(ids);await queue.flush();assert.equal(calls,1);assert.equal(full,0);assert.equal(applied.items.length,7);assert.deepEqual(applied.removed_ids,[ids[7]]);}
  finally{queue.dispose();}
});

test('旧服务回退仍区分可访问、隐藏和已退出会话',async()=>{
  const c=adapter(async url=>{
    if(url.endsWith('/client/conversation-updates'))return Response.json({error:{code:'not_found'}},{status:404});
    if(url.endsWith(uuid(3)))return Response.json({error:{code:'forbidden'}},{status:403});
    return Response.json({...conversation(url.split('/').pop()),hidden:url.endsWith(uuid(2))});
  });
  const ids=[1,2,3].map(n=>c.local('conversation',uuid(n)));
  const result=await c.request('/conversations/updates?ids='+ids.join(','));
  assert.equal(result.incremental,true);assert.equal(result.items.length,1);assert.deepEqual(result.removed_ids,ids.slice(1));
});

test('批量摘要不能接收额外会话或缺失结果，也不能把登录失效视为移除',async()=>{
  for(const data of [
    {incremental:true,items:[],removed_ids:[]},
    {incremental:true,items:[conversation(uuid(2))],removed_ids:[]},
    {incremental:true,items:[conversation(uuid(1))],removed_ids:[uuid(1)]}
  ]){
    const c=adapter(async()=>Response.json(data));
    await assert.rejects(c.request('/conversations/updates?ids='+c.local('conversation',uuid(1))),{code:'invalid_response'});
  }
  let calls=0;
  const c=adapter(async()=>{calls++;return Response.json({error:{code:'unauthorized'}},{status:401});});
  await assert.rejects(c.request('/conversations/updates?ids='+c.local('conversation',uuid(1))),{status:401});assert.equal(calls,1);
});

test('摘要批量请求拒绝超出限制的输入',async()=>{
  let calls=0;const c=adapter(async()=>{calls++;return Response.json({});});
  const ids=Array.from({length:101},(_,i)=>c.local('conversation',uuid(i+1)));
  await assert.rejects(c.request('/conversations/updates?ids='+ids.join(',')),{code:'invalid_request'});assert.equal(calls,0);
});
