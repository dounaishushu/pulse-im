const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../client-shared/go-v2.js');
const permissions=require('../pc/web/composer-permissions.js');
const groupId='33333333-3333-4333-8333-333333333333';
const ownerId='11111111-1111-4111-8111-111111111111';

function fixture(role='owner'){
  const values=new Map(),requests=[];
  const state={role,muted:false,allMuted:false,pinned:true,preference:1};
  const row=()=>({id:groupId,kind:'group',title:'Group',my_role:state.role,membership_version:'1',
    preference_version:String(state.preference),muted_notifications:state.muted,pinned:state.pinned,
    state:{clear_seq:'0'},visible_from_seq:'1',message_seq:'0',unread_count:'3',
    updated_at:'2026-11-16T00:00:00Z',mute_all:state.allMuted,can_send:!state.allMuted||state.role!=='member'});
  const client=create({base:'https://fixture.invalid/api/v2',storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},fetch:async(url,options)=>{
    const path=new URL(url).pathname.replace('/api/v2',''),body=options.body?JSON.parse(options.body):null;
    requests.push({path,method:options.method||'GET',body});
    if(path===`/groups/${groupId}/mute-all`){
      if(state.role==='member')return Response.json({error:{code:'forbidden'}},{status:403});
      assert.equal(options.method,'PUT');state.allMuted=body.muted;return Response.json({status:'ok'});
    }
    if(path===`/conversations/${groupId}/preferences`){
      assert.equal(options.method,'PATCH');assert.equal(body.expected_version,String(state.preference));
      if(Object.hasOwn(body,'muted_notifications'))state.muted=body.muted_notifications;
      if(Object.hasOwn(body,'pinned'))state.pinned=body.pinned;
      state.preference++;return Response.json({preference_version:String(state.preference),muted_notifications:state.muted,pinned:state.pinned});
    }
    if(path===`/groups/${groupId}`)return Response.json({id:groupId,kind:'group',title:'Group',my_role:state.role,owner_id:ownerId,member_limit:500,member_count:3,mute_all:state.allMuted,block_member_friend_requests:false});
    assert.equal(path,`/conversations/${groupId}`);return Response.json(row());
  }});
  client.session('fixture-session');
  const id=client.local('conversation',groupId);
  return {client,id,state,requests,row,profile:()=>client.request('/conversations/groups/profile?conversation_id='+id),
    mute:value=>client.request('/conversations/groups/profile',{method:'POST',body:JSON.stringify({conversation_id:id,all_muted:value})}),
    notifications:value=>client.request('/conversations/groups/settings',{method:'POST',body:JSON.stringify({conversation_id:id,notifications_muted:value})})};
}

test('group notification state survives profile reloads and can be toggled repeatedly',async()=>{
  const f=fixture();
  for(const muted of [true,false,true,false]){
    const saved=await f.notifications(muted);
    assert.equal(saved.notifications_muted,muted);assert.equal(saved.is_pinned,true);
    assert.equal((await f.profile()).notifications_muted,muted);
    assert.equal(saved.can_invite,true);assert.equal(saved.max_members,500);
  }
});

test('the sidebar profile command changes server-wide mute and keeps managers able to send',async()=>{
  for(const role of ['owner','admin']){
    const f=fixture(role);
    const muted=await f.mute(true);assert.equal(f.state.allMuted,true);assert.equal(muted.all_muted,true);assert.equal(muted.can_send,true);assert.equal(permissions.reason(muted),'');
    assert.equal(f.requests.filter(r=>r.path.endsWith('/mute-all')).length,1);
    const reopened=await f.mute(false);assert.equal(reopened.all_muted,false);assert.equal(f.state.allMuted,false);
  }
});

test('ordinary members see the group mute restriction and cannot change it',async()=>{
  const f=fixture('member');f.state.allMuted=true;
  const profile=await f.profile();assert.equal(profile.can_send,false);assert.equal(permissions.reason(profile),'group_muted');
  assert.equal(permissions.label(permissions.reason(profile)),'已开启禁言');
  await assert.rejects(f.mute(false),error=>error.status===403);
  assert.equal(f.state.allMuted,true);
  f.state.allMuted=false;assert.equal(permissions.reason(await f.profile()),'');
});

test('late conversation reads cannot restore an older notification preference',()=>{
  const f=fixture(),old=f.row();
  f.client.conversation(old);f.state.muted=true;f.state.preference=2;
  assert.equal(f.client.conversation(f.row()).notifications_muted,true);
  assert.equal(f.client.conversation(old).notifications_muted,true);
  f.client.session('another-account');assert.equal(f.client.conversation(old).notifications_muted,false);
});
