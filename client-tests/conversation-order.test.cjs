const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../pc/web/conversation-order.js');
const {create:createGo}=require('../client-shared/go-v2.js');
const account={base:'https://fixture.invalid/api/v2',userId:1};
const uuid=n=>String(n).padStart(8,'0')+'-7777-4777-8777-777777777777';
const row=(id,time,extra={})=>({id,type:'direct',is_pinned:false,updated_at:time.slice(0,19).replace('T',' '),_go_updated_at:time,_go_wire_id:uuid(id),...extra});
function fixture(){const values=new Map();return create({storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}});}
const sorted=(order,rows)=>order.sort(account,rows).map(row=>row.id);

test('same-second conversation updates keep microsecond ordering rather than sorting by local IDs',()=>{
  const order=fixture(),a=row(1,'2026-11-17T09:58:00.900001Z'),b=row(2,'2026-11-17T09:58:00.800001Z');
  assert.deepEqual(sorted(order,[b,a]),[1,2]);
  b.unread_count=0;b.peer_online=true;
  assert.deepEqual(sorted(order,[a,b]),[1,2]);
});
test('whole-second, microsecond and nanosecond timestamps compare without losing precision',()=>{
  const order=fixture(),rows=[row(1,'2026-11-17T09:58:00Z'),row(2,'2026-11-17T09:58:00.000001Z'),row(3,'2026-11-17T09:58:00.000000001Z')];
  assert.deepEqual(sorted(order,rows),[2,3,1]);
});
test('equivalent timezone offsets use the same instant and retain fractional order',()=>{
  const order=fixture(),rows=[row(1,'2026-11-17T17:58:00.000003+08:00'),row(2,'2026-11-17T09:58:00.000002Z'),row(3,'2026-11-17T04:58:00.000001-05:00')];
  assert.deepEqual(sorted(order,[rows[2],rows[0],rows[1]]),[1,2,3]);
});
test('equal activity timestamps use the full server UUID rather than unrelated local IDs',()=>{
  const order=fixture(),rows=[row(99,'2026-11-17T09:58:00Z',{_go_wire_id:uuid(1)}),row(1,'2026-11-17T09:58:00Z',{_go_wire_id:uuid(2)})];
  assert.deepEqual(sorted(order,rows),[1,99]);
});
test('new activity moves a recent chat while persisted pinned positions remain fixed',()=>{
  const order=fixture(),a=row(1,'2026-11-17T09:58:00.900Z'),b=row(2,'2026-11-17T09:58:00.800Z'),p=row(3,'2026-11-17T09:58:00.700Z',{is_pinned:true}),q=row(4,'2026-11-17T09:58:00.600Z',{is_pinned:true});
  order.reconcile(account,[q,p,a,b]);
  b._go_updated_at='2026-11-17T09:58:00.999999Z';
  assert.deepEqual(sorted(order,[a,p,b,q]),[4,3,2,1]);
  b.is_pinned=true;order.setPinned(account,2,true);
  assert.deepEqual(sorted(order,[b,a,p,q]),[4,3,2,1]);
  b.is_pinned=false;order.setPinned(account,2,false);
  assert.deepEqual(sorted(order,[q,p,a,b]),[4,3,2,1]);
});
test('legacy local timestamps and numeric IDs still sort consistently without Go fields',()=>{
  const order=fixture(),rows=[{id:3,updated_at:'2026-11-17 17:58:00'},{id:1,updated_at:'2026-11-17 17:59:00'},{id:2,updated_at:'2026-11-17 17:58:00'}];
  assert.deepEqual(sorted(order,rows),[1,3,2]);
});
test('Go full and incremental directory adapters preserve the exact activity stamp and wire identity',async()=>{
  const values=new Map(),wireID=uuid(100),time='2026-11-17T09:58:00.123456Z';
  const raw={id:wireID,kind:'direct',peer_id:uuid(2),peer_name:'好友',membership_version:'1',preference_version:'1',visible_from_seq:'1',message_seq:'0',unread_count:'0',updated_at:time,state:{clear_seq:'0'}};
  const go=createGo({base:account.base,storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},fetch:async(url,options)=>{
    if(url.endsWith('/client/conversation-updates'))return Response.json({items:[raw],removed_ids:[],incremental:true});
    assert.ok(url.includes('/client/conversation-page?'));return Response.json({items:[raw],total:1,page:1,size:50});
  }});go.session('fixture');
  const full=await go.request('/conversations'),id=full.items[0].id,increment=await go.request('/conversations/updates?ids='+id);
  for(const item of [full.items[0],increment.items[0]]){assert.equal(item._go_updated_at,time);assert.equal(item._go_wire_id,wireID);assert.ok(item.updated_at.includes(' '));}
});
