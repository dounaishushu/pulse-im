/* Go v2 transport for the retained management interface. */
(() => {
  'use strict';
  const base = `${location.origin}/api/v2`;
  const entryKey = 'pulse.go.admin.entry';
  const csrfKey = 'pulse.go.admin.csrf';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const state = {admin: null};
  let mediaEpoch=0;
  const rawGroups = new Map(),rawUsers = new Map(),mediaBlobs = new Map(),rawDispatch = new Map(),rawQuestions = new Map(),rawAccounts = new Map(),rawTasks = new Map(),rawWords = new Map(),settingVersions = new Map();
  const errorMessages = {
    admin_entry_required: '缺少当前账号的专属入口，请从机器人重新打开完整入口链接后登录。',
    unauthorized: '账号、密码或专属入口无效，请确认账号密码并使用该账号的完整入口链接。',
    admin_ip_denied: '当前网络地址没有后台访问权限，请联系管理员。',
    csrf_invalid: '登录校验已失效，请刷新页面后重新登录。',
    session_changed: '登录账号已改变，本次操作已取消，请重新打开页面。',
    conflict: '数据已被更新，请重新加载后再保存。',
    invalid_request: '填写内容不符合要求，请检查必填项和格式。',
    forbidden: '当前账号或目标对象不允许此操作。',
    not_found: '记录已不存在，请刷新列表。',
    dispatch_running: '任务正在执行，请先暂停后再修改。',
    reload_required: '数据已过期，请刷新列表后重试。',
    upload_busy: '上传服务繁忙，请稍后重试。',
  };
  const failure = (status, code = 'invalid_request') => Object.assign(new Error(errorMessages[code] || (status===409?'数据发生冲突，请重新加载后重试。':status===429?'请求较多，请稍后重试。':status===403?'当前账号没有此操作权限。':status>=500?'服务暂时不可用，请稍后重试。':code)), {status, code});
  function local(type, value) {
    if (!(type==='route'?/^[A-Za-z0-9_.:-]{1,64}$/.test(String(value)):uuid.test(String(value)))) throw failure(502, 'invalid_response');
    value = type==='route'?String(value):String(value).toLowerCase();
    const key = `pulse.go.admin.id.${type}.${value}`;
    let id = localStorage.getItem(key);
    if (!id) {
      const nextKey = `pulse.go.admin.next.${type}`;
      id = String(Number(localStorage.getItem(nextKey) || 0) + 1);
      localStorage.setItem(nextKey, id);
      localStorage.setItem(key, id);
      localStorage.setItem(`pulse.go.admin.wire.${type}.${id}`, value);
    }
    return Number(id);
  }
  function wire(type, id) {
    const value = localStorage.getItem(`pulse.go.admin.wire.${type}.${Number(id)}`);
    if (!(type==='route'?/^[A-Za-z0-9_.:-]{1,64}$/.test(value||''):uuid.test(value || ''))) throw failure(400, 'unknown_local_id');
    return value;
  }
  function permissions(values) {
    const map = {stats:'dashboard',devices:'devices',users:'users',groups:'groups',messages:'messages',
      sensitive_words:'sensitive-words',audit:'login-logs',announcements:'announcement',tasks:'task-config',
      questions:'question-bank',records:'task-records',dispatch:'dispatch-tasks',maintenance:'maintenance',config:'client-config'};
    return (values || []).flatMap(value => {
      const [name, mode] = String(value).split('.');
      if(!map[name])return [];
      const views=[map[name],...(name==='messages'?['moderation']:[]),...(name==='config'?['routes']:[])];
      return views.flatMap(key=>[key+'.'+mode,...mode==='manage'?[key+'.view']:[]]);
    });
  }
  function goPermissions(values) {
    const map = {'dashboard':'stats','devices':'devices','users':'users','groups':'groups','messages':'messages',
      'moderation':'messages','sensitive-words':'sensitive_words','login-logs':'audit','announcement':'announcements',
      'task-config':'tasks','question-bank':'questions','task-records':'records','client-config':'config',
      'routes':'config','dispatch-tasks':'dispatch','maintenance':'maintenance'};
    return [...new Set((values||[]).map(value=>{const [key,mode]=String(value).split('.');return map[key]&&['view','manage'].includes(mode)?map[key]+'.'+mode:null;}).filter(Boolean))];
  }
  function admin(raw) {
    return {...raw,id:local('admin',raw.id),username:raw.account,
      role:raw.role === 'superadmin' ? 'admin' : raw.role,
      is_super_admin:raw.role === 'superadmin',permissions:permissions(raw.permissions),
      status:raw.active === false ? 'disabled' : 'active'};
  }
  function pagination(row, convert = value => value) {
    const items = (row.items || []).map(convert);
    return {...row,items,total:(Number(row.page || 1)-1)*Number(row.size || 50)+items.length+(row.has_more ? 1 : 0)};
  }
  function user(row) {
    rawUsers.set(local('user',row.id),row);
    const active = row.active !== false, deleted = !!row.deleted_at;
    return {...row,id:local('user',row.id),user_id:local('user',row.id),username:row.account,
      status:deleted ? 'deleted' : active ? 'active' : 'frozen',
      member_id:row.legacy_numeric_id || local('user',row.id),registered_at:row.created_at,
      register_ip:row.registration_ip || '',login_ip:row.last_login_ip || '',login_at:row.last_login_at || '',
      online:row.last_active_at ? Date.now()-Date.parse(row.last_active_at)<60000:false,
      permissions:{muted:!row.can_send,allow_add_friend:row.can_add_friends,
        allow_create_group:row.can_create_group,internal_staff:row.internal_staff,
        formal_employee:row.formal_employee,allow_view_devices:row.can_view_devices},
      avatar_url:avatarURL(row.avatar_id),
      public_id:row.legacy_public_id || row.public_id};
  }
  function group(row) {
    rawGroups.set(local('conversation',row.id),row);
    return {...row,id:local('conversation',row.id),group_id:row.legacy_numeric_id || row.public_id || row.id,
      name:row.title,type:row.management_type||row.kind,owner_id:row.owner_id ? local('user',row.owner_id) : 0,
      max_members:row.member_limit,all_muted:row.mute_all,allow_member_add_friend:!row.block_member_friend_requests,
      join_method:row.join_policy==='open'?'free':row.join_policy==='closed'?'approval':'invite',
      display_member_count:Number(row.member_count||0)+Number(row.display_count_offset||0),
      status:row.active === false ? 'disabled' : 'active'};
  }
  function message(row) {
    return {...row,id:local('message',row.id),conversation_id:local('conversation',row.conversation_id),
      sender_id:row.sender_id ? local('user',row.sender_id) : 0,type:row.kind==='audio'?'voice':row.kind==='contact'?'contact_card':row.kind,
      recipients:(row.recipients||[]).map(peer=>({...peer,id:local('user',peer.id)})),
      body:{...(row.content||{}),text:row.body||''},recalled_at:row.revoked?row.updated_at:null,
      status:row.revoked ? 'recalled' : 'sent'};
  }
  const captureSession = () => ({epoch:mediaEpoch,entry:sessionStorage.getItem(entryKey),csrf:sessionStorage.getItem(csrfKey)});
  function requireSession(scope) {
    if(scope.epoch!==mediaEpoch||scope.entry!==sessionStorage.getItem(entryKey)||scope.csrf!==sessionStorage.getItem(csrfKey))throw failure(409,'session_changed');
  }
  async function raw(path, {method = 'GET',body,signal,scope = captureSession(),entry = scope.entry,csrf = scope.csrf} = {}) {
    requireSession(scope);
    const headers = {'Accept':'application/json'};
    if (entry) headers['X-Admin-Entry'] = entry;
    if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + path,{method,body:body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      credentials:'same-origin',cache:'no-store',redirect:'error',signal,headers});
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    requireSession(scope);
    if (!response.ok) throw failure(response.status,data.error?.code || 'request_failed');
    return data;
  }
  async function mediaBlob(id,signal,scope = captureSession()) {
    requireSession(scope);
    if(!uuid.test(id||''))throw failure(400,'invalid_media');
    if(mediaBlobs.has(id))return mediaBlobs.get(id);
    const response=await fetch(base+'/admin/media/'+id+'/content',{credentials:'same-origin',redirect:'error',signal,
      headers:{'X-Admin-Entry':scope.entry||''}});
    requireSession(scope);
    if(!response.ok)throw failure(response.status,'media_unavailable');
    if(Number(response.headers.get('Content-Length'))>100*1024*1024){await response.body?.cancel();throw failure(413,'media_too_large');}
    const blob=await response.blob();
    if(blob.size>100*1024*1024)throw failure(422,'invalid_media');
    requireSession(scope);
    const url=URL.createObjectURL(blob);mediaBlobs.set(id,url);return url;
  }
  function mediaURL(value) {
    const id=/^pulse-media:([0-9a-f-]{36})$/i.exec(String(value||''))?.[1];
    return id?avatarURL(id):String(value||'');
  }
  function avatarURL(id) {
    // Same-origin image requests retain HttpOnly session/entrance cookies and
    // server-side authorization without blocking the JSON list on downloads.
    return uuid.test(id||'') ? mediaBlobs.get(id)||base+'/admin/media/'+id+'/content' : '';
  }
  function reset() {mediaEpoch++;for(const url of mediaBlobs.values())URL.revokeObjectURL(url);mediaBlobs.clear();rawGroups.clear();rawUsers.clear();rawDispatch.clear();rawQuestions.clear();rawAccounts.clear();rawTasks.clear();rawWords.clear();settingVersions.clear();state.admin=null;}
  async function upload(path,form,signal,scope = captureSession()) {
    requireSession(scope);
    const file=form?.get('file');if(!(file instanceof File)||file.size<1)throw failure(400,'invalid_upload');
    if(path==='/admin/work-questions/import'){
      const response=await fetch(base+'/admin/questions/import',{method:'POST',body:form,credentials:'same-origin',redirect:'error',signal,
        headers:{'X-Admin-Entry':scope.entry||'','X-CSRF-Token':scope.csrf||''}});
      const result=await response.json().catch(()=>({}));
      requireSession(scope);
      if(!response.ok)throw failure(response.status,result.error?.code||'import_failed');
      return result;
    }
    const kind=path==='/admin/users/avatar'?'avatar':path==='/admin/work-questions/upload'?'question':'image';
    if(file.size>10*1024*1024)throw failure(413,'media_too_large');
    const sum=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
    requireSession(scope);
    const sha256=[...new Uint8Array(sum)].map(value=>value.toString(16).padStart(2,'0')).join('');
    const metadata={request_id:'admin-media-'+crypto.randomUUID(),kind,filename:file.name.replace(/[\\/\r\n:]/g,'_'),
      bytes:String(file.size),sha256,original:false};
    let admitted;
    for(let attempt=0;attempt<12;attempt++){
      try{admitted=await raw('/admin/media/uploads',{method:'POST',body:metadata,signal,scope});break;}
      catch(error){if(![429,503].includes(error.status))throw error;await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));}
    }
    if(!admitted?.id)throw failure(503,'upload_busy');
    requireSession(scope);
    const {entry,csrf}=scope;
    if(admitted.status==='pending'){
      const response=await fetch(base+'/admin/media/'+admitted.id+'/bytes',{method:'PUT',body:file,signal,credentials:'same-origin',redirect:'error',
        headers:{'X-Admin-Entry':entry,'X-CSRF-Token':csrf,'Content-Type':'application/octet-stream'}});
      requireSession(scope);
      if(!response.ok){const data=await response.json().catch(()=>({}));throw failure(response.status,data.error?.code||'upload_failed');}
    }
    for(let attempt=0;attempt<90;attempt++){
      const status=await raw('/admin/media/'+admitted.id,{signal,scope});
      if(status.status==='ready'){await mediaBlob(admitted.id,signal,scope);return {id:admitted.id,url:'pulse-media:'+admitted.id,mime:status.mime,size:Number(status.bytes)};}
      if(status.status==='failed'||status.status==='cancelled')throw failure(422,status.error_code||'media_failed');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw failure(503,'media_timeout');
  }
  async function download(path, signal) {
    const scope=captureSession();
    const params=new URL(path,'https://admin.invalid').searchParams;params.set('format','xlsx');
    for(const key of ['user_id','task_id'])if(params.get(key)){try{params.set(key,wire(key==='user_id'?'user':'task',params.get(key)));}catch{}}
    const suffix='?'+params;
    const target=path.startsWith('/admin/work-questions/template')?'/admin/questions/template':
      path.startsWith('/admin/work-questions/export')?'/admin/exports/questions'+suffix:
      path.startsWith('/admin/work-records/export')?'/admin/exports/wages'+suffix:'';
    if(!target)throw failure(501,'admin_export_unmapped');
    const response=await fetch(base+target+(target.includes('?')?'':'?format=xlsx'),{credentials:'same-origin',signal,redirect:'error',cache:'no-store',headers:{'X-Admin-Entry':scope.entry||''}});
    try {requireSession(scope);} catch(error) {await response.body?.cancel();throw error;}
    return response;
  }
  async function adapt(path,options,scope) {
    const url = new URL(path,'https://admin.invalid');
    const p = url.pathname,q = url.searchParams,method=(options.method || 'GET').toUpperCase();
    const body = options.body instanceof FormData ? options.body : typeof options.body === 'string' ? JSON.parse(options.body) : options.body || {};
    const get = route => raw(route,{signal:options.signal,scope});
    const send = (route,verb,payload) => raw(route,{method:verb,body:payload,signal:options.signal,scope});
    const query = () => '?' + new URLSearchParams({page:q.get('page') || '1',size:q.get('size') || '50',q:q.get('q') || ''});
    const allRows = async route => {
      const items=[];
      for(let page=1;page<=100;page++){
        const result=await get(route+(route.includes('?')?'&':'?')+'page='+page+'&size=100');
        items.push(...(result.items||[]));if(!result.has_more)return items;
      }
      throw failure(503,'too_many_pages');
    };
    const currentUser = async id => {
      requireSession(scope);
      return get('/admin/users/'+wire('user',id));
    };
    const exactActor = (items,text) => items.find(row=>row.account===text||row.public_id===text||row.legacy_public_id===text||row.id===text)
      || items.find(row=>String(row.legacy_numeric_id||'')===text)
      || items.find(row=>String(local('user',row.id))===text);
    const legacyID = (entity,raw) => {
      const value=String(raw||'');if(uuid.test(value))return local(entity,value);
      const num=Number(value);return Number.isSafeInteger(num)&&num>0?num:0;
    };
    const findRow = async (route,predicate) => {
      for(let page=1;page<=100;page++){
        const result=await get(route+(route.includes('?')?'&':'?')+'page='+page+'&size=100');
        const found=(result.items||[]).find(predicate);if(found)return found;
        if(!result.has_more)break;
      }
      throw failure(404,'not_found');
    };
    const setting = async key => {const current=await get('/admin/config/'+key);if(method==='GET')settingVersions.set(key,String(current.version));return current;};
    const saveSetting = async (key,value) => {
      const expected=body._versions?.[key]??(key==='maintenance'?body.version:undefined)??settingVersions.get(key);
      const current=await get('/admin/config/'+key);
      if(expected!==undefined&&String(expected)!==String(current.version))throw failure(409,'conflict');
      await send('/admin/config/'+key,'PUT',{value,expected_version:current.version});
      settingVersions.set(key,String(Number(current.version)+1));
      return {value,version:String(Number(current.version)+1),updated_at:new Date().toISOString()};
    };
    switch (p) {
    case '/admin/auth/login': {
      const entry = sessionStorage.getItem(entryKey);
      const result = await raw('/admin/auth/login',{method:'POST',body:{account:body.username,password:body.password,entry_token:entry || ''},entry,signal:options.signal,scope});
      reset();
      state.admin = admin(result.user); sessionStorage.setItem(csrfKey,result.csrf_token);
      return {session_mode:'cookie',csrf_token:result.csrf_token,admin:state.admin};
    }
    case '/admin/auth/me': {
      const result = await get('/admin/me');state.admin=admin(result);
      return {admin:state.admin,csrf_token:sessionStorage.getItem(csrfKey) || ''};
    }
    case '/admin/auth/logout':await send('/admin/auth/logout','POST',{});sessionStorage.removeItem(csrfKey);reset();return {status:'ok'};
    case '/admin/stats': {
      const [stats,health] = await Promise.all([get('/admin/stats'),get('/admin/health')]);
      return {users:{total:stats.users,online:stats.recently_active,frozen:stats.frozen_users},
        conversations:stats.conversations,today_messages:stats.messages_today,today_logins:stats.successful_logins_today,
        generated_at:new Date().toISOString(),health:{database_latency_ms:health.database_latency_ms}};
    }
    case '/admin/stats/regions':case '/admin/stats/regions/resolve': {
      let pending=await get('/admin/ip-locations/pending'),processed=0;
      if(method==='POST'&&pending.lookup_available!==false&&pending.items?.length){const refreshed=await send('/admin/ip-locations/refresh','POST',{ips:pending.items});processed=refreshed.items?.length||0;pending=await get('/admin/ip-locations/pending');}
      const [regions,stats]=await Promise.all([get('/admin/regions?page=1&size=100'),get('/admin/stats')]);
      const entries=(regions.items||[]).filter(item=>item.country==='CN'||item.country==='China'||item.country==='中国');
      const codes=new Map((typeof registrationProvinceMap==='undefined'?(window.PulseRegistrationMap||[]):registrationProvinceMap).map(item=>[item.name,item.code]));
      const provinces=entries.filter(item=>codes.has(item.province)).map(item=>({code:codes.get(item.province),name:item.province,count:Number(item.users)}));
      const identified=provinces.reduce((sum,item)=>sum+item.count,0);
      const overseas=(regions.items||[]).filter(item=>!['CN','China','中国','unknown',''].includes(item.country)).reduce((sum,item)=>sum+Number(item.users),0);
      const unknown=Math.max(0,Number(stats.users)-identified-overseas);
      return {provinces,identified,domestic:identified,overseas,unknown,total:Number(stats.users),
        unknown_reasons:{missing_or_invalid:0,private:0,pending:pending.items?.length||0,unavailable:0,unmapped:Math.max(0,unknown-(pending.items?.length||0))},
        lookup_available:pending.lookup_available!==false,next_ips:pending.lookup_available===false?[]:pending.items||[],pending_ip_count:pending.items?.length||0,processed_ips:processed};
    }
    case '/admin/stats/offsite-logins':case '/admin/stats/offsite-logins/resolve': {
      const route='/admin/offsite-logins?'+new URLSearchParams({page:q.get('page')||'1',size:q.get('size')||'30'});
      let result=await get(route),processed=0;
      if(method==='POST'&&result.lookup_available!==false&&result.next_ips?.length){
        const refreshed=await send('/admin/ip-locations/refresh','POST',{ips:result.next_ips});
        processed=refreshed.items?.length||0;result=await get(route);
      }
      return {...result,next_ips:result.lookup_available===false?[]:result.next_ips||[],processed_ips:processed,items:(result.items||[]).map(row=>({...row,user_id:local('user',row.user_id),
        avatar_url:avatarURL(row.avatar_id)}))};
    }
    case '/admin/announcement': {
      if(method==='GET'){
        const current=await setting('announcement');
        return {...current.value,content:current.value.body,revision:Number(current.version),_versions:{announcement:current.version},updated_at:new Date().toISOString()};
      }
      const saved=await saveSetting('announcement',{enabled:!!body.enabled,title:body.title||'',body:body.content||''});
      return {enabled:!!body.enabled,title:body.title,content:body.content,revision:Number(saved.version),_versions:{announcement:saved.version},updated_at:saved.updated_at};
    }
    case '/admin/client-navigation': {
      if(method==='GET'){const current=await setting('navigation');return {_versions:{navigation:current.version},explore_links:current.value.map(row=>({id:row.id,name:row.title,url:row.url}))};}
      const items=(body.explore_links||[]).map((row,index)=>({id:'navigation-'+crypto.randomUUID(),title:row.name,url:row.url,sort_order:index}));
      await saveSetting('navigation',items);return {explore_links:body.explore_links||[]};
    }
    case '/admin/client-config': {
      if(method==='GET'){
        const [registration,releases,shops,display]=await Promise.all([setting('registration'),setting('releases'),setting('shops'),setting('display')]);
        const pc=releases.value.pc||{};
        return {_versions:{registration:registration.version,releases:releases.version,shops:shops.version,display:display.version},show_group_member_count:display.value.show_group_count===true,latest_version:pc.latest||'',
          android_download_url:releases.value.android?.url||'',ios_download_url:releases.value.ios?.url||'',
          pc_download_url:pc.url||'',update_description:pc.notes||'',force_update:pc.force===true,
          register_require_avatar:registration.value.avatar_required===true,max_register_accounts_per_ip:registration.value.per_ip_limit||0,
          mall_links:(shops.value||[]).map(row=>({name:row.title,url:row.url})),platform_updates:Object.fromEntries(Object.entries(releases.value).map(([key,value])=>[key,{latest_version:value.latest,minimum_version:value.minimum,force_update:value.force}]))};
      }
      const registration=await setting('registration'),releases=await setting('releases');
      await saveSetting('registration',{...registration.value,avatar_required:!!body.register_require_avatar,per_ip_limit:Number(body.max_register_accounts_per_ip||0)});
      const next={...releases.value};
      for(const platform of ['pc','web','android','ios']){
        const rule=body.platform_updates?.[platform]||{};
        next[platform]={latest:rule.latest_version||body.latest_version||'1.0.0',minimum:rule.minimum_version||'',force:!!rule.force_update,
          url:platform==='pc'?body.pc_download_url||'':platform==='android'?body.android_download_url||'':platform==='ios'?body.ios_download_url||'':next[platform]?.url||'',
          notes:body.update_description||''};
      }
      await saveSetting('releases',next);
      await saveSetting('shops',(body.mall_links||[]).map((row,index)=>({id:'shop-'+crypto.randomUUID(),title:row.name,url:row.url,sort_order:index})));
      await saveSetting('display',{show_group_count:!!body.show_group_member_count});
      return {status:'saved'};
    }
    case '/admin/client-routes': {
      const current=await setting('routes');
      const routes=current.value||[];
      if(method==='GET'){
        const text=(q.get('name')||'').toLowerCase(),status=q.get('status')||'';
        const matched=routes.filter(row=>(!text||row.name.toLowerCase().includes(text))&&(!status||(row.enabled?'enabled':'disabled')===status));
        const page=Number(q.get('page')||1),size=Number(q.get('size')||20);
        return {items:matched.slice((page-1)*size,page*size).map(row=>({...row,_routes_version:current.version,id:local('route',row.id),url:row.api_url,
          sort:row.sort_order,status:row.enabled?'enabled':'disabled'})),total:matched.length,page,size};
      }
      const id=body.id?wire('route',body.id):'route-'+crypto.randomUUID();
      const expected=body._routes_version??settingVersions.get('routes');
      if(expected!==undefined&&String(expected)!==String(current.version))throw failure(409,'conflict');
      const updated={id,name:body.name,api_url:body.url,ws_url:body.ws_url||body.url.replace(/^http/,'ws').replace(/\/$/,'')+'/realtime',
        media_url:body.media_url||body.url,sort_order:Number(body.sort||0),enabled:body.status!=='disabled'};
      const next=routes.filter(row=>row.id!==id).concat(updated);
      await send('/admin/config/routes','PUT',{value:next,expected_version:current.version});
      settingVersions.set('routes',String(Number(current.version)+1));
      return {id:local('route',id)};
    }
    case '/admin/client-routes/delete': {
      const current=await setting('routes');
      const removed=new Set((body.ids||[]).map(id=>wire('route',id)));
      const next=(current.value||[]).filter(row=>!removed.has(row.id));
      await send('/admin/config/routes','PUT',{value:next,expected_version:current.version});
      return {count:removed.size};
    }
    case '/health': {
      const status = await get('/admin/health');
      const workers=status.queues?.workers||[],worker=name=>workers.find(row=>row.name===name),queue=worker('send.queue'),scheduler=worker('dispatch.scheduler');
      const live=row=>Boolean(row?.last_success)&&Date.now()-Date.parse(row.last_success)<120000&&!row.error_code;
      return {ok:true,database:{status:status.database_ready?'up':'down',latency_ms:status.database_latency_ms},
        realtime:{status:status.redis_ready?'up':'down',queued_bytes:status.queued_ws_bytes},
        websocket:{status:status.redis_ready?'up':'down',connections:Number(status.websocket_connections||0)},
        dispatch:{status:live(queue)&&live(scheduler)?'up':queue||scheduler?'degraded':'unknown',workers:[queue,scheduler].filter(Boolean).length,expected_workers:2,
          pending:Number(status.queues?.send_pending||0),message_outbox:Number(status.queues?.message_outbox||0)},
        push:{status:status.apns_configured||status.fcm_configured?'up':'unconfigured',pending_jobs:Number(status.queues?.push_pending||0)}};
    }
    case '/admin/users': {
      const uid=q.get('user_id');
      if(uid){const row=await currentUser(uid);return {items:[user(row)],page:1,size:1,total:1};}
      if(method==='POST'){
        const created=await send('/admin/users','POST',{account:body.username,nickname:body.nickname,password:body.password});
        if(body.avatar_url)await send('/admin/users/'+created.id+'/avatar','PUT',{media_id:body.avatar_url.replace(/^pulse-media:/,'')});
        return {id:local('user',created.id)};
      }
      const result=await get('/admin/users'+query()+'&status='+encodeURIComponent(q.get('status')||''));
      return pagination(result,user);
    }
    case '/admin/users/batch': {
      const result=await send('/admin/users/batch','POST',body);
      return {count:(result.items||[]).length,items:(result.items||[]).map(item=>({...item,id:local('user',item.id)}))};
    }
    case '/admin/users/permission':case '/admin/users/edit':case '/admin/users/status':case '/admin/users/delete': {
      const id=Number(body.user_id),current=await currentUser(id),patch={expected_version:body.profile_version??body.expected_version??current.profile_version};
      if(p==='/admin/users/permission'){
        const fields={muted:'can_send',allow_add_friend:'can_add_friends',allow_create_group:'can_create_group',
          internal_staff:'internal_staff',formal_employee:'formal_employee',allow_view_devices:'can_view_devices'};
        const field=fields[body.field];if(!field)throw failure(400,'invalid_request');
        patch[field]=body.field==='muted'?!body.value:!!body.value;
      }
      if(p==='/admin/users/edit'){
        if(body.nickname!==undefined)patch.nickname=body.nickname;
        if(body.password)patch.password=body.password;
      }
      if(p==='/admin/users/status'&&current.deleted_at&&body.status==='active'){
        await send('/admin/users/'+wire('user',id)+'/restore','POST',{});rawUsers.delete(id);return {user_id:id,status:'active'};
      }
      if(p==='/admin/users/status')patch.active=body.status==='active';
      if(p==='/admin/users/delete')patch.delete=true;
      await send('/admin/users/'+wire('user',id),'PATCH',patch);
      if(p==='/admin/users/edit'&&body.avatar_url?.startsWith('pulse-media:'))
        await send('/admin/users/'+wire('user',id)+'/avatar','PUT',{media_id:body.avatar_url.slice(12)});
      rawUsers.delete(id);return {user_id:id,status:body.status||'updated'};
    }
    case '/admin/users/logout':case '/admin/users/reset-token':{
      await send('/admin/users/'+wire('user',body.user_id)+'/logout','POST',{});
      return {revoked_tokens:1};
    }
    case '/admin/users/clear-chat':{
      return send('/admin/users/'+wire('user',body.user_id)+'/clear-history','POST',{});
    }
    case '/admin/users/devices': {
      const result=await get('/admin/users/'+wire('user',q.get('user_id'))+'/devices');
      return result.hidden?result:{hidden:false,items:{sessions:(result.items||[]).map(item=>({...item,device_type:item.platform}))}};
    }
    case '/admin/users/ip-locations': {
      const ips=q.getAll('ips[]');if(!ips.length)return {items:[]};
      const result=await get('/admin/ip-locations?'+new URLSearchParams(ips.map(ip=>['ip',ip])));
      const byIP=new Map((result.items||[]).map(row=>[row.ip,row]));
      return {items:ips.map(ip=>{
        const row=byIP.get(ip);
        return {ip,location:row?[row.country,row.province,row.city].filter(Boolean).join(' '):'暂未查到归属地',
          status:row?.status==='resolved'?'ready':'unavailable',error_code:row?.status==='failed'?'lookup_failed':''};
      })};
    }
    case '/admin/groups':return pagination(await get('/admin/groups'+query()+'&name='+encodeURIComponent(q.get('name')||'')+'&group_id='+encodeURIComponent(q.get('group_id')||'')+'&owner='+encodeURIComponent(q.get('owner')||'')),group);
    case '/admin/groups/detail': {
      const id=Number(q.get('id'));let found=rawGroups.get(id);
      if(!found){for(let page=1;page<=100;page++){
        const list=await get('/admin/groups?page='+page+'&size=100');
        found=(list.items||[]).find(row=>local('conversation',row.id)===id);
        if(found||!list.has_more)break;
      }}
      if(!found)throw failure(404,'not_found');return group(found);
    }
    case '/admin/groups/create':case '/admin/groups/update':case '/admin/groups/delete': {
      if(p==='/admin/groups/delete'){
        const results=[];
        for(const id of body.ids||[]){const row=rawGroups.get(Number(id));if(!row)throw failure(404,'not_found');
          const payload={title:row.title,owner_id:row.owner_id,kind:row.management_type||row.kind,description:row.description||'',announcement:row.announcement||'',
            join_policy:row.join_policy,member_limit:row.member_limit,block_member_friend_requests:row.block_member_friend_requests,
            mute_all:row.mute_all,display_count_offset:row.display_count_offset||0,active:false,delete:true};
          results.push(await send('/admin/groups/'+wire('conversation',id),'PUT',payload));
        }
        return {count:results.length};
      }
      const id=p==='/admin/groups/update'?Number(body.group_id):0;
      const prior=id?rawGroups.get(id):null;
      const offset=Object.hasOwn(body,'display_member_count')?(body.display_member_count==null?0:Math.max(0,Number(body.display_member_count)-Number(prior?.member_count||1))):Number(prior?.display_count_offset||0);
      const payload={title:body.name,owner_id:wire('user',body.owner_id),kind:body.type,description:body.description||'',
        announcement:body.announcement||'',join_policy:body.join_method==='free'?'open':body.join_method==='approval'?'closed':'invite',
        member_limit:Number(body.max_members||500),block_member_friend_requests:body.allow_member_add_friend===false,
        mute_all:!!body.all_muted,display_count_offset:offset,active:body.status==='active',delete:false};
      const created=await send('/admin/groups'+(id?'/'+wire('conversation',id):''),id?'PUT':'POST',payload);
      return {id:local('conversation',created.id),group_id:local('conversation',created.id)};
    }
    case '/admin/messages':{
      const type=q.get('type')||'';
      const params=new URLSearchParams({page:q.get('page')||'1',size:q.get('size')||'30',q:q.get('q')||'',kind:type==='voice'?'audio':type==='contact_card'?'contact':type,conversation_type:q.get('conversation_type')||''});
      const sender=q.get('sender')||'',receiver=q.get('receiver')||'';
      if(sender){const found=await get('/admin/users?page=1&size=100&q='+encodeURIComponent(sender));
        const actor=exactActor(found.items||[],sender);
        if(actor)params.set('sender_id',actor.id);else return {items:[],total:0,page:Number(params.get('page')),size:Number(params.get('size'))};}
      if(receiver){const found=await get('/admin/users?page=1&size=100&q='+encodeURIComponent(receiver));
        const actor=exactActor(found.items||[],receiver);
        if(actor)params.set('peer_id',actor.id);else return {items:[],total:0,page:Number(params.get('page')),size:Number(params.get('size'))};}
      const result=await get('/admin/messages?'+params);
      return pagination(result,row=>{
        const item=message(row),media=row.content?.media;
        if(media){item.body.url='pulse-media:'+media.id;item.body.image_url=item.body.url;item.body.name=media.filename||'';item.body._go_media_id=media.id;}
        return item;
      });
    }
    case '/admin/messages/recall':await send('/admin/messages/'+wire('message',body.message_id),'DELETE');return {status:'recalled'};
    case '/admin/accounts/permissions':return {items:[
      ['dashboard','运营总览',false],['devices','设备管理',true],['users','用户管理',true],
      ['groups','群组管理',true],['messages','消息与会话',true],['moderation','内容审核',true],
      ['sensitive-words','敏感词管理',true],['login-logs','系统日志',false],['announcement','通知公告',true],
      ['task-config','任务配置',true],['question-bank','题库管理',true],['task-records','作业记录',true],
      ['client-config','客户端配置',true],['routes','线路管理',true],['dispatch-tasks','分发任务',true],
      ['maintenance','数据清理',true]].map(([key,title,manage])=>({key,title,view:key+'.view',manage:manage?key+'.manage':null}))};
    case '/admin/accounts/update':case '/admin/accounts/status':case '/admin/accounts': {
      if(method==='GET'){const result=await get('/admin/accounts'+query()+'&status='+encodeURIComponent(q.get('status')||''));return pagination(result,row=>{rawAccounts.set(local('admin',row.id),row);return admin(row);});}
      const id=p==='/admin/accounts/status'?body.id:body.id||0;
      let current;
      if(id)current=rawAccounts.get(Number(id))||await findRow('/admin/accounts',row=>row.id===wire('admin',id));
      const payload={account:body.username||current?.account,password:body.password||'',
        role:(body.role||current?.role)==='admin'?'superadmin':body.role||current?.role,
        permissions:goPermissions(body.permissions||permissions(current?.permissions||[])),
        active:p==='/admin/accounts/status'?body.status==='active':body.status!=='disabled',
        expected_version:body.version??current?.version??'0'};
      const result=await send('/admin/accounts'+(id?'/'+wire('admin',id):''),id?'PUT':'POST',payload);
      return {id:local('admin',result.id),entry_token:result.entry_token||''};
    }
    case '/admin/mobile-devices':{
      const [devices,policy]=await Promise.all([get('/admin/devices'+query()),setting('mobile_binding')]);
      return {...pagination(devices,row=>({...row,id:local('mobile_binding',row.user_id),user_id:local('user',row.user_id),
        public_id:row.user_id,username:row.account,device_id:row.device_digest})),
        enabled:policy.value.enabled===true,locked_total:(devices.items||[]).length};
    }
    case '/admin/mobile-devices/unbind':case '/admin/mobile-devices/unbind-all':{
      await send('/admin/devices/unbind','POST',p.endsWith('unbind-all')?{all:true,confirmation:'UNBIND_ALL'}:{user_id:wire('user',body.user_id),all:false});
      return {unbound_count:p.endsWith('unbind-all')?1:1};
    }
    case '/admin/mobile-devices/policy':{
      const result=await saveSetting('mobile_binding',{enabled:!!body.enabled});return {enabled:!!body.enabled,version:result.version};
    }
    case '/admin/maintenance/config':{
      if(method==='GET'){
        const [current,status]=await Promise.all([setting('maintenance'),get('/admin/maintenance/status')]),value=current.value;
        return {...value,inactive_days:Number(value.inactive_days||180),cache_days:Number(value.retention_days||90),clean_accounts:value.clean_accounts!==false,clean_cache:value.clean_cache!==false,
          interval_days:Number(value.interval_days||1),run_time:String(value.hour??3).padStart(2,'0')+':'+String(value.minute??0).padStart(2,'0'),
          version:current.version,...status};
      }
      const time=String(body.run_time||'03:00').split(':');
      const saved=await saveSetting('maintenance',{enabled:!!body.enabled,retention_days:Number(body.cache_days||90),
        inactive_days:Number(body.inactive_days||180),interval_days:Number(body.interval_days||1),clean_accounts:!!body.clean_accounts,clean_cache:!!body.clean_cache,
        hour:Number(time[0]),minute:Number(time[1])});
      return {...body,version:saved.version,...await get('/admin/maintenance/status')};
    }
    case '/admin/maintenance/preview':{
      const days=Number(q.get('days')||180),page=Number(q.get('page')||1);
      const items=[];let after='';
      for(let index=0;index<100;index++){
        const next=await get('/admin/maintenance/idle?'+new URLSearchParams({days:String(days),after}));
        items.push(...(next.items||[]));
        if(!next.has_more)break;
        if(!next.items?.length||!next.next_after||next.next_after===after)throw failure(502,'invalid_cursor');
        after=next.next_after;
      }
      const active=items;
      const slice=active.slice((page-1)*20,page*20);
      return {items:slice.map(item=>({...item,id:local('user',item.id),username:item.account,
        offline_days:Math.max(0,Math.floor((Date.now()-Date.parse(item.last_active_at))/86400000))})),
        total:active.length,page,size:20,inactive_days:days};
    }
    case '/admin/maintenance/cache-preview':{
      const result=await get('/admin/maintenance/cache-preview?days='+encodeURIComponent(q.get('days')||90));
      const rows=result.database_rows||{};
      return {...result,database_rows:{auth_tokens:rows.login_sessions||0,admin_sessions:rows.admin_sessions||0,
        registration_captchas:0,registration_captcha_rates:0,login_events:rows.login_events||0,login_audit:rows.login_audit||0,
        client_diagnostics:rows.client_diagnostics||0,notifications:rows.notifications||0,admin_ops_nonces:rows.admin_ops_nonces||0,
        incomplete_uploads:rows.incomplete_uploads||0}};
    }
    case '/admin/maintenance/runs':{
      const result=await get('/admin/maintenance/runs?'+new URLSearchParams({page:q.get('page')||'1',size:'20'}));
      return pagination(result,row=>({...row,id:local('maintenance',row.id),trigger_type:row.kind==='scheduled'?'scheduled':'manual',
        status:row.status==='pending'?'queued':row.status,deleted_count:Number(row.result?.account_count||0),skipped_count:Number(row.result?.skipped_count||0),cleanup_items:Number(row.result?.cleanup_items||0)}));
    }
    case '/admin/maintenance/run':{
      if(method==='GET'){
        const runs=await allRows('/admin/maintenance/runs'),found=runs.find(row=>local('maintenance',row.id)===Number(q.get('id')));
        if(!found)throw failure(404,'not_found');
        const result=found.result||{},users=(result.users||[]).map(item=>({...item,user_id:local('user',item.user_id)}));
        return {...found,...result,id:Number(q.get('id')),status:found.status==='pending'?'queued':found.status,users,deleted_count:Number(result.account_count||0),skipped_count:Number(result.skipped_count||0)};
      }
      let users=[];
      if(body.clean_accounts&&body.user_ids?.length){
        const all=[];let after='';
        for(let page=0;page<100;page++){
          const next=await get('/admin/maintenance/idle?'+new URLSearchParams({days:String(body.inactive_days||180),after}));
          all.push(...(next.items||[]));if(!next.has_more)break;
          if(!next.items?.length||!next.next_after||next.next_after===after)throw failure(502,'invalid_cursor');after=next.next_after;
        }
        const chosen=all.filter(row=>body.user_ids.includes(local('user',row.id)));
        users=chosen.map(row=>({id:row.id,version:String(row.version)}));
      }
      const cleanAccounts=!!body.clean_accounts&&users.length>0,cleanCache=!!body.clean_cache;
      if(!cleanAccounts&&!cleanCache)return {id:0,status:'completed',deleted_count:0,skipped_count:0};
      const job=await send('/admin/maintenance/runs','POST',{retention_days:Number(body.cache_days||90),inactive_days:Number(body.inactive_days||180),clean_accounts:cleanAccounts,clean_cache:cleanCache,users});
      return {...job,id:job.id?local('maintenance',job.id):0,deleted_count:Number(job.deleted_count||0),skipped_count:Number(job.skipped_count||0)};
    }
    case '/admin/login-logs':return pagination(await get('/admin/login-events'+query()));
    case '/admin/audit-logs':return pagination(await get('/admin/audit'+query()+'&action='+encodeURIComponent(q.get('action')||'')+'&target_type='+encodeURIComponent(q.get('target_type')||'')));
    case '/admin/sensitive-words':case '/admin/sensitive-words/edit': {
      if(method==='GET'){
        const result=await get('/admin/sensitive-words'+query());
        const searched=(result.items||[]).filter(row=>!q.get('q')||row.word.includes(q.get('q')));
        return pagination({...result,items:searched},row=>{rawWords.set(local('word',row.id),row);return {...row,id:local('word',row.id)};});
      }
      const id=body.id?wire('word',body.id):'';
      const prior=id?(rawWords.get(Number(body.id))||await findRow('/admin/sensitive-words',row=>row.id===id)):null;
      const payload={word:body.word,replacement:body.replacement,enabled:true,expected_version:body.version??prior?.version??'0'};
      const result=await send('/admin/sensitive-words'+(id?'/'+id:''),id?'PUT':'POST',payload);
      return {id:local('word',result.id)};
    }
    case '/admin/sensitive-words/delete':case '/admin/sensitive-words/batch-delete': {
      const ids=(body.ids||[body.id]).map(id=>wire('word',id));
      await send('/admin/sensitive-words/delete','POST',{ids});return {count:ids.length};
    }
    case '/admin/work-tasks':case '/admin/work-tasks/status':case '/admin/work-tasks/delete':{
      if(method==='GET'){
        const result=await get('/admin/tasks?'+new URLSearchParams({page:q.get('page')||'1',size:q.get('size')||'20',q:q.get('q')||'',key:q.get('key')||'',name:q.get('name')||'',status:q.get('status')||''}));
        return pagination(result,row=>{rawTasks.set(local('task',row.id),row);return {...row,id:local('task',row.id),status:row.enabled?'enabled':'disabled'};});
      }
      if(p.endsWith('/delete')){
        for(const id of body.ids||[]){
          const target='/admin/tasks/'+wire('task',id);
          try{await send(target,'DELETE');}
          catch(error){
            if(error.code!=='task_has_records')throw error;
            const current=rawTasks.get(Number(id))||await findRow('/admin/tasks',row=>row.id===wire('task',id));
            await send(target,'PUT',{task_key:current.task_key,name:current.name,description:current.description||'',open_time:current.open_time,
              estimated_minutes:Number(current.estimated_minutes),question_count:Number(current.question_count),intern_unit_price:current.intern_unit_price,
              formal_unit_price:current.formal_unit_price,enabled:false,sort_order:Number(current.sort_order||0),expected_version:current.version});
          }
        }
        return {count:(body.ids||[]).length};
      }
      const id=Number(body.id||0),current=id?(rawTasks.get(id)||await findRow('/admin/tasks',row=>row.id===wire('task',id))):null;
      if(id&&!current)throw failure(404,'not_found');
      const source=p.endsWith('/status')?current:body;
      const payload={
        task_key:source.task_key,name:source.name,description:source.description||'',open_time:source.open_time,
        estimated_minutes:Number(source.estimated_minutes),question_count:Number(source.question_count),
        intern_unit_price:source.intern_unit_price,formal_unit_price:source.formal_unit_price,
        enabled:body.status==='enabled',sort_order:Number(source.sort_order||0)};
      payload.expected_version=body.version??current?.version??'0';
      const result=await send('/admin/tasks'+(id?'/'+wire('task',id):''),id?'PUT':'POST',payload);
      return {id:local('task',result.id)};
    }
    case '/admin/work-tasks/code':{
      const id=wire('task',q.get('task_id')),date=q.get('date')||'';
      const result=await send('/admin/tasks/'+id+'/code?date='+encodeURIComponent(date),q.get('regenerate')==='1'?'POST':'GET',q.get('regenerate')==='1'?{}:undefined);
      const current=rawTasks.get(Number(q.get('task_id')))||await findRow('/admin/tasks',row=>row.id===id);
      return {...result,task_name:current?.name||'',regenerated:q.get('regenerate')==='1'};
    }
    case '/admin/work-questions':case '/admin/work-questions/delete':{
      if(method==='GET'){
        const answer=q.get('answer');
        const result=await get('/admin/questions?'+new URLSearchParams({page:q.get('page')||'1',size:q.get('size')||'20',q:q.get('uuid')||'',correct:answer==='1'?'true':answer==='0'?'false':''}));
        return pagination(result,row=>{rawQuestions.set(local('question',row.id),row);return {...row,id:local('question',row.id),question_uuid:row.code,
          correct_answer:row.correct,image_url:row.media_id?'pulse-media:'+row.media_id:row.image_url};});
      }
      if(p.endsWith('/delete')){
        await send('/admin/questions/delete','POST',{ids:(body.ids||[]).map(id=>wire('question',id))});
        return {count:(body.ids||[]).length};
      }
      const id=body.id?wire('question',body.id):'';
      const prior=id?rawQuestions.get(Number(body.id)):null;
      if(id&&!prior)throw failure(409,'reload_required');
      const image=body.image_url||'';
      const media=image.startsWith('pulse-media:')?image.slice(12):'';
      const payload={code:body.question_uuid||prior?.code||'',media_id:media,image_url:media?'':image,
        correct:body.correct_answer==='1'||body.correct_answer===1||body.correct_answer===true,version:prior?.version||'0'};
      const result=await send('/admin/questions'+(id?'/'+id:''),id?'PUT':'POST',payload);
      return {id:local('question',result.id)};
    }
    case '/admin/work-records':{
      const params=new URLSearchParams(q);
      for(const key of ['user_id','task_id'])if(params.get(key)){try{params.set(key,wire(key==='user_id'?'user':'task',params.get(key)));}catch{}}
      const result=await get('/admin/task-records?'+params);
      return pagination(result,row=>({...row,id:local('record',row.id),user_id:local('user',row.user_id),
        task_id:local('task',row.task_id),total_questions:row.total,wrong_count:Number(row.total)-Number(row.correct_count),start_at:row.started_at}));
    }
    case '/admin/work-records/task-options':{
      const result=await get('/admin/task-codes');
      return {items:(result.items||[]).map(row=>({id:local('task',row.task_id),name:row.task_name}))};
    }
    case '/admin/work-records/detail':{
      const result=await get('/admin/task-records/'+wire('record',q.get('id')));
      const record={...result,id:local('record',result.id),user_id:local('user',result.user_id),
        task_id:local('task',result.task_id),total_questions:result.total,wrong_count:Number(result.total)-Number(result.correct_count)};
      record.avatar_url=avatarURL(result.avatar_id);record.start_at=result.started_at;
      const questions=(result.questions||[]).map(row=>({...row,question_uuid:row.id,question_code:row.code,
        image_url:row.media_id?'pulse-media:'+row.media_id:row.image_url,
        answer:result.answers?.[row.id],correct_answer:row.correct,reviewed_correct:result.results?.[row.id]}));
      return {record,questions};
    }
    case '/admin/work-records/review':{
      await send('/admin/task-records/'+wire('record',body.record_id)+'/review','POST',
        {request_id:body.request_id,results:body.results,note:body.note||''});
      return {status:'reviewed'};
    }
    case '/admin/dispatch-tasks':{
      const result=method==='GET'?await get('/admin/dispatch-plans'+query()+'&status='+encodeURIComponent(q.get('status')||'')+'&trigger_type='+encodeURIComponent(q.get('trigger_type')||'')):null;
      if(method==='GET')return pagination(result,row=>{
        const id=local('dispatch',row.id);rawDispatch.set(id,row);
        const payload=row.payload||{};
        return {...row,id,sender_id:legacyID('user',payload.sender_id),
          sender:{id:legacyID('user',payload.sender_id)},
          recipient_type:payload.recipient_user_ids?.length?'user':'group',recipient_ids:(payload.recipient_user_ids||payload.conversation_ids||[]).map(value=>legacyID(payload.recipient_user_ids?.length?'user':'conversation',value)),
          recipients:(payload.recipient_user_ids||payload.conversation_ids||[]).map(value=>({id:legacyID(payload.recipient_user_ids?.length?'user':'conversation',value)})),
          trigger_type:row.cron?'cron':'once',cron_expression:row.cron,execute_at:row.run_at,
          steps:(payload.steps||[]).map((step,index)=>({type:step.kind==='image'&&step.body?'text_image':step.kind||'text',
            text:step.body||'',image_url:step.media_id?'pulse-media:'+step.media_id:'',delay_seconds:payload.delays_seconds?.[index]||0})),
          step_count:payload.steps?.length||0,status:row.ui_status||(row.enabled?'pending':'paused')};
      });
      if(!['group','user'].includes(body.recipient_type))throw failure(400,'invalid_request');
      const id=body.id?wire('dispatch',body.id):'';
      const prior=id?rawDispatch.get(Number(body.id)):null;
      if(id&&!prior)throw failure(404,'not_found');
      const steps=(body.steps||[]).map(step=>{
        const kind=step.type==='text'?'text':'image',media=String(step.image_url||'').replace(/^pulse-media:/,'');
        if(kind==='image'&&!uuid.test(media))throw failure(400,'invalid_media');
        return {kind,body:step.text||'',media_id:kind==='image'?media:''};
      });
      const payload={name:body.name||'分发任务',sender_id:wire('user',body.sender_id),
        ...(body.recipient_type==='user'?{recipient_user_ids:(body.recipient_ids||[]).map(id=>wire('user',id))}:{conversation_ids:(body.recipient_ids||[]).map(id=>wire('conversation',id))}),steps,
        delays_seconds:(body.steps||[]).map(step=>Number(step.delay_seconds||0)),
        cron:body.trigger_type==='cron'?String(body.cron_expression||'').trim():'',
        run_at:body.trigger_type==='once'?new Date(body.execute_at+'+08:00').toISOString():null,
        enabled:body.enabled!==false,expected_version:body.version??prior?.version??'0'};
      const saved=await send('/admin/dispatch-plans'+(id?'/'+id:''),id?'PUT':'POST',payload);
      return {id:local('dispatch',saved.id)};
    }
    case '/admin/dispatch-tasks/detail':{
      const id=Number(q.get('id'));let row=rawDispatch.get(id);
      if(!row)row=await findRow('/admin/dispatch-plans',item=>item.id===wire('dispatch',id));
      if(!row)throw failure(404,'not_found');
      const payload=row.payload||{};
      return {task:{...row,id,sender:{id:legacyID('user',payload.sender_id)},sender_id:legacyID('user',payload.sender_id),
        recipient_type:payload.recipient_user_ids?.length?'user':'group',recipients:(payload.recipient_user_ids||payload.conversation_ids||[]).map(value=>({id:legacyID(payload.recipient_user_ids?.length?'user':'conversation',value)})),
        trigger_type:row.cron?'cron':'once',cron_expression:row.cron,execute_at:row.run_at,
        steps:(payload.steps||[]).map((step,index)=>({type:step.kind==='image'&&step.body?'text_image':step.kind||'text',text:step.body||'',
          image_url:step.media_id?'pulse-media:'+step.media_id:'',delay_seconds:payload.delays_seconds?.[index]||0})),enabled:row.enabled}};
    }
    case '/admin/dispatch-tasks/options':{
      const kind=q.get('kind'),search=q.get('q')||'',scope=q.get('scope')||'dispatch';
      const result=await get('/admin/select-options?'+new URLSearchParams({scope,kind,q:search,page:'1',size:'100'}));
      return {items:(result.items||[]).map(row=>({...row,id:local(kind==='group'?'conversation':'user',row.id)}))};
    }
    case '/admin/dispatch-tasks/upload':{
      const uploaded=await upload(path,options.body,options.signal,scope);
      return {url:uploaded.url,id:uploaded.id};
    }
    case '/admin/dispatch-tasks/status':{
      const row=rawDispatch.get(Number(body.id));if(!row)throw failure(404,'not_found');
      if(body.status==='paused'){await send('/admin/dispatch-plans/'+wire('dispatch',body.id)+'/disable','POST',{});return {status:'paused'};}
      const payload={...(row.payload||{}),enabled:true,expected_version:row.version};
      if(payload.recipient_user_ids?.length)delete payload.conversation_ids;
      await send('/admin/dispatch-plans/'+wire('dispatch',body.id),'PUT',payload);return {status:'pending'};
    }
    case '/admin/dispatch-tasks/delete':{
      await send('/admin/dispatch-plans/'+wire('dispatch',body.id)+'/delete','POST',{});return {status:'deleted'};
    }
    default: throw failure(501,'admin_route_unmapped');
    }
  }
  async function request(path,options = {}) {
    const authentication=['/admin/auth/login','/admin/auth/logout'].includes(new URL(path,'https://admin.invalid').pathname);
    if(authentication)reset();
    const scope=captureSession();
    const result=await adapt(path,options,scope);
    if(!authentication)requireSession(scope);
    return result;
  }
  async function fetchOld(path, options = {}) {
    try {
      const value=await request(path,options);
      return new Response(JSON.stringify({ok:true,data:value}),{status:200,headers:{'Content-Type':'application/json'}});
    } catch (error) {
      if(error?.name==='AbortError')throw error;
      return new Response(JSON.stringify({ok:false,error:{code:error.code || 'request_failed',message:error.message || '请求失败'}}),
        {status:error.status || 503,headers:{'Content-Type':'application/json'}});
    }
  }
  window.PulseGoAdmin = Object.freeze({fetch:fetchOld,request,upload,download,reset,entryKey,csrfKey,local,wire,mediaURL,mediaBlob});
})();
