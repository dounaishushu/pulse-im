const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const id = n => `${String(n).padStart(8,'0')}-2222-4222-8222-222222222222`;
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(fetcher) {
  const created=[],revoked=[],storage=new Map(),requests=[];
  class URLs extends URL {}
  URLs.createObjectURL=blob=>{const url='blob:https://admin.invalid/'+created.length;created.push({url,bytes:blob.size});return url;};
  URLs.revokeObjectURL=url=>revoked.push(url);
  const sandbox={window:{},location:{origin:'https://admin.invalid'},URL:URLs,URLSearchParams,Response,FormData,AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    fetch:async(url,options)=>{requests.push({url,options});return fetcher(url,options);}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/go-api.js'),'utf8'),sandbox);
  return {api:sandbox.window.PulseGoAdmin,created,revoked,storage,requests};
}
const mediaResponse = (bytes=100) => ({ok:true,status:200,headers:new Headers({'Content-Length':String(bytes)}),blob:async()=>({size:bytes})});
function statsResponse(url) {
  const p=new URL(url).pathname;
  return Response.json(p.endsWith('/stats')?{users:100}:p.endsWith('/health')?{queues:{workers:[]}}:{items:[]});
}

test('dashboard shares statistics and health once per load and refresh remains fresh',async()=>{
  const f=fixture(statsResponse);
  for(let turn=1;turn<=2;turn++) {
    const [results]=await Promise.all([f.api.request('/admin/dashboard'),f.api.request('/admin/stats/offsite-logins')]);
    assert.ok(results.every(r=>r.status==='fulfilled'));
    assert.equal(f.requests.length,5*turn);
    assert.equal(f.requests.filter(r=>r.url.endsWith('/admin/stats')).length,turn);
    assert.equal(f.requests.filter(r=>r.url.endsWith('/admin/health')).length,turn);
  }
});
test('dashboard propagates expired credentials and discards another login response',async()=>{
  const denied=fixture(()=>Response.json({error:{code:'unauthorized'}},{status:401}));
  await assert.rejects(denied.api.request('/admin/dashboard'),{status:401});
  let finish;const gate=new Promise(resolve=>finish=resolve);
  const f=fixture(async url=>{await gate;return statsResponse(url);});
  const result=f.api.request('/admin/dashboard');
  f.api.reset();finish();
  await assert.rejects(result,{status:409});
});
test('concurrent media views share one download and every object URL is released on logout',async()=>{
  const f=fixture(async()=>{await tick();return mediaResponse();});
  const [a,b]=await Promise.all([f.api.acquireMedia(id(1)),f.api.acquireMedia(id(1))]);
  assert.equal(f.requests.length,1);assert.equal(a.url,b.url);assert.equal(f.created.length,1);
  a.release();b.release();b.release();
  f.api.reset();assert.deepEqual(f.revoked,[a.url]);
});
test('canceling one media view leaves the other consumer and its URL alive',async()=>{
  let finish;const gate=new Promise(resolve=>finish=resolve);
  const f=fixture(async(_url,{signal})=>{await gate;signal.throwIfAborted();return mediaResponse();});
  const controller=new AbortController();
  const canceled=f.api.acquireMedia(id(1),controller.signal);
  const waiting=f.api.acquireMedia(id(1));
  const checked=assert.rejects(canceled,{name:'AbortError'});
  controller.abort();await checked;
  assert.equal(f.requests[0].options.signal.aborted,false);
  finish();const lease=await waiting;lease.release();f.api.reset();
  assert.equal(f.created.length,1);assert.equal(f.revoked.length,1);
});
test('last consumer cancellation aborts the download and a retry starts a fresh flight',async()=>{
  let first=true;
  const f=fixture((_url,{signal})=>{
    if(!first)return mediaResponse();first=false;
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  });
  const controller=new AbortController(),pending=f.api.acquireMedia(id(1),controller.signal);
  const checked=assert.rejects(pending,{name:'AbortError'});controller.abort();await checked;await tick();
  assert.equal(f.requests[0].options.signal.aborted,true);
  const lease=await f.api.acquireMedia(id(1));assert.equal(f.requests.length,2);lease.release();f.api.reset();
});
test('completed media uses bounded LRU storage without revoking active playback',async()=>{
  const f=fixture(()=>mediaResponse(4*1024*1024));
  const playing=await f.api.acquireMedia(id(1));
  for(let n=2;n<=40;n++) {const lease=await f.api.acquireMedia(id(n));lease.release();}
  assert.equal(f.revoked.includes(playing.url),false);
  const live=()=>f.created.filter(e=>!f.revoked.includes(e.url));
  assert.ok(live().reduce((sum,e)=>sum+e.bytes,0)<=64*1024*1024);
  playing.release();f.api.reset();assert.equal(live().length,0);
});
test('media larger than idle budget is retained only while in use; over-limit response is canceled',async()=>{
  const f=fixture(()=>mediaResponse(80*1024*1024));
  const lease=await f.api.acquireMedia(id(1));assert.equal(f.revoked.length,0);
  lease.release();assert.deepEqual(f.revoked,[lease.url]);
  let canceled=false;
  const huge=fixture(()=>({...mediaResponse(101*1024*1024),body:{cancel:async()=>{canceled=true;}}}));
  await assert.rejects(huge.api.acquireMedia(id(1)),{status:413});assert.equal(canceled,true);assert.equal(huge.created.length,0);
});
test('logout during download cannot install old media in a new session cache',async()=>{
  let finish;const gate=new Promise(resolve=>finish=resolve);
  const f=fixture(async()=>{await gate;return mediaResponse();});
  const pending=f.api.acquireMedia(id(1));const checked=assert.rejects(pending);
  f.api.reset();finish();await checked;await tick();assert.equal(f.created.length,0);
  const lease=await f.api.acquireMedia(id(1));assert.equal(f.requests.length,2);lease.release();f.api.reset();
  assert.equal(f.created.length,1);assert.equal(f.revoked.length,1);
});

test('failed health does not hide otherwise successful statistics and regions',async()=>{
  const f=fixture(url=>url.endsWith('/admin/health')?Response.json({error:{code:'unavailable'}},{status:503}):statsResponse(url));
  const results=await f.api.request('/admin/dashboard');
  assert.equal(results[0].status,'fulfilled');assert.equal(results[0].value.users.total,100);
  assert.equal(results[1].status,'rejected');assert.equal(results[2].status,'fulfilled');
});
