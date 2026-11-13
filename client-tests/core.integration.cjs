const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {create}=require('../client-shared/go-v2.js');
const {connect}=require('../client-shared/go-realtime.js');
const config=JSON.parse(fs.readFileSync(process.env.PULSE_CLIENT_TEST_CONFIG,'utf8'));
assert.equal(new URL(config.base).hostname,'127.0.0.1','Only isolated loopback fixture accounts are allowed');
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)};};
const clients={};let chat,group,secret,edited;
function post(client,path,body={},method='POST'){return client.request(path,{method,body});}
function localUser(client,other){return client.local('user',other.uuid);}
function localChat(client,id,owner=clients.a){return client.local('conversation',owner.wire('conversation',id));}
const payload=(cid,text,id)=>({conversation_id:cid,type:'text',body:{text},request_id:id||crypto.randomUUID()});
async function history(client,id){return client.request('/messages/history?conversation_id='+id);}
before(async()=>{
 for(const suffix of 'abcd'){
  const c=create({base:config.base,storage:storage(),platform:suffix==='a'?'pc':'web'});
  const session=await post(c,'/auth/login',{phone:config.prefix+suffix,password:config.password});c.session(session.access_token);c.me=await c.request('/auth/me');c.uuid=c.wire('user',c.me.id);clients[suffix]=c;
 }
});
after(async()=>{for(const c of Object.values(clients))await post(c,'/auth/logout').catch(()=>{});});
test('01 login, directory, device sessions and exact account lookup',async()=>{
 const a=clients.a;assert.equal(a.me.internal_staff,true);assert.equal(clients.b.me.internal_staff,false);
 const found=await a.request('/contacts/search?q='+config.prefix+'b');assert.equal(a.wire('user',found.items[0].id),clients.b.uuid);
 assert.equal((await a.request('/auth/sessions')).items.some(s=>s.is_current),true);
 assert.equal((await a.request('/conversations')).total,0);
});
test('02 temporary chat, persistent request id and conflicting retry',async()=>{
 const a=clients.a,b=clients.b;chat=await post(a,'/conversations/direct',{user_id:localUser(a,b)});assert.equal(chat.temporary,true);
 const body=payload(chat.id,'hello temporary');const one=await post(a,'/messages',body),two=await post(a,'/messages',body);assert.equal(one.body._go_wire_id,two.body._go_wire_id);
 await assert.rejects(post(a,'/messages',{...body,body:{text:'changed retry'}}),e=>e.status===409);
 assert.equal((await history(b,localChat(b,chat.id))).items[0].body.text,'hello temporary');
 edited=one;
});
test('03 sender-only edit and captured version CAS',async()=>{
 const a=clients.a,b=clients.b,cid=localChat(b,chat.id);
 await assert.rejects(post(b,'/messages/edit',{conversation_id:cid,message_id:edited.id,text:'unauthorized',expected_version:edited.body._go_version}),e=>e.status===403);
 const peer=await post(b,'/messages',payload(cid,'peer text'));await history(a,chat.id);
 await assert.rejects(post(a,'/messages/edit',{conversation_id:chat.id,message_id:peer.id,text:'staff unauthorized',expected_version:peer.body._go_version}),e=>e.status===403);
 const patch={conversation_id:chat.id,message_id:edited.id,text:'own edit',expected_version:edited.body._go_version};
 const result=await post(a,'/messages/edit',patch);assert.equal(result.body.text,'own edit');assert.equal(result.body._go_version,'2');
 await assert.rejects(post(a,'/messages/edit',{...patch,text:'stale editor'}),e=>e.status===409);
});
test('04 privacy rules, exceptions and bilateral block precedence',async()=>{
 const a=clients.a,b=clients.b;let privacy=await b.request('/go/privacy');
 await post(b,'/go/privacy',{expected_version:privacy.version,temporary_chat:{visibility:'nobody',allow:[],deny:[]}},'PATCH');
 await assert.rejects(post(a,'/messages',payload(chat.id,'blocked by privacy')),e=>e.status===403);
 privacy=await b.request('/go/privacy');await post(b,'/go/privacy',{expected_version:privacy.version,temporary_chat:{visibility:'nobody',allow:[a.uuid],deny:[]}},'PATCH');
 await post(a,'/messages',payload(chat.id,'allowed exception'));
 await post(b,'/blocks',{user_id:localUser(b,a)});assert.equal((await b.request('/blocks')).items[0].blocked_id,localUser(b,a));
 await assert.rejects(post(a,'/messages',payload(chat.id,'blocked despite exception')),e=>e.status===403);
 await post(b,'/blocks/unblock',{user_id:localUser(b,a)});
});
test('05 create group, source-authorized forwarding and per-conversation seq isolation',async()=>{
 const a=clients.a;group=await post(a,'/conversations/groups',{name:'Web PC integration',member_ids:[],allow_member_add_friend:true});
 secret=await post(a,'/messages',payload(group.id,'private pre-join history'));assert.equal(secret.id,1);
 const forwarded=await post(a,'/messages',{...payload(group.id,edited.body.text),body:{text:edited.body.text,_source_wire_id:edited.body._go_wire_id}});
 assert.equal(forwarded.body.text,'own edit');
 await post(a,'/messages/edit',{conversation_id:group.id,message_id:secret.id,text:'group only',expected_version:secret.body._go_version});
 assert.equal((await history(a,chat.id)).items.find(m=>m.id===edited.id).body.text,'own edit');
});
test('06 invitation history off/on, same member reinvite, member version boundary',async()=>{
 const a=clients.a,b=clients.b,c=clients.c;
 await post(a,'/conversations/members',{conversation_id:group.id,user_id:localUser(a,b),allow_history:false});
 const bid=localChat(b,group.id);const first=await history(b,bid);assert.equal(first.items.length,0);
 await post(a,'/conversations/members',{conversation_id:group.id,user_id:localUser(a,b),allow_history:true});assert.equal((await history(b,bid)).items.length,0);
 await post(a,'/conversations/members',{conversation_id:group.id,user_id:localUser(a,c),allow_history:true});assert.equal((await history(c,localChat(c,group.id))).items.length,2);
 await post(a,'/conversations/members/remove',{conversation_id:group.id,user_id:localUser(a,b)});
 await assert.rejects(history(b,bid),e=>e.status===403);
 await post(a,'/conversations/members',{conversation_id:group.id,user_id:localUser(a,b),allow_history:true});
 const next=await history(b,bid);assert.ok(next.membership_version>first.membership_version);assert.equal(next.items.length,2);
 await assert.rejects(b.request('/messages/sync?'+new URLSearchParams({conversation_id:bid,snapshot_max_id:next.snapshot_max_id,membership_version:first.membership_version})),e=>e.status===409);
});
test('07 delete, captured clear boundary, new message preserved and receipts',async()=>{
 const a=clients.a,b=clients.b,cid=localChat(b,group.id);const page=await history(b,cid);const deleted=page.items[0];
 const result=await post(b,'/messages/delete',{conversation_id:cid,message_ids:[deleted.id]});assert.equal(result.user_id,b.me.id);
 assert.equal((await history(b,cid)).items.some(m=>m.id===deleted.id),false);
 const boundary=(await a.request('/conversations/info?conversation_id='+group.id)).message_seq;
 const latest=await post(a,'/messages',payload(group.id,'after captured clear'));
 await post(b,'/messages/clear-history',{conversation_id:cid,through_message_id:boundary});assert.deepEqual((await history(b,cid)).items.map(m=>m.id),[latest.id]);
 await post(b,'/messages/receipt',{conversation_id:cid,through_message_id:latest.id,status:'read'});
 const receipts=await a.request('/messages/receipts?conversation_id='+group.id+'&message_id='+latest.id);assert.ok(receipts.read_count>=1);const batch=await a.request('/messages/receipts?conversation_id='+group.id+'&message_ids='+latest.id);assert.equal(batch.conversation_type,'group');assert.equal(batch.items[0].read_count,receipts.read_count);assert.equal(batch.items[0].message_id,latest.id);
});
test('08 permanent mute, role, transfer and ownership checks',async()=>{
 const a=clients.a,c=clients.c,cid=localChat(c,group.id);
 await post(a,'/conversations/members/mute',{conversation_id:group.id,user_id:localUser(a,c),minutes:-1});
 const profile=await c.request('/conversations/groups/profile?conversation_id='+cid);assert.equal(profile.can_send,false);
 await assert.rejects(post(c,'/messages',payload(cid,'muted')),e=>e.status===403);
 await post(a,'/conversations/members/mute',{conversation_id:group.id,user_id:localUser(a,c),minutes:0});
 await post(a,'/conversations/members/role',{conversation_id:group.id,user_id:localUser(a,c),role:'admin'});
 assert.equal((await c.request('/conversations/groups/profile?conversation_id='+cid)).can_manage,true);
});
test('09 friend request, accept, temporary conversation reuse and removal',async()=>{
 const c=clients.c,d=clients.d;await post(c,'/contact-requests',{to_user_id:localUser(c,d),message:'test request'});
 const requests=await d.request('/contact-requests?direction=received');await post(d,'/contact-requests/handle',{request_id:requests.items[0].id,action:'accept'});
 assert.equal((await c.request('/contacts')).items.length,1);
 await post(c,'/contacts/remove',{user_id:localUser(c,d)});assert.equal((await c.request('/contacts')).items.length,0);
});
test('10 batch invite, join by rotated code, unsupported operations fail explicitly',async()=>{
 const a=clients.a,d=clients.d;const batch=await post(a,'/conversations/members/batch',{conversation_id:group.id,user_ids:[localUser(a,d)],allow_history:false});assert.equal(batch.items[0].status,'joined');
 await post(a,'/conversations/members/remove',{conversation_id:group.id,user_id:localUser(a,d)});
 const code=await post(a,'/go/invite-code',{conversation_id:group.id});
 const joined=await post(d,'/conversations/groups/join',{invite_code:code.invite_code});assert.equal((await history(d,joined.id)).items.length,0);
 await assert.rejects(post(d,'/uploads',{}),e=>e.status===501);
 await assert.rejects(post(a,'/conversations/members/mute',{conversation_id:group.id,user_id:localUser(a,d),minutes:10}),e=>e.status===501);
});
test('11 actual WebSocket ticket readiness and committed message notification',async()=>{
 const a=clients.a;let connection;const packets=[];
 const wait=predicate=>new Promise((resolve,reject)=>{const deadline=setTimeout(()=>{clearInterval(poll);reject(Error('WebSocket event timeout'));},10000);const poll=setInterval(()=>{if(packets.some(predicate)){clearTimeout(deadline);clearInterval(poll);resolve();}},20);});
 try{connection=await connect({api:a,token:a.token,shared:false,onPacket:p=>packets.push(p)});await wait(p=>p.type==='ready');await post(a,'/messages',payload(group.id,'ws committed'));await wait(p=>p.type==='conversation.changed'&&p.conversation_id===a.wire('conversation',group.id));}
 finally{connection?.close();}
});
test('12 stale response, invalid numeric range and namespace collision guards',async()=>{
 const a=clients.b;const cid=localChat(a,group.id);const now=(await history(a,cid)).membership_version;
 assert.throws(()=>a.version(cid,now-1),e=>e.status===409);assert.throws(()=>a.integer('9007199254740993'),e=>e.code==='unsafe_number');
 const isolated=create({base:config.base,storage:storage()});isolated.local('user','12345678-1234-4567-8123-123456789abc');
 assert.throws(()=>isolated.local('user','12345678-1234-4567-8123-123456789abd'),e=>e.code==='id_collision');
 assert.throws(()=>create({base:'https://example.test/api/v2?token=x',storage:storage()}));
});

test('13 in-flight requests cannot publish into a replacement login',async()=>{
 let finish;const c=create({base:config.base,storage:storage(),fetch:()=>new Promise(resolve=>{finish=resolve;})});c.session('old');
 const pending=c.request('/auth/me');c.session('new');finish(new Response(JSON.stringify({id:clients.a.uuid,account:'old'}),{status:200}));
 await assert.rejects(pending,e=>e.code==='stale_session');
});
