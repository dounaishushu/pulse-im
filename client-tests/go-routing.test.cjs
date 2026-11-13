const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Manager}=require('../pc/web/go-routes.js');
const {createRouteBridge}=require('../pc/route-bridge.cjs');
const sources=require('../pc/web/media-source.js');
const base='https://chat.example.org/api/v2',alternate='https://relay.example.org/api/v2';
const policy={protocol:'pulse-v2',routes:[{id:'alias',name:'备用',api_url:alternate,enabled:true}]};

test('Go aliases come from the configured authority and cannot accept an IPC URL',async()=>{
  const calls=[];
  const bridge=createRouteBridge({runtimeConfig:{apiBaseUrl:base,production:true},fetchForProfile:async(_profile,url)=>{calls.push(url);return Response.json(policy);}});
  const profile={accountId:1};
  await assert.rejects(bridge.accept(profile,{goRoute:'unknown',url:'https://other.example.org/api/v2'}));
  await bridge.accept(profile,{goRoute:'alias'});
  assert.equal(bridge.current(profile).api_url,alternate);
  assert.ok(calls.every(url=>url===base+'/client/config'||url===alternate+'/client/config'));
});

test('Go failover retries reads and preserves the outcome of an uncertain write',async()=>{
  const calls=[];
  const manager=new Manager({base,fetch:async(url,options={})=>{
    calls.push({url,method:options.method||'GET'});
    if(url.endsWith('/client/config'))return Response.json(policy);
    if(url.startsWith(base))throw Error('network failure');return Response.json({ok:true});
  }});
  await manager.refresh();
  assert.equal((await manager.request('/me')).status,200);
  assert.equal(manager.current.api_url,alternate);
  manager.current=manager.seeds[0];calls.length=0;
  await assert.rejects(manager.request('/auth/password',{method:'PUT',body:'{}'},false));
  assert.equal(calls.filter(row=>row.method==='PUT').length,1);
});

test('Go grants remain account-bound cache sources and reject malformed credentials',()=>{
  const url='https://chat.example.org/api/v2/media-grants/'+'a'.repeat(64)+'/content';
  assert.ok(sources.source(url));assert.equal(sources.source(url+'?token=other'),null);
  const display=sources.display(url,1,2,3,true),parsed=sources.parseDisplay(display);
  assert.equal(parsed.account,1);assert.equal(parsed.message,3);assert.equal(parsed.source,url);
});

test('Privacy-filtered invitation pages request only the remaining rows',async()=>{
  const {create}=require('../client-shared/go-v2.js'),values=new Map();
  const cid='11111111-1111-4111-8111-111111111111',uid='22222222-2222-4222-8222-222222222222';
  const candidates=['33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
  const limits=[];
  const client=create({base,storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},fetch:async raw=>{
    const url=new URL(raw);
    if(url.pathname.endsWith('/invite-candidates')){limits.push(url.searchParams.get('limit'));const index=limits.length-1;return Response.json({items:[{id:candidates[index],account:'candidate',nickname:'Candidate'}],next_after:candidates[index]});}
    if(url.pathname.includes('/groups/'))return Response.json({id:cid,kind:'group',owner_id:uid,my_role:'owner',member_limit:500,member_count:1});
    return Response.json({id:cid,kind:'group',membership_version:'1',state:{clear_seq:'0'},visible_from_seq:'1',unread_count:'0',message_seq:'0',updated_at:'2026-11-13T00:00:00Z',can_send:true});
  }});
  const result=await client.request('/conversations/invite-candidates?conversation_id='+client.local('conversation',cid)+'&page=1&size=2');
  assert.equal(result.items.length,2);assert.deepEqual(limits,['2','1']);
});

test('A newer cached message does not retain an unavailable quoted parent',()=>{
  const {create}=require('../client-shared/go-v2.js'),values=new Map();
  const client=create({base,storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}});
  const common={conversation_id:'11111111-1111-4111-8111-111111111111',sender_id:'22222222-2222-4222-8222-222222222222',event_seq:'1',created_at:'2026-11-13T00:00:00Z',updated_at:'2026-11-13T00:00:00Z',kind:'text',request_id:'test',content:{}};
  const parent={...common,id:'33333333-3333-4333-8333-333333333333',seq:'1',version:'1',body:'private parent'};
  const child={...common,id:'44444444-4444-4444-8444-444444444444',seq:'2',version:'2',body:'newer child',reply_to_id:parent.id,_go_reply:{reply_seq:'1',message:parent}};
  client.message(child);
  const result=client.message({...child,version:'1',body:'older child',_go_reply:{reply_seq:'1',message:null}});
  assert.equal(result.body.text,'newer child');assert.deepEqual(result.body.reply_to,{id:1,unavailable:true});
});
