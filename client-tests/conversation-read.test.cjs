const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../pc/web/conversation-read.js');
const {create:createGo}=require('../client-shared/go-v2.js');

const row=(latest=20,mention=18,version='1')=>({id:7,type:'group',unread_count:4,unread_mention_count:mention?2:0,last_mention_message_id:mention,
  last_message:{id:latest},message_seq:latest,state:{version,reminder:false}});
const ack=(through=20,extra={})=>({conversation_id:7,through_message_id:through,status:'read',unread_count:0,state_version:'2',...extra});
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function tick(){for(let i=0;i<8;i++)await Promise.resolve();}
function fixture(request=async body=>ack(body.through_message_id)){
  const f={context:{token:'fixture',userId:1,conversationId:7,available:true},rows:[row()],requests:[],confirmed:[],errors:[],timers:new Set()};
  f.api=create({context:()=>f.context,request:async(path,options)=>{const body=JSON.parse(options.body);f.requests.push(body);return request(body);},
    changed:(id,ticket)=>{f.rows=f.rows.map(value=>value.id===id?f.api.merge(value,ticket):value);},confirmed:value=>f.confirmed.push(value),failed:error=>f.errors.push(error),
    setTimeout:fn=>{const timer={fn};f.timers.add(timer);return timer;},clearTimeout:timer=>f.timers.delete(timer)});
  f.api.capture();return f;
}

test('a displayed read immediately clears the old mention and unread count before its acknowledgment',async()=>{
  const gate=deferred(),f=fixture(()=>gate.promise);
  const task=f.api.mark(7,20);
  assert.equal(f.rows[0].unread_count,0);assert.equal(f.rows[0].unread_mention_count,0);assert.equal(f.rows[0].last_mention_message_id,0);
  f.context.conversationId=8;gate.resolve(ack());assert.equal(await task,true);
  assert.equal(f.confirmed.length,1);assert.equal(f.rows[0].unread_mention_count,0,'leaving the conversation must not lose an in-flight acknowledgment');
});

test('older list responses cannot resurrect a read, including requests captured after acknowledgment',async()=>{
  const f=fixture(),before=f.api.capture();await f.api.mark(7,20);
  for(const ticket of [before,f.api.capture()]){
    const value=f.api.merge(row(),ticket);assert.equal(value.unread_count,0);assert.equal(value.unread_mention_count,0);
  }
});

test('a later plain message retains unread while an already read mention clears independently',async()=>{
  const f=fixture();await f.api.mark(7,20);
  const value=f.api.merge(row(22,18,'2'),f.api.capture());
  assert.equal(value.unread_count,4);assert.equal(value.unread_mention_count,0);assert.equal(value.last_mention_message_id,0);
});

test('later messages and later mentions remain unread after an earlier read',async()=>{
  const f=fixture();await f.api.mark(7,20);
  const value=f.api.merge(row(22,22,'2'),f.api.capture());
  assert.equal(value.unread_count,4);assert.equal(value.unread_mention_count,2);assert.equal(value.last_mention_message_id,22);
});

test('private chats clear displayed unread counts and retain newer unseen messages',async()=>{
  const f=fixture();f.rows=[{...row(20,0),type:'direct'}];await f.api.mark(7,20);
  assert.equal(f.rows[0].unread_count,0);
  const newer={...row(21,0,'2'),type:'direct',unread_count:1};
  assert.equal(f.api.merge(newer,f.api.capture()).unread_count,1);
});

test('a newer explicit unread reminder wins even when its request started before the read',async()=>{
  const f=fixture(),ticket=f.api.capture();await f.api.mark(7,20);
  const value=row(20,0,'3');value.state.reminder=true;value.unread_count=1;
  assert.deepEqual(f.api.merge(value,ticket),value);
});

test('manually marking unread invalidates local read coverage',async()=>{
  const f=fixture();await f.api.mark(7,20);f.api.invalidate(7);
  assert.deepEqual(f.api.merge(row(),f.api.capture()),row());
});

test('a transient receipt failure retains bounded progress for a foreground retry',async()=>{
  let attempts=0;const f=fixture(async()=>{if(++attempts===1)throw Error('offline');return ack();});
  assert.equal(await f.api.mark(7,20),false);assert.equal(f.timers.size,1);assert.equal(f.rows[0].unread_mention_count,0);
  const timer=[...f.timers][0];timer.fn();await tick();
  assert.equal(attempts,2);assert.equal(f.confirmed.length,1);assert.equal(f.rows[0].unread_count,0);
});

test('an account change rejects a late receipt without changing the new account list',async()=>{
  const gate=deferred(),f=fixture(()=>gate.promise);const task=f.api.mark(7,20);
  f.context.token='another-account';f.api.capture();f.rows=[row()];gate.resolve(ack());
  assert.equal(await task,false);assert.equal(f.confirmed.length,0);assert.equal(f.rows[0].unread_mention_count,2);
});

test('messages arriving during a read coalesce into a newer request without concurrent receipts',async()=>{
  const gates=[deferred(),deferred()];let index=0,inFlight=0,maximum=0;
  const f=fixture(async()=>{maximum=Math.max(maximum,++inFlight);try{return await gates[index++].promise;}finally{inFlight--;}});
  const first=f.api.mark(7,20);f.rows=[row(23,23,'2')];void f.api.mark(7,23);
  gates[0].resolve(ack(20,{unread_count:1}));await first;await tick();
  assert.deepEqual(f.requests.map(value=>value.through_message_id),[20,23]);assert.equal(maximum,1);
  gates[1].resolve(ack(23,{state_version:'3'}));await tick();assert.equal(f.rows[0].unread_count,0);assert.equal(f.rows[0].unread_mention_count,0);
});

test('server receipt counts and explicit newer mention metadata remain authoritative',async()=>{
  const f=fixture(async()=>ack(20,{unread_count:1,unread_mention_count:1,last_mention_message_id:25}));
  await f.api.mark(7,20);assert.equal(f.rows[0].unread_count,1);assert.equal(f.rows[0].unread_mention_count,1);assert.equal(f.rows[0].last_mention_message_id,25);
});

test('a later receipt without mention metadata does not retain an earlier unread mention count',async()=>{
  const f=fixture(async body=>body.through_message_id===20?ack(20,{unread_count:1,unread_mention_count:1,last_mention_message_id:25}):ack(25,{state_version:'3'}));
  await f.api.mark(7,20);f.rows=[{...row(25,25,'2'),unread_count:1,unread_mention_count:1}];
  await f.api.mark(7,25);assert.equal(f.rows[0].unread_count,0);assert.equal(f.rows[0].unread_mention_count,0);
});

test('a hidden or unrelated conversation cannot initiate a read',async()=>{
  const f=fixture();f.context.available=false;assert.equal(await f.api.mark(7,20),false);
  f.context.available=true;assert.equal(await f.api.mark(8,20),false);assert.equal(f.requests.length,0);
});

test('64-bit state versions compare exactly without losing newer unread reminders',async()=>{
  const f=fixture(async()=>ack(20,{state_version:'9223372036854775806'}));await f.api.mark(7,20);
  assert.equal(f.api.merge(row(20,18,'9223372036854775805'),f.api.capture()).unread_count,0);
  assert.equal(f.api.merge(row(20,0,'9223372036854775807'),f.api.capture()).unread_count,4);
});

test('an invalid state version does not confirm a read',async()=>{
  const f=fixture(async()=>ack(20,{state_version:'1e3'}));assert.equal(await f.api.mark(7,20),false);
  assert.equal(f.confirmed.length,0);assert.equal(f.timers.size,1);
});

for(const mode of ['normal','reminder','delivered'])test('Go read adapter preserves version and reminder semantics: '+mode,async()=>{
  const cid='33333333-3333-4333-8333-333333333333',calls=[],values=new Map();let reminder=mode!=='normal';
  const client=createGo({base:'https://chat.example.org/api/v2',storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},fetch:async(url,options)=>{
    const pathname=new URL(url).pathname;calls.push(pathname);
    if(pathname.endsWith('/reminder')){assert.equal(JSON.parse(options.body).reminder,false);reminder=false;return Response.json({version:'6',reminder:false});}
    if(pathname.endsWith('/unread'))return Response.json({count:0,truncated:false});
    assert.equal(options.method,'PUT');assert.equal(JSON.parse(options.body).seq,'20');return Response.json({version:'5',reminder});
  }});
  client.session('fixture');const id=client.local('conversation',cid);
  const result=await client.request('/messages/receipt',{method:'POST',body:{conversation_id:id,through_message_id:20,status:mode==='delivered'?'delivered':'read'}});
  assert.equal(result.state_version,mode==='reminder'?'6':'5');assert.equal(result.unread_count,0);
  assert.equal(calls.filter(path=>path.endsWith('/reminder')).length,mode==='reminder'?1:0);
  assert.equal(reminder,mode==='delivered');assert.equal(calls.length,mode==='reminder'?3:2);
});
