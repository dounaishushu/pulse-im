const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../client-shared/go-v2.js');
const cid='33333333-3333-4333-8333-333333333333',uid='11111111-1111-4111-8111-111111111111',media='22222222-2222-4222-8222-222222222222';
const wire=n=>'44444444-4444-4444-8444-'+String(n).padStart(12,'0');
const message=(n,extra={})=>({id:wire(n),conversation_id:cid,sender_id:uid,seq:String(n),version:'1',kind:'text',body:'authorized text '+n,content:{},request_id:'message-'+n,sender:{name:'member'},created_at:'2026-11-16T00:00:00Z',updated_at:'2026-11-16T00:00:00Z',...extra});
function setup({deny=false}={}){
  let release,previewReady,version='1',complete=false,mediaCalls=0,replyCalls=0;
  const held=new Promise(r=>release=r),seen=new Promise(r=>previewReady=r),invalidations=[];
  const storage=new Map();
  const items=[message(3,{reply_to_id:wire(1)}),message(2,{kind:'image',content:{media:{id:media,bytes:'100',width:320,height:240,mime:'image/png',filename:'photo.png'}}})];
  const api=create({base:'https://fixture.example.org/api/v2',storage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},onInvalidate:(...args)=>invalidations.push(args),fetch:async(url,options)=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/history'))return deny?Response.json({error:{code:'forbidden'}},{status:403}):Response.json({items,membership_version:version,snapshot_max_seq:'3',next_after_seq:'0',has_more:false,visible_from_seq:'2',clear_seq:'1'});
    if(path.endsWith('/reply-contexts')){replyCalls++;await held;return Response.json({items:[{message_id:wire(3),reply_seq:'1',message:null}]});}
    if(path.endsWith('/media/grants')){mediaCalls++;await held;return Response.json({items:[{id:media,access:{content_path:'/api/v2/media-grants/'+'a'.repeat(64)+'/content',expires_in:120}}]});}
    if(path==='/api/v2/conversations/'+cid)return Response.json({id:cid,kind:'group',title:'group',membership_version:version,preference_version:'1',my_role:'member',state:{clear_seq:'1',read_seq:'0',delivered_seq:'0',version:'1'},message_seq:'3',visible_from_seq:'2',unread_count:'0',updated_at:'2026-11-16T00:00:00Z'});
    throw Error('Unexpected route '+path);
  }});
  api.session('fixture');const id=api.local('conversation',cid);
  return {api,id,seen,invalidations,release,previewReady,changeVersion:()=>{version='2';},counts:()=>({mediaCalls,replyCalls}),load:options=>api.request('/messages/history?conversation_id='+id,{...options,onHistoryPage:options?.onHistoryPage??previewReady}).finally(()=>{complete=true;}),isComplete:()=>complete};
}
async function ready(value){let timer;try{return await Promise.race([value,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('First paint blocked on enrichment')),2000);})]);}finally{clearTimeout(timer);}}

test('authorized first page is delivered before slow media and reply context, with one request per enrichment',async()=>{
  const f=setup(),work=f.load();
  const first=await ready(f.seen);
  assert.equal(f.isComplete(),false);assert.equal(first.membership_version,1);assert.equal(first.cleared_before_message_id,1);
  assert.equal(first.items[0].body.text,'authorized text 3');assert.equal(first.items[1].body.media_pending,true);assert.equal(first.items[1].body.url,'');
  f.release();const full=await work;
  assert.ok(full.items[1].body.url.endsWith('/content'));assert.equal(full.items[1].body.media_pending,undefined);
  assert.equal(full.items[0].body.reply_to.unavailable,true);assert.deepEqual(f.counts(),{mediaCalls:1,replyCalls:1});
});
test('a denied history page never reaches the first-paint callback',async()=>{
  const f=setup({deny:true});let painted=0;
  await assert.rejects(f.load({onHistoryPage:()=>painted++}),{status:403});assert.equal(painted,0);assert.deepEqual(f.counts(),{mediaCalls:0,replyCalls:0});
});
test('a membership change during enrichment rejects the old final page',async()=>{
  const f=setup(),work=f.load();await ready(f.seen);
  f.changeVersion();await f.api.request('/conversations/info?conversation_id='+f.id);f.release();
  await assert.rejects(work,{code:'membership_changed'});assert.equal(f.invalidations.length,1);
});
test('switching login during enrichment cannot deliver the old final page',async()=>{
  const f=setup(),work=f.load();await ready(f.seen);f.api.session('another-login');f.release();await assert.rejects(work,{code:'stale_session'});
});
test('navigation cancellation stops enrichment without another history fetch',async()=>{
  const f=setup(),controller=new AbortController(),work=f.load({signal:controller.signal});await ready(f.seen);
  controller.abort();f.release();await assert.rejects(work);assert.equal(f.counts().mediaCalls,1);
});
