const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto'),{Readable}=require('node:stream');
const sources=require('./web/media-source.js'),hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const CHUNK=65536,OWN=/^[a-f0-9]{64}\.(?:media|json|part|meta)$/;
const IMAGE_TYPE=/^image\/(?:jpeg|png|gif|webp|avif|bmp|x-ms-bmp)$/;
const validType=(type,image)=>image?IMAGE_TYPE.test(type):/^((video|audio)\/[a-z0-9.+-]+|application\/octet-stream)$/.test(type);
// Remove the caller's continuation on abort. The shared operation may still be
// needed by another window, so its promise must not retain the cancelled reader.
function settleWait(wait,error,value){if(!wait.resolve)return;const resolve=wait.resolve,reject=wait.reject;wait.signal?.removeEventListener('abort',wait.cancel);wait.resolve=wait.reject=wait.signal=wait.cancel=null;if(error)reject(error);else resolve(value);}
function abortable(promise,signal){if(signal.aborted)return Promise.reject(Error('MEDIA_CANCELLED'));return new Promise((resolve,reject)=>{const wait={resolve,reject,signal,cancel:null};wait.cancel=()=>settleWait(wait,Error('MEDIA_CANCELLED'));signal.addEventListener('abort',wait.cancel,{once:true});promise.then(value=>settleWait(wait,null,value),error=>settleWait(wait,error));});}
function imageBytes(bytes,type){
 if(type==='image/jpeg')return bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(type==='image/png')return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(type==='image/gif')return /^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'));
 if(type==='image/webp')return bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
 if(type==='image/avif')return bytes.subarray(4,8).toString()==='ftyp'&&/avi[fs]/.test(bytes.subarray(8,64).toString('ascii'));
 return /^image\/(?:bmp|x-ms-bmp)$/.test(type)&&bytes.subarray(0,2).toString()==='BM';
}
function createMediaDiskCache({directory,fetch,maxBytes=2*1024**3,maxFileBytes=100*1024**2,maxEntries=500,report=()=>{}}){
 const root=path.resolve(directory),states=new WeakMap(),flights=new Map(),starts=new Map(),reads=new Map(),leases=new Map(),blocked=new Set(),owners=new Map(),references=new Map(),readers=new Map();let epoch=0,active=0,pruning=false;const waiters=[];
 const safeName=k=>path.join(root,k),tag=(p,c,m,account=p.accountId)=>hash(`${p.id}|${account}|${c}|${m}`),group=(p,c,account=p.accountId)=>hash(`${p.id}|${account}|${c}`);
 const cacheKey=(p,account,cid,mid,source)=>hash(`${p.id}|${account}|${cid}|${mid}|${sources.identity(source)}`);
 function dropReferences(keys){for(const k of keys){const n=(references.get(k)||1)-1;if(n)references.set(k,n);else{references.delete(k);const f=flights.get(k);if(f&&!f.done)f.controller.abort();for(const reader of [...(readers.get(k)||[])])reader.cancel();}}}
 function updateConsumers(owner,profile,urls){
  if(!Array.isArray(urls)||urls.length>2048)return false;
  const keys=new Set();for(const url of urls){const parsed=sources.parseDisplay(url);if(!parsed||parsed.account!==profile.accountId||profile.locked||!sources.isImage(parsed.source))continue;keys.add(cacheKey(profile,parsed.account,parsed.conversation,parsed.message,parsed.source));}
  const previous=owners.get(owner);for(const k of keys)if(!previous?.keys.has(k))references.set(k,(references.get(k)||0)+1);
  if(keys.size)owners.set(owner,{profile,keys});else owners.delete(owner);
  if(previous)dropReferences([...previous.keys].filter(k=>!keys.has(k)));return true;
 }
 function releaseConsumer(owner){const previous=owners.get(owner);if(!previous)return;owners.delete(owner);dropReferences(previous.keys);}
 const current=(p,t)=>p.accountId===t.account&&!p.locked&&t.generation===states.get(p)?.generation&&t.epoch===epoch;
 const permitted=(p,t,mediaTag,mediaGroup)=>current(p,t)&&!blocked.has(mediaTag)&&!blocked.has(mediaGroup);
 async function acquire(signal){if(signal.aborted)throw Error('MEDIA_CANCELLED');if(active<2){active++;return;}await new Promise((resolve,reject)=>{const job={resolve:()=>{signal.removeEventListener('abort',cancel);resolve();}},cancel=()=>{const i=waiters.indexOf(job);if(i>=0)waiters.splice(i,1);reject(Error('MEDIA_CANCELLED'));};signal.addEventListener('abort',cancel,{once:true});waiters.push(job);});}
 function release(){const next=waiters.shift();if(next)next.resolve();else active--;}
 async function initialize(){await fsp.mkdir(root,{recursive:true,mode:0o700});const st=await fsp.lstat(root);if(!st.isDirectory()||st.isSymbolicLink())throw Error('MEDIA_DIRECTORY');}
 async function remove(k){await Promise.all([fsp.unlink(safeName(k+'.media')).catch(()=>{}),fsp.unlink(safeName(k+'.json')).catch(()=>{})]);}
 async function cached(k,image,mediaTag,mediaGroup){
  if(reads.has(k))return reads.get(k);
  const pending=(async()=>{try{const a=await fsp.lstat(safeName(k+'.media')),b=await fsp.lstat(safeName(k+'.json'));if(!a.isFile()||a.isSymbolicLink()||!b.isFile()||b.isSymbolicLink()||b.size>256*1024)throw Error();const meta=JSON.parse(await fsp.readFile(safeName(k+'.json'),'utf8'));if(!validType(meta.type,image)||meta.tag!==mediaTag||meta.group!==mediaGroup||a.size!==meta.size||a.size<=0||a.size>maxFileBytes||!Array.isArray(meta.chunks)||meta.chunks.length!==Math.ceil(a.size/CHUNK)||meta.chunks.some(chunk=>!/^[a-f0-9]{64}$/.test(chunk)))throw Error();void fsp.utimes(safeName(k+'.json'),new Date(),new Date()).catch(()=>{});return meta;}catch(error){if(error.code!=='ENOENT'&&!flights.has(k)&&!starts.has(k))await remove(k);return null;}})();
  reads.set(k,pending);try{return await pending;}finally{if(reads.get(k)===pending)reads.delete(k);}
 }
 async function prune(){if(pruning)return;pruning=true;try{await initialize();const rows=[];for(const name of await fsp.readdir(root)){if(!OWN.test(name))continue;const k=name.slice(0,64);if(flights.has(k)||starts.has(k)||leases.has(k))continue;
  if(/\.(?:part|meta)$/.test(name)||name.endsWith('.media')){const st=await fsp.lstat(safeName(name)).catch(()=>null);if(st&&Date.now()-st.mtimeMs>60000&&!flights.has(k)&&!starts.has(k)&&!leases.has(k)&&(!name.endsWith('.media')||!fs.existsSync(safeName(k+'.json'))))await fsp.unlink(safeName(name)).catch(()=>{});continue;}
  try{const st=await fsp.lstat(safeName(name)),data=await fsp.lstat(safeName(k+'.media'));if(!st.isFile()||st.isSymbolicLink()||!data.isFile()||data.isSymbolicLink()||st.size>256*1024)throw Error();const m=JSON.parse(await fsp.readFile(safeName(name),'utf8'));if(m.size!==data.size)throw Error();rows.push({k,bytes:data.size,time:st.mtimeMs});}catch{if(!flights.has(k)&&!starts.has(k)&&!leases.has(k))await remove(k);}}rows.sort((a,b)=>a.time-b.time);let total=rows.reduce((n,r)=>n+r.bytes,0);while(rows.length>maxEntries||total>maxBytes){const row=rows.shift();if(!row)break;if(flights.has(row.k)||starts.has(row.k)||leases.has(row.k))continue;total-=row.bytes;await remove(row.k);}}finally{pruning=false;}}
 function wake(f){for(const fn of f.waiters.splice(0))fn();}
 async function startDownload(profile,t,k,source,cid,mid){
  await initialize();if(!readers.get(k)?.size)throw Error('MEDIA_CANCELLED');const controller=new AbortController(),f={controller,profile,t,k,waiters:[],written:0,chunks:[],type:'',size:0,done:false,error:null,image:sources.isImage(source),part:safeName(k+'.part'),tag:tag(profile,cid,mid,t.account),group:group(profile,cid,t.account)};
  const valid=()=>permitted(profile,t,f.tag,f.group)&&!controller.signal.aborted;
  f.headers=new Promise((resolve,reject)=>{f.headerResolve=resolve;f.headerReject=reject;});f.headers.catch(()=>{});flights.set(k,f);
  f.finished=(async()=>{let handle,acquired=false;const timeout=setTimeout(()=>controller.abort(),180000);try{
   await acquire(controller.signal);acquired=true;if(!valid())throw Error('MEDIA_CANCELLED');
   const response=await fetch(profile,source,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal});
   const type=String(response.headers.get('content-type')||'').split(';')[0].toLowerCase(),size=Number(response.headers.get('content-length'));
   if(response.status!==200||!validType(type,f.image)){await response.body?.cancel().catch(()=>{});throw Error('MEDIA_RESPONSE');}
   if(Number.isFinite(size)&&size>maxFileBytes){void response.body?.cancel().catch(()=>{});throw Error('MEDIA_SIZE');}f.type=type;f.size=size>0?size:0;
   if(!valid()){await response.body?.cancel().catch(()=>{});throw Error('MEDIA_CANCELLED');}
   await fsp.unlink(f.part).catch(()=>{});handle=await fsp.open(f.part,'wx',0o600);if(f.size&&!f.image)f.headerResolve(f);
   const reader=response.body.getReader();let carry=Buffer.alloc(0),total=0;
   async function write(bytes){if(!valid())throw Error('MEDIA_CANCELLED');if(f.image&&!f.written&&!imageBytes(bytes,type))throw Error('MEDIA_CONTENT');await handle.writeFile(bytes);if(!valid())throw Error('MEDIA_CANCELLED');f.chunks.push(hash(bytes));f.written+=bytes.length;wake(f);}
   try{for(;;){const{done,value}=await reader.read();if(done)break;total+=value.length;if(total>maxFileBytes)throw Error('MEDIA_SIZE');carry=Buffer.concat([carry,Buffer.from(value)]);while(carry.length>=CHUNK){await write(carry.subarray(0,CHUNK));carry=carry.subarray(CHUNK);}}if(carry.length)await write(carry);}catch(e){await reader.cancel().catch(()=>{});throw e;}
   if(!total||(f.size&&total!==f.size))throw Error('MEDIA_TRUNCATED');f.size=total;f.committing=true;await handle.close();handle=null;
   if(!valid())throw Error('MEDIA_CANCELLED');
   const meta={size:f.size,type:f.type,chunks:f.chunks,tag:f.tag,group:f.group};
   await fsp.rename(f.part,safeName(k+'.media'));if(!valid())throw Error('MEDIA_CANCELLED');await fsp.writeFile(safeName(k+'.meta'),JSON.stringify(meta),{mode:0o600});if(!valid())throw Error('MEDIA_CANCELLED');await fsp.rename(safeName(k+'.meta'),safeName(k+'.json'));if(!valid())throw Error('MEDIA_CANCELLED');f.done=true;f.headerResolve(f);wake(f);
  }catch(error){f.error=error;f.headerReject(error);wake(f);await handle?.close().catch(()=>{});await Promise.all([fsp.unlink(f.part).catch(()=>{}),fsp.unlink(safeName(k+'.meta')).catch(()=>{})]);await remove(k);report(/^MEDIA_[A-Z_]+$/.test(error.message)?error.message:'MEDIA_IO');}
  finally{clearTimeout(timeout);if(acquired)release();flights.delete(k);void prune().catch(()=>{});}})();return f;
 }
 async function* bytes(profile,t,k,meta,start,end,flight,image,signal){let handle;leases.set(k,(leases.get(k)||0)+1);try{
  const names=flight&&!flight.done?[flight.part,safeName(k+'.media')]:[safeName(k+'.media')];for(const name of names)try{handle=await fsp.open(name,'r');break;}catch{}
  if(!handle)throw Error('MEDIA_FILE');let position=start;
  while(position<=end){if(signal.aborted||!current(profile,t)||blocked.has(meta.tag)||blocked.has(meta.group))throw Error('MEDIA_CANCELLED');if(flight?.error)throw flight.error;
   const index=Math.floor(position/CHUNK),offset=index*CHUNK,count=Math.min(CHUNK,meta.size-offset);
   while(flight&&flight.written<offset+count&&!flight.done&&!flight.error){let resume;const ready=new Promise(resolve=>{resume=resolve;flight.waiters.push(resolve);});try{await abortable(ready,signal);}finally{const i=flight.waiters.indexOf(resume);if(i>=0)flight.waiters.splice(i,1);}}
   if(flight?.error)throw flight.error;if(!permitted(profile,t,meta.tag,meta.group))throw Error('MEDIA_CANCELLED');
   const buffer=Buffer.alloc(count),read=await handle.read(buffer,0,count,offset);if(read.bytesRead!==count||hash(buffer)!==meta.chunks[index])throw Error('MEDIA_CORRUPT');
   if(image&&index===0&&!imageBytes(buffer,meta.type))throw Error('MEDIA_CORRUPT');if(signal.aborted||!permitted(profile,t,meta.tag,meta.group))throw Error('MEDIA_CANCELLED');
   const last=Math.min(end+1,offset+count);yield buffer.subarray(position-offset,last-offset);position=last;
  }
  // Completing the full response also completes the atomic cache commit. A
  // normal reader finishing is not an abandoned transfer.
  if(flight&&end===meta.size-1&&!flight.done){await abortable(flight.finished,signal);if(flight.error)throw flight.error;}
 }catch(error){if(error.message==='MEDIA_CORRUPT')await remove(k);throw error;}finally{await handle?.close().catch(()=>{});const n=(leases.get(k)||1)-1;if(n)leases.set(k,n);else leases.delete(k);void prune().catch(()=>{});}}
 function available(profile){return states.get(profile)?.registered===true;}
 function invalidate(profile){const state=states.get(profile);if(state)state.generation++;for(const [owner,value] of owners)if(value.profile===profile)releaseConsumer(owner);for(const set of readers.values())for(const reader of [...set])if(reader.profile===profile)reader.cancel();for(const f of flights.values())if(f.profile===profile)f.controller.abort();}
 async function purge(profile,cid,ids){const targets=new Set(ids.map(id=>tag(profile,cid,id))),whole=!ids.length,g=group(profile,cid);for(const target of targets)blocked.add(target);if(whole)blocked.add(g);for(const set of readers.values())for(const reader of [...set])if(reader.profile===profile&&((whole&&reader.group===g)||targets.has(reader.tag)))reader.cancel();const pending=[...flights.values()].filter(f=>f.profile===profile&&((whole&&f.group===g)||targets.has(f.tag)));for(const f of pending)f.controller.abort();await Promise.allSettled(pending.map(f=>f.finished));await initialize();for(const name of await fsp.readdir(root)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;try{const m=JSON.parse(await fsp.readFile(safeName(name),'utf8'));if((whole&&m.group===g)||targets.has(m.tag))await remove(name.slice(0,-5));}catch{}}}
 async function clear(){epoch++;for(const set of readers.values())for(const reader of [...set])reader.cancel();const pending=[...flights.values()];for(const f of pending)f.controller.abort();await Promise.allSettled(pending.map(f=>f.finished));blocked.clear();await initialize();for(const name of await fsp.readdir(root))if(OWN.test(name))await fsp.unlink(safeName(name)).catch(()=>{});}
 function register(profile,resolveSource){if(states.has(profile))return available(profile);const state={generation:0,registered:false};states.set(profile,state);
  try{profile.session.protocol.handle('pulse-media',async request=>{let fallback,releaseHold=()=>{},consumer;try{
   const parsed=sources.parseDisplay(request.url);if(!parsed||!['GET','HEAD'].includes(request.method))throw Error('MEDIA_DENIED');
   const{account,conversation:cid,message:mid,source}=parsed;
   if(profile.accountId!==account||profile.locked)throw Error('MEDIA_DENIED');
   const allowed=resolveSource(source),mediaTag=tag(profile,cid,mid),mediaGroup=group(profile,cid);if(allowed!==source||blocked.has(mediaTag)||blocked.has(mediaGroup))throw Error('MEDIA_DENIED');
   const t={account,generation:state.generation,epoch},image=sources.isImage(allowed);fallback={source:allowed,t,tag:mediaTag,group:mediaGroup};const k=cacheKey(profile,account,cid,mid,allowed);
   const controller=new AbortController();consumer={profile,tag:mediaTag,group:mediaGroup,controller,stream:null,cancel:()=>{controller.abort();releaseHold();consumer.stream?.destroy(Error('MEDIA_CANCELLED'));}};
   if(!readers.has(k))readers.set(k,new Set());readers.get(k).add(consumer);
   leases.set(k,(leases.get(k)||0)+1);let released=false;releaseHold=()=>{if(released)return;released=true;request.signal?.removeEventListener('abort',consumer.cancel);const set=readers.get(k);set?.delete(consumer);if(!set?.size){readers.delete(k);const f=flights.get(k);if(f&&!f.done&&!f.committing&&!references.has(k))f.controller.abort();}const n=(leases.get(k)||1)-1;if(n)leases.set(k,n);else leases.delete(k);void prune().catch(()=>{});};
   request.signal?.addEventListener('abort',consumer.cancel,{once:true});if(request.signal?.aborted)consumer.cancel();
   const signal=controller.signal;let flight=flights.get(k),meta=flight?null:await abortable(cached(k,image,mediaTag,mediaGroup),signal);
   if(!meta){for(;;){if(signal.aborted)throw Error('MEDIA_CANCELLED');flight=flights.get(k);if(flight?.controller.signal.aborted){await abortable(flight.finished,signal);continue;}if(flight)break;let pending=starts.get(k);if(!pending){if(starts.size+flights.size>=64)throw Error('MEDIA_BUSY');pending=startDownload(profile,t,k,allowed,cid,mid);starts.set(k,pending);pending.finally(()=>{if(starts.get(k)===pending)starts.delete(k);}).catch(()=>{});}flight=await abortable(pending,signal);if(!flight.controller.signal.aborted)break;}await abortable(flight.headers,signal);meta=flight;}
   if(signal.aborted||!permitted(profile,t,mediaTag,mediaGroup))throw Error('MEDIA_CANCELLED');let start=0,end=meta.size-1,status=200;const raw=request.headers.get('range');
   if(raw){const match=/^bytes=(\d*)-(\d*)$/.exec(raw);if(!match||(!match[1]&&!match[2])){releaseHold();return new Response(null,{status:416,headers:{'Content-Range':`bytes */${meta.size}`}});}if(match[1]){start=Number(match[1]);end=match[2]?Math.min(end,Number(match[2])):end;}else start=Math.max(0,meta.size-Number(match[2]));if(!Number.isSafeInteger(start)||start<0||start>end||start>=meta.size){releaseHold();return new Response(null,{status:416,headers:{'Content-Range':`bytes */${meta.size}`}});}status=206;}
   const headers={'Content-Type':meta.type,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${meta.size}`;
   if(request.method==='HEAD'){releaseHold();return new Response(null,{status,headers});}
   consumer.stream=Readable.from(bytes(profile,t,k,meta,start,end,flight,image,signal));
   // Web-stream cancellation calls Node destroy before close. Wake a generator
   // waiting for its next chunk now, otherwise destroy waits for that generator
   // while the generator waits for close to cancel its upstream request.
   const destroy=consumer.stream._destroy.bind(consumer.stream);consumer.stream._destroy=(error,done)=>{controller.abort();releaseHold();destroy(error,done);};
   consumer.stream.once('close',()=>{controller.abort();releaseHold();});
   return new Response(Readable.toWeb(consumer.stream),{status,headers});
  }catch(error){releaseHold();if(!consumer?.controller.signal.aborted&&fallback&&permitted(profile,fallback.t,fallback.tag,fallback.group)&&(error.message==='MEDIA_SIZE'||['ENOSPC','EACCES','EPERM','EROFS','EMFILE'].includes(error.code)))return Response.redirect(fallback.source,307);return new Response(null,{status:403,headers:{'Cache-Control':'no-store'}});}});state.registered=true;void prune().catch(()=>{});return true;}catch{return false;}}
  function unregister(profile){invalidate(profile);const s=states.get(profile);if(s?.registered){try{profile.session.protocol.unhandle('pulse-media');}catch{}s.registered=false;}states.delete(profile);}
  return{register,unregister,available,invalidate,clear,purge,updateConsumers,releaseConsumer,allow:(profile,cid)=>blocked.delete(group(profile,cid))};
}
module.exports={createMediaDiskCache};
