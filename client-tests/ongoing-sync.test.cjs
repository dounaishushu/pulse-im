const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../client-shared/go-v2.js');
const cid='33333333-3333-4333-8333-333333333333',uid='11111111-1111-4111-8111-111111111111';
const wire=n=>'44444444-4444-4444-8444-'+String(n).padStart(12,'0');
const row=n=>({id:wire(n),conversation_id:cid,sender_id:uid,seq:String(n),event_seq:String(n),version:'1',kind:'text',body:'消息'+n,content:{},request_id:'message-'+n,created_at:'2026-11-17T00:00:00Z',updated_at:'2026-11-17T00:00:00Z'});
function setup(handler){
 const calls=[],values=new Map();
 const client=create({base:'https://chat.example.org/api/v2',storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},fetch:async(url,options)=>{calls.push(new URL(url).pathname);return handler(new URL(url),options);}});
 client.session('session');const id=client.local('conversation',cid);client.version(id,1);
 return {client,id,calls};
}
function response(path,events=[],personal=[]){
 if(path.endsWith('/personal-sync'))return Response.json({events:personal,snapshot_max_seq:String(personal.length),next_after_seq:String(personal.length),has_more:false});
 if(path.endsWith('/sync'))return Response.json({events,membership_version:'1',visible_from_seq:'1',snapshot_max_seq:String(events.at(-1)?.seq||10),next_after_seq:String(events.at(-1)?.seq||10),has_more:false});
 return Response.json({membership_version:'1',visible_from_seq:'1',state:{clear_seq:'0'}});
}
test('新增消息只读取事件，不重新下载完整历史',async()=>{
 const {client,id,calls}=setup(url=>response(url.pathname,[{seq:'11',kind:'message.created',message:row(51)}]));
 const result=await client.delta(id,{events:10,personal:0,membership:1});
 assert.equal(result.items.length,1);assert.equal(result.items[0].id,51);assert.equal(result.cursor.events,11);assert.equal(result.needs_snapshot,false);
 assert.equal(calls.length,3);assert.ok(calls.every(path=>!path.endsWith('/history')&&!path.endsWith('/reply-contexts')));
});
test('没有新事件不补引用或媒体，空结果可推进游标',async()=>{
 const {client,id,calls}=setup(url=>response(url.pathname));let preview;
 const result=await client.delta(id,{events:10,personal:0,membership:1},{onPreview:r=>preview=r});
 assert.deepEqual(result.items,[]);assert.equal(preview.items.length,0);assert.equal(result.cursor.events,10);assert.equal(calls.length,3);
});
test('编辑撤回和个人删除要求重新校验完整窗口及引用',async()=>{
 for(const kind of ['message.edited','message.revoked','message.deleted']){
  const {client,id,calls}=setup(url=>response(url.pathname,kind==='message.deleted'?[]:[{seq:'11',kind,message:{...row(1),version:'2',revoked:kind==='message.revoked'}}],kind==='message.deleted'?[{seq:'1',kind,message_id:wire(1)}]:[]));
  let preview=false;const result=await client.delta(id,{events:10,personal:0,membership:1},{onPreview:()=>preview=true});
  assert.equal(result.needs_snapshot,true);assert.equal(preview,false);assert.deepEqual(result.items,[]);assert.equal(calls.length,3);
 }
});
test('元数据的成员版本改变不能交付旧身份消息',async()=>{
 const {client,id}=setup(url=>url.pathname.endsWith('/sync')||url.pathname.endsWith('/personal-sync')?response(url.pathname,[{seq:'11',kind:'message.created',message:row(51)}]):Response.json({membership_version:'2',state:{clear_seq:'0'},visible_from_seq:'1'}));
 let preview=false;await assert.rejects(client.delta(id,{events:10,personal:0,membership:1},{onPreview:()=>preview=true}),{code:'membership_changed'});assert.equal(preview,false);
});
test('增量页的跨会话消息和停滞游标都被拒绝',async()=>{
 for(const invalid of ['conversation','cursor']){
  const {client,id}=setup(url=>url.pathname.endsWith('/sync')?Response.json({membership_version:'1',events:invalid==='conversation'?[{seq:'11',kind:'message.created',message:{...row(51),conversation_id:uid}}]:[],snapshot_max_seq:'11',next_after_seq:invalid==='cursor'?'10':'11',has_more:invalid==='cursor'}):response(url.pathname));
  await assert.rejects(client.delta(id,{events:10,personal:0,membership:1}),{code:'invalid_response'});
 }
});
test('切换会话和退出后迟到的增量不交付到页面',async()=>{
 const {client,id}=setup(url=>response(url.pathname,[{seq:'11',kind:'message.created',message:row(51)}]));
 let current=false;await assert.rejects(client.delta(id,{events:10,personal:0,membership:1},{current:()=>current}),{code:'stale_session'});
 const abort=new AbortController();abort.abort();await assert.rejects(client.delta(id,{events:10,personal:0,membership:1},{signal:abort.signal}),{name:'AbortError'});
});

// A slow photo cannot keep a subsequently delivered text message behind it.
test('deferred media never blocks new text and cancelled enrichment stays out of the old view', {timeout: 2500}, async () => {
  const media = wire(901);
  const gate = Promise.withResolvers();
  let grantRequests = 0;
  const {client,id} = setup(async (url) => {
    if (url.pathname.endsWith('/media/grants')) {
      grantRequests++;
      await gate.promise;
      return Response.json({items:[{id:media,access:{content_path:'/api/v2/media-grants/'+ 'a'.repeat(64) +'/content',expires_in:120}}]});
    }
    const photo = {...row(51),kind:'image',body:'',content:{media:{id:media,bytes:'1234',mime:'image/png',filename:'photo.png'}}};
    const after = url.searchParams.get('after');
    return response(url.pathname, after === '11'
      ? [{seq:'12',kind:'message.created',message:row(52)}]
      : [{seq:'11',kind:'message.created',message:photo}]);
  });
  const navigation = new AbortController();
  try {
    const photo = await client.delta(id,{events:10,personal:0,membership:1},{deferMedia:true,signal:navigation.signal});
    assert.equal(photo.items[0].body._go_media_id,media);
    assert.equal(photo.items[0].body.media_pending,true);
    assert.ok(photo.enriched);
    const next = await client.delta(id,photo.cursor,{deferMedia:true});
    assert.equal(next.items[0].body.text,'消息52');
    assert.equal(next.cursor.events,12);
    assert.equal(grantRequests,1);
    navigation.abort();
    assert.equal(await photo.enriched,null);
  } finally {
    gate.resolve();
  }
});
