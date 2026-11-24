// Real notification/search components and the account-scoped name resolver.
// All data is isolated; no production account or push provider is contacted.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),repo=path.dirname(root);
const output=process.env.PULSE_MENTION_PRIVACY_OUTPUT||path.join(repo,'.local/mention-privacy-ui');
const fixture=`import {createApp,defineComponent,h,shallowRef,provide,onMounted,nextTick} from 'vue';
import '/src/App.vue';
import ChatSearch from '/src/features/chat/ChatSearch.vue';
import {chatKey} from '/src/composables/useChat.ts';
import {useNotifications} from '/src/composables/useNotifications.ts';
import {mentionPreview} from '/src/features/chat/mentionText.ts';
import '/@fs/REPO/web/contact-names.js';
const body={text:'@发送方私有备注 请查看',mention_user_ids:[2],mention_users:[{user_id:2,nickname:'被提及者昵称',labels:['发送方私有备注']}]};
const message={id:22,conversation_id:9000,sender_id:1,sender_name:'发送者昵称',type:'text',body,status:'sent',created_at:'2026-11-24T04:00:00Z'};
createApp(defineComponent({setup(){
 const me=shallowRef({id:1,nickname:'发送者昵称'}),rows=shallowRef([]),foreground=shallowRef(false),locked=shallowRef(false),revision=shallowRef(0);
 const apiCalls=[];
 const names=window.PulseContactNames.create({context:()=>({base:'fixture',token:'viewer-'+me.value.id,userId:me.value.id,nickname:me.value.nickname}),request:async()=>{throw Error('unexpected name lookup');},changed:()=>{revision.value++;}});
 const resolve=(id,fallback)=>{void revision.value;return names.resolve(id,fallback);};
 const preview=m=>mentionPreview(m,resolve);
 useNotifications(rows,me,locked,()=>{},foreground,preview);
 const active=shallowRef({id:9000,type:'group',name:'隐私回归群'});
 const chat={active,me,error:e=>{throw e;},api:async p=>{apiCalls.push(p);return p.startsWith('/messages/search?')?{items:[message]}:p.startsWith('/messages/calendar?')?{today:'2026-11-24',first_date:'2026-01-01'}:{items:[]};},contactName:resolve,messagePreview:preview};
 provide(chatKey,chat);let seq=23;
 const account=(id,remark)=>{me.value={id,nickname:id===1?'发送者昵称':id===2?'被提及者昵称':'旁观者昵称'};names.remember(2,remark);};
 names.remember(2,'发送方私有备注');
 window.mentionPrivacy={account,rename:n=>{me.value={...me.value,nickname:n};},clear:()=>names.remember(2,''),raw:()=>JSON.stringify(body),calls:apiCalls,
 notify:()=>{rows.value=[{id:9000,type:'group',name:'隐私回归群',last_message:{...message,id:seq++},unread_count:1}];}};
 onMounted(async()=>{rows.value=[{id:9000,type:'group',name:'隐私回归群',last_message:message,unread_count:1}];await nextTick();window.mentionPrivacyReady=true;});
 return()=>h('main',[h('p',{id:'viewer-text'},preview(message)),h(ChatSearch)]);
}})).mount('#app');`;
const checks=[],errors=[];let browser,server;
const pass=name=>{checks.push(name);console.log('PASS '+name);};
(async()=>{
 fs.mkdirSync(output,{recursive:true});process.chdir(root);
 const {createServer}=await import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')));
 server=await createServer({root,configFile:path.join(root,'vite.config.ts'),logLevel:'error',cacheDir:path.join(output,'vite-cache'),server:{host:'127.0.0.1',port:0,strictPort:false,open:false},plugins:[{
  name:'mention-privacy-fixture',resolveId:id=>id==='virtual:mention-privacy'?'\0virtual:mention-privacy':undefined,
  load:id=>id==='\0virtual:mention-privacy'?fixture.replace('REPO',repo.replaceAll('\\','/')):undefined,
  configureServer(vite){vite.middlewares.use('/__mention-privacy',(_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/@id/__x00__virtual:mention-privacy"></script></html>');});},
 }]});await server.listen();
 browser=await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{channel:'chrome'})});
 const page=await browser.newPage({viewport:{width:1000,height:780}});page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.mentionNotifications=[];window.Notification=class{static permission='granted';constructor(title,options){window.mentionNotifications.push({title,...options});}close(){}};});
 try{
  await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__mention-privacy');await page.waitForFunction(()=>window.mentionPrivacyReady);
  await page.getByRole('textbox',{name:'搜索消息',exact:true}).fill('请查看');await page.getByRole('button',{name:'搜索',exact:true}).click();
  const result=page.locator('.vue-search-results button p');await result.waitFor();
  assert.equal(await result.textContent(),'@发送方私有备注 请查看');pass('sender sees their own remark in search');
  const initial=await page.evaluate(()=>({raw:window.mentionPrivacy.raw(),calls:window.mentionPrivacy.calls.length}));
  await page.evaluate(()=>{window.mentionPrivacy.account(2,'不应显示的自备注');window.mentionPrivacy.notify();});
  await page.waitForFunction(()=>window.mentionNotifications.length===1);
  assert.equal(await result.textContent(),'@被提及者昵称 请查看');assert.equal(await page.evaluate(()=>window.mentionNotifications[0].body),'@被提及者昵称 请查看');
  pass('mentioned recipient sees their own nickname in both notification and search');
  await page.screenshot({path:path.join(output,'recipient-name.png')});
  await page.evaluate(()=>{window.mentionPrivacy.account(3,'旁观者自己的备注');window.mentionPrivacy.notify();});await page.waitForFunction(()=>window.mentionNotifications.length===2);
  assert.equal(await result.textContent(),'@旁观者自己的备注 请查看');assert.equal(await page.evaluate(()=>window.mentionNotifications[1].body),'@旁观者自己的备注 请查看');
  pass('another viewer sees their own remark and never the sender private label');
  await page.evaluate(()=>{window.mentionPrivacy.clear();window.mentionPrivacy.notify();});await page.waitForFunction(()=>window.mentionNotifications.length===3);
  assert.equal(await result.textContent(),'@被提及者昵称 请查看');assert.equal(await page.evaluate(()=>window.mentionNotifications[2].body),'@被提及者昵称 请查看');
  pass('clearing a viewer remark restores the public nickname in previews');
  await page.evaluate(()=>{window.mentionPrivacy.account(2,'');window.mentionPrivacy.rename('我现在的昵称');window.mentionPrivacy.notify();});await page.waitForFunction(()=>window.mentionNotifications.length===4);
  assert.equal(await result.textContent(),'@我现在的昵称 请查看');assert.equal(await page.evaluate(()=>window.mentionNotifications[3].body),'@我现在的昵称 请查看');
  const final=await page.evaluate(()=>({raw:window.mentionPrivacy.raw(),calls:window.mentionPrivacy.calls.length,notifications:window.mentionNotifications}));
  assert.equal(final.raw,initial.raw);assert.equal(final.calls,initial.calls);assert.deepEqual(errors,[]);
  pass('account/name changes rerender without changing shared source or making per-mention requests');
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,notifications:final.notifications},null,2));console.log(JSON.stringify({passed:checks.length,output}));
 }catch(e){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw e;}
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();await server?.close();});
