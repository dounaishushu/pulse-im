const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../client-shared/go-v2.js');
const uuid=n=>String(n).padStart(8,'0')+'-7777-4777-8777-777777777777';
const cid=uuid(9000),owner=uuid(1);
function fixture(role='owner',adminCount=20){
  const storage=new Map(),requests=[],grants=[];
  const admins=new Set(adminCount===20?Array.from({length:20},(_,i)=>2+i*23):Array.from({length:adminCount},(_,i)=>i+2));
  const model={role,repeat:false};
  const roster=()=>Array.from({length:476},(_,i)=>({id:uuid(i+1),nickname:'成员'+(i+1),account:'user'+(i+1),avatar_id:uuid(10000+i),role:i===0?'owner':admins.has(i+1)?'admin':'member'}));
  const client=create({base:'https://fixture.invalid/api/v2',storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},fetch:async(raw,options)=>{
    const u=new URL(raw),p=u.pathname.replace('/api/v2','');requests.push(u);
    if(p==='/groups/'+cid)return Response.json({id:cid,kind:'group',title:'群',my_role:model.role,owner_id:owner,member_limit:500,member_count:476});
    if(p==='/conversations/'+cid)return Response.json({id:cid,kind:'group',title:'群',my_role:model.role,membership_version:'1',preference_version:'1',visible_from_seq:'1',message_seq:'0',unread_count:0,updated_at:'2026-11-18T00:00:00Z',state:{clear_seq:'0'}});
    if(p==='/media/grants'){
      const ids=JSON.parse(options.body).media_ids;grants.push(...ids);
      return Response.json({items:ids.map(id=>({id,access:{content_path:'/api/v2/media-grants/'+'a'.repeat(64)+'/content',expires_in:120}}))});
    }
    assert.equal(p,'/groups/'+cid+'/member-profiles');
    const all=roster().filter(row=>model.role!=='member'||['owner','admin'].includes(row.role));
    const after=u.searchParams.get('after')||'',remaining=all.filter(row=>row.id>after),items=remaining.slice(0,100);
    return Response.json({items,query:'',search_scope:model.role==='member'?'friends':'group',members_visibility:model.role==='member'?'managers':'all',next_after:model.repeat?uuid(100):remaining.length>100?items.at(-1).id:''});
  }});
  client.session('fixture');const id=client.local('conversation',cid);
  return {model,admins,requests,grants,client,id,roster,managers:()=>client.request('/conversations/members?conversation_id='+id+'&roles=managers')};
}
test('complete administrator directory includes all 20 admins scattered across 476 members',async()=>{
  const f=fixture(),first=await f.client.request('/conversations/members?conversation_id='+f.id+'&page=1');
  assert.equal(first.items.filter(p=>p.role==='admin').length,5);
  const result=await f.managers();
  assert.equal(result.items.filter(p=>p.role==='admin').length,20);
  assert.equal(result.items.filter(p=>p.role==='owner').length,1);
  assert.equal(result.items.length,21);assert.equal(result.managers_only,true);assert.equal(result.has_more,false);
  assert.equal(new Set(result.items.map(p=>p.user_id)).size,21);
});
test('administrator completion authorizes only manager avatars, not every group member avatar',async()=>{
  const f=fixture();await f.managers();
  assert.deepEqual(new Set(f.grants),new Set(f.roster().filter(p=>p.role!=='member').map(p=>p.avatar_id)));
});
test('administrator directory has no five/twenty/hundred-person cap and follows role changes',async()=>{
  const f=fixture('owner',120);assert.equal((await f.managers()).items.filter(p=>p.role==='admin').length,120);
  f.admins.delete(2);f.admins.delete(3);assert.equal((await f.managers()).items.filter(p=>p.role==='admin').length,118);
});
test('ordinary members retain manager-only privacy while seeing the entire manager roster',async()=>{
  const f=fixture('member',120),result=await f.managers();
  assert.equal(result.members_visibility,'managers');assert.equal(result.viewer_role,'member');
  assert.equal(result.items.length,121);assert.ok(result.items.every(p=>['owner','admin'].includes(p.role)));
});
test('manager completion cannot reuse search pagination or silently accept unsupported filters',async()=>{
  for(const suffix of ['roles=all','roles=managers&page=1','roles=managers&q=abc']){
    const f=fixture();await assert.rejects(f.client.request('/conversations/members?conversation_id='+f.id+'&'+suffix),{code:'invalid_request'});
  }
});
test('a stuck backend cursor is rejected rather than presenting a partial manager list as complete',async()=>{
  const f=fixture();f.model.repeat=true;await assert.rejects(f.managers(),{code:'invalid_response'});
});
