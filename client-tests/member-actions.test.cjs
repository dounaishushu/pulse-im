const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../client-shared/go-v2.js');
const uuid=n=>String(n).padStart(8,'0')+'-7777-4777-8777-777777777777';
const cid=uuid(9000),owner=uuid(1),peer=uuid(476);
function fixture(role='owner'){
  const storage=new Map(),requests=[];
  const model={role,targetRole:'member',removed:false,deny:false,muted:false,malformed:false,gate:null};
  const rows=()=>Array.from({length:476},(_,i)=>({id:uuid(i+1),nickname:'成员'+(i+1),avatar_id:uuid(10000+i),role:i===0?'owner':i===475?model.targetRole:'member',muted:i===475&&model.muted,muted_permanent:i===475&&model.muted})).filter(row=>!model.removed||row.id!==peer);
  const client=create({base:'https://fixture.invalid/api/v2',storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},fetch:async(raw,options)=>{
    const u=new URL(raw),p=u.pathname.replace('/api/v2','');requests.push({p,url:u,method:options.method,body:options.body});
    if(model.deny)return Response.json({error:{code:'forbidden'}},{status:403});
    if(p==='/groups/'+cid)return Response.json({id:cid,kind:'group',status:'active',title:'群',my_role:model.role,owner_id:owner,member_count:476,block_member_friend_requests:true});
    if(p===`/groups/${cid}/members/${peer}/muted`){model.muted=JSON.parse(options.body).minutes!==0;return new Response(null,{status:204});}
    assert.equal(p,'/groups/'+cid+'/member-profiles','member actions must not fetch a conversation or authorize avatars');
    if(model.gate)await model.gate;
    const after=u.searchParams.get('after')||'',limit=Number(u.searchParams.get('limit')||100);
    const remaining=rows().filter(row=>row.id>after&&(model.role!=='member'||row.role!=='member'));
    const items=model.malformed?[...remaining.slice(0,limit),rows()[0]]:remaining.slice(0,limit);
    return Response.json({items,query:'',search_scope:model.role==='member'?'friends':'group',members_visibility:model.role==='member'?'managers':'all',next_after:remaining.length>limit?items.at(-1).id:''});
  }});
  client.session('fixture');const id=client.local('conversation',cid),target=client.local('user',peer);
  return {model,requests,client,id,target,context:()=>client.request(`/conversations/members/context?conversation_id=${id}&user_id=${target}`)};
}
test('member menu reads exactly the selected member without scanning 476 people or fetching media',async()=>{
  const f=fixture(),result=await f.context();
  assert.equal(result.conversation_id,f.id);assert.equal(result.user_id,f.target);
  assert.equal(result.items.length,1);assert.equal(result.items[0].user_id,f.target);assert.equal(result.items[0].role,'member');
  assert.equal(result.profile.my_role,'owner');assert.equal(result.profile.owner_id,f.client.local('user',owner));
  assert.equal(result.profile.allow_member_add_friend,false);
  assert.equal(f.requests.length,2);
  const lookup=f.requests.find(r=>r.p.endsWith('/member-profiles')).url;
  assert.equal(lookup.searchParams.get('limit'),'1');
  const before=BigInt('0x'+lookup.searchParams.get('after').replaceAll('-',''));
  assert.equal(before+1n,BigInt('0x'+peer.replaceAll('-','')));
});
test('a departed or hidden target is absent rather than replaced by the next visible member',async()=>{
  const f=fixture();f.model.removed=true;assert.deepEqual((await f.context()).items,[]);
  const member=fixture('member');assert.deepEqual((await member.context()).items,[]);
  member.model.targetRole='admin';assert.equal((await member.context()).items[0].role,'admin');
});
test('fresh member context follows promotions, demotions and permission denial',async()=>{
  const f=fixture('admin');assert.equal((await f.context()).items[0].role,'member');
  f.model.targetRole='admin';assert.equal((await f.context()).items[0].role,'admin');
  f.model.role='member';assert.equal((await f.context()).profile.my_role,'member');
  f.model.deny=true;await assert.rejects(f.context(),{status:403});
});
test('invalid identity and malformed bounded lookup cannot become a moderation target',async()=>{
  const f=fixture();
  await assert.rejects(f.client.request(`/conversations/members/context?conversation_id=${f.id}&user_id=999`),{code:'invalid_request'});
  f.model.malformed=true;await assert.rejects(f.context(),{code:'invalid_response'});
});
test('a permission response from an earlier login is discarded',async()=>{
  const f=fixture();let release;f.model.gate=new Promise(r=>release=r);
  const pending=f.context();await new Promise(r=>setImmediate(r));f.client.session('new-account');release();
  await assert.rejects(pending,{code:'stale_session'});
});
test('mute confirmation reads one member and preserves permanent and unmute results',async()=>{
  const f=fixture();
  for(const minutes of [-1,0]){
    f.requests.length=0;
    const result=await f.client.request('/conversations/members/mute',{method:'POST',body:{conversation_id:f.id,user_id:f.target,minutes}});
    assert.equal(result.is_muted,minutes!==0);assert.equal(result.muted_permanent,minutes!==0);
    assert.equal(result.muted_until,minutes===0?null:'9999-12-31 23:59:59');
    assert.equal(f.requests.length,2);assert.equal(f.requests[1].url.searchParams.get('limit'),'1');
  }
});
test('an unconfirmable mute never fabricates a successful unmute receipt',async()=>{
  const f=fixture();f.model.removed=true;
  await assert.rejects(f.client.request('/conversations/members/mute',{method:'POST',body:{conversation_id:f.id,user_id:f.target,minutes:0}}),{code:'conflict'});
});
