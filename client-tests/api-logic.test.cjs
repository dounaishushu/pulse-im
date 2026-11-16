const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../client-shared/go-v2.js');
const uid='11111111-1111-4111-8111-111111111111',cid='33333333-3333-4333-8333-333333333333',mid='22222222-2222-4222-8222-222222222222';
function adapter(fetch){const data=new Map();const c=create({base:'https://chat.example.org/api/v2',fetch,storage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)}});c.session('test-session');return c;}
function message(seq){return {id:mid,conversation_id:cid,sender_id:uid,seq:String(seq),version:'1',kind:'text',body:'test',request_id:'test',created_at:'2026-11-16T00:00:00Z',updated_at:'2026-11-16T00:00:00Z',content:{}};}

test('头像授权的登录过期不能被伪装成个人资料成功',async()=>{
  for(const status of [401,429,503]){
    const c=adapter(async url=>url.endsWith('/me/profile')?Response.json({id:uid,avatar_id:mid}):Response.json({error:{code:status===401?'unauthorized':'unavailable'}},{status}));
    await assert.rejects(c.request('/auth/me'),e=>e.status===status);
  }
});

test('不可访问头像仍可用默认头像，批量授权故障须保留错误状态',async()=>{
  for(const status of [403,404]){
    const c=adapter(async url=>url.endsWith('/me/profile')?Response.json({id:uid,avatar_id:mid}):Response.json({error:{code:'forbidden'}},{status}));
    assert.equal((await c.request('/auth/me')).avatar_url,'');
  }
  const c=adapter(async url=>url.includes('/history?')?Response.json({items:[{...message(1),sender:{avatar_id:mid}}],membership_version:'1',snapshot_max_seq:'1',next_after_seq:'1',clear_seq:'0',visible_from_seq:'1'}):Response.json({error:{code:'unavailable'}},{status:503}));
  await assert.rejects(c.request('/messages/history?conversation_id='+c.local('conversation',cid)),{status:503});
});

test('取消头像加载不能返回过期的页面结果',async()=>{
  const controller=new AbortController();
  let entered;const started=new Promise(r=>{entered=r;});
  const c=adapter(async url=>{
    if(url.endsWith('/me/profile'))return Response.json({id:uid,avatar_id:mid});
    entered();await new Promise(r=>setTimeout(r,30));return Response.json({content_path:'/api/v2/media-grants/'+'a'.repeat(64)+'/content',expires_in:120});
  });
  const request=c.request('/auth/me',{signal:controller.signal});await started;controller.abort();
  await assert.rejects(request,{name:'AbortError'});
});

test('单条已读回执不能被转换成整段历史已读',async()=>{
  const requests=[];
  const c=adapter(async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return Response.json({status:'read'});});
  const id=c.local('conversation',cid);c.message(message(5));
  await c.request('/messages/receipt',{method:'POST',body:{conversation_id:id,message_id:5,status:'read'}});
  assert.equal(requests.length,1);assert.ok(requests[0].url.endsWith('/messages/'+mid+'/receipt'));
  assert.deepEqual(requests[0].body,{status:'read'});
});

test('非法回执状态不能默认为已读',async()=>{
  let calls=0;const c=adapter(async()=>{calls++;return Response.json({});});
  await assert.rejects(c.request('/messages/receipt',{method:'POST',body:{conversation_id:c.local('conversation',cid),through_message_id:5,status:'unknown'}}),{code:'invalid_request'});
  assert.equal(calls,0);
});
test('范围回执返回服务端未读数，已送达保持独立操作',async()=>{
  for(const status of ['read','delivered']){
    const requests=[];
    const c=adapter(async(url,options)=>{
      requests.push(url);
      if(url.endsWith('/unread'))return Response.json({count:4,truncated:false});
      assert.ok(url.endsWith('/'+status));assert.deepEqual(JSON.parse(options.body),{seq:'5'});return Response.json({});
    });
    const id=c.local('conversation',cid);
    const result=await c.request('/messages/receipt',{method:'POST',body:{conversation_id:id,through_message_id:5,status}});
    assert.equal(result.unread_count,4);assert.equal(result.through_message_id,5);assert.equal(result.status,status);assert.equal(requests.length,2);
  }
});
