/* Shared Go v2 transport for the retained Web and Electron views. */
(function(root) {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const fail = (code, status = 400) => {
    const messages = {unsupported:'当前服务暂未开放此功能', forbidden:'没有操作权限，或对方的隐私/屏蔽设置不允许',
      unauthorized:'登录已失效，请重新登录', conflict:'内容或成员身份已变化，请刷新后再操作',
      version_conflict:'消息已在其他设备修改，请关闭编辑器后重新打开', membership_changed:'群成员身份已变化，正在重新校验历史',
      request_conflict:'同一次发送的内容已改变，请重新发送', invalid_request:'请求参数无效', invalid_response:'服务返回的数据无效',
      rate_limited:'操作太频繁，请稍后重试', unavailable:'服务暂时不可用，请稍后重试', not_found:'没有找到该账号或内容',
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
  function create({base, storage, fetch:fetcher=root.fetch.bind(root), platform='web', onInvalidate=()=>{},resolveBase=()=>base}) {
    base=baseURL(base); const scope='pulse_go_v2:'+encodeURIComponent(base)+':';
    let token='', generation=0;
    const memberships=new Map(), messageIndex=new Map(), mediaGrants=new Map(), inviteCursors=new Map(), broadcastPartial=new Set();
    let activeUploads=0;const uploadWaiters=[];
    function session(next) { next=String(next||''); if(token!==next) {token=next; generation++; memberships.clear(); messageIndex.clear();mediaGrants.clear();inviteCursors.clear();broadcastPartial.clear();} }
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
      if(v>old){ memberships.set(cid,v); if(old) {messageIndex.delete(cid);onInvalidate(cid,'membership');} } return v;
    }
    function requireVersion(cid,v) {if(memberships.get(cid)!==integer(v))throw fail('membership_changed',409);}
    async function raw(path,{method='GET',body,signal,authToken=token}={}) {
      const mine=generation;
      if(authToken&&authToken!==token)throw fail('stale_session',409);
      if(!path.startsWith('/')||path.startsWith('//')||/[\\#]/.test(path))throw fail('invalid_request');
      const activeBase=baseURL(resolveBase());
      const url=new URL(activeBase+path); if(url.origin!==new URL(activeBase).origin||!url.pathname.startsWith('/api/v2/'))throw fail('invalid_request');
      const headers={}; if(authToken)headers.Authorization='Bearer '+authToken; if(body!==undefined)headers['Content-Type']='application/json';
      const timeout=AbortSignal.timeout(15000); signal=signal?AbortSignal.any([signal,timeout]):timeout;
      const response=await fetcher(url.href,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal,cache:'no-store',credentials:'omit',redirect:'error'});
      const data=response.status===204?{}:await response.json();
      if(mine!==generation||(authToken&&authToken!==token))throw fail('stale_session',409);
      if(!response.ok) {const e=fail(data.error?.code||'unavailable',response.status);e.retryAfter=response.headers?.get('Retry-After');throw e;} return data;
    }
    async function mediaGrant(id,authToken=token,signal) {
      if(authToken!==token)throw fail('stale_session',409);
      if(!UUID.test(id))throw fail('invalid_request');
      const cached=mediaGrants.get(id);if(cached?.expires>Date.now()+10000)return cached.url;
      const granted=await raw('/media/'+id+'/grants',{method:'POST',body:{},authToken,signal});
      const path=granted.content_path;
      if(typeof path!=='string'||!/^\/api\/v2\/media-grants\/[a-f0-9]{64}\/content$/.test(path))throw fail('invalid_response');
      const url=new URL(path,new URL(baseURL(resolveBase())).origin).href;
      mediaGrants.set(id,{url,expires:Date.now()+Math.min(120,Number(granted.expires_in)||120)*1000});return url;
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
        for(let attempt=0;attempt<12;attempt++){
          try{media=await raw('/media/uploads',{method:'POST',body:metadata,signal,authToken});break;}
          catch(error){if(error.status!==429&&error.status!==503)throw error;await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,Math.min(3000,500*(attempt+1)));signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});}
        }
        if(!media?.id)throw fail('unavailable',503);
        if(media.status==='pending'){
          onProgress({stage:'upload'});
          const url=new URL(baseURL(resolveBase())+'/media/'+media.id+'/bytes');
          const timeout=AbortSignal.timeout(150000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
          const response=await fetcher(url.href,{method:'PUT',headers:{Authorization:'Bearer '+authToken,'Content-Type':'application/octet-stream'},body:file,signal:combined,cache:'no-store',credentials:'omit',redirect:'error'});
          const result=response.status===204?{}:await response.json();
          if(!response.ok){const error=fail(result.error?.code||'unavailable',response.status);error.retryAfter=response.headers?.get('Retry-After');throw error;}
        }
        onProgress({stage:'processing'});
        for(let attempt=0;attempt<90;attempt++){
          if(mine!==generation||signal?.aborted)throw fail('stale_session',409);
          const result=await raw('/media/'+media.id,{authToken,signal});
          if(result.status==='ready')return {id:media.id,url:'pulse-media:'+media.id,mime:result.mime,size:Number(result.bytes),width:result.width,height:result.height,duration_ms:result.duration_ms,original:result.original};
          if(result.status==='failed'||result.status==='cancelled')throw fail(result.error_code||'unavailable',422);
          await new Promise(resolve=>setTimeout(resolve,1000));
        }
        throw fail('unavailable',503);
      }finally{release();}
    }
    async function hydrateMessages(rows,authToken,signal) {
      const scopes=new Map(rows.map(row=>{const cid=local('conversation',row.conversation_id);return [cid,memberships.get(cid)];}));
      const groups=new Map();
      for(const row of rows)if(row.reply_to_id&&!row.revoked){if(!groups.has(row.conversation_id))groups.set(row.conversation_id,[]);groups.get(row.conversation_id).push(row);}
      for(const [cid,children] of groups){
        const result=await raw('/conversations/'+cid+'/reply-contexts',{method:'POST',body:{message_ids:children.map(row=>row.id)},authToken,signal});
        const contexts=new Map((result.items||[]).map(row=>[row.message_id,row]));
        for(const child of children){child._go_reply=contexts.get(child.id);if(child._go_reply?.message){const id=child._go_reply.message.content?.media?.id;if(id)await mediaGrant(id,authToken,signal).catch(()=>{});}}
      }
      const ids=new Set();for(const row of rows){for(const id of [row?.content?.media?.id,row?.sender?.avatar_id])if(id)ids.add(id);}
      await Promise.all([...ids].map(id=>mediaGrant(id,authToken,signal).catch(()=>{})));
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
        last_seen_hidden:row.last_seen==null,remark:row.remark||'',
        avatar_url:row.avatar_url||'',signature:row.bio||''};
    }
    function message(row,withReply=true) {
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
      if(row.reply_to_id){const previous=messageIndex.get(cid);for(const item of previous?.values()||[])if(item.body._go_wire_id===row.reply_to_id){body.reply_to_id=item.id;break;}}
      const msg={id,conversation_id:cid,sender_id:local('user',row.sender_id),sender_name:row.sender?.name||'会话成员',sender_nickname:row.sender?.name||'会话成员',
        sender_avatar_url:row.sender?.avatar_id?mediaGrants.get(row.sender.avatar_id)?.url||'':'',type,
        body,
        request_id:row.request_id,created_at:displayTime(row.created_at),edited_at:v>1?displayTime(row.updated_at):null,recalled_at:row.revoked?displayTime(row.updated_at):null,status:row.revoked?'recalled':'sent'};
      if(!messageIndex.has(cid))messageIndex.set(cid,new Map()); const index=messageIndex.get(cid), previous=index.get(id);
      if(previous&&integer(previous.body._go_version)>v){
        if(body.reply_to?.unavailable===true&&previous.body.reply_to_id===body.reply_to_id)previous.body.reply_to={id:body.reply_to_id,unavailable:true};
        return previous;
      }
      index.set(id,msg);return msg;
    }
    function storedMessage(cid,id){const msg=messageIndex.get(integer(cid))?.get(integer(id));if(!msg)throw fail('invalid_request');return msg;}
    function conversation(row) {
      const cid=local('conversation',row.id), memberVersion=version(cid,row.membership_version), manages=['owner','admin'].includes(row.my_role), s=row.state;
      return {...row,id:cid,type:row.kind,name:row.kind==='direct'?row.peer_name:row.title,
        avatar_url:row.avatar_id?mediaGrants.get(row.avatar_id)?.url||'':'',
        peer_user_id:row.peer_id?local('user',row.peer_id):null,can_manage:manages,can_publish:row.can_send,
        is_pinned:row.pinned===true,notifications_muted:row.muted_notifications===true,
        is_archived:row.archived===true,is_hidden:row.hidden===true,
        folder_id:row.folder_id?local('folder',row.folder_id):0,
        last_message:row.last_message?message(row.last_message):null,unread_count:Math.max(integer(row.unread_count),s.reminder?1:0),
        unread_mention_count:integer(row.unread_mention_count||0),last_mention_message_id:integer(row.last_mention_seq||0),
        cleared_before_message_id:Math.max(integer(s.clear_seq),integer(row.visible_from_seq)-1),membership_version:memberVersion,
        message_seq:integer(row.message_seq),updated_at:displayTime(row.updated_at),status:'active',all_muted:row.mute_all,
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
      const profile=async route=>{const row=await get(route);if(row.avatar_id)row.avatar_url=await mediaGrant(row.avatar_id,authToken,options.signal).catch(()=>'' );return row;};
      const info=async id=>{const row=await get('/conversations/'+wire('conversation',id));if(row.avatar_id)await mediaGrant(row.avatar_id,authToken,options.signal).catch(()=>{});if(row.last_message)await hydrateMessages([row.last_message],authToken,options.signal);return conversation(row);};
      const receipt=status=>({status:status||'ok',conversation_id:b.conversation_id,user_id:b.user_id,blocked_id:b.user_id});
      const pageParams=()=>new URLSearchParams({page:q.get('page')||'1',size:String(Math.min(100,integer(q.get('size')||50)))});
      const group=async()=>{const g=await get('/groups/'+cw()), c=await info(cid()), manages=['owner','admin'].includes(g.my_role);if(g.avatar_id)await mediaGrant(g.avatar_id,authToken,options.signal).catch(()=>{});return {...g,id:cid(),conversation_id:cid(),type:g.kind,name:g.title,avatar_url:g.avatar_id?mediaGrants.get(g.avatar_id)?.url||'':'',max_members:g.member_limit,can_invite:manages,owner_id:local('user',g.owner_id),can_manage:manages,is_owner:g.my_role==='owner',allow_member_add_friend:!g.block_member_friend_requests,members_visibility:manages||!g.block_member_friend_requests?'all':'managers',all_muted:g.mute_all,can_send:c.can_send,send_disabled_reason:c.send_disabled_reason};};
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
        const result=await put('/auth/login','POST',{account:account||phone,password:b.password,device_id:device,platform,device_name:platform});
        return {...result,user_id:local('user',result.user_id)};
      }
      case '/auth/login': {
        const deviceKey=scope+'device:'+platform;let device=storage.getItem(deviceKey);if(!device){device=platform+'-'+crypto.randomUUID();storage.setItem(deviceKey,device);}
        const r=await put('/auth/login','POST',{account:b.phone||b.username||b.account,password:b.password,device_id:device,platform,device_name:b.device_name||platform,second_factor:b.two_step_code||''}); return {...r,user_id:local('user',r.user_id)};
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
        if(updated.avatar_id&&!updated.avatar_url)updated.avatar_url=await mediaGrant(updated.avatar_id,authToken,options.signal).catch(()=>'');
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
        await Promise.all(items.map(item=>item.actor_avatar_id?mediaGrant(item.actor_avatar_id,authToken,options.signal).catch(()=>{}):null));
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
      case '/contacts':case '/contacts/names':{const r=await get('/client/friend-page?'+pageParams()),items=await Promise.all((r.items||[]).map(async row=>{const item=user(row);if(row.avatar_id)item.avatar_url=await mediaGrant(row.avatar_id,authToken,options.signal).catch(()=> '');return item;}));return {...r,items};}
      case '/contacts/profile':{
        const context=q.get('context_conversation_id');const r=user(await profile('/profiles/'+target()+(context?'?conversation_id='+wire('conversation',context):'')));
        return {...r,blocked_by_me:(await all('/blocks')).includes(target())};
      }
      case '/contacts/internal-profile':{
        const context=q.get('context_conversation_id');const raw=await get('/staff/users/'+target()+(context?'?conversation_id='+wire('conversation',context):''));
        const history=raw.logins||[],last=history[0]||{};return {user_id:local('user',raw.id),nickname:raw.nickname||'',phone:raw.phone||'',register_ip:raw.registration_ip||'',login_history:history,
          last_login_ip:last.ip||'',last_login_at:last.created_at||'',last_login_device:last.device_name||'',public_id:raw.public_id||''};
      }
      case '/contacts/card-profile':{
        const conversation=integer(input('conversation_id')),mid=storedMessage(conversation,input('message_id')).body._go_wire_id;
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
        const current=await profile('/profiles/'+target());
        const remark=b.remark??current.remark??'',groupName=b.group_name??current.group_name??'';
        await put('/friends/'+target()+'/metadata','PUT',{remark,group_name:groupName,expected_version:current.contact_version});
        return {user_id:b.user_id,remark,group_name:groupName};
      }
      case '/contacts/remove':await put('/friends/'+target(),'DELETE');return receipt('removed');
      case '/contacts/force-add':await put('/friends/direct-add','POST',{target_id:target()});return {...receipt('accepted'),forced:true};
      case '/contact-requests':{
        if(method==='GET'){const direction=q.get('direction')==='sent'?'outgoing':'incoming',params=pageParams();params.set('direction',direction);if(q.get('status'))params.set('status',q.get('status'));const r=await get('/client/friend-request-page?'+params);return {...r,items:(r.items||[]).map(x=>({...x,id:local('request',x.id),user_id:local('user',direction==='incoming'?x.requester_id:x.target_id),nickname:direction==='incoming'?x.requester_account:x.target_account,message:x.note}))};}
        const payload={target_id:wire('user',b.to_user_id),note:b.message||''};if(b.context_conversation_id)payload.context_conversation_id=wire('conversation',b.context_conversation_id);
        if(b.card_message_id){if(!b.card_conversation_id)throw fail('invalid_request');payload.card_conversation_id=wire('conversation',b.card_conversation_id);payload.card_message_id=storedMessage(b.card_conversation_id,b.card_message_id).body._go_wire_id;}
        const r=await put('/friend-requests','POST',payload);return {...r,id:local('request',r.id),request_id:local('request',r.id),conversation_id:r.conversation_id?local('conversation',r.conversation_id):0};
      }
      case '/contact-requests/handle':if(!['accept','reject'].includes(b.action))throw fail('invalid_request');await put('/friend-requests/'+wire('request',b.request_id)+'/decision','PUT',{accept:b.action==='accept'});return receipt(b.action==='accept'?'accepted':'rejected');
      case '/notifications/friend-chats':{
        const result=await get('/friend-chats?after_id='+encodeURIComponent(q.get('after_id')||'0'));
        return {...result,items:(result.items||[]).map(row=>({...row,id:integer(row.id),conversation_id:local('conversation',row.conversation_id),peer_user_id:local('user',row.peer_user_id)}))};
      }
      case '/blocks':if(method==='GET'){const items=(await all('/blocks')).map(id=>({blocked_id:local('user',id),user_id:local('user',id),nickname:'已屏蔽用户'}));return {items,total:items.length};}await put('/blocks/'+target(),'PUT',{reason:b.reason||''});return receipt();
      case '/blocks/unblock':await put('/blocks/'+target(),'DELETE');return receipt();
      case '/conversations':{const r=await get('/client/conversation-page?'+pageParams()+'&kind='+encodeURIComponent(q.get('type')||''));await Promise.all((r.items||[]).map(item=>item.avatar_id?mediaGrant(item.avatar_id,authToken,options.signal).catch(()=>{}):null));await hydrateMessages((r.items||[]).map(item=>item.last_message).filter(Boolean),authToken,options.signal);return {...r,items:(r.items||[]).map(conversation)};}
      case '/conversations/info':return info(cid());
      case '/conversations/open':{
        const current=await info(cid());if(current.is_hidden)await put('/conversations/'+cw()+'/preferences','PATCH',{hidden:false,expected_version:String(current.preference_version)});
        return info(cid());
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
      case '/conversations/updates':{const ids=(q.get('ids')||'').split(',').filter(Boolean);return {items:await Promise.all(ids.map(id=>info(integer(id))))};}
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
      case '/conversations/groups/profile':if(method!=='GET'){const patch={};if(b.name!==undefined)patch.title=b.name;if(b.description!==undefined)patch.description=b.description;if(b.announcement!==undefined)patch.announcement=b.announcement;if(typeof b.allow_member_add_friend==='boolean')patch.block_member_friend_requests=!b.allow_member_add_friend;if(Object.keys(patch).length)await put('/groups/'+cw(),'PATCH',patch);const avatarID=/^pulse-media:([0-9a-f-]{36})$/.exec(b.avatar_url||'')?.[1];if(avatarID)await put('/groups/'+cw()+'/avatar','PUT',{media_id:avatarID});}return group();
      case '/conversations/groups/settings':{
        if(typeof b.all_muted==='boolean')await put('/groups/'+cw()+'/mute-all','PUT',{muted:b.all_muted});
        if(typeof b.notifications_muted==='boolean'||typeof b.is_pinned==='boolean'){
          const current=await info(cid());
          const patch={expected_version:String(current.preference_version)};
          if(typeof b.notifications_muted==='boolean')patch.muted_notifications=b.notifications_muted;
          if(typeof b.is_pinned==='boolean')patch.pinned=b.is_pinned;
          await put('/conversations/'+cw()+'/preferences','PATCH',patch);
        }
        return {...await group(),...await info(cid())};
      }
      case '/conversations/members':if(method==='GET'){const rows=await all('/groups/'+cw()+'/member-profiles');await Promise.all(rows.map(row=>row.avatar_id?mediaGrant(row.avatar_id,authToken,options.signal).catch(()=>{}):null));const items=rows.map(r=>({...user(r),avatar_url:r.avatar_id?mediaGrants.get(r.avatar_id)?.url||'':'',muted_until:r.muted_until|| (r.muted_permanent?'9999-12-31 23:59:59':null),muted_permanent:r.muted_permanent===true,is_muted:r.muted===true}));const profile=await group();return {conversation_id:cid(),items,total:items.length,members_visibility:profile.members_visibility};}
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
        const items=await Promise.all(rows.map(async row=>{const item={...user(row),in_group:false,is_member:false,can_invite:true};if(row.avatar_id)item.avatar_url=await mediaGrant(row.avatar_id,authToken,options.signal).catch(()=> '');return item;}));
        return {group:{...g,can_invite:g.can_manage,remaining:Math.max(0,g.member_limit-g.member_count)},items,has_more:nextAfter!==''};
      }
      case '/conversations/groups/mention-members':{
        const page=integer(q.get('page')||1),query=q.get('q')||'',cursorKey='mention:'+String(cid())+'|'+query,after=inviteCursors.get(cursorKey+'|'+page)??(page===1?'':null);if(after===null)throw fail('invalid_request');
        const result=await get('/groups/'+cw()+'/search-members?'+new URLSearchParams({after,q:query,limit:'100'})),rows=result.items||[],hasMore=!!result.next_after;
        if(hasMore)inviteCursors.set(cursorKey+'|'+(page+1),result.next_after);
        const g=await group(),items=await Promise.all(rows.map(async row=>{const item={...user(row),role:row.role||'member'};if(row.avatar_id)item.avatar_url=await mediaGrant(row.avatar_id,authToken,options.signal).catch(()=> '');return item;}));
        return {items,conversation_id:cid(),page,size:100,total:rows.length,has_more:hasMore,can_search:g.can_manage,can_mention_all:g.can_manage};
      }
      case '/conversations/members/remove':await put('/groups/'+cw()+'/members/'+target(),'DELETE');return receipt('removed');
      case '/conversations/members/role':await put('/groups/'+cw()+'/members/'+target()+'/role','PUT',{role:b.role});return receipt();
      case '/conversations/members/mute':{
        const minutes=Number(b.minutes);if(!Number.isInteger(minutes)||minutes< -1||minutes>43200)throw fail('invalid_request');
        await put('/groups/'+cw()+'/members/'+target()+'/muted','PUT',{minutes});
        const member=(await all('/groups/'+cw()+'/member-profiles')).find(row=>row.id===target());
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
        const result=await get('/broadcast-targets?'+params),items=result.items||[];
        await Promise.all(items.map(item=>item.avatar_id?mediaGrant(item.avatar_id,authToken,options.signal).catch(()=>{}):null));
        return {...result,items:items.map(item=>({id:local(type==='friend'?'user':'conversation',item.id),type,name:item.name||item.username||'会话',username:item.username||'',avatar_url:item.avatar_id?mediaGrants.get(item.avatar_id)?.url||'':''}))};
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
          if(b.body.reply_to_id)payload.reply_to_id=storedMessage(cid(),b.body.reply_to_id).body._go_wire_id;
          if(b.body.mention_all)payload.mention_all=true;
          if(b.body.mention_user_ids?.length)payload.mentions=b.body.mention_user_ids.map(id=>wire('user',id));
        }
        const r=await put('/conversations/'+cw()+'/messages','POST',payload);await hydrateMessages([r.message],authToken,options.signal);return message(r.message);
      }
      case '/messages/history':case '/messages/sync':{
        const sync=p.endsWith('/sync'), params=new URLSearchParams({limit:q.get('size')||q.get('limit')||'50',order:sync?'asc':'desc'});
        if(sync){params.set('after_seq',q.get('after_id')||'0');params.set('floor_seq',q.get('floor_id')||'0');if(q.has('snapshot_max_id')){if(!q.get('membership_version'))throw fail('membership_changed',409);params.set('snapshot_max_seq',q.get('snapshot_max_id'));params.set('membership_version',q.get('membership_version'));}}
        else if(q.has('max_id'))params.set('before_seq',q.get('max_id'));
        const r=await get('/conversations/'+cw()+'/history?'+params), v=version(cid(),r.membership_version);
        await hydrateMessages(r.items||[],authToken,options.signal);
        requireVersion(cid(),v);
        return {conversation_id:cid(),items:(r.items||[]).map(message),has_more:r.has_more,snapshot_max_id:integer(r.snapshot_max_seq),next_after_id:integer(r.next_after_seq),cleared_before_message_id:Math.max(integer(r.clear_seq),integer(r.visible_from_seq)-1),membership_version:v};
      }
      case '/messages/receipt':{
        const seq=b.through_message_id??b.message_id??b.message_ids?.reduce((a,v)=>Math.max(a,integer(v)),0);if(seq==null)throw fail('invalid_request');
        const operation=b.status==='delivered'?'delivered':'read';await put('/conversations/'+cw()+'/'+operation,'PUT',{seq:String(integer(seq))});return {...receipt(operation),through_message_id:integer(seq)};
      }
      case '/messages/mark-unread':await put('/conversations/'+cw()+'/reminder','PUT',{reminder:true});return receipt();
      case '/messages/clear-history':{
        if(b.through_message_id==null)throw fail('invalid_request');const r=await put('/conversations/'+cw()+'/clear','PUT',{through_seq:String(integer(b.through_message_id))});return {conversation_id:cid(),cleared_before_message_id:integer(r.clear_seq)};
      }
      case '/messages/delete':{
        const ids=b.message_ids||[b.message_id], wires=ids.map(id=>storedMessage(cid(),id).body._go_wire_id);await put('/conversations/'+cw()+'/personal-deletions','POST',{message_ids:wires});const me=await get('/me');return {...receipt(),user_id:local('user',me.user_id),message_ids:ids};
      }
      case '/messages/edit':case '/messages/recall':{
        const msg=storedMessage(cid(),b.message_id), path='/conversations/'+cw()+'/messages/'+msg.body._go_wire_id;
        if(p.endsWith('/recall')){const r=message(await put(path,'DELETE'));return {...r,message_id:r.id,status:'recalled'};}
        if(!b.expected_version)throw fail('invalid_request');return message(await put(path,'PATCH',{body:b.text,expected_version:String(integer(b.expected_version))}));
      }
      case '/messages/receipts':{
        if(q.has('message_ids')){
          const ids=q.get('message_ids').split(',').map(integer);if(!ids.length||ids.length>100)throw fail('invalid_request');
          const known=ids.map(id=>storedMessage(cid(),id)), byWire=new Map(known.map(m=>[m.body._go_wire_id,m.id]));
          const r=await put('/conversations/'+cw()+'/message-receipts','POST',{message_ids:known.map(m=>m.body._go_wire_id)}),c=await info(cid());
          return {conversation_id:cid(),conversation_type:c.type,items:r.items.map(row=>({...row,message_id:byWire.get(row.message_id),status:row.read_count>0?'read':'unread'}))};
        }
        const msg=storedMessage(cid(),input('message_id'));return get('/conversations/'+cw()+'/messages/'+msg.body._go_wire_id+'/receipts');
      }
      case '/messages/pins':{
        const result=await get('/conversations/'+cw()+'/pins');await hydrateMessages(result.items||[],authToken,options.signal);
        return {conversation_id:cid(),items:(result.items||[]).map(message)};
      }
      case '/messages/pin':case '/messages/unpin':{
        const msg=storedMessage(cid(),b.message_id);
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
          const known=storedMessage(cid(),q.get('message_id'));
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
    async function request(path,options={}) {
      const mine=generation;
      const result=await adapt(path,options);
      if(mine!==generation)throw fail('stale_session',409);
      return result;
    }
    return {base,tokenKey:scope+'token',session,request,raw,uploadMedia,mediaGrant,local,wire,integer,version,requireVersion,message,conversation,fail,
      get generation(){return generation;},get token(){return token;},get websocketURL(){return baseURL(resolveBase()).replace(/^http/,'ws')+'/realtime';}};
  }
  const api={create,integer,baseURL,fail}; if(typeof module==='object'&&module.exports)module.exports=api;else root.PulseGoV2=api;
})(globalThis);
