const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/go-v2.js');
const cid='33333333-3333-4333-8333-333333333333',uid='11111111-1111-4111-8111-111111111111',peer='22222222-2222-4222-8222-222222222222';
function fixture(role='member') {
  const storage=new Map(),requests=[],model={role,invalid:false};
  const client=create({base:'https://fixture.invalid/api/v2',storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},fetch:async raw=>{
    const u=new URL(raw),p=u.pathname.replace('/api/v2','');requests.push(u);
    if(p==='/groups/'+cid)return Response.json({id:cid,title:'群',kind:'group',my_role:model.role,owner_id:uid,member_limit:500,block_member_friend_requests:false});
    if(p==='/conversations/'+cid)return Response.json({id:cid,kind:'group',title:'群',my_role:model.role,membership_version:'1',preference_version:'1',visible_from_seq:'1',message_seq:'0',unread_count:'0',state:{clear_seq:'0'},updated_at:'2026-11-16T00:00:00Z'});
    assert.equal(p,'/groups/'+cid+'/member-profiles');
    if(!u.searchParams.has('q'))return Response.json({items:[{id:uid,nickname:'群主',role:'owner'},{id:peer,nickname:'好友人才',role:'member'}]});
    return Response.json({query:u.searchParams.get('q'),search_scope:model.role==='member'?'friends':'group',items:[{id:peer,nickname:'好友人才',role:'member',is_contact:!model.invalid}],next_after:u.searchParams.get('after')?'':peer});
  }});
  client.session('fixture');const id=client.local('conversation',cid);
  return {model,requests,client,roster:()=>client.request('/conversations/members?conversation_id='+id),search:(q,page=1)=>client.request('/conversations/members?conversation_id='+id+'&q='+encodeURIComponent(q)+'&page='+page)};
}
test('ordinary roster only contains managers even when the add-friend setting is enabled',async()=>{
  const f=fixture(),result=await f.roster();assert.equal(result.members_visibility,'managers');assert.equal(result.items.length,1);assert.equal(result.items[0].role,'owner');
});
test('friend directory search preserves query, identity, friendship and cursor contract',async()=>{
  const f=fixture();for(const query of ['人才','工作备注','ROL01','8899']) {
    const first=await f.search(query);assert.equal(first.query,query);assert.equal(first.page,1);assert.equal(first.search_scope,'friends');assert.equal(first.has_more,true);assert.equal(first.items[0].is_contact,true);assert.ok(first.items[0].user_id>0);
    const second=await f.search(query,2);assert.equal(second.page,2);assert.equal(second.has_more,false);assert.equal(f.requests.at(-1).searchParams.get('after'),peer);
  }
});
test('search cursor is scoped to query, current role and login session',async()=>{
  const f=fixture();await f.search('人才');await assert.rejects(f.search('其他',2));f.model.role='admin';await assert.rejects(f.search('人才',2));
  await f.search('人才');f.client.session('different');await assert.rejects(f.search('人才',2));
});
test('ordinary searches reject a result without a current friendship',async()=>{
  const f=fixture();f.model.invalid=true;await assert.rejects(f.search('人才'));
});
test('owner and admin retain full roster and group search scope',async()=>{
  for(const role of ['owner','admin']){const f=fixture(role);assert.equal((await f.roster()).items.length,2);assert.equal((await f.search('人才')).search_scope,'group');}
});
