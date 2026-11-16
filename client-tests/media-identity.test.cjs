const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const stable=require('../pc/web/media-identity.js'),media=require('../pc/web/media-source.js'),avatars=require('../pc/web/avatar-source.js');
const {createMediaDiskCache}=require('../pc/media-disk-cache.cjs'),{createAvatarDiskCache}=require('../pc/avatar-disk-cache.cjs');
const id='cc111111-1111-4111-8111-111111111111',a='https://chat.example.org/api/v2/media-grants/'+'a'.repeat(64)+'/content',b=a.replace('a'.repeat(64),'b'.repeat(64));
test('Go grant rotation preserves media identity and keeps preview, content and media IDs distinct',()=>{
 assert.equal(stable.remember(a,id),true);assert.equal(stable.remember(b,id),true);
 assert.equal(media.identity(media.display(a,1,2,3,true,'image')),media.identity(media.display(b,1,2,3,true,'image')));
 assert.notEqual(media.identity(media.display(a,1,2,3,true,'image')),media.identity(media.display(a.replace('/content','/preview'),1,2,3,true,'image')));
 const other=b.replace('b'.repeat(64),'c'.repeat(64));stable.remember(other,'dd111111-1111-4111-8111-111111111111');assert.notEqual(stable.identity(a),stable.identity(other));
 assert.equal(stable.remember('https://other.example.org/path#token',id),false);
});
test('verified chat bytes survive grant rotation while account, origin and revoke checks remain active',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pulse-stable-media-'));let handler,fetches=0;
 const profile={id:'stable',accountId:1,locked:false,session:{protocol:{handle:(_,fn)=>handler=fn,unhandle(){}}}};
 const bytes=Buffer.from([255,216,255,219,1,2,3,4]);
 const cache=createMediaDiskCache({directory:dir,fetch:async()=>{fetches++;return new Response(bytes,{headers:{'Content-Type':'image/jpeg','Content-Length':String(bytes.length)}});}});
 try{
  cache.register(profile,url=>new URL(url).hostname==='chat.example.org'?url:null);
  for(const source of [a,b]){const response=await handler(new Request(media.display(source,1,2,3,true,'image')));assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);}
  assert.equal(fetches,1,'a renewed capability must reuse the verified file');
  assert.equal((await handler(new Request(media.display(b,2,2,3,true,'image')))).status,403);
  const bad=media.display(b,1,2,3,true,'image').replace(encodeURIComponent('https://chat.example.org'),encodeURIComponent('https://untrusted.example.org'));
  assert.equal((await handler(new Request(bad))).status,403);assert.equal(fetches,1);
  await cache.purge(profile,2,[3]);assert.equal((await handler(new Request(media.display(b,1,2,3,true,'image')))).status,403);
 }finally{await cache.clear();cache.unregister(profile);await fs.rm(dir,{recursive:true,force:true});}
});
test('avatar disk reads reuse the same content across renewed capabilities',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pulse-stable-avatar-'));let handler,fetches=0;
 const profile={id:'stable-avatar',accountId:1,locked:false,session:{protocol:{handle:(_,fn)=>handler=fn,unhandle(){}}}};
 const bytes=Buffer.from([255,216,255,219,1,2,3,4]);
 const cache=createAvatarDiskCache({directory:dir,fetch:async()=>{fetches++;return new Response(bytes,{headers:{'Content-Type':'image/jpeg','Content-Length':String(bytes.length)}});}});
 try{
  cache.register(profile,url=>new URL(url).hostname==='chat.example.org'?url:null);
  for(const source of [a,b]){const response=await handler(new Request(avatars.display(source,1,true)));assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);}
  assert.equal(fetches,1);profile.locked=true;assert.equal((await handler(new Request(avatars.display(b,1,true)))).status,403);assert.equal(fetches,1);
 }finally{await cache.clear(profile);cache.unregister(profile);await fs.rm(dir,{recursive:true,force:true});}
});
test('the old PHP signed URL cache keeps its session, content version and kind boundaries',()=>{
 const url='https://chat.example.org/storage/uploads/2026/11/'+'a'.repeat(32)+'.jpg?media_expires=1&media_signature=old&media_session=actor&media_kind=image';
 assert.equal(media.identity(url),media.identity(url.replace('expires=1','expires=2').replace('signature=old','signature=new')));
 assert.notEqual(media.identity(url),media.identity(url.replace('media_session=actor','media_session=other')));
 assert.notEqual(media.identity(url),media.identity(url.replace('media_kind=image','media_kind=video')));
});

test('a failed avatar grant does not poison the native cache after a fresh capability succeeds',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pulse-avatar-renewal-'));let handler,fetches=0;
 const profile={id:'avatar-renewal',accountId:1,locked:false,session:{protocol:{handle:(_,fn)=>handler=fn,unhandle(){}}}};
 const bytes=Buffer.from([255,216,255,219,1,2,3,4]);
 const cache=createAvatarDiskCache({directory:dir,fetch:async(_profile,url)=>{fetches++;return url===a?new Response('',{status:403}):new Response(bytes,{headers:{'Content-Type':'image/jpeg'}});}});
 try{
  cache.register(profile,url=>new URL(url).hostname==='chat.example.org'?url:null);
  assert.equal((await handler(new Request(avatars.display(a,1,true)))).status,403);
  const renewed=await handler(new Request(avatars.display(b,1,true)));assert.equal(renewed.status,200);assert.deepEqual(Buffer.from(await renewed.arrayBuffer()),bytes);
  const repaired=await handler(new Request(avatars.display(a,1,true)));assert.equal(repaired.status,200);assert.deepEqual(Buffer.from(await repaired.arrayBuffer()),bytes);assert.equal(fetches,2);
  profile.locked=true;assert.equal((await handler(new Request(avatars.display(b,1,true)))).status,403);assert.equal(fetches,2);
 }finally{await cache.clear(profile);cache.unregister(profile);await fs.rm(dir,{recursive:true,force:true});}
});
