const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../client-shared/go-v2.js');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const uuid=n=>String(n).padStart(8,'0')+'-6666-4666-8666-666666666666';
const rawMessage=(n=2)=>({id:uuid(100+n),conversation_id:uuid(n),sender_id:uuid(90),seq:'2',event_seq:'2',version:'1',kind:'image',body:'预览文字',request_id:'fixture-'+n,reply_to_id:uuid(80),sender:{name:'用户',avatar_id:uuid(91)},content:{media:{id:uuid(92),bytes:'24',filename:'photo.png'}},created_at:'2026-11-16T00:00:00Z',updated_at:'2026-11-16T00:00:00Z'});
const conversation=n=>({id:uuid(n),kind:'group',title:'群聊',avatar_id:uuid(93),message_seq:'2',event_seq:'2',membership_version:'1',visible_from_seq:'1',my_role:'member',can_send:true,unread_count:1,state:{read_seq:'0',clear_seq:'0'},updated_at:'2026-11-16T00:00:00Z',last_message:rawMessage(n)});
function adapter(fetch){const data=new Map();const c=create({base:'https://chat.example.org/api/v2',fetch,storage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)}});c.session('fixture');return c;}

test('会话摘要只授权列表头像，不补查引用、图片正文和发件人头像',async()=>{
  const paths=[],grants=[];
  const c=adapter(async(url,options)=>{
    paths.push(new URL(url).pathname);
    if(url.includes('/client/conversation-page'))return Response.json({items:Array.from({length:8},(_,i)=>conversation(i+1))});
    if(url.endsWith('/media/grants')){
      const ids=JSON.parse(options.body).media_ids;grants.push(...ids);
      return Response.json({items:ids.map(id=>({id,access:{content_path:'/api/v2/media-grants/'+'a'.repeat(64)+'/content',expires_in:120}}))});
    }
    if(url.endsWith('/reply-contexts'))return Response.json({items:JSON.parse(options.body).message_ids.map(id=>({message_id:id,reply_seq:'1',message:null}))});
    throw new Error('Unexpected request');
  });
  const result=await c.request('/conversations');
  assert.equal(result.items.length,8);
  assert.equal(result.items[0].last_message.body.text,'预览文字');
  assert.equal(result.items[0].last_message.type,'image');
  assert.ok(result.items[0].avatar_url.endsWith('/content'));
  assert.equal(paths.length,2);assert.deepEqual(grants,[uuid(93)]);
});

test('摘要刷新不覆盖已加载消息的引用和图片授权',async()=>{
  const c=adapter(async url=>{
    if(url.endsWith('/media/grants'))return Response.json({items:[{id:uuid(93),access:{content_path:'/api/v2/media-grants/'+'a'.repeat(64)+'/content',expires_in:120}}]});
    if(url.endsWith('/reply-contexts'))return Response.json({items:[{message_id:uuid(102),reply_seq:'1',message:null}]});
    return Response.json({...conversation(2),avatar_id:'',last_message:{...rawMessage(),version:'2',content:{},sender:{}}});
  });
  const cid=c.local('conversation',uuid(2));c.version(cid,1);
  const complete=c.message({...rawMessage(),version:'2',content:{},sender:{},_go_reply:{reply_seq:'1',message:{...rawMessage(80),seq:'1',kind:'text',body:'已加载引用',content:{},sender:{}}}});
  await c.request('/conversations/info?conversation_id='+cid);
  const cached=c.message({...rawMessage(),version:'1'});
  assert.equal(complete.body.reply_to.text,'已加载引用');
  assert.equal(cached.body.reply_to.text,'已加载引用');
});

test('消息写入成功后的引用服务故障不能重放发送请求',async()=>{
  const controller=new AbortController();let sends=0,replies=0;
  const c=adapter(async url=>{
    if(url.endsWith('/messages')){sends++;return Response.json({message:{...rawMessage(),kind:'text',content:{},sender:{}}});}
    if(url.endsWith('/reply-contexts')){
      replies++;
      if(replies>1)controller.abort(new DOMException('Repeated hydration','AbortError'));
      return Response.json({error:{code:'unavailable'}},{status:503});
    }
    throw new Error('Unexpected request');
  });
  const cid=c.local('conversation',uuid(2));
  await assert.rejects(c.request('/messages',{method:'POST',signal:controller.signal,body:{conversation_id:cid,type:'text',body:{text:'内容'},request_id:'stable-request'}}));
  assert.equal(sends,1);assert.equal(replies,1);
});

for(const directory of ['web','pc/web']){
  test(directory+' 不同会话相同消息序号分别通知，同一消息只通知一次',()=>{
    const source=fs.readFileSync(path.join(__dirname,'..',directory,'app.js'),'utf8');
    const start=source.indexOf('function desktopNotificationState()'),flush=source.indexOf('function flushDesktopInboxNotifications()',start),end=source.indexOf('\n}',flush)+2;
    const notices=[],state={token:'fixture',user:{id:1},conversations:[]};
    const scope={state,Map,Set,isDetachedConversation:false,desktop:{isDesktop:true,notify:(...args)=>notices.push(args)},
      document:{hidden:true,hasFocus:()=>false},readPasscodeSettings:()=>({locked:false}),localSetting:(_,fallback)=>fallback,
      contactDisplayName:(_,name)=>name,conversationMessagePreview:()=> 'preview',mediaUrl:x=>x,$:()=>({hidden:false})};
    vm.runInNewContext(source.slice(start,end),scope);
    const notify=cid=>scope.notifyDesktopMessage({id:1,conversation_id:cid,sender_id:2,body:{text:'message'}},{id:cid,type:'group',name:'group'});
    notify(10);notify(20);notify(10);
    assert.equal(notices.length,2);
    scope.queueDesktopInboxNotification({data:{event_type:'message.new',conversation_id:30,message_id:1}});
    assert.ok(state.desktopNotifications.pending.has(30));
  });
  function searchHarness(){
    const source=fs.readFileSync(path.join(__dirname,'..',directory,'app.js'),'utf8');
    const start=source.indexOf('async function searchMessages('),end=source.indexOf('\nfunction closeFeatureModal',start);
    const box={innerHTML:'current',isConnected:true},input={value:'first'},requests=[];
    const state={token:'session',user:{id:1},active:{id:1},historyEpoch:1};
    const scope={state,AbortController,URLSearchParams,console,$:id=>id==='message-search'?input:box,
      loadConversations:async()=>{},messageHtml:row=>row.text,bindMessageActions:()=>{},composerFeedback:()=>{},
      api:(_,options)=>new Promise((resolve,reject)=>requests.push({resolve,reject,options}))};
    vm.runInNewContext(source.slice(start,end),scope);
    return {scope,state,box,input,requests};
  }
  test(directory+' 搜索的迟到响应不能覆盖已切换的聊天',async()=>{
    const {scope,state,box,requests}=searchHarness();
    const pending=scope.searchMessages('first');state.active={id:2};state.historyEpoch++;
    requests[0].resolve({items:[{text:'old result'}]});await pending;
    assert.equal(box.innerHTML,'current');
  });
  test(directory+' 新关键词取消旧搜索，旧响应和旧错误都不回写',async()=>{
    const {scope,box,input,requests}=searchHarness();
    const old=scope.searchMessages('first');input.value='second';const current=scope.searchMessages('second');
    requests[1].resolve({items:[{text:'new result'}]});await current;
    requests[0].resolve({items:[{text:'old result'}]});await old;
    assert.equal(box.innerHTML,'new result');assert.equal(requests[0].options.signal.aborted,true);
    input.value='third';const failed=scope.searchMessages('third');input.value='fourth';const latest=scope.searchMessages('fourth');
    requests[2].reject(new Error('old failure'));await failed;requests[3].resolve({items:[{text:'latest'}]});await latest;
    assert.equal(box.innerHTML,'latest');
  });
  test(directory+' 桌面搜索面板替换关键词时取消上一请求',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'..',directory,'app.js'),'utf8');
    const start=source.indexOf('async function runChatSearch('),end=source.indexOf('\n}',start)+2;
    const search={id:1,request:0,items:[],page:0,keyword:''},state={token:'fixture',active:{id:1},chatSearch:search};
    const input={value:'first'},requests=[];
    const scope={state,AbortController,URLSearchParams,clearTimeout,renderChatSearchPanel:()=>{},$:()=>input,
      api:(_,options)=>new Promise(resolve=>requests.push({resolve,options}))};
    vm.runInNewContext(source.slice(start,end),scope);
    const first=scope.runChatSearch();input.value='second';const second=scope.runChatSearch();
    requests[1].resolve({items:[{id:2}],total:1});await second;requests[0].resolve({items:[{id:1}],total:1});await first;
    assert.equal(requests[0].options.signal.aborted,true);assert.equal(search.items[0].id,2);
  });
}
