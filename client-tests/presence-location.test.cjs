const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../client-shared/go-v2.js');
const uid='22222222-2222-4222-8222-222222222222';
function fixture(profile,staff={}){
  const storage=new Map(),requests=[];
  const go=create({base:'https://fixture.invalid/api/v2',storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},fetch:async(raw,options)=>{
    const p=new URL(raw).pathname.replace('/api/v2','');requests.push(p);
    if(p==='/profiles/'+uid)return Response.json({id:uid,account:'peer',nickname:'好友',is_contact:true,...profile});
    assert.equal(p,'/staff/users/'+uid,'presence and staff metadata must not fetch avatars or blocks');
    if(staff.denied)return Response.json({error:{code:'forbidden'}},{status:403});
    return Response.json({id:uid,nickname:'好友',...staff});
  }});go.session('fixture');
  const id=go.local('user',uid);
  return {requests,relationship:()=>go.request('/contacts/relationship?user_id='+id),internal:()=>go.request('/contacts/internal-profile?user_id='+id)};
}
test('authorized online/offline profiles retain the last-seen timestamp for the PC header',async()=>{
  for(const online of [true,false]){
    const f=fixture({last_seen:'2026-11-18T02:12:34Z',online,avatar_id:'33333333-3333-4333-8333-333333333333'}),row=await f.relationship();
    assert.equal(row.online,online);assert.equal(row.last_seen_hidden,false);
    assert.ok(row.last_seen_at&&Number.isFinite(Date.parse(row.last_seen_at.replace(' ','T'))));
    assert.equal(f.requests.length,1);
  }
});
test('a privacy-hidden last-seen remains hidden and carries no timestamp',async()=>{
  const f=fixture({online:false}),row=await f.relationship();
  assert.equal(row.last_seen_hidden,true);assert.equal(row.last_seen_at,null);
});
test('staff location fields and login history survive the Go view adaptation',async()=>{
  const f=fixture({}, {registration_ip:'192.0.2.10',registration_ip_location:'中国 北京',registration_ip_location_status:'resolved',lookup_available:false,
    logins:[{ip:'192.0.2.20',location:'中国 广东 深圳',location_status:'resolved',created_at:'2026-11-18T02:00:00Z',device_name:'phone'}]});
  const row=await f.internal();
  assert.equal(row.register_ip_location,'中国 北京');assert.equal(row.register_ip_location_status,'resolved');
  assert.equal(row.last_login_ip,'192.0.2.20');assert.equal(row.last_login_location,'中国 广东 深圳');assert.equal(row.ip_location,'中国 广东 深圳');
  assert.equal(row.last_login_location_status,'resolved');assert.equal(row.login_history[0].location,'中国 广东 深圳');
});
test('missing geolocation data stays distinct from resolved data and a forbidden staff profile',async()=>{
  const f=fixture({}, {registration_ip:'192.0.2.10',registration_ip_location_status:'unconfigured',logins:[{ip:'192.0.2.20',location_status:'unknown'}]});
  const row=await f.internal();assert.equal(row.last_login_location,'');assert.equal(row.last_login_location_status,'unknown');
  assert.equal(row.register_ip_location_status,'unconfigured');
  await assert.rejects(fixture({}, {denied:true}).internal(),{status:403});
});
