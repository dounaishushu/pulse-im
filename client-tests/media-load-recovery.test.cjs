const {test}=require('node:test');
const assert=require('node:assert/strict');
const {create}=require('../client-shared/media-load-recovery.js');
function fixture(refresh){
  let key='account-a/chat-a/version-1',allowed=true,serial=0;
  const timers=new Map(),children=[];
  const button=new EventTarget();button.attrs=new Map([['aria-label','查看图片']]);button.getAttribute=k=>button.attrs.get(k);button.setAttribute=(k,v)=>button.attrs.set(k,v);button.append=node=>{children.push(node);node.parentElement=button;};
  const img=new EventTarget();img.isConnected=true;img.complete=false;img.naturalWidth=0;img.hidden=false;img.attrs=new Map([['src','old-grant/preview']]);
  img.getAttribute=k=>img.attrs.get(k);img.setAttribute=(k,v)=>img.attrs.set(k,v);img.closest=()=>button;
  img.ownerDocument={createElement:()=>({parentElement:null,remove(){const i=children.indexOf(this);if(i>=0)children.splice(i,1);this.parentElement=null;}})};
  const recovery=create({context:()=>({key,allowed}),refresh,setTimer:fn=>{const id=++serial;timers.set(id,fn);return id;},clearTimer:id=>timers.delete(id)});
  return {img,button,children,timers,recovery,setKey:v=>key=v,setAllowed:v=>allowed=v,
    fire:()=>img.dispatchEvent(new Event('error')),next:async()=>{const [id,fn]=timers.entries().next().value||[];assert.ok(fn,'a bounded retry must be queued');timers.delete(id);await fn();}};
}
test('a transient image error gets a renewed source, then keeps the decoded image',async()=>{
  let calls=0;const f=fixture(async(img,valid)=>{calls++;assert.ok(valid());return 'new-grant/preview';});
  f.recovery.bind(f.img);f.fire();assert.equal(f.timers.size,1);await f.next();
  assert.equal(f.img.getAttribute('src'),'new-grant/preview');assert.equal(calls,1);
  f.img.naturalWidth=640;f.img.dispatchEvent(new Event('load'));assert.equal(f.img.hidden,false);assert.equal(f.children.length,0);
  f.recovery.bind(f.img);assert.equal(f.timers.size,0);
});
test('persistent errors stop after two attempts and require the user to retry',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return 'grant-'+calls;});f.recovery.bind(f.img);
  f.fire();await f.next();f.fire();await f.next();f.fire();
  assert.equal(calls,2);assert.equal(f.timers.size,0);assert.equal(f.children[0].textContent,'图片加载失败，点击重试');
  // A background message render must preserve the retry affordance.
  f.children[0].remove();f.recovery.bind(f.img);assert.equal(f.children.length,1);
  f.button.dispatchEvent(new Event('click',{cancelable:true}));await f.next();assert.equal(calls,3);
});
test('a delayed renewal cannot update the same node after an account or chat switch',async()=>{
  let complete;const f=fixture(()=>new Promise(resolve=>complete=resolve));f.recovery.bind(f.img);f.fire();const pending=f.next();
  f.setKey('account-b/chat-b/version-1');f.recovery.bind(f.img);complete('old-account-grant');await pending;
  assert.equal(f.img.getAttribute('src'),'old-grant/preview');assert.equal(f.children.length,0);
});
test('removed images and locked accounts do not start a queued renewal',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return 'unexpected';});f.recovery.bind(f.img);f.fire();f.setAllowed(false);await f.next();
  assert.equal(calls,0);f.setAllowed(true);f.img.isConnected=false;f.fire();assert.equal(f.timers.size,0);
});
test('permission rejection stops automatic retries instead of hiding the denial',async()=>{
  const f=fixture(async()=>{throw Object.assign(Error('forbidden'),{status:403});});f.recovery.bind(f.img);f.fire();await f.next();
  assert.equal(f.timers.size,0);assert.equal(f.children[0].textContent,'图片加载失败，点击重试');
});
