// Account-scoped persistent avatars. No tokens, URLs or arbitrary filesystem paths in metadata.
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto');
const {Readable, Transform} = require('node:stream');
const sources = require('./web/avatar-source.js');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const MIME = /^image\/(?:jpeg|png|gif|webp|avif|bmp)(?:;|$)/i;
function createAvatarDiskCache({ directory, fetch, maxBytes = 96 * 1024 * 1024, maxEntries = 800, maxImageBytes = 8 * 1024 * 1024,
  maxAge = 30 * 86400000, timeout = 12000, now = Date.now, report = () => {} }) {
  const root = path.resolve(directory), states = new WeakMap(), flights = new Map(), writes = new Map(), leases = new Map(), streams = new Map(); let pending = 0, pruning = null, pruneAgain = false, epoch = 0, active = 0;
  const waiters = [];
  async function acquire(signal) {
    if (signal.aborted) throw Error('AVATAR_CANCELLED');
    if (active < 4) { active++; return; }
    await new Promise((resolve,reject) => {
      const item = {resolve:()=>{signal.removeEventListener('abort',cancel);resolve();}};
      const cancel=()=>{const i=waiters.indexOf(item);if(i>=0)waiters.splice(i,1);reject(Error('AVATAR_CANCELLED'));};
      signal.addEventListener('abort',cancel,{once:true});waiters.push(item);
    });
  }
  function release() { const next=waiters.shift();if(next)next.resolve();else active--; }
  const inside = file => path.dirname(file) === root;
  function state(profile) { let s = states.get(profile); if (!s) { s = { generation: 0, registered: false, resolve: null }; states.set(profile, s); } return s; }
  function ticket(profile, accountId) {
    if (!Number.isSafeInteger(accountId) || accountId <= 0 || profile.accountId !== accountId || profile.locked) throw Error('AVATAR_ACCOUNT');
    return { accountId, generation: state(profile).generation, epoch };
  }
  const current = (profile, t) => epoch === t.epoch && profile.accountId === t.accountId && !profile.locked && state(profile).generation === t.generation;
  function key(profile, accountId, source) { return sha(JSON.stringify([String(profile.id), accountId, sources.identity(source)])); }
  async function prepare() {
    await fsp.mkdir(root, {recursive: true, mode: 0o700});
    const s = await fsp.lstat(root); if (!s.isDirectory() || s.isSymbolicLink()) throw Error('AVATAR_DIRECTORY');
  }
  async function remove(k) { for (const suffix of ['.image', '.json']) { const file = path.join(root, k + suffix); if (inside(file)) await fsp.unlink(file).catch(() => {}); } }
  async function read(k) {
    if(writes.has(k))await writes.get(k).catch(()=>{});
    try {
      const dataFile = path.join(root, k + '.image'), metaFile = path.join(root, k + '.json');
      const [a,b] = await Promise.all([fsp.lstat(dataFile), fsp.lstat(metaFile)]);
      if (!a.isFile() || a.isSymbolicLink() || !b.isFile() || b.isSymbolicLink() || b.size > 1024 || a.size <= 0 || a.size > maxImageBytes) throw Error();
      const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
      if (!MIME.test(meta.type) || !Number.isFinite(meta.created) || now() - meta.created < 0 || now() - meta.created > maxAge || meta.size !== a.size) throw Error();
      const bytes = await fsp.readFile(dataFile); if (bytes.length !== a.size || sha(bytes) !== meta.sha256) throw Error();
      void fsp.utimes(metaFile, new Date(), new Date()).catch(() => {}); return { bytes, type: meta.type };
    } catch { await remove(k); return null; }
  }
  async function prune() {
    if (pruning) { pruneAgain=true;return pruning; }
    pruning = (async () => {
      do { pruneAgain=false;
      await prepare(); const rows = [];
      for (const name of await fsp.readdir(root)) {
        if(/^[a-f0-9]{64}\.[a-f0-9]{20}\.(?:part|meta)$/.test(name)) {
          const k=name.slice(0,64);if(!writes.has(k)&&!flights.has(k)){const s=await fsp.lstat(path.join(root,name)).catch(()=>null);if(s&&now()-s.mtimeMs>60000)await fsp.unlink(path.join(root,name)).catch(()=>{});}continue;
        }
        if(/^[a-f0-9]{64}\.image$/.test(name)) {
          const k=name.slice(0,64);if(!writes.has(k)&&!flights.has(k)&&!fs.existsSync(path.join(root,k+'.json')))await remove(k);continue;
        }
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const k = name.slice(0,64); if(writes.has(k)||flights.has(k)||leases.has(k))continue; try { const a=await fsp.lstat(path.join(root,k+'.image')), b=await fsp.lstat(path.join(root,name));
          if (a.isSymbolicLink() || b.isSymbolicLink() || !a.isFile() || !b.isFile()) { await remove(k); continue; }
          rows.push({k, size:a.size, time:b.mtimeMs}); } catch { await remove(k); }
      }
      rows.sort((a,b)=>b.time-a.time); let total=0;
      for (let i=0;i<rows.length;i++) { total+=rows[i].size; if (i>=maxEntries || total>maxBytes || now()-rows[i].time>maxAge) await remove(rows[i].k); }
      } while(pruneAgain);
    })().finally(()=>{pruning=null}); return pruning;
  }
  async function writeFile(k, bytes, type, valid) {
    if (!bytes.length || bytes.length > maxImageBytes || !MIME.test(type) || !valid()) return false;
    await prepare(); const nonce=crypto.randomBytes(10).toString('hex'), a=path.join(root,k+'.'+nonce+'.part'), b=path.join(root,k+'.'+nonce+'.meta');
    try {
      await fsp.writeFile(a,bytes,{flag:'wx',mode:0o600}); await fsp.writeFile(b,JSON.stringify({type,size:bytes.length,created:now(),sha256:sha(bytes)}),{flag:'wx',mode:0o600});
      if (!valid()) return false;
      await fsp.rename(a,path.join(root,k+'.image')); await fsp.rename(b,path.join(root,k+'.json'));
      if (!valid()) { await remove(k); return false; } void prune().catch(()=>{}); return true;
    } finally { await Promise.all([fsp.unlink(a).catch(()=>{}),fsp.unlink(b).catch(()=>{})]); }
  }
  async function write(k,bytes,type,valid) {
    const next=(writes.get(k)||Promise.resolve()).catch(()=>{}).then(()=>writeFile(k,bytes,type,valid));writes.set(k,next);
    try{return await next;}finally{if(writes.get(k)===next)writes.delete(k);void prune().catch(()=>{});}
  }
  function invalidate(profile) { state(profile).generation++; for (const value of flights.values()) if(value.profile===profile)value.abort.abort();for(const [stream,owner]of streams)if(owner===profile)stream.destroy(Error('AVATAR_CANCELLED')); }
  async function authorized(profile, raw, accountId) {
    const t=ticket(profile,accountId), u=sources.source(raw); if(!u)throw Error('AVATAR_SOURCE');
    const resolved=await state(profile).resolve?.(u.href); if(resolved!==u.href || !current(profile,t))throw Error('AVATAR_ORIGIN');
    return {t,u,k:key(profile,accountId,u.href)};
  }
  async function get(profile, raw, accountId) {
    const {t,u,k}=await authorized(profile,raw,accountId); const cached=await read(k);
    if(!current(profile,t))throw Error('AVATAR_ACCOUNT');if(cached)return cached;
    let flight=flights.get(k);
    if(!flight){
      if(pending>=128)throw Error('AVATAR_BUSY');
      const abort=new AbortController();flight={profile,abort};pending++;
      flight.promise=(async()=>{
        await acquire(abort.signal);
        try {
        const response=await fetch(profile,u.href,{redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(timeout)])});
        const type=response.headers.get('content-type')||'';
        if(!response.ok){await response.body?.cancel();throw Error('AVATAR_HTTP_'+response.status);}
        if(!MIME.test(type)||Number(response.headers.get('content-length'))>maxImageBytes){await response.body?.cancel();throw Error('AVATAR_CONTENT');}
        const chunks=[];let size=0;const reader=response.body.getReader();
        try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>maxImageBytes){await reader.cancel();throw Error('AVATAR_TOO_LARGE');}chunks.push(p.value);}}finally{reader.releaseLock();}
        if(!size||!current(profile,t)||abort.signal.aborted)throw Error('AVATAR_ACCOUNT');
        const bytes=Buffer.concat(chunks.map(c=>Buffer.from(c)),size);
        await write(k,bytes,type,()=>current(profile,t)&&!abort.signal.aborted).catch(()=>false);
        return {bytes,type};
        } finally { release(); }
      })().finally(()=>{pending--;if(flights.get(k)===flight)flights.delete(k);void prune().catch(()=>{});});flights.set(k,flight);
    }
    const value=await flight.promise;if(!current(profile,t))throw Error('AVATAR_ACCOUNT');return value;
  }
  async function seed(profile,value) {
    if(!value||!ArrayBuffer.isView(value.bytes)&&!(value.bytes instanceof ArrayBuffer))return false;
    if(value.bytes.byteLength>maxImageBytes)return false;
    const {t,k}=await authorized(profile,value.source,Number(value.accountId));
    const bytes=Buffer.from(value.bytes instanceof ArrayBuffer?new Uint8Array(value.bytes):value.bytes);return write(k,bytes,String(value.type||''),()=>current(profile,t));
  }
  // Protocol responses stream cached files in bounded chunks instead of buffering
  // a large group's compressed avatars simultaneously in the main process.
  async function diskStream(profile,t,k) {
    leases.set(k,(leases.get(k)||0)+1);let released=false;
    const releaseLease=()=>{if(released)return;released=true;const n=(leases.get(k)||1)-1;if(n)leases.set(k,n);else leases.delete(k);void prune().catch(()=>{});};
    try {
      if(writes.has(k))await writes.get(k).catch(()=>{});
      const file=path.join(root,k+'.image'),metaFile=path.join(root,k+'.json');
      const [a,b]=await Promise.all([fsp.lstat(file),fsp.lstat(metaFile)]);
      if(!a.isFile()||a.isSymbolicLink()||!b.isFile()||b.isSymbolicLink()||b.size>1024||a.size<=0||a.size>maxImageBytes)throw Error();
      const meta=JSON.parse(await fsp.readFile(metaFile,'utf8'));
      if(!MIME.test(meta.type)||meta.size!==a.size||!Number.isFinite(meta.created)||now()-meta.created<0||now()-meta.created>maxAge||!current(profile,t))throw Error();
      const digest=crypto.createHash('sha256');let size=0;
      const input=fs.createReadStream(file,{highWaterMark:64*1024});
      const checked=new Transform({transform(chunk,_encoding,callback){if(!current(profile,t)||size+chunk.length>maxImageBytes)return callback(Error('AVATAR_CANCELLED'));size+=chunk.length;digest.update(chunk);callback(null,chunk);},flush(callback){callback(size===meta.size&&digest.digest('hex')===meta.sha256?null:Error('AVATAR_CACHE_CORRUPT'));}});
      streams.set(checked,profile);input.on('error',error=>checked.destroy(error));
      checked.on('error',()=>{void remove(k);});checked.on('close',()=>{input.destroy();streams.delete(checked);releaseLease();});
      input.pipe(checked);void fsp.utimes(metaFile,new Date(),new Date()).catch(()=>{});
      return {body:Readable.toWeb(checked),type:meta.type};
    } catch { releaseLease();return null; }
  }
  async function clear(profile) {
    epoch++;invalidate(profile);for(const value of flights.values())value.abort.abort();for(const stream of streams.keys())stream.destroy(Error('AVATAR_CANCELLED'));await Promise.allSettled([...writes.values()]);await prepare();
    // Cache is disposable and private to this application. Clearing one account
    // also drops other profiles' cached copies rather than retaining hidden data.
    for(const name of await fsp.readdir(root))if(/^[a-f0-9]{64}(?:\.[a-f0-9]{20})?\.(?:image|json|part|meta)$/.test(name))await fsp.unlink(path.join(root,name)).catch(()=>{});
  }
  async function drop(profile,value) {
    const {k}=await authorized(profile,value?.source,Number(value?.accountId));
    const next=(writes.get(k)||Promise.resolve()).catch(()=>{}).then(()=>remove(k));writes.set(k,next);
    try{await next;return true;}finally{if(writes.get(k)===next)writes.delete(k);}
  }
  function register(profile,resolve) {
    const s=state(profile);s.resolve=resolve;if(s.registered)return true;
    if(typeof profile.session?.protocol?.handle!=='function')return false;
    profile.session.protocol.handle('pulse-avatar',async request=>{
      try {
        const u=new URL(request.url);if(request.method!=='GET'||u.hostname!=='cache'||u.pathname!=='/v1'||u.searchParams.getAll('account').length!==1||u.searchParams.getAll('source').length!==1)return new Response('',{status:400});
        const source=u.searchParams.get('source'),accountId=Number(u.searchParams.get('account'));
        const {t,k}=await authorized(profile,source,accountId);let value=await diskStream(profile,t,k);
        if(!value){const fetched=await get(profile,source,accountId);value=await diskStream(profile,t,k);if(!value)value={body:Readable.toWeb(Readable.from((function*(){for(let i=0;i<fetched.bytes.length;i+=65536){if(!current(profile,t))throw Error('AVATAR_CANCELLED');yield fetched.bytes.subarray(i,i+65536);}})())),type:fetched.type};}
        if(!current(profile,t))return new Response('',{status:403});
        return new Response(value.body,{headers:{'Content-Type':value.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
      }catch(error){try{report(String(error.message||'AVATAR_CACHE'));}catch{}return new Response('',{status:403});}
    });s.registered=true;void prune().catch(()=>{});return true;
  }
  function unregister(profile) { invalidate(profile); const s=states.get(profile); if(s?.registered){try{profile.session.protocol.unhandle('pulse-avatar');}catch{}s.registered=false;s.resolve=null;} states.delete(profile); }
  return {register,unregister,available:profile=>state(profile).registered,get,seed,drop,invalidate,clear,prune,key};
}
module.exports={createAvatarDiskCache};
