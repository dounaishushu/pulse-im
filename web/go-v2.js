/* Shared Go v2 transport for the retained Web and Electron views. */
(function(root) {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const fail = (code, status = 400) => {
    const messages = {unsupported:'当前服务暂未开放此功能', forbidden:'没有操作权限，或对方的隐私/屏蔽设置不允许',
      unauthorized:'登录已失效，请重新登录', conflict:'内容或成员身份已变化，请刷新后再操作',
      version_conflict:'消息已在其他设备修改，请关闭编辑器后重新打开', membership_changed:'群成员身份已变化，正在重新校验历史',
      request_conflict:'同一次发送的内容已改变，请重新发送', invalid_request:'请求参数无效', invalid_response:'服务返回的数据无效',
      rate_limited:'操作太频繁，请稍后重试', unavailable:'服务繁忙，正在等待恢复', not_found:'没有找到该账号或内容',
      already_exists:'该用户名或手机号已注册，请直接登录或换一个账号', captcha_invalid_or_expired:'验证码错误或已过期，请输入新的验证码',
      registration_disabled:'暂未开放注册', registration_avatar_required:'请先选择头像再注册', registration_ip_limit:'此网络的注册名额已用完，请联系管理员',
      stale_session:'账号已改变，本次操作已取消', device_session_limit:'登录设备已达 8 台，请在已登录设备的“设备会话”中退出不用的设备后重试', second_factor_required:'请输入两步验证密码或恢复码', mobile_device_bound:'账号已绑定其他手机，请联系管理员解除旧设备绑定', media_too_large:'文件超过该类型允许的大小，请选择较小文件', unsafe_number:'消息序号超出本客户端支持范围，请升级客户端', id_collision:'本机标识冲突，请联系管理员'};
    const error = new Error(messages[code] || (status === 409 ? messages.conflict : status === 403 ? messages.forbidden : status === 401 ? messages.unauthorized : '请求失败，请稍后重试'));
    error.code=code; error.status=status; return error;
  };
  function integer(value) {
    if (!/^(0|[1-9]\d*)$/.test(String(value))) throw fail('invalid_response');
    const n=Number(value); if(!Number.isSafeInteger(n)) throw fail('unsafe_number'); return n;
  }
  function baseURL(value) {
    const u=new URL(value);
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname.replace(/\/$/,'')!=='/api/v2') throw fail('invalid_request');
    return u.origin+'/api/v2';
  }
  function create({base, storage, fetch:fetcher=root.fetch.bind(root), platform='web', clientVersion='', onInvalidate=()=>{},resolveBase=()=>base,mediaIdentity=root.PulseMediaIdentity}) {
    base=baseURL(base); const scope='pulse_go_v2:'+encodeURIComponent(base)+':';
    const MESSAGE_CHAT_LIMIT=500,MESSAGE_TOTAL_LIMIT=2000;
    let token='', generation=0, presenceBatchUnsupportedUntil=0;
    const memberships=new Map(), preferenceSnapshots=new Map(), messageIndex=new Map(), mediaGrants=new Map(), grantFlights=new Map(), mediaDenied=new Map(), inviteCursors=new Map(), broadcastPartial=new Set();
    const messageLRU=new Map();
    let directoryHeads=new Map();const hiddenDirectoryHeads=new Map();
    let activeUploads=0;const uploadWaiters=[];
    function session(next) { next=String(next||''); if(token!==next) {token=next; generation++; memberships.clear();preferenceSnapshots.clear(); messageIndex.clear();messageLRU.clear();directoryHeads.clear();hiddenDirectoryHeads.clear();mediaGrants.clear();mediaDenied.clear();grantFlights.clear();inviteCursors.clear();broadcastPartial.clear();} }
    function directorySignature(row){
      const state=row.state||{};
      return JSON.stringify([row.kind,row.title||'',row.history_allowed===true,row.temporary===true,
        ...['message_seq','event_seq','membership_version','visible_from_seq','visible_from_event_seq'].map(k=>integer(row[k]??0)),
        ...['version','personal_seq','clear_seq','read_seq','delivered_seq'].map(k=>integer(state[k]??0)),state.reminder===true]);
    }
    function rememberDirectoryVisibility(items,removed){
      for(const row of items)hiddenDirectoryHeads.delete(local('conversation',row.id));
      for(const wireID of removed){const id=local('conversation',wireID),signature=directoryHeads.get(id);if(signature)hiddenDirectoryHeads.set(id,signature);else hiddenDirectoryHeads.delete(id);}
    }
    async function directoryChanges(known,{signal,current=()=>true}={}){
      const mine=generation,authToken=token,heads=new Map();let after='';
      for(let pageNumber=0;;pageNumber++){
        if(pageNumber>=100)throw fail('unavailable',503);
        const page=await raw('/conversations?after='+encodeURIComponent(after),{authToken,signal});
        if(mine!==generation||!current())throw fail('stale_session',409);
        if(!Array.isArray(page.items))throw fail('invalid_response');
        let last=after;
        for(const row of page.items){
          if(!UUID.test(row.id)||row.id<=last)throw fail('invalid_response');last=row.id;
          const id=local('conversation',row.id);if(heads.has(id))throw fail('invalid_response');heads.set(id,directorySignature(row));
        }
        const next=page.next_after;if(!next)break;
        if(!UUID.test(next)||next!==last||next<=after)throw fail('invalid_response');after=next;
      }
      const listed=new Map(known.map(row=>[Number(row.id),row])),changed=[];
      for(const [id,signature] of heads){const row=listed.get(id);if(row?directorySignature(row)!==signature:hiddenDirectoryHeads.get(id)!==signature)changed.push(id);}
      for(const id of listed.keys())if(!heads.has(id))changed.push(id);
      directoryHeads=heads;for(const id of hiddenDirectoryHeads.keys())if(!heads.has(id))hiddenDirectoryHeads.delete(id);
      return changed;
    }
    function forgetMessage(msg){
      messageLRU.delete(msg);
      const index=messageIndex.get(msg.conversation_id);index?.delete(msg.id);
      if(index&&!index.size)messageIndex.delete(msg.conversation_id);
    }
    function cachedMessage(cid,id){
      const msg=messageIndex.get(cid)?.get(id);
      if(msg){const index=messageIndex.get(cid);index.delete(id);index.set(id,msg);messageLRU.delete(msg);messageLRU.set(msg,true);}
      return msg;
    }
    function rememberMessage(msg){
      const cid=msg.conversation_id,id=msg.id;
      if(!messageIndex.has(cid))messageIndex.set(cid,new Map());
      const index=messageIndex.get(cid);messageLRU.delete(index.get(id));index.delete(id);index.set(id,msg);messageLRU.set(msg,true);
      while(index.size>MESSAGE_CHAT_LIMIT)forgetMessage(index.values().next().value);
      while(messageLRU.size>MESSAGE_TOTAL_LIMIT)forgetMessage(messageLRU.keys().next().value);
      return msg;
    }
    function local(type, uuid) {
      if(!UUID.test(uuid))throw fail('invalid_response');
      uuid=uuid.toLowerCase(); const n=Number.parseInt(uuid.replace(/-/g,'').slice(0,13),16)+1;
      const key=scope+'id:'+type+':'+n, old=storage.getItem(key);
      if(old&&old!==uuid)throw fail('id_collision'); if(!old)storage.setItem(key,uuid); return n;
    }
    function wire(type,n) { const value=storage.getItem(scope+'id:'+type+':'+integer(n)); if(!UUID.test(value||''))throw fail('invalid_request'); return value; }
    function version(cid,v) {
      v=integer(v); if(v<1)throw fail('invalid_response');
      const old=memberships.get(cid)||0; if(v<old)throw fail('membership_changed',409);
      if(v>old){ memberships.set(cid,v); if(old) {for(const msg of messageIndex.get(cid)?.values()||[])messageLRU.delete(msg);messageIndex.delete(cid);mediaDenied.clear();onInvalidate(cid,'membership');} } return v;
    }
    function requireVersion(cid,v) {if(memberships.get(cid)!==integer(v))throw fail('membership_changed',409);}
    async function deliveryRetry(operation,signal) {
      const mine=generation;
      for(let attempt=0;;attempt++){
        if(mine!==generation)throw fail('stale_session',409);
        signal?.throwIfAborted();
        try{return await operation();}catch(error){
          if(signal?.aborted||mine!==generation)throw error;
          if(![408,425,429,500,502,503,504].includes(error.status)&&error.code!=='upload_interrupted'&&!['TypeError','TimeoutError','AbortError'].includes(error.name))throw error;
          await new Promise((resolve,reject)=>{
            const cleanup=()=>signal?.removeEventListener('abort',abort);
            const timer=setTimeout(()=>{cleanup();resolve();},Math.min(30000,1000*2**Math.min(attempt,5)));
            const abort=()=>{clearTimeout(timer);cleanup();reject(signal.reason);};
            signal?.addEventListener('abort',abort,{once:true});
            if(signal?.aborted)abort();
          });
        }
      }
    }
    async function raw(path,{method='GET',body,signal,authToken=token}={}) {
      const mine=generation;
      if(authToken&&authToken!==token)throw fail('stale_session',409);
      if(!path.startsWith('/')||path.startsWith('//')||/[\\#]/.test(path))throw fail('invalid_request');
      const activeBase=baseURL(resolveBase());
      const url=new URL(activeBase+path); if(url.origin!==new URL(activeBase).origin||!url.pathname.startsWith('/api/v2/'))throw fail('invalid_request');
      const headers={}; if(authToken)headers.Authorization='Bearer '+authToken; if(body!==undefined)headers['Content-Type']='application/json';
      const timeout=AbortSignal.timeout(15000); signal=signal?AbortSignal.any([signal,timeout]):timeout;
      // Go JSON replies already require Cache-Control: no-store. Forcing a
      // no-store request also bypasses Chromium's separate preflight cache.
      const response=await fetcher(url.href,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal,cache:'default',credentials:'omit',redirect:'error'});
      let data={};
      if(response.status!==204){
        try{data=await response.json();}
        catch{throw fail(response.ok?'invalid_response':'unavailable',response.ok?502:response.status);}
      }
      if(mine!==generation||(authToken&&authToken!==token))throw fail('stale_session',409);
      if(!response.ok) {const e=fail(data.error?.code||'unavailable',response.status);e.retryAfter=response.headers?.get('Retry-After');throw e;} return data;
    }
    function rememberMediaGrant(id,granted) {
      mediaDenied.delete(id);
      const path=granted.content_path;
      if(typeof path!=='string'||!/^\/api\/v2\/media-grants\/[a-f0-9]{64}\/content$/.test(path))throw fail('invalid_response');
      const url=new URL(path,new URL(baseURL(resolveBase())).origin).href;
      mediaIdentity?.remember(url,id);
      mediaGrants.set(id,{url,expires:Date.now()+Math.min(120,Number(granted.expires_in)||120)*1000});return url;
    }
    function rememberMediaDenial(id,error,mine) {
      if(mine===generation&&[403,404].includes(error.status)) {
        // 确定不可访问的图片短暂退避；重新登录、权限变化或手动重试可立即重新校验。
        mediaDenied.delete(id);mediaDenied.set(id,{error,expires:Date.now()+10000});
        if(mediaDenied.size>512)mediaDenied.delete(mediaDenied.keys().next().value);
      }
      throw error;
    }
    function waitForMediaRequest(promise,signal) {
      if(!signal)return promise;
      signal.throwIfAborted();
      return new Promise((resolve,reject)=>{
        const abort=()=>{cleanup();reject(signal.reason);};
        const cleanup=()=>signal.removeEventListener('abort',abort);
        signal.addEventListener('abort',abort,{once:true});
        promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
      });
    }
    async function mediaGrant(id,authToken=token,signal,force=false) {
      if(authToken!==token)throw fail('stale_session',409);
      if(!UUID.test(id))throw fail('invalid_request');
      signal?.throwIfAborted();
      if(force){mediaGrants.delete(id);mediaDenied.delete(id);}
      const denied=mediaDenied.get(id);if(denied?.expires>Date.now())throw denied.error;
      const cached=mediaGrants.get(id);if(cached?.expires>Date.now()+10000)return cached.url;
      let flight=grantFlights.get(id);
      if(!flight){
        // History, realtime sync and the conversation list share one request.
        // Cancelling one view does not cancel another view's authorization.
        const mine=generation;
        flight=raw('/media/'+id+'/grants',{method:'POST',body:{},authToken}).then(granted=>rememberMediaGrant(id,granted)).catch(error=>rememberMediaDenial(id,error,mine));
        grantFlights.set(id,flight);
        flight.finally(()=>{if(grantFlights.get(id)===flight)grantFlights.delete(id);}).catch(()=>{});
      }
      return waitForMediaRequest(flight,signal);
    }
    async function warmMediaGrants(values,authToken=token,signal) {
      const ids=[...new Set(values.filter(Boolean))];
      for(let offset=0;offset<ids.length;offset+=128){
        const mine=generation,chunk=ids.slice(offset,offset+128),fresh=chunk.filter(id=>!(mediaGrants.get(id)?.expires>Date.now()+10000)&&!(mediaDenied.get(id)?.expires>Date.now())&&!grantFlights.has(id));
        if(fresh.length){
          const batch=raw('/media/grants',{method:'POST',body:{media_ids:fresh},authToken}).then(result=>{
            const rows=result.items;if(!Array.isArray(rows)||rows.length!==fresh.length||new Set(rows.map(row=>row.id)).size!==fresh.length||rows.some(row=>!fresh.includes(row.id)))throw fail('invalid_response');
            return new Map(rows.map(row=>[row.id,row]));
          }).catch(error=>{if(error.status===404)return null;throw error;});
          for(const id of fresh){
            const flight=batch.then(async rows=>{
              if(!rows)return rememberMediaGrant(id,await raw('/media/'+id+'/grants',{method:'POST',body:{},authToken}));
              const row=rows.get(id);if(row.error)throw fail(row.error.code,row.error.status);
              return rememberMediaGrant(id,row.access);
            }).catch(error=>rememberMediaDenial(id,error,mine));
            grantFlights.set(id,flight);flight.finally(()=>{if(grantFlights.get(id)===flight)grantFlights.delete(id);}).catch(()=>{});
          }
        }
        const results=await Promise.allSettled(chunk.map(id=>grantFlights.has(id)?waitForMediaRequest(grantFlights.get(id),signal):Promise.resolve()));
        signal?.throwIfAborted();
        const failed=results.find(row=>row.status==='rejected'&&![403,404].includes(row.reason?.status));if(failed)throw failed.reason;
      }
    }
    async function optionalMediaGrant(id,authToken,signal) {
      try{return await mediaGrant(id,authToken,signal);}
      catch(error){
        // 仅内容不可访问时使用默认头像，登录失效、取消和服务故障必须保留原来的语义。
        if([403,404].includes(error.status))return '';
        throw error;
      }
    }
    async function uploadMedia(kind,file,{authToken=token,signal,original=false,onProgress=()=>{}}={}) {
      if(!file||!Number.isSafeInteger(file.size)||file.size<1||!['image','video','voice','audio','file','avatar'].includes(kind))throw fail('invalid_request');
      const mine=generation, mediaKind=kind==='voice'?'audio':kind;
      const maximum={image:10,avatar:10,audio:10,video:100,file:50}[mediaKind]*1024*1024;
      if(file.size>maximum)throw fail('media_too_large',413);
      if(authToken!==token)throw fail('stale_session',409);
      const acquire=()=>new Promise((resolve,reject)=>{
        if(signal?.aborted){reject(signal.reason);return;}
        const enter=()=>{signal?.removeEventListener('abort',abort);activeUploads++;resolve(()=>{activeUploads--;uploadWaiters.shift()?.();});};
        const abort=()=>{const index=uploadWaiters.indexOf(enter);if(index>=0)uploadWaiters.splice(index,1);reject(signal.reason||fail('unavailable',503));};
        if(activeUploads<2)enter();else{uploadWaiters.push(enter);signal?.addEventListener('abort',abort,{once:true});}
      });
      const release=await acquire();
      try{
        if(mine!==generation||signal?.aborted)throw fail('stale_session',409);
        onProgress({stage:'hash'});
        const sum=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
        if(mine!==generation||signal?.aborted)throw fail('stale_session',409);
        const sha256=Array.from(new Uint8Array(sum),x=>x.toString(16).padStart(2,'0')).join('');
        const filename=String(file.name||'upload').replace(/[\\/\r\n:\0]/g,'_').slice(0,255)||'upload';
        const requestID='media-'+crypto.randomUUID();
        const metadata={request_id:requestID,kind:mediaKind,filename,bytes:String(file.size),sha256,original:!!original};
        let media;
        media=await deliveryRetry(()=>raw('/media/uploads',{method:'POST',body:metadata,signal,authToken}),signal);
        if(!media?.id)throw fail('unavailable',503);
        let result=media;
        if(media.status==='pending'){
          onProgress({stage:'upload'});
          let initial=true;
          await deliveryRetry(async()=>{
            // A lost PUT acknowledgement must not upload a second attachment.
            // A successful new admission already gives the first status; only
            // uncertain retries need another read before transferring bytes.
            const state=initial?media:await raw('/media/'+media.id+'?wait_ms=1500',{authToken,signal});
            initial=false;result=state;
            if(['queued','processing','ready'].includes(state.status))return;
            if(state.status==='receiving')throw fail('unavailable',503);
            if(state.status!=='pending')throw fail(state.error_code||'media_failed',422);
            const url=new URL(baseURL(resolveBase())+'/media/'+media.id+'/bytes?wait_ms=1500');
            const timeout=AbortSignal.timeout(150000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
            const response=await fetcher(url.href,{method:'PUT',headers:{Authorization:'Bearer '+authToken,'Content-Type':'application/octet-stream'},body:file,signal:combined,cache:'default',credentials:'omit',redirect:'error'});
            let received={};try{if(response.status!==204)received=await response.json();}catch{throw fail('unavailable',response.ok?502:response.status);}
            if(!response.ok){const error=fail(received.error?.code||'unavailable',response.status);error.retryAfter=response.headers?.get('Retry-After');throw error;}
            if(received.id!==undefined&&received.id!==media.id)throw fail('invalid_response');
            result=received;
          },signal);
        }
        onProgress({stage:'processing'});
        const processingUntil=Date.now()+90000;
        for(let attempt=0;attempt<90&&Date.now()<processingUntil;attempt++){
          if(mine!==generation||signal?.aborted)throw fail('stale_session',409);
          if(result.status==='ready'){
            if(result.access)rememberMediaGrant(media.id,result.access);
            return {id:media.id,url:'pulse-media:'+media.id,mime:result.mime,size:Number(result.bytes),width:result.width,height:result.height,duration_ms:result.duration_ms,original:result.original};
          }
          if(result.status==='failed'||result.status==='cancelled')throw fail(result.error_code||'unavailable',422);
          if(attempt)await new Promise((resolve,reject)=>{
            const cleanup=()=>signal?.removeEventListener('abort',abort),timer=setTimeout(()=>{cleanup();resolve();},Math.min(500,100*attempt));
            const abort=()=>{clearTimeout(timer);cleanup();reject(signal.reason);};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
          });
          result=await deliveryRetry(()=>raw('/media/'+media.id+'?wait_ms=1500',{authToken,signal}),signal);
        }
        throw fail('unavailable',503);
      }finally{release();}
    }
    async function hydrateMessages(rows,authToken,signal,extraMedia=[]) {
      const scopes=new Map(rows.map(row=>{const cid=local('conversation',row.conversation_id);return [cid,memberships.get(cid)];}));
      const ownIds=[...extraMedia,...rows.filter(row=>!row.revoked).flatMap(row=>[row.content?.media?.id,row.sender?.avatar_id])];
      const ownMedia=warmMediaGrants(ownIds,authToken,signal);
      // 正文附件授权与引用查询互不依赖，避免每次切换会话都串行等待。
      const replies=(async()=>{
      const groups=new Map();
      for(const row of rows)if(row.reply_to_id&&!row.revoked){if(!groups.has(row.conversation_id))groups.set(row.conversation_id,[]);groups.get(row.conversation_id).push(row);}
      for(const [cid,children] of groups){
        const result=await raw('/conversations/'+cid+'/reply-contexts',{method:'POST',body:{message_ids:children.map(row=>row.id)},authToken,signal});
        const contexts=new Map((result.items||[]).map(row=>[row.message_id,row]));
        for(const child of children)child._go_reply=contexts.get(child.id);
      }
      })();
      await Promise.all([ownMedia,replies]);
      const ids=new Set();for(const row of rows){for(const item of [row,row._go_reply?.message])if(item&&!item.revoked)for(const id of [item?.content?.media?.id,item?.sender?.avatar_id])if(id)ids.add(id);}
      await warmMediaGrants([...ids],authToken,signal);
      for(const [cid,expected] of scopes)if(expected!==undefined)requireVersion(cid,expected);
      return rows;
    }
    function displayTime(value) {
      const d=new Date(value);if(!Number.isFinite(d.getTime()))throw fail('invalid_response');
      const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
    }
    function user(row) {
      const id=local('user',row.id), account=String(row.account||'');
      return {...row,id,user_id:id,username:account,nickname:row.nickname||account,
        formal_employee:row.formal_employee===true,online:row.online===true,
        last_seen_hidden:row.last_seen==null,last_seen_at:row.last_seen==null?null:displayTime(row.last_seen),remark:row.remark||'',
        avatar_url:row.avatar_url||'',signature:row.bio||''};
    }
    function message(row,withReply=true,remember=true) {
      const cid=local('conversation',row.conversation_id), id=integer(row.seq), v=integer(row.version);
      if(!id||!v||!UUID.test(row.id)||typeof row.body!=='string')throw fail('invalid_response');
      const kind=row.kind||'text', content=row.content||{}, media=content.media,
        type=kind==='audio'?'voice':kind==='contact'?'contact_card':kind;
      const body={...content,text:row.revoked?'':row.body,request_id:row.request_id,_go_wire_id:row.id,_go_version:String(v)};
      if(media){body._go_media_id=media.id;body.url=mediaGrants.get(media.id)?.url||'';body.mime=media.mime;body.size=integer(media.bytes);body.name=media.filename;body.width=media.width;body.height=media.height;body.duration_ms=media.duration_ms;body.original=media.original;}
      if(media&&kind==='image'&&body.url)body.thumbnail_url=body.url.replace(/\/content$/,'/preview');
      if(content.contact){body.user_id=local('user',content.contact.id);body.nickname=content.contact.nickname;body.username=content.contact.account;body.public_id=content.contact.public_id;}
      if(content.mentions)body.mention_user_ids=content.mentions.map(id=>local('user',id));
      if(withReply!==false&&row._go_reply){
        const context=row._go_reply;body.reply_to_id=integer(context.reply_seq);
        if(context.message){const parent=message(context.message,false);body.reply_to={id:parent.id,sender_id:parent.sender_id,sender_name:parent.sender_name||'会话成员',type:parent.type,text:parent.body.text||({image:'图片',video:'视频',voice:'语音',file:parent.body.name||'文件',contact_card:'个人名片'}[parent.type])||'消息',thumbnail_url:parent.type==='image'?parent.body.url:'',unavailable:false};}
        else body.reply_to={id:body.reply_to_id,unavailable:true};
      }
      if(withReply!==false&&row.reply_to_id&&!row._go_reply){const previous=messageIndex.get(cid);for(const item of previous?.values()||[])if(item.body._go_wire_id===row.reply_to_id){body.reply_to_id=item.id;break;}}
      const msg={id,conversation_id:cid,sender_id:local('user',row.sender_id),sender_name:row.sender?.name||'会话成员',sender_nickname:row.sender?.name||'会话成员',
        sender_avatar_url:row.sender?.avatar_id?mediaGrants.get(row.sender.avatar_id)?.url||'':'',type,
        body,
        request_id:row.request_id,created_at:displayTime(row.created_at),edited_at:v>1?displayTime(row.updated_at):null,recalled_at:row.revoked?displayTime(row.updated_at):null,status:row.revoked?'recalled':'sent'};
      // 列表摘要没有补齐引用与媒体，不能覆盖聊天窗口已经加载的完整消息。
      if(remember===false)return msg;
      const previous=cachedMessage(cid,id);
      if(previous&&integer(previous.body._go_version)>v){
        if(body.reply_to?.unavailable===true&&previous.body.reply_to_id===body.reply_to_id)previous.body.reply_to={id:body.reply_to_id,unavailable:true};
        return previous;
      }
      return rememberMessage(msg);
    }
    async function storedMessage(cid,id,{authToken=token,signal}={}){
      cid=integer(cid);id=integer(id);if(!id)throw fail('invalid_request');
      const cached=cachedMessage(cid,id);if(cached)return cached;
      // A long-lived view may still contain an evicted row. Resolve its identity
      // through current authorized history instead of retaining every body forever.
      const wireID=wire('conversation',cid);
      const page=await raw('/conversations/'+wireID+'/history?'+new URLSearchParams({after_seq:String(id-1),order:'asc',limit:'1'}),{authToken,signal});
      const v=version(cid,page.membership_version),row=page.items?.[0];
      if(!row||row.conversation_id!==wireID||integer(row.seq)!==id)throw fail('not_found',404);
      await hydrateMessages([row],authToken,signal);requireVersion(cid,v);return message(row);
    }
    async function storedMessages(cid,ids,options){
      const items=new Array(ids.length);let next=0;
      await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{
        while(next<ids.length){const index=next++;items[index]=await storedMessage(cid,ids[index],options);}
      }));return items;
    }
    function conversation(row) {
      const cid=local('conversation',row.id), memberVersion=version(cid,row.membership_version), manages=['owner','admin'].includes(row.my_role), s=row.state;
      const preferenceVersion=row.preference_version==null?0:integer(row.preference_version), saved=preferenceSnapshots.get(cid);
      if(preferenceVersion>0){
        if(saved&&saved.version>preferenceVersion)row={...row,...saved.value};
        else preferenceSnapshots.set(cid,{version:preferenceVersion,value:Object.fromEntries(['preference_version','muted_notifications','pinned','archived','hidden','folder_id'].filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]))});
      }
      return {...row,id:cid,type:row.kind==='saved'?'favorites':row.kind,name:row.kind==='direct'?row.peer_name:row.title,
        avatar_url:row.avatar_id?mediaGrants.get(row.avatar_id)?.url||'':'',
        peer_user_id:row.peer_id?local('user',row.peer_id):null,can_manage:manages,can_publish:row.can_send,
        is_pinned:row.pinned===true,notifications_muted:row.muted_notifications===true,
        is_archived:row.archived===true,is_hidden:row.hidden===true,
        folder_id:row.folder_id?local('folder',row.folder_id):0,
        last_message:row.last_message?message(row.last_message,false,false):null,unread_count:Math.max(integer(row.unread_count),s.reminder?1:0),
        unread_mention_count:integer(row.unread_mention_count||0),last_mention_message_id:integer(row.last_mention_seq||0),
        cleared_before_message_id:Math.max(integer(s.clear_seq),integer(row.visible_from_seq)-1),membership_version:memberVersion,
        message_seq:integer(row.message_seq),_go_updated_at:row.updated_at,_go_wire_id:row.id,updated_at:displayTime(row.updated_at),status:'active',all_muted:row.mute_all,
        send_disabled_reason:row.can_send?'':row.my_muted?'member_muted':row.mute_all&&!manages?'group_muted':'peer_unavailable'};
    }
    async function adapt(path,options={}) {
      const mine=generation, authToken=options.authToken??token;
      if(authToken!==token && !(path==='/client/config' && authToken===''))throw fail('stale_session',409);
      const url=new URL(path,'https://view.invalid'), q=url.searchParams, p=url.pathname, method=options.method||'GET';
      const b=typeof options.body==='string'?JSON.parse(options.body):options.body||{};
      const input=k=>b[k]??q.get(k), cid=()=>integer(input('conversation_id')), cw=()=>wire('conversation',cid()), target=()=>wire('user',input('user_id'));
      const get=async route=>{const result=await raw(route,{signal:options.signal,authToken});if(mine!==generation)throw fail('stale_session',409);return result;};
      const put=async(route,verb='POST',body)=>{const result=await raw(route,{method:verb,body,signal:options.signal,authToken});if(mine!==generation)throw fail('stale_session',409);return result;};
      const all=async route=>{let after='',items=[],seen=new Set();for(let n=0;n<1000;n++){const page=await get(route+(route.includes('?')?'&':'?')+'after='+encodeURIComponent(after));items.push(...(page.items||[]));if(!page.next_after)return items;if(page.next_after===after||seen.has(page.next_after))throw fail('invalid_response');seen.add(page.next_after);after=page.next_after;}throw fail('invalid_response');};
      const profile=async route=>{const row=await get(route);if(row.avatar_id)row.avatar_url=await optionalMediaGrant(row.avatar_id,authToken,options.signal);return row;};
      const renderConversation=async row=>{await warmMediaGrants([row.avatar_id],authToken,options.signal);return conversation(row);};
      const info=async id=>{const expected=wire('conversation',id),row=await get('/conversations/'+expected);if(row.id!==expected)throw fail('invalid_response');return renderConversation(row);};
      const receipt=status=>({status:status||'ok',conversation_id:b.conversation_id,user_id:b.user_id,blocked_id:b.user_id});
      const pageParams=()=>new URLSearchParams({page:q.get('page')||'1',size:String(Math.min(100,integer(q.get('size')||50)))});
      const group=async()=>{const [g,c]=await Promise.all([get('/groups/'+cw()),info(cid())]), manages=['owner','admin'].includes(g.my_role);if(g.avatar_id)await optionalMediaGrant(g.avatar_id,authToken,options.signal);return {...c,...g,id:cid(),conversation_id:cid(),type:g.kind,name:g.title,avatar_url:g.avatar_id?mediaGrants.get(g.avatar_id)?.url||'':'',max_members:g.member_limit,can_invite:manages,owner_id:local('user',g.owner_id),can_manage:manages,is_owner:g.my_role==='owner',allow_member_add_friend:g.kind==='group'&&g.block_member_friend_requests===false,members_visibility:manages||g.kind==='group'&&g.block_member_friend_requests===false?'all':'managers',all_muted:g.mute_all,can_send:c.can_send,send_disabled_reason:c.send_disabled_reason};};
      const selectedMember=async()=>{
        const id=target(),value=BigInt('0x'+id.replace(/-/g,''));if(value===0n)throw fail('invalid_request');
        // The authenticated directory is ordered by the complete UUID. Seek
        // immediately before this identity; never scan pages or match a name.
        const hex=(value-1n).toString(16).padStart(32,'0'),after=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
        const page=await get('/groups/'+cw()+'/member-profiles?'+new URLSearchParams({after,limit:'1',directory_version:'2'}));
        if(!Array.isArray(page.items)||page.items.length>1||page.query!==''||!['group','friends'].includes(page.search_scope)||!['all','managers'].includes(page.members_visibility)||typeof page.next_after!=='string'||page.next_after&&page.next_after!==page.items[0]?.id)throw fail('invalid_response');
        const row=page.items[0];
        if(row&&(!UUID.test(row.id)||row.id<id||!['owner','admin','member'].includes(row.role)||page.members_visibility==='managers'&&row.role==='member'))throw fail('invalid_response');
        return {page,row:row?.id===id?row:null};
      };
      switch(p){
      case '/client/config':{
        const raw=await get('/client/config'),release=(raw.releases||{})[platform]||{},announcement=raw.announcement||{},registration=raw.registration||{};
        const links=(key)=>Array.isArray(raw[key])?raw[key].map((item,index)=>({id:index+1,name:item.title||'',url:item.url||''})):[];
        return {...raw,chat_notice:announcement.body||'',announcement:{id:1,title:announcement.title||'',content:announcement.body||'',enabled:!!announcement.enabled,revision:integer(raw.announcement_version||1)},
          group_member_limit:Number(raw.group_member_limit||500),explore_links:links('navigation'),mall_links:links('shops'),
          show_group_member_count:raw.display?.show_group_count!==false,latest_version:release.latest||'1.0.0',minimum_version:release.minimum||'',
          android_download_url:platform==='android'?release.url||'':'',ios_download_url:platform==='ios'?release.url||'':'',update_description:release.notes||'',force_update:!!release.force,
          register_require_avatar:raw.registration_avatar_required===true,max_register_accounts_per_ip:Number(registration.per_ip_limit||0)};
      }
      case '/auth/register-challenge':{
        const captcha=await get('/auth/captcha');
        return {challenge_id:captcha.id,image_data_url:captcha.image,code_length:5,expires_in:captcha.expires_in};
      }
      case '/auth/register':{
        const account=b.username||'', phone=b.phone||'';
        const registration={account,phone,nickname:b.nickname,password:b.password,captcha_id:b.captcha_id,captcha_code:b.captcha_code};
        if(b.avatar_data_url){
          const match=/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(b.avatar_data_url);
          if(!match||match[2].length>14*1024*1024)throw fail('invalid_request');
          registration.avatar_filename='avatar.'+(match[1]==='jpeg'?'jpg':match[1]);registration.avatar_base64=match[2];
        }
        await put('/auth/register','POST',registration);
        const deviceKey=scope+'device:'+platform;let device=storage.getItem(deviceKey);
        if(!device){device=platform+'-'+crypto.randomUUID();storage.setItem(deviceKey,device);}
        const result=await put('/auth/login','POST',{account:account||phone,password:b.password,device_id:device,platform,device_name:platform,client_version:clientVersion});
        return {...result,user_id:local('user',result.user_id)};
      }
      case '/auth/login': {
        const deviceKey=scope+'device:'+platform;let device=storage.getItem(deviceKey);if(!device){device=platform+'-'+crypto.randomUUID();storage.setItem(deviceKey,device);}
        const r=await put('/auth/login','POST',{account:b.phone||b.username||b.account,password:b.password,device_id:device,platform,device_name:b.device_name||platform,client_version:clientVersion,second_factor:b.two_step_code||''}); return {...r,user_id:local('user',r.user_id)};
      }
      case '/auth/me':return user(await profile('/me/profile'));
      case '/auth/profile':{
        const current=await profile('/me/profile'),patch={expected_version:current.version};
        for(const [from,to] of [['nickname','nickname'],['username','account'],['birthday','birthday'],['gender','gender'],['signature','bio'],['inactivity_days','inactivity_days']])
          if(b[from]!==undefined)patch[to]=b[from];
        let updated=current;
        if(Object.keys(patch).length>1)updated=await put('/me/profile','PATCH',patch);
        const id=/^pulse-media:([0-9a-f-]{36})$/.exec(b.avatar_url||'')?.[1];
        if(id){
          await put('/me/avatar','PUT',{media_id:id,expected_version:updated.version});
          updated=await profile('/me/profile');
        }
        if(updated.avatar_id&&!updated.avatar_url)updated.avatar_url=await optionalMediaGrant(updated.avatar_id,authToken,options.signal);
        return user(updated);
      }
      case '/auth/logout':await put('/auth/logout');return receipt();
      case '/auth/password':await put('/auth/password','PUT',{current_password:b.current_password,new_password:b.new_password});return receipt();
      case '/auth/security':return method==='GET'?get('/me/security'):put('/me/security','PUT',{
        action:b.action,login_password:b.login_password||'',current:b.current??b.current_code??'',next:b.next??b.new_password??''});
      case '/auth/sessions':return {items:(await get('/auth/sessions')).items.map(r=>({...r,id:local('session',r.id),device_type:r.device_id.split('-')[0],is_current:r.current}))};
      case '/auth/sessions/revoke':await put('/auth/sessions/'+wire('session',b.session_id),'DELETE');return receipt();
      case '/go/privacy':return method==='GET'?get('/me/privacy'):put('/me/privacy','PATCH',b);
      case '/notifications/summary':{
        const result=await get('/notifications?limit=1');return {unread_count:integer(result.unread_count||0)};
      }
      case '/notifications/read':{
        const ids=(b.ids||[]).map(value=>{const id=Number(value);if(!Number.isSafeInteger(id)||id<1)throw fail('invalid_request');return id;});
        if(!ids.length)throw fail('invalid_request');await put('/notifications/read','PUT',{ids});
        const result=await get('/notifications?limit=1');return {unread_count:integer(result.unread_count||0)};
      }
      case '/notifications':{
        const limit=Math.min(100,integer(q.get('limit')||30)),params=new URLSearchParams({limit:String(limit)});
        if(q.has('before_id'))params.set('before_id',String(q.get('before_id')));
        const result=await get('/notifications?'+params),items=result.items||[];
        await Promise.all(items.map(item=>item.actor_avatar_id?optionalMediaGrant(item.actor_avatar_id,authToken,options.signal):null));
        return {...result,items:items.map(item=>({...item,id:integer(item.id),request_id:item.request_id?local('request',item.request_id):0,
          conversation_id:item.conversation_id?local('conversation',item.conversation_id):0,
          actor_id:item.actor_id?local('user',item.actor_id):0,actor_avatar_url:item.actor_avatar_id?mediaGrants.get(item.actor_avatar_id)?.url||'':'',
          request_status:item.request_status||item.handled||'',unread:item.unread===true}))};
      }
      case '/auth/settings':{
        const current=await get('/me/privacy'),me=await profile('/me/profile');
        const scopes={phone_visibility:'phone',phone_search_visibility:'phone_search',last_seen_visibility:'last_seen',voice_call_visibility:'voice_call',invite_visibility:'group_invites'};
        const oldView=rules=>({can_manage_privacy:rules.can_manage_group_invites,
          phone_visibility:rules.phone.visibility,phone_search_visibility:rules.phone_search.visibility,
          last_seen_visibility:rules.last_seen.visibility,voice_call_visibility:rules.voice_call.visibility,
          voice_call_peer_to_peer:rules.voice_call_peer_to_peer,invite_visibility:rules.group_invites.visibility,
          show_active_sessions:rules.show_active_sessions,account_auto_delete_days:me.inactivity_days,
          privacy_exceptions:{phone_visibility_always:rules.phone.allow.map(id=>local('user',id)),
            phone_search_always:rules.phone_search.allow.map(id=>local('user',id)),
            last_seen_never:rules.last_seen.deny.map(id=>local('user',id)),
            voice_call_never:rules.voice_call.deny.map(id=>local('user',id)),
            invite_never:rules.group_invites.deny.map(id=>local('user',id))}});
        if(method==='GET')return oldView(current);
        const settings=b.settings||{},patch={expected_version:current.version};
        for(const [oldKey,scopeName] of Object.entries(scopes))if(settings[oldKey]!==undefined)
          patch[scopeName]={...current[scopeName],visibility:settings[oldKey]};
        const exceptions=settings.privacy_exceptions;
        if(exceptions){
          for(const [oldKey,scopeName,effect] of [['phone_visibility_always','phone','allow'],['phone_search_always','phone_search','allow'],['last_seen_never','last_seen','deny'],['voice_call_never','voice_call','deny'],['invite_never','group_invites','deny']]){
            if(exceptions[oldKey]!==undefined){const rule=patch[scopeName]||{...current[scopeName]};rule[effect]=exceptions[oldKey].map(id=>wire('user',id));patch[scopeName]=rule;}
          }
        }
        if(settings.voice_call_peer_to_peer!==undefined)patch.voice_call_peer_to_peer=settings.voice_call_peer_to_peer;
        if(settings.show_active_sessions!==undefined)patch.show_active_sessions=!!settings.show_active_sessions;
        let result=current;
        if(Object.keys(patch).length>1)result=await put('/me/privacy','PATCH',patch);
        if(settings.account_auto_delete_days!==undefined){
          await put('/me/profile','PATCH',{inactivity_days:Number(settings.account_auto_delete_days),expected_version:me.version});
        }
        return oldView(result);
      }
      case '/contacts/search':{
        const publicID=q.get('public_id');if(publicID!==null&&!(/^([A-Za-z0-9]{16}|[A-F0-9]{32})$/.test(publicID)))throw fail('invalid_request');let items=[];
        try{items=[user(await profile(publicID!==null?'/public-users/'+encodeURIComponent(publicID):'/users/by-account/'+encodeURIComponent(q.get('q')||q.get('username')||'')))];}catch(e){if(e.status!==404)throw e;}
        return {items,total:items.length,page:1,size:1};
      }
      case '/contacts/names':{const r=await get('/client/friend-page?'+pageParams());return {...r,items:(r.items||[]).map(user)};}
      case '/contacts':{const r=await get('/client/friend-page?'+pageParams()),items=await Promise.all((r.items||[]).map(async row=>{const item=user(row);if(row.avatar_id)item.avatar_url=await optionalMediaGrant(row.avatar_id,authToken,options.signal);return item;}));return {...r,items};}
      case '/contacts/profile':{
        const context=q.get('context_conversation_id');const r=user(await profile('/profiles/'+target()+(context?'?conversation_id='+wire('conversation',context):'')));
        return {...r,blocked_by_me:(await all('/blocks')).includes(target())};
      }
      case '/contacts/relationship':{
        const context=q.get('context_conversation_id');
        return user(await get('/profiles/'+target()+(context?'?conversation_id='+wire('conversation',context):'')));
      }
      case '/contacts/internal-profile':{
        const context=q.get('context_conversation_id');const raw=await get('/staff/users/'+target()+(context?'?conversation_id='+wire('conversation',context):''));
        const history=raw.logins||[],last=history[0]||{},location=last.location||raw.last_login_location||'';return {user_id:local('user',raw.id),nickname:raw.nickname||'',phone:raw.phone||'',register_ip:raw.registration_ip||'',login_history:history,
          register_ip_location:raw.registration_ip_location||'',register_ip_location_status:raw.registration_ip_location_status||'unknown',lookup_available:raw.lookup_available===true,
          last_login_ip:last.ip||'',last_login_at:last.created_at||'',last_login_device:last.device_name||'',last_login_location:location,ip_location:location,last_login_location_status:last.location_status||'unknown',public_id:raw.public_id||''};
      }
      case '/contacts/card-profile':{
        const conversation=integer(input('conversation_id')),mid=(await storedMessage(conversation,input('message_id'),options)).body._go_wire_id;
        const raw=await get('/conversations/'+wire('conversation',conversation)+'/messages/'+mid+'/contact'),profile=user(raw.user||{});
        return {...profile,is_contact:raw.is_contact===true,can_add_friend:raw.can_add_friend===true,add_friend_restriction:raw.add_friend_restriction||'',
          source_conversation_id:conversation,source_message_id:integer(input('message_id'))};
      }
      case '/contacts/common-groups':{
        const peer=target(),context=q.get('context_conversation_id'),params=pageParams();
        if(context)params.set('conversation_id',wire('conversation',context));
        const result=await get('/profiles/'+peer+'/common-groups?'+params);
        return {...result,items:(result.items||[]).map(row=>({id:local('conversation',row.id),type:'group',name:row.title||'',status:'active'}))};
      }
      case '/contacts/remark':{
        const current=await get('/profiles/'+target());
        const remark=b.remark??current.remark??'',groupName=b.group_name??current.group_name??'';
        await put('/friends/'+target()+'/metadata','PUT',{remark,group_name:groupName,expected_version:current.contact_version});
        return {user_id:b.user_id,remark,group_name:groupName};
      }
      case '/contacts/remove':await put('/friends/'+target(),'DELETE');return receipt('removed');
      case '/contacts/force-add':await put('/friends/direct-add','POST',{target_id:target()});return {...receipt('accepted'),forced:true};
      case '/contact-requests':{
        if(method==='GET'){const direction=q.get('direction')==='sent'?'outgoing':'incoming',params=pageParams();params.set('direction',direction);if(q.get('status'))params.set('status',q.get('status'));const r=await get('/client/friend-request-page?'+params);return {...r,items:(r.items||[]).map(x=>({...x,id:local('request',x.id),user_id:local('user',direction==='incoming'?x.requester_id:x.target_id),nickname:direction==='incoming'?x.requester_account:x.target_account,message:x.note}))};}
        const payload={target_id:wire('user',b.to_user_id),note:b.message||''};if(b.context_conversation_id)payload.context_conversation_id=wire('conversation',b.context_conversation_id);
        if(b.card_message_id){if(!b.card_conversation_id)throw fail('invalid_request');payload.card_conversation_id=wire('conversation',b.card_conversation_id);payload.card_message_id=(await storedMessage(b.card_conversation_id,b.card_message_id,options)).body._go_wire_id;}
        const r=await put('/friend-requests','POST',payload);return {...r,id:local('request',r.id),request_id:local('request',r.id),conversation_id:r.conversation_id?local('conversation',r.conversation_id):0};
      }
      case '/contact-requests/handle':if(!['accept','reject'].includes(b.action))throw fail('invalid_request');await put('/friend-requests/'+wire('request',b.request_id)+'/decision','PUT',{accept:b.action==='accept'});return receipt(b.action==='accept'?'accepted':'rejected');
      case '/notifications/friend-chats':{
        const result=await get('/friend-chats?after_id='+encodeURIComponent(q.get('after_id')||'0'));
        return {...result,items:(result.items||[]).map(row=>({...row,id:integer(row.id),conversation_id:local('conversation',row.conversation_id),peer_user_id:local('user',row.peer_user_id)}))};
      }
      case '/blocks':if(method==='GET'){const items=(await all('/blocks')).map(id=>({blocked_id:local('user',id),user_id:local('user',id),nickname:'已屏蔽用户'}));return {items,total:items.length};}await put('/blocks/'+target(),'PUT',{reason:b.reason||''});return receipt();
      case '/blocks/unblock':await put('/blocks/'+target(),'DELETE');return receipt();
      case '/conversations':{const r=await get('/client/conversation-page?'+pageParams()+'&kind='+encodeURIComponent(q.get('type')||''));await warmMediaGrants((r.items||[]).map(item=>item.avatar_id),authToken,options.signal);return {...r,items:(r.items||[]).map(conversation)};}
      case '/conversations/info':return info(cid());
      case '/conversations/open':{
        try{const expected=cw(),row=await put('/conversations/'+expected+'/open','POST',{});if(row.id==null)return info(cid());if(row.id!==expected)throw fail('invalid_response');return await renderConversation(row);}
        catch(error){if(error.status!==404)throw error;}
        for(let attempt=0;attempt<3;attempt++){
          const current=await info(cid());if(!current.is_hidden)return current;
          try{await put('/conversations/'+cw()+'/preferences','PATCH',{hidden:false,expected_version:String(current.preference_version)});return info(cid());}
          catch(error){if(error.status!==409||attempt===2)throw error;}
        }
        throw fail('unavailable',503);
      }
      case '/conversations/settings':case '/conversations/hide':{
        const current=await info(cid()),patch={expected_version:String(current.preference_version)};
        for(const [oldKey,newKey] of [['is_pinned','pinned'],['notifications_muted','muted_notifications'],['is_archived','archived']])
          if(b[oldKey]!==undefined)patch[newKey]=!!b[oldKey];
        if(p==='/conversations/hide')patch.hidden=true;
        if(Object.keys(patch).length===1)throw fail('invalid_request');
        await put('/conversations/'+cw()+'/preferences','PATCH',patch);
        return info(cid());
      }
      case '/conversation-folders':{
        if(method==='GET'){
          const result=await get('/conversation-folders');
          return {items:(result.items||[]).map(row=>({...row,id:local('folder',row.id),scope:row.scope==='group'?'groups':row.scope,
            conversation_ids:(row.conversation_ids||[]).map(id=>local('conversation',id))}))};
        }
        const row=await put('/conversation-folders','POST',{scope:b.scope==='groups'?'group':b.scope,name:b.name,sort_order:0,collapsed:false});
        return {...row,id:local('folder',row.id)};
      }
      case '/conversation-folders/toggle':{
        const list=await get('/conversation-folders'),folder=(list.items||[]).find(row=>local('folder',row.id)===integer(b.folder_id));
        if(!folder)throw fail('not_found',404);
        const updated=await put('/conversation-folders/'+folder.id,'PUT',{scope:folder.scope,name:folder.name,sort_order:folder.sort_order,collapsed:!!b.collapsed,expected_version:folder.version});
        return {...updated,id:integer(b.folder_id),scope:b.scope};
      }
      case '/conversation-folders/assign':{
        const current=await info(cid());
        await put('/conversations/'+cw()+'/preferences','PATCH',{folder_id:b.folder_id?wire('folder',b.folder_id):'',expected_version:String(current.preference_version)});
        return info(cid());
      }
      case '/conversations/favorites':{const result=await put('/conversations/saved','POST',{});return info(local('conversation',result.id));}
      case '/conversations/direct':{const r=await put('/conversations/direct','POST',{peer_id:target()});return info(local('conversation',r.id));}
      case '/conversations/presence':{
        const rows=b.items;
        if(!Array.isArray(rows)||!rows.length||rows.length>100||rows.some(row=>!Number.isSafeInteger(row.conversation_id)||row.conversation_id<1||!Number.isSafeInteger(row.peer_user_id)||row.peer_user_id<1)||new Set(rows.map(row=>row.conversation_id)).size!==rows.length)throw fail('invalid_request');
        const requested=rows.map(row=>wire('conversation',row.conversation_id)),peers=new Map(rows.map(row=>[wire('conversation',row.conversation_id),wire('user',row.peer_user_id)]));
        let result;
        if(Date.now()>=presenceBatchUnsupportedUntil){
          try{result=await put('/client/conversation-presence','POST',{conversation_ids:requested});}
          catch(error){if(![404,405].includes(error.status))throw error;presenceBatchUnsupportedUntil=Date.now()+300000;}
        }
        if(!result){
          // Older servers use their existing privacy-authorized profile route.
          // Limit concurrency, and never fetch avatars, blocks, or chat history.
          const items=[],removed_ids=[];let cursor=0;
          await Promise.all(Array.from({length:Math.min(3,rows.length)},async()=>{
            while(cursor<rows.length){
              const index=cursor++,id=requested[index],peer=peers.get(id);
              try{
                const profile=await get('/profiles/'+peer);
                if(profile.id!==peer||typeof profile.online!=='boolean')throw fail('invalid_response');
                const hidden=profile.last_seen==null;
                items.push({conversation_id:id,peer_id:peer,online:hidden?false:profile.online,last_seen_hidden:hidden,last_seen:hidden?null:profile.last_seen});
              }catch(error){if(![403,404].includes(error.status))throw error;removed_ids.push(id);}
            }
          }));
          result={items,removed_ids};
        }
        if(!Array.isArray(result.items)||!Array.isArray(result.removed_ids))throw fail('invalid_response');
        const received=[...result.items.map(row=>row.conversation_id),...result.removed_ids];
        if(received.length!==requested.length||new Set(received).size!==requested.length||received.some(id=>!requested.includes(id)))throw fail('invalid_response');
        for(const row of result.items){
          if(row.peer_id!==peers.get(row.conversation_id)||typeof row.online!=='boolean'||typeof row.last_seen_hidden!=='boolean'
            ||(row.last_seen_hidden?row.last_seen!=null:typeof row.last_seen!=='string'||!Number.isFinite(Date.parse(row.last_seen))))throw fail('invalid_response');
        }
        return {items:result.items.map(row=>({id:local('conversation',row.conversation_id),peer_user_id:local('user',row.peer_id),peer_online:row.last_seen_hidden?null:row.online,peer_last_seen_hidden:row.last_seen_hidden})),removed_ids:result.removed_ids.map(id=>local('conversation',id))};
      }
      case '/conversations/updates':{
        const ids=[...new Set((q.get('ids')||'').split(',').filter(Boolean).map(integer))];
        if(!ids.length||ids.length>100)throw fail('invalid_request');
        const requested=ids.map(id=>wire('conversation',id));
        let result;
        try{result=await put('/client/conversation-updates','POST',{conversation_ids:requested});}
        catch(error){
          if(![404,405].includes(error.status))throw error;
          // 兼容旧服务时仍输出完整增量契约，避免逐项读取后再次加载整页。
          const items=[],removed_ids=[];
          for(const id of ids){try{const row=await info(id);if(row.is_hidden)removed_ids.push(id);else items.push(row);}catch(e){if([403,404].includes(e.status))removed_ids.push(id);else throw e;}}
          rememberDirectoryVisibility(items.map(item=>({id:wire('conversation',item.id)})),removed_ids.map(id=>wire('conversation',id)));
          return {items,removed_ids,incremental:true};
        }
        if(result.incremental!==true||!Array.isArray(result.items)||!Array.isArray(result.removed_ids))throw fail('invalid_response');
        const received=[...result.items.map(row=>row.id),...result.removed_ids];
        if(received.length!==requested.length||new Set(received).size!==requested.length||received.some(id=>!requested.includes(id)))throw fail('invalid_response');
        rememberDirectoryVisibility(result.items,result.removed_ids);
        await warmMediaGrants(result.items.map(row=>row.avatar_id),authToken,options.signal);
        return {items:result.items.map(conversation),removed_ids:result.removed_ids.map(id=>local('conversation',id)),incremental:true};
      }
      case '/conversations/groups':{
        const avatarID=/^pulse-media:([0-9a-f-]{36})$/.exec(b.avatar_url||'')?.[1]||'';
        if(b.avatar_url&&!avatarID)throw fail('invalid_request');
        const r=await put('/groups','POST',{title:b.name,initial_members:(b.member_ids||[]).map(id=>wire('user',id)),block_member_friend_requests:b.allow_member_add_friend===false,...avatarID?{avatar_id:avatarID}:{}});return {...await info(local('conversation',r.id)),invite_code:r.invite_code};
      }
      case '/conversations/channels':{
        const created=await put('/channels','POST',{title:b.name});
        const conversationID=local('conversation',created.id),avatarID=/^pulse-media:([0-9a-f-]{36})$/.exec(b.avatar_url||'')?.[1];
        if(avatarID)await put('/groups/'+wire('conversation',conversationID)+'/avatar','PUT',{media_id:avatarID});
        return {...await info(conversationID),invite_code:created.invite_code};
      }
      case '/conversations/groups/join':{
        if(b.group_number!==undefined){const joined=await put('/groups/join-by-number','POST',{number:String(b.group_number),invite_code:b.invite_code||''});return info(local('conversation',joined.id));}
        if(b.conversation_id!==undefined){
          const value=String(b.conversation_id),stored=storage.getItem(scope+'id:conversation:'+integer(value));
          const number=stored?wire('conversation',value):value;
          const joined=await put('/groups/join-by-number','POST',{number,invite_code:b.invite_code||''});
          return info(local('conversation',joined.id));
        }
        const r=await put('/groups/join','POST',{invite_code:b.invite_code});return info(local('conversation',r.id));
      }
      case '/conversations/channels/follow':{
        const payload={};
        if(b.conversation_id!==undefined&&Number(b.conversation_id)>0){
          const value=String(b.conversation_id),stored=storage.getItem(scope+'id:conversation:'+integer(value));
          payload.conversation_id=stored?wire('conversation',value):value;
        }else if(b.invite_code)payload.invite_code=b.invite_code;
        else throw fail('invalid_request');
        const joined=await put('/channels/follow','POST',payload);
        return {...await info(local('conversation',joined.id)),status:'joined'};
      }
      case '/conversations/groups/profile':if(method!=='GET'){const patch={};if(b.name!==undefined)patch.title=b.name;if(b.description!==undefined)patch.description=b.description;if(b.announcement!==undefined)patch.announcement=b.announcement;if(typeof b.allow_member_add_friend==='boolean')patch.block_member_friend_requests=!b.allow_member_add_friend;if(Object.keys(patch).length)await put('/groups/'+cw(),'PATCH',patch);if(typeof b.all_muted==='boolean')await put('/groups/'+cw()+'/mute-all','PUT',{muted:b.all_muted});const avatarID=/^pulse-media:([0-9a-f-]{36})$/.exec(b.avatar_url||'')?.[1];if(avatarID)await put('/groups/'+cw()+'/avatar','PUT',{media_id:avatarID});}return group();
      case '/conversations/groups/settings':{
        if(typeof b.all_muted==='boolean')await put('/groups/'+cw()+'/mute-all','PUT',{muted:b.all_muted});
        if(typeof b.notifications_muted==='boolean'||typeof b.is_pinned==='boolean'){
          const current=await info(cid());
          const patch={expected_version:String(current.preference_version)};
          if(typeof b.notifications_muted==='boolean')patch.muted_notifications=b.notifications_muted;
          if(typeof b.is_pinned==='boolean')patch.pinned=b.is_pinned;
          await put('/conversations/'+cw()+'/preferences','PATCH',patch);
        }
        return group();
      }
      case '/conversations/members/context':{
        if(method!=='GET')throw fail('invalid_request');
        const [g,selected]=await Promise.all([get('/groups/'+cw()),selectedMember()]);
        if(g.id!==cw()||g.kind!=='group'||!['owner','admin','member'].includes(g.my_role)||!UUID.test(g.owner_id))throw fail('invalid_response');
        const manages=['owner','admin'].includes(g.my_role);
        if((manages||g.kind==='group'&&g.block_member_friend_requests===false)!==(selected.page.search_scope==='group'))throw fail('membership_changed',409);
        const profile={...g,id:cid(),conversation_id:cid(),type:g.kind,status:g.status||'active',owner_id:local('user',g.owner_id),can_manage:manages,is_owner:g.my_role==='owner',allow_member_add_friend:g.kind==='group'&&g.block_member_friend_requests===false,members_visibility:selected.page.members_visibility};
        const member=selected.row,items=member?[{...user(member),muted_until:member.muted_permanent?'9999-12-31 23:59:59':member.muted_until||null,muted_permanent:member.muted_permanent===true,is_muted:member.muted===true}]:[];
        return {conversation_id:cid(),user_id:integer(input('user_id')),profile,items,member_count:g.member_count,members_visibility:profile.members_visibility};
      }
      case '/conversations/members':if(method==='GET'){
        let profile=await group();const query=String(q.get('q')||'').trim(),page=integer(q.get('page')||1);
        const managersOnly=q.get('roles')==='managers';
        if(page<1||query.length>100||q.has('roles')&&(!managersOnly||query||q.has('page')))throw fail('invalid_request');
        let rows,hasMore=false,scope=profile.members_visibility==='all'?'group':'friends';
        if(query||q.has('page')){
          const key='directory:'+String(cid())+'|'+profile.my_role+'|'+profile.members_visibility+'|'+query,after=page===1?'':inviteCursors.get(key+'|'+page);
          if(after==null)throw fail('invalid_request');
          const result=await get('/groups/'+cw()+'/member-profiles?'+new URLSearchParams({q:query,after,limit:'100',directory_version:'2'}));
          if(result.query!==query||!['group','friends'].includes(result.search_scope)||!Array.isArray(result.items)||result.items.length>100||typeof result.next_after!=='string'||result.next_after&&result.next_after===after||result.search_scope!==scope||result.members_visibility!==profile.members_visibility)throw fail('invalid_response');
          rows=result.items;scope=result.search_scope;hasMore=Boolean(result.next_after);
          if(query&&scope==='friends'&&rows.some(row=>row.is_contact!==true))throw fail('invalid_response');
          if(!query&&profile.members_visibility!=='all')rows=rows.filter(row=>['owner','admin'].includes(row.role));
          if(hasMore)inviteCursors.set(key+'|'+(page+1),result.next_after);else inviteCursors.delete(key+'|'+(page+1));
        }else{
          rows=await all('/groups/'+cw()+'/member-profiles?directory_version=2');profile=await group();scope=profile.members_visibility==='all'?'group':'friends';
          if(managersOnly||profile.members_visibility!=='all')rows=rows.filter(row=>['owner','admin'].includes(row.role));
        }
        await warmMediaGrants(rows.map(row=>row.avatar_id),authToken,options.signal);
        // Completion may span several pages. Recheck the viewer before the
        // sidebar merges this result into a roster loaded with earlier rights.
        if(managersOnly){profile=await group();scope=profile.members_visibility==='all'?'group':'friends';}
        const items=rows.map(row=>({...user(row),avatar_url:mediaGrants.get(row.avatar_id)?.url||'',muted_until:row.muted_until||(row.muted_permanent?'9999-12-31 23:59:59':null),muted_permanent:row.muted_permanent===true,is_muted:row.muted===true}));
        return {conversation_id:cid(),items,total:items.length,members_visibility:profile.members_visibility,query,page,has_more:hasMore,search_scope:scope,...(managersOnly?{managers_only:true,viewer_role:profile.my_role}:{})};
      }
        if(typeof b.allow_history!=='boolean')throw fail('invalid_request');await put('/groups/'+cw()+'/members','POST',{target_id:target(),allow_history:b.allow_history});return receipt('joined');
      case '/conversations/members/batch':{
        if(typeof b.allow_history!=='boolean')throw fail('invalid_request');
        const r=await put('/groups/'+cw()+'/members/batch','POST',{user_ids:b.user_ids.map(id=>wire('user',id)),allow_history:b.allow_history});
        const profile=await group();return {...r,conversation_id:cid(),items:(r.items||[]).map(x=>({...x,user_id:local('user',x.user_id),status:x.error?'rejected':'joined',message:x.error?fail(x.error,403).message:''})),member_count:profile.member_count,remaining:Math.max(0,profile.member_limit-profile.member_count)};
      }
      case '/conversations/invite-candidates':{
        const g=await group(),page=integer(q.get('page')||1),pageSize=Math.min(500,integer(q.get('size')||50)),query=q.get('q')||'',cursorKey=String(cid())+'|'+query;
        let after=inviteCursors.get(cursorKey+'|'+page)??(page===1?'':null);if(after===null)throw fail('invalid_request');
        const rows=[];let nextAfter='';
        for(let index=0;index<1000&&rows.length<pageSize;index++){
          const needed=Math.min(100,pageSize-rows.length),params=new URLSearchParams({after,q:q.get('q')||'',limit:String(needed)}),r=await get('/groups/'+cw()+'/invite-candidates?'+params);
          if((r.items||[]).length>needed)throw fail('invalid_response');
          rows.push(...(r.items||[]));nextAfter=r.next_after||'';
          if(!nextAfter)break;
          if(nextAfter===after)throw fail('invalid_response');after=nextAfter;
        }
        if(nextAfter)inviteCursors.set(cursorKey+'|'+(page+1),nextAfter);
        const items=await Promise.all(rows.map(async row=>{const item={...user(row),in_group:false,is_member:false,can_invite:true};if(row.avatar_id)item.avatar_url=await optionalMediaGrant(row.avatar_id,authToken,options.signal);return item;}));
        return {group:{...g,can_invite:g.can_manage,remaining:Math.max(0,g.member_limit-g.member_count)},items,has_more:nextAfter!==''};
      }
      case '/conversations/groups/mention-members':{
        const page=integer(q.get('page')||1),query=q.get('q')||'',cursorKey='mention:'+String(cid())+'|'+query,after=inviteCursors.get(cursorKey+'|'+page)??(page===1?'':null);if(after===null)throw fail('invalid_request');
        const result=await get('/groups/'+cw()+'/search-members?'+new URLSearchParams({after,q:query,limit:'100'})),rows=result.items||[],hasMore=!!result.next_after;
        if(hasMore)inviteCursors.set(cursorKey+'|'+(page+1),result.next_after);
        const g=await group(),items=await Promise.all(rows.map(async row=>{const item={...user(row),role:row.role||'member'};if(!g.can_manage){item.account='';item.username='';item.public_id='';}if(row.avatar_id)item.avatar_url=await optionalMediaGrant(row.avatar_id,authToken,options.signal);return item;}));
        return {items,conversation_id:cid(),page,size:100,total:rows.length,has_more:hasMore,can_search:result.can_search===true,can_mention_all:g.can_manage&&result.can_mention_all===true};
      }
      case '/conversations/members/remove':await put('/groups/'+cw()+'/members/'+target(),'DELETE');return receipt('removed');
      case '/conversations/members/role':await put('/groups/'+cw()+'/members/'+target()+'/role','PUT',{role:b.role});return receipt();
      case '/conversations/members/mute':{
        const minutes=Number(b.minutes);if(!Number.isInteger(minutes)||minutes< -1||minutes>43200)throw fail('invalid_request');
        await put('/groups/'+cw()+'/members/'+target()+'/muted','PUT',{minutes});
        const {row:member}=await selectedMember();
        if(!member)throw fail('conflict',409);
        const mutedUntil=member?.muted_permanent?'9999-12-31 23:59:59':member?.muted_until||null;
        return {...receipt(),muted_until:mutedUntil,muted_permanent:member?.muted_permanent===true,is_muted:member?.muted===true};
      }
      case '/conversations/groups/transfer':await put('/groups/'+cw()+'/transfer','POST',{target_id:target()});return receipt();
      case '/conversations/groups/dissolve':await put('/groups/'+cw(),'DELETE');return receipt();
      case '/conversations/leave':{const me=await get('/me');await put('/groups/'+cw()+'/members/'+me.user_id,'DELETE');return receipt('left');}
      case '/go/invite-code':return put('/groups/'+cw()+'/invite-code/rotate');
      case '/internal/broadcast/targets':{
        const type=q.get('type');if(!['friend','group'].includes(type))throw fail('invalid_request');
        const params=new URLSearchParams({kind:type,limit:String(Math.min(100,integer(q.get('limit')||100)))});
        if(q.get('after_id'))params.set('after',q.get('after_id'));
        if(q.get('snapshot_max_id'))params.set('snapshot',q.get('snapshot_max_id'));
        if(q.has('q'))params.set('q',q.get('q'));
        const result=await get('/broadcast-targets?'+params),items=result.items||[];
        await Promise.all(items.map(item=>item.avatar_id?optionalMediaGrant(item.avatar_id,authToken,options.signal):null));
        return {...result,items:items.map(item=>({id:local(type==='friend'?'user':'conversation',item.id),type,name:item.name||item.username||'会话',username:item.username||'',remark:item.remark||'',display_name:item.display_name||item.remark||item.name||item.username||'会话',public_id:item.public_id||'',avatar_url:item.avatar_id?mediaGrants.get(item.avatar_id)?.url||'':''}))};
      }
      case '/internal/broadcast/send':{
        const targetInfo=b.target||{},messages=b.messages||[];
        if(!b.request_id||!Number.isSafeInteger(Number(targetInfo.id))||!['friend','group'].includes(targetInfo.type)||!Array.isArray(messages)||messages.length<1||messages.length>11)throw fail('invalid_request');
        let conversationID;
        if(targetInfo.type==='friend')conversationID=(await put('/conversations/direct','POST',{peer_id:wire('user',targetInfo.id)})).id;
        else conversationID=wire('conversation',targetInfo.id);
        const text=messages.find(item=>item.type==='text')?.body?.text||'';
        const attachments=messages.filter(item=>item.type==='image'||item.type==='video').map(item=>{
          const media=/^pulse-media:([0-9a-f-]{36})$/.exec(item.body?.url||'')?.[1];
          if(!media)throw fail('invalid_request');return {id:media,kind:item.type};
        });
        if(messages.some(item=>!['text','image','video'].includes(item.type))||messages.filter(item=>item.type==='text').length>1||attachments.length>10||(!text&&!attachments.length))throw fail('invalid_request');
        const key='b-'+String(b.request_id).slice(0,36)+'-'+(targetInfo.type==='group'?'g':'f')+'-'+Number(targetInfo.id).toString(36);
        const admitted=await raw('/broadcasts',{method:'POST',body:{request_id:key,conversation_ids:[conversationID],body:String(text),attachments},authToken});
        try{
          for(let attempt=0;attempt<40;attempt++){
            if(options.signal?.aborted)throw options.signal.reason||new DOMException('群发已停止','AbortError');
            const result=await get('/send-batches/'+admitted.id+'?page=1&size=100'),items=result.items||[],status=items[0]?.batch_status||'';
            if(status==='completed')return {complete:items.length>0&&items.every(item=>item.status==='sent')};
            if(status==='partial'){
              const partialKey=authToken+'|'+b.request_id+'|'+targetInfo.type+'|'+targetInfo.id;
              if(!broadcastPartial.has(partialKey)){broadcastPartial.add(partialKey);return {complete:false,error:{message:'部分消息发送失败，可点击继续重试未完成项目。'}};}
              await raw('/send-batches/'+admitted.id+'/retry',{method:'POST',body:{},authToken});
              broadcastPartial.delete(partialKey);continue;
            }
            if(status==='cancelled')return {complete:false,error:{message:'群发任务已取消。'}};
            await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,750);if(options.signal?.aborted){clearTimeout(timer);reject(options.signal.reason||new DOMException('群发已停止','AbortError'));return;}options.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason||new DOMException('群发已停止','AbortError'));},{once:true});});
          }
          throw fail('unavailable',503);
        }catch(error){
          if(options.signal?.aborted)await raw('/send-batches/'+admitted.id,{method:'DELETE',authToken}).catch(()=>{});
          throw error;
        }
      }
      case '/messages':{
        if(!b.body||!['text','image','video','voice','audio','file','contact_card','shake'].includes(b.type))throw fail('invalid_request');
        const payload={request_id:b.request_id};
        if(b.body._source_wire_id){if(!UUID.test(b.body._source_wire_id))throw fail('invalid_request');payload.source_message_id=b.body._source_wire_id;}
        else{
          payload.kind=b.type==='voice'?'audio':b.type==='contact_card'?'contact':b.type;
          payload.body=String(b.body.text||'');
          if(['image','video','audio','file'].includes(payload.kind)){
            const media=/^pulse-media:([0-9a-f-]{36})$/.exec(b.body.url||'')?.[1];
            if(!media||!UUID.test(media))throw fail('invalid_request');payload.media_id=media;
          }
          if(payload.kind==='contact')payload.card_user_id=wire('user',b.body.user_id);
          if(b.body.reply_to_id)payload.reply_to_id=(await storedMessage(cid(),b.body.reply_to_id,options)).body._go_wire_id;
          if(b.body.mention_all)payload.mention_all=true;
          if(b.body.mention_user_ids?.length)payload.mentions=b.body.mention_user_ids.map(id=>wire('user',id));
        }
        // 写入重试只覆盖幂等发送；后续引用或媒体补齐失败不能重放已成功的写请求。
        const r=await deliveryRetry(()=>put('/conversations/'+cw()+'/messages','POST',payload),options.signal);
        await hydrateMessages([r.message],authToken,options.signal);return message(r.message);
      }
      case '/messages/history':case '/messages/sync':{
        const sync=p.endsWith('/sync'), params=new URLSearchParams({limit:q.get('size')||q.get('limit')||'50',order:sync?'asc':'desc'});
        if(sync){params.set('after_seq',q.get('after_id')||'0');params.set('floor_seq',q.get('floor_id')||'0');if(q.has('snapshot_max_id')){if(!q.get('membership_version'))throw fail('membership_changed',409);params.set('snapshot_max_seq',q.get('snapshot_max_id'));params.set('membership_version',q.get('membership_version'));}}
        else if(q.has('max_id'))params.set('before_seq',q.get('max_id'));
        const r=await get('/conversations/'+cw()+'/history?'+params), v=version(cid(),r.membership_version);
        const page=items=>({conversation_id:cid(),items,has_more:r.has_more,snapshot_max_id:integer(r.snapshot_max_seq),next_after_id:integer(r.next_after_seq),cleared_before_message_id:Math.max(integer(r.clear_seq),integer(r.visible_from_seq)-1),membership_version:v});
        if(!sync&&typeof options.onHistoryPage==='function'){
          // The history response already authorizes these rows. Optional media
          // grants and reply context must not delay the first readable frame.
          const items=(r.items||[]).map(row=>{
            const original=message(row);
            const item={...original,body:{...original.body}};
            if(item.body._go_media_id&&!item.body.url)item.body.media_pending=true;
            return item;
          });
          requireVersion(cid(),v);options.signal?.throwIfAborted();
          options.onHistoryPage(page(items));
        }
        await hydrateMessages(r.items||[],authToken,options.signal);
        requireVersion(cid(),v);
        return page((r.items||[]).map(message));
      }
      case '/messages/receipt':{
        const operation=b.status??'read';if(!['read','delivered'].includes(operation))throw fail('invalid_request');
        if(b.through_message_id!=null){
          if(b.message_id!=null||b.message_ids!=null)throw fail('invalid_request');
          const seq=integer(b.through_message_id);
          let readState=await put('/conversations/'+cw()+'/'+operation,'PUT',{seq:String(seq)});
          if(operation==='read'&&readState.reminder===true)readState=await put('/conversations/'+cw()+'/reminder','PUT',{reminder:false});
          const unread=await get('/conversations/'+cw()+'/unread');
          return {...receipt(operation),through_message_id:seq,unread_count:integer(unread.count),unread_truncated:unread.truncated===true,state_version:String(readState.version??'0')};
        }
        const ids=b.message_ids??(b.message_id!=null?[b.message_id]:[]);
        if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids.map(integer)).size!==ids.length)throw fail('invalid_request');
        // 单条回执只更新该条事实，不能把未实际阅读的更早消息一起标记已读。
        const known=await storedMessages(cid(),ids,options);
        const items=[];for(const item of known)items.push({...await put('/conversations/'+cw()+'/messages/'+item.body._go_wire_id+'/receipt','PUT',{status:operation}),message_id:item.id});
        return {...receipt(items.length===1?items[0].status:operation),message_id:known.length===1?known[0].id:undefined,message_ids:known.map(item=>item.id),items};
      }
      case '/messages/mark-unread':await put('/conversations/'+cw()+'/reminder','PUT',{reminder:true});return receipt();
      case '/messages/clear-history':{
        if(b.through_message_id==null)throw fail('invalid_request');const r=await put('/conversations/'+cw()+'/clear','PUT',{through_seq:String(integer(b.through_message_id))});return {conversation_id:cid(),cleared_before_message_id:integer(r.clear_seq)};
      }
      case '/messages/delete':{
        const ids=b.message_ids||[b.message_id], wires=(await storedMessages(cid(),ids,options)).map(item=>item.body._go_wire_id);await put('/conversations/'+cw()+'/personal-deletions','POST',{message_ids:wires});const me=await get('/me');return {...receipt(),user_id:local('user',me.user_id),message_ids:ids};
      }
      case '/messages/edit':case '/messages/recall':{
        const msg=await storedMessage(cid(),b.message_id,options), path='/conversations/'+cw()+'/messages/'+msg.body._go_wire_id;
        if(p.endsWith('/recall')){const r=message(await put(path,'DELETE'));return {...r,message_id:r.id,status:'recalled'};}
        if(!b.expected_version)throw fail('invalid_request');return message(await put(path,'PATCH',{body:b.text,expected_version:String(integer(b.expected_version))}));
      }
      case '/messages/receipts':{
        if(q.has('message_ids')){
          const ids=q.get('message_ids').split(',').map(integer);if(!ids.length||ids.length>100)throw fail('invalid_request');
          const known=await storedMessages(cid(),ids,options), byWire=new Map(known.map(m=>[m.body._go_wire_id,m.id]));
          const r=await put('/conversations/'+cw()+'/message-receipts','POST',{message_ids:known.map(m=>m.body._go_wire_id)}),c=await info(cid());
          return {conversation_id:cid(),conversation_type:c.type,items:r.items.map(row=>({...row,message_id:byWire.get(row.message_id),status:row.read_count>0?'read':'unread'}))};
        }
        const msg=await storedMessage(cid(),input('message_id'),options);return get('/conversations/'+cw()+'/messages/'+msg.body._go_wire_id+'/receipts');
      }
      case '/messages/pins':{
        const result=await get('/conversations/'+cw()+'/pins');await hydrateMessages(result.items||[],authToken,options.signal);
        return {conversation_id:cid(),items:(result.items||[]).map(message)};
      }
      case '/messages/pin':case '/messages/unpin':{
        const msg=await storedMessage(cid(),b.message_id,options);
        await put('/conversations/'+cw()+'/pins/'+msg.body._go_wire_id,p==='/messages/pin'?'PUT':'DELETE');
        const result=await get('/conversations/'+cw()+'/pins');await hydrateMessages(result.items||[],authToken,options.signal);
        return {conversation_id:cid(),items:(result.items||[]).map(message)};
      }
      case '/messages/search':{
        const page=integer(q.get('page')||1),size=Math.min(100,integer(q.get('size')||50));
        if(page<1||size<1||page>100)throw fail('invalid_request');
        const params=new URLSearchParams({q:q.get('q')||'',limit:String(size)});
        if(q.has('conversation_id'))params.set('conversation_id',cw());
        if(q.has('sender_id'))params.set('sender_id',wire('user',q.get('sender_id')));
        if(q.has('type'))params.set('kind',q.get('type')==='voice'?'audio':q.get('type')==='contact_card'?'contact':q.get('type'));
        if(q.has('date')){const date=q.get('date');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw fail('invalid_request');params.set('from',date+'T00:00:00+08:00');const next=new Date(date+'T00:00:00+08:00');next.setUTCDate(next.getUTCDate()+1);params.set('to',next.toISOString());}
        let result;
        for(let n=1;n<=page;n++){
          result=await get('/messages/search?'+params);
          if(n<page){if(!result.next_before){result={items:[]};break;}params.set('before_id',result.next_before);}
        }
        await hydrateMessages(result.items||[],authToken,options.signal);
        return {...result,items:(result.items||[]).map(message),page,size,total:(page-1)*size+(result.items||[]).length+(result.next_before?1:0)};
      }
      case '/messages/calendar':{
        const result=await get('/conversations/'+cw()+'/history?order=asc&limit=1');
        return {today:new Date().toLocaleDateString('en-CA'),first_date:result.items?.[0]?.created_at?.slice(0,10)||''};
      }
      case '/messages/locate':{
        let target;
        if(q.get('first')==='1'){
          const oldest=await get('/conversations/'+cw()+'/history?order=asc&limit=1');target=oldest.items?.[0];
        }else{
          const known=await storedMessage(cid(),q.get('message_id'),options);
          target=await get('/conversations/'+cw()+'/messages/'+known.body._go_wire_id);
        }
        if(!target)throw fail('not_found',404);
        const seq=integer(target.seq),prefix='/conversations/'+cw()+'/history?limit=25';
        const [older,newer]=await Promise.all([seq>1?get(prefix+'&before_seq='+(seq-1)):Promise.resolve({items:[]}),get(prefix+'&after_seq='+seq+'&order=asc')]);
        const items=[...(older.items||[]).slice().reverse(),target,...(newer.items||[])];await hydrateMessages(items,authToken,options.signal);
        return {conversation_id:cid(),target_id:seq,items:items.map(message),max_id:Math.max(...items.map(row=>integer(row.seq))),page:1,total:items.length};
      }
      default:throw fail('unsupported',501);
      }
    }
    async function delta(cid,cursor,{signal,onPreview,current=()=>true}={}) {
      const mine=generation,authToken=token,conversationID=wire('conversation',cid),membership=integer(cursor.membership);
      const check=()=>{signal?.throwIfAborted();if(mine!==generation||authToken!==token||!current())throw fail('stale_session',409);requireVersion(cid,membership);};
      check();let events=integer(cursor.events),personal=integer(cursor.personal),snapshot=null,needsSnapshot=false;
      const rows=new Map();
      const firstPersonal=raw('/conversations/'+conversationID+'/personal-sync?'+new URLSearchParams({after:String(personal),limit:'100'}),{authToken,signal});
      firstPersonal.catch(()=>{});
      // 只补新增事件；编辑、撤回和个人删除继续使用完整授权窗口，避免留下旧引用正文。
      for(let pageNumber=0;;pageNumber++){
        check();if(pageNumber>=100)throw fail('unavailable',503);
        const params=new URLSearchParams({after:String(events),limit:'100',membership_version:String(membership)});
        if(snapshot!==null)params.set('snapshot_max_seq',snapshot);
        const page=await raw('/conversations/'+conversationID+'/sync?'+params,{authToken,signal});check();
        if(integer(page.membership_version)!==membership)throw fail('membership_changed',409);
        const maximum=integer(page.snapshot_max_seq),next=integer(page.next_after_seq);
        if(maximum<events||snapshot!==null&&maximum!==snapshot||next<events||next>maximum||page.has_more&&next===events||!page.has_more&&next!==maximum)throw fail('invalid_response',502);
        let last=events;
        for(const event of page.events||[]){
          const seq=integer(event.seq),row=event.message;
          if(seq<=last||seq>next||!row||row.conversation_id!==conversationID)throw fail('invalid_response',502);
          last=seq;if(event.kind!=='message.created'||row.revoked)needsSnapshot=true;
          const old=rows.get(row.id);if(!old||integer(row.version)>=integer(old.version))rows.set(row.id,row);
        }
        events=next;snapshot=maximum;if(!page.has_more)break;
      }
      snapshot=null;
      for(let pageNumber=0;;pageNumber++){
        check();if(pageNumber>=100)throw fail('unavailable',503);
        const params=new URLSearchParams({after:String(personal),limit:'100'});if(snapshot!==null)params.set('snapshot_max_seq',snapshot);
        const page=await (pageNumber===0?firstPersonal:raw('/conversations/'+conversationID+'/personal-sync?'+params,{authToken,signal}));check();
        const maximum=integer(page.snapshot_max_seq),next=integer(page.next_after_seq);
        if(maximum<personal||snapshot!==null&&maximum!==snapshot||next<personal||next>maximum||page.has_more&&next===personal||!page.has_more&&next!==maximum)throw fail('invalid_response',502);
        let last=personal;
        for(const event of page.events||[]){const seq=integer(event.seq);if(seq<=last||seq>next)throw fail('invalid_response',502);last=seq;if(event.kind!=='reminder.changed')needsSnapshot=true;}
        personal=next;snapshot=maximum;if(!page.has_more)break;
      }
      const info=await raw('/conversations/'+conversationID,{authToken,signal});check();
      if(integer(info.membership_version)!==membership)throw fail('membership_changed',409);
      const cleared=Math.max(integer(info.state.clear_seq),integer(info.visible_from_seq)-1),nextCursor={events,personal,membership};
      const changed=[...rows.values()].filter(row=>integer(row.seq)>cleared);
      const result=items=>({items,cleared_before_message_id:cleared,cursor:nextCursor,needs_snapshot:needsSnapshot});
      if(needsSnapshot)return result([]);
      if(typeof onPreview==='function')onPreview(result(changed.map(row=>{const item=message(row,false,false);return {...item,body:{...item.body,...(item.body._go_media_id&&!item.body.url?{media_pending:true}:{})}};})));
      await hydrateMessages(changed,authToken,signal);check();
      return result(changed.map(row=>message(row)));
    }
    async function request(path,options={}) {
      const mine=generation;
      const result=await adapt(path,options);
      if(mine!==generation)throw fail('stale_session',409);
      return result;
    }
    return {base,tokenKey:scope+'token',session,request,raw,delta,directoryChanges,uploadMedia,mediaGrant,local,wire,integer,version,requireVersion,message,conversation,fail,
      get generation(){return generation;},get token(){return token;},get websocketURL(){return baseURL(resolveBase()).replace(/^http/,'ws')+'/realtime';}};
  }
  const api={create,integer,baseURL,fail}; if(typeof module==='object'&&module.exports)module.exports=api;else root.PulseGoV2=api;
})(globalThis);
