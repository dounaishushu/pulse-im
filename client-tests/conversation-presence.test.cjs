const {test}=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../pc/web/conversation-presence.js'),{create:createGo}=require('../client-shared/go-v2.js');
const turn=()=>new Promise(r=>setImmediate(r));
function controller(){
  let time=1000,changes=0,handler;
  const c={base:'fixture',token:'a',userId:10,visible:true,rows:[{id:1,peer_user_id:20}]},calls=[];
  const reply=rows=>({items:rows.map(r=>({...r,peer_online:true,peer_last_seen_hidden:false})),removed_ids:[]});
  const api=create({context:()=>c,now:()=>time,changed:()=>changes++,load:async(rows,account,options)=>{calls.push({rows,account:{...account},...options});return handler?handler(rows):reply(rows);}});
  return {api,c,calls,reply,get changes(){return changes;},advance:ms=>time+=ms,handle:f=>handler=f};
}
test('sidebar presence is batched, cached, and refreshed without opening chats',async()=>{
  const f=controller();f.c.rows.push({id:2,peer_user_id:30});await f.api.refresh();assert.equal(f.calls.length,1);assert.equal(f.calls[0].rows.length,2);assert.equal(f.api.get(f.c.rows[0]).peer_online,true);
  await f.api.refresh();assert.equal(f.calls.length,1);f.advance(30000);await f.api.refresh();assert.equal(f.calls.length,2);
});
test('hidden, invalid, self, and duplicate targets do not become fake offline users',async()=>{
  const f=controller();f.c.visible=false;await f.api.refresh();assert.equal(f.calls.length,0);f.c.visible=true;f.c.rows.push({id:1,peer_user_id:20},{id:2,peer_user_id:10},{id:-1,peer_user_id:9});
  f.handle(rows=>({items:rows.map(r=>({...r,peer_online:false,peer_last_seen_hidden:true})),removed_ids:[]}));await f.api.refresh();assert.equal(f.calls[0].rows.length,1);assert.equal(f.api.get(f.c.rows[0]).peer_online,null);assert.equal(f.api.get({id:99,peer_user_id:8}),null);
});
test('a changed privacy rule clears an earlier online state',async()=>{
  const f=controller();await f.api.refresh();f.advance(30000);f.handle(rows=>({items:rows.map(r=>({...r,peer_online:false,peer_last_seen_hidden:true})),removed_ids:[]}));await f.api.refresh();assert.equal(f.api.get(f.c.rows[0]).peer_online,null);
});
test('errors retain a recent known state only until expiry',async()=>{
  const f=controller();await f.api.refresh();f.handle(()=>{throw Error('offline');});f.advance(30000);await f.api.refresh();assert.equal(f.api.get(f.c.rows[0]).peer_online,true);
  f.advance(40000);await f.api.refresh();assert.equal(f.api.get(f.c.rows[0]),null);assert.ok(f.changes>=3);
});
test('responses cannot replace the peer identity or partially apply invalid batches',async()=>{
  for(const transform of [r=>({...r,peer_user_id:99}),r=>({...r,id:99})]){
    const f=controller();f.handle(rows=>({items:[transform(f.reply(rows).items[0])],removed_ids:[]}));await f.api.refresh();assert.equal(f.api.get(f.c.rows[0]),null);
  }
});
test('late results from another account are ignored and account caches are isolated',async()=>{
  const f=controller();let release;f.handle(rows=>new Promise(r=>release=()=>r(f.reply(rows))));const old=f.api.refresh();await turn();f.c.token='b';assert.equal(f.api.get(f.c.rows[0]),null);assert.equal(f.calls[0].signal.aborted,true);release();await old;assert.equal(f.api.get(f.c.rows[0]),null);
  f.handle(null);await f.api.refresh();assert.equal(f.calls.length,2);assert.equal(f.api.get({id:1,peer_user_id:21}),null);
});
test('pausing aborts an in-flight request and allows a foreground retry',async()=>{
  const f=controller();let release;f.handle(rows=>new Promise(r=>release=()=>r(f.reply(rows))));const old=f.api.refresh();await turn();f.api.pause();assert.equal(f.calls[0].signal.aborted,true);f.handle(null);await f.api.refresh();assert.equal(f.calls.length,2);release();await old;assert.equal(f.api.get(f.c.rows[0]).peer_online,true);
});
test('scrolling during a request queues newly visible rows without duplicate requests',async()=>{
  const f=controller();let release;f.handle(rows=>new Promise(r=>release=()=>r(f.reply(rows))));const pending=f.api.refresh();await turn();f.c.rows=[{id:2,peer_user_id:30}];void f.api.refresh();f.handle(null);release();await pending;await turn();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].rows,[{id:2,peer_user_id:30}]);
});
test('a removed conversation loses its cached presence without changing any directory row',async()=>{
  const f=controller();await f.api.refresh();const original={...f.c.rows[0]};f.advance(30000);f.handle(()=>({items:[],removed_ids:[1]}));await f.api.refresh();assert.equal(f.api.get(f.c.rows[0]),null);assert.deepEqual(f.c.rows[0],original);
});
const uuid=n=>String(n).padStart(8,'0')+'-9999-4999-8999-999999999999';
function adapter(handler){
  const storage=new Map(),calls=[];const go=createGo({base:'https://fixture.invalid/api/v2',storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},fetch:async(url,options)=>{const p=new URL(url).pathname.replace('/api/v2','');calls.push({p,body:options.body?JSON.parse(options.body):null});return handler(p,options);}});go.session('fixture');
  const targets=[0,1,2].map(n=>({conversation_id:go.local('conversation',uuid(100+n)),peer_user_id:go.local('user',uuid(200+n))}));
  const data=()=>({items:targets.map((r,n)=>({conversation_id:uuid(100+n),peer_id:uuid(200+n),online:n===0,last_seen_hidden:n===2,last_seen:n===2?null:'2026-11-18T04:00:00Z'})),removed_ids:[]});
  return {go,calls,targets,data,read:(items=targets)=>go.request('/conversations/presence',{method:'POST',body:JSON.stringify({items})})};
}
test('the adapter maps one bounded presence request and preserves hidden status',async()=>{
  let f;f=adapter(()=>Response.json(f.data()));const result=await f.read();assert.equal(f.calls.length,1);assert.equal(f.calls[0].p,'/client/conversation-presence');assert.deepEqual(f.calls[0].body.conversation_ids,[uuid(100),uuid(101),uuid(102)]);assert.deepEqual(result.items.map(r=>r.peer_online),[true,false,null]);
  assert.deepEqual(result.items.map(r=>r.peer_last_seen_at),['2026-11-18T04:00:00Z','2026-11-18T04:00:00Z',null]);
});
test('the adapter rejects extra, duplicate, missing, swapped, and malformed presence results',async()=>{
  for(const change of [r=>r.items.push({...r.items[0],conversation_id:uuid(900)}),r=>r.items.push(r.items[0]),r=>r.items.pop(),r=>r.items[0].peer_id=uuid(900),r=>r.items[0].online='true',r=>r.items[2].last_seen='2026-11-18T04:00:00Z',r=>r.items[0].last_seen='bad',r=>r.removed_ids.push(r.items[0].conversation_id)]){
    let f;f=adapter(()=>{const r=f.data();change(r);return Response.json(r);});await assert.rejects(f.read(),{code:'invalid_response'});
  }
});
test('presence request validation prevents empty, duplicate, and oversized batches',async()=>{
  const f=adapter(()=>{throw Error('must not fetch');});for(const items of [[],[f.targets[0],f.targets[0]],Array(101).fill(f.targets[0]),[{conversation_id:1,peer_user_id:0}]])await assert.rejects(f.read(items),{code:'invalid_request'});assert.equal(f.calls.length,0);
});
test('legacy fallback uses only privacy-authorized profiles with bounded concurrency',async()=>{
  let f,running=0,maximum=0;f=adapter(async p=>{
    if(p==='/client/conversation-presence')return Response.json({error:{code:'missing'}},{status:404});
    assert.ok(p.startsWith('/profiles/'));maximum=Math.max(maximum,++running);await turn();running--;const n=Number(p.split('/')[2].slice(0,8))-200;return Response.json({id:uuid(200+n),online:n===0,...(n===2?{}:{last_seen:'2026-11-18T04:00:00Z'})});
  });const result=await f.read();assert.deepEqual(result.items.map(r=>r.peer_online),[true,false,null]);assert.ok(maximum<=3);await f.read();assert.equal(f.calls.filter(r=>r.p==='/client/conversation-presence').length,1);
});
test('authentication and service failures never fall back to unrelated profile reads',async()=>{
  for(const status of [401,403,429,503]){const f=adapter(()=>Response.json({error:{code:'unavailable'}},{status}));await assert.rejects(f.read(),e=>e.status===status);assert.equal(f.calls.length,1);}
});
