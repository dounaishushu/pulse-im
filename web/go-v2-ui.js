/* Bind the retained pages to the same server-authoritative Go contract. */
(() => {
  'use strict';
  if (!GO) return;
  let refreshTimer=null, realtime=null, socketEpoch=0, refreshRunning=false, refreshAgain=false, historyAgain=false;
  let fullDirectory=false,refreshFailures=0,lastCatchUp=0;
  let directoryTimer=null,directoryRunning=false,directoryFailures=0;
  let directoryProbeRunning=false,lastFullDirectory=Date.now(),disposed=false;
  const directoryHints=new Set();
  const originalOpen=openConversation;
  const active=()=>Boolean(state.token&&state.user&&state.active&&!state.favoriteMode&&!readPasscodeSettings().locked);
  const visible=()=>active()&&!document.hidden&&state.desktopAccountVisible!==false;
  const membershipChecks=new Map();
  async function revalidateMembership(id){
    if(!active()||Number(state.active.id)!==Number(id)){schedule(false,false,id);return;}
    const token=state.token,key=token+':'+id,previous=membershipChecks.get(key);
    if(previous){previous.again=true;return;}
    const task={again:false};membershipChecks.set(key,task);
    const current=()=>state.token===token&&active()&&Number(state.active.id)===Number(id);
    try{
      // Preferences and group-wide mute use the same hint as membership changes.
      // A fresh metadata read validates access and updates sending permissions.
      // GO invalidates the old history itself if the membership version changed.
      const info=await api('/conversations/info?conversation_id='+id,{authToken:token,signal:AbortSignal.timeout(10000)});
      if(!current())return;
      Object.assign(state.active,info);
      const listed=state.conversations.find(row=>Number(row.id)===Number(id));if(listed)Object.assign(listed,info);
      updateDesktopChat();syncChatInfoNotification();schedule(false,false,id);
    }catch(error){
      if(current()&&[401,403,404,409].includes(error.status))invalidate(id,'access');
    }finally{
      if(membershipChecks.get(key)===task)membershipChecks.delete(key);
      if(task.again&&current())void revalidateMembership(id);
    }
  }
  function wipe(id){
    conversationViews.clear();
    if(Number(state.active?.id)!==Number(id))return;
    cancelConversationRecovery();state.messageVersions=new Map();syncPulseMessageCache().clear();
    state.goEventCursor=null;state.initialHistoryFailed=true;
    if($('messages'))$('messages').innerHTML='<p class="empty">正在校验会话权限…</p>';
  }
  function invalidate(id,reason){
    wipe(id);
    schedule(active()&&Number(state.active.id)===Number(id),Number(state.active?.id)===Number(id),id);
  }
  async function refreshDirectory(ids,token,startedConversation,startedEpoch){
    if(ids&&ids.length&&typeof conversationRefresh!=='undefined'){
      conversationRefresh.hint(ids);await conversationRefresh.flush();return;
    }
    const complete=await loadConversations();
    if(state.token!==token||Number(state.active?.id)!==startedConversation||state.historyEpoch!==startedEpoch)return;
    if(complete===true&&active()&&!state.conversations.some(c=>Number(c.id)===Number(state.active.id))){wipe(state.active.id);state.active=null;if($('messages'))$('messages').innerHTML='<p class="empty">已退出或无权访问该会话</p>';updateDesktopChat();}
  }
  function unauthorized(token){
    if(state.token!==token)return;
    state.socket?.close();localStorage.removeItem(GO.tokenKey);state.token='';state.user=null;GO.session('');renderLogin();
  }
  function armDirectory(delay=80){
    if(disposed||directoryTimer!==null||directoryRunning||!state.token||!state.user||!fullDirectory&&!directoryHints.size)return;
    directoryTimer=setTimeout(()=>{directoryTimer=null;void drainDirectory();},delay);
  }
  async function drainDirectory(){
    if(disposed||directoryRunning||!state.token||!state.user)return;
    directoryRunning=true;
    const changed=fullDirectory?null:[...directoryHints];fullDirectory=false;directoryHints.clear();
    const token=state.token,cid=Number(state.active?.id),epoch=state.historyEpoch;
    let retryDelay=80;
    try{await refreshDirectory(changed,token,cid,epoch);if(state.token===token){directoryFailures=0;if(!changed?.length)lastFullDirectory=Date.now();}}
    catch(error){
      if(state.token===token){
        if(error.status===401)unauthorized(token);
        else if(![403,404].includes(error.status)){
          if(changed?.length)for(const id of changed)directoryHints.add(id);else fullDirectory=true;
          retryDelay=Math.min(15000,1000*2**Math.min(4,directoryFailures++));
        }
      }
    }finally{directoryRunning=false;armDirectory(retryDelay);}
  }
  function schedule(authorize=false,history=true,id=0){
    if(state.initialHistory&&(history||authorize))state.initialHistory.goHistoryDirty=true;
    if(authorize&&active())wipe(state.active.id);
    refreshAgain=true;
    historyAgain=historyAgain||history||authorize;
    if(Number.isSafeInteger(id)&&id>0)directoryHints.add(id);else fullDirectory=true;
    if(directoryHints.size>100){fullDirectory=true;directoryHints.clear();}
    // Directory I/O has its own coalesced queue; it must not hold up chat delivery.
    armDirectory();armRefresh();
  }
  function armRefresh(delay=80){
    // 连续消息只合并刷新，不能不断延后已安排的任务，否则权限校验界面会一直等待。
    if(disposed||refreshTimer!==null||refreshRunning)return;
    refreshTimer=setTimeout(()=>{refreshTimer=null;void refresh().catch(e=>console.warn(e.message));},delay);
  }
  async function refresh(){
    if(disposed||refreshRunning||!state.token||!state.user)return;
    refreshRunning=true;refreshAgain=false;
    const refreshHistory=historyAgain;historyAgain=false;
    const token=state.token,startedConversation=Number(state.active?.id),startedEpoch=state.historyEpoch;
    let retryDelay=80;
    try{
      if(!visible())return;
      if(state.initialHistory)return;
      if(state.initialHistoryFailed||state.historyReadyEpoch!==state.historyEpoch){await openConversation(Number(state.active.id),{focusInput:false});return;}
      if(!refreshHistory)return;
      const cid=Number(state.active.id),epoch=state.historyEpoch,container=$('messages');if(!container)return;
      const ids=[...container.querySelectorAll('[data-message-id]')].map(n=>Number(n.dataset.messageId));
      const floor=ids.length?Math.min(...ids):Math.max(1,Number(state.active.message_seq)-49);
      const current=()=>state.token===token&&Number(state.active?.id)===cid&&state.historyEpoch===epoch&&visible();
      let nextCursor=null;
      const previous=state.goEventCursor;
      if(typeof GO.delta==='function'&&previous?.token===token&&previous.cid===cid&&previous.epoch===epoch){
        const apply=batch=>{
          if(!current()||batch.needs_snapshot)return;
          const cleared=Math.max(Number(state.active.cleared_before_message_id)||0,batch.cleared_before_message_id);
          const live=visibleConversationMessages(),merged=new Map(live.filter(row=>Number(row.id)>cleared).map(row=>[Number(row.id),row]));
          let dirty=cleared>Number(state.active.cleared_before_message_id||0);
          for(const item of batch.items){
            if(Number(item.id)<floor||Number(item.id)<=cleared)continue;
            const old=merged.get(Number(item.id));
            if(old&&Number(old.body?._go_version)>Number(item.body?._go_version))continue;
            if(old&&JSON.stringify(old)===JSON.stringify(item))continue;
            merged.set(Number(item.id),item);dirty=true;
          }
          if(!dirty)return;
          const position=recoveryScrollAnchor(container),newest=live.reduce((last,row)=>Math.max(last,Number(row.id)),0);
          if(!state.historyLocation&&batch.items.some(row=>Number(row.id)>newest)&&(globalThis.PulseMessageScroll?.shouldFollowIncoming?.()??true))position.bottom=true;
          state.active.cleared_before_message_id=cleared;
          renderConversationMessages(initialSnapshotMessages([...merged.values()].sort((a,b)=>Number(a.id)-Number(b.id))));
          bindMessageActions();renderOlderHistoryControl();restoreRecoveryScroll(container,position);
        };
        const batch=await GO.delta(cid,previous,{signal:AbortSignal.timeout(15000),current,onPreview:apply});if(!current())return;
        nextCursor={...batch.cursor,token,cid,epoch};
        if(!batch.needs_snapshot){apply(batch);state.goEventCursor=nextCursor;refreshFailures=0;scheduleRead();return;}
      }
      const messages=[];let after=0,snapshot=null,membership=null,cleared=0;
      for(let i=0;i<10000&&current();i++){
        const q=new URLSearchParams({conversation_id:cid,floor_id:floor,after_id:after,limit:100});
        if(snapshot!==null){q.set('snapshot_max_id',snapshot);q.set('membership_version',membership);}
        const page=await api('/messages/sync?'+q,{authToken:token});if(!current())return;
        if(snapshot!==null&&page.snapshot_max_id!==snapshot)throw GO.fail('invalid_response');
        snapshot=page.snapshot_max_id;membership=page.membership_version;GO.requireVersion(cid,membership);
        cleared=Math.max(cleared,page.cleared_before_message_id);messages.push(...page.items);
        if(!page.has_more){
          GO.requireVersion(cid,membership);state.active.cleared_before_message_id=cleared;
          // Read the position after the request: a send or reader gesture may
          // have moved it while synchronization was in flight.
          const position=recoveryScrollAnchor(container),live=visibleConversationMessages();
          const newest=live.reduce((last,message)=>Math.max(last,Number(message.id)),0);
          messages.push(...live.filter(message=>Number(message.id)>snapshot));
          if(!state.historyLocation&&messages.some(message=>Number(message.id)>newest)&&(globalThis.PulseMessageScroll?.shouldFollowIncoming?.()??true))position.bottom=true;
          // This complete authorized window replaces cache entries including personal deletions.
          state.messageVersions=new Map();syncPulseMessageCache().clear();
          renderConversationMessages(initialSnapshotMessages(messages));bindMessageActions();renderOlderHistoryControl();restoreRecoveryScroll(container,position);
          if(nextCursor)state.goEventCursor=nextCursor;refreshFailures=0;scheduleRead();return;
        }
        if(page.next_after_id<=after)throw GO.fail('invalid_response');after=page.next_after_id;
      }
    }catch(error){
      if(state.token!==token)return;
      if(error.status!==401&&(Number(state.active?.id)!==startedConversation||state.historyEpoch!==startedEpoch))return;
      if([401,403,404,409].includes(error.status)&&state.active){wipe(state.active.id);if([403,404].includes(error.status)){state.active=null;if($('messages'))$('messages').innerHTML='<p class="empty">当前会话不可访问</p>';updateDesktopChat();}}
      if(error.status===401)unauthorized(token);
      else if(error.code==='membership_changed')schedule(true);
      else if(![401,403,404,409].includes(error.status)){
        // 读取失败保留待同步范围，按退避重试，不能等待下一条消息或用户点击才恢复。
        refreshAgain=true;historyAgain=historyAgain||refreshHistory;
        retryDelay=Math.min(15000,1000*2**Math.min(4,refreshFailures++));
      }
    }finally{refreshRunning=false;if(refreshAgain&&state.token)armRefresh(retryDelay);}
  }
  openConversation=async function(id,options={}){
    await originalOpen(id,options);
    if(active()&&Number(state.active.id)===Number(id)&&state.initialHistoryFailed===false)scheduleRead();
  };
  const originalInitial=fetchInitialHistory;
  fetchInitialHistory=async function(context){
    let seed=null;
    try{const info=state.active,events=Number(info?.event_seq),personal=Number(info?.state?.personal_seq??0),membership=Number(info?.membership_version);if(Number.isSafeInteger(events)&&events>=0&&Number.isSafeInteger(personal)&&personal>=0&&Number.isSafeInteger(membership)&&membership>0)seed={events,personal,membership};}catch{}
    try{
      const page=await originalInitial(context);if(!page)return page;
      GO.requireVersion(context.conversationId,page.membership_version);
      if(state.token===context.token&&Number(state.active?.id)===context.conversationId&&state.historyEpoch===context.epoch){state.active.cleared_before_message_id=page.cleared_before_message_id;state.active.membership_version=page.membership_version;state.goInitialHistory=context;if(seed&&seed.membership===Number(page.membership_version))state.goEventCursor={...seed,token:context.token,cid:context.conversationId,epoch:context.epoch};}
      return page;
    }catch(error){if([401,403,404].includes(error.status)&&state.token===context.token&&Number(state.active?.id)===context.conversationId&&state.historyEpoch===context.epoch){wipe(context.conversationId);if($('messages'))$('messages').innerHTML='<p class="empty">当前会话不可访问</p>';}throw error;}
  };
  recoverConversation=function(){
    const initial=state.goInitialHistory;state.goInitialHistory=null;
    // The fresh HTTP page is already a complete authorized snapshot. Repeat it
    // only if a live hint/connection gap arrived while it was being hydrated.
    if(initial&&initial.token===state.token&&initial.epoch===state.historyEpoch&&initial.conversationId===Number(state.active?.id)&&!initial.goHistoryDirty)return;
    schedule();
  };
  subscribeConversation=function(){if(!state.initialHistory&&state.historyReadyEpoch!==state.historyEpoch)schedule();};
  // Previously rendered pages are never restored before the current authorization read.
  rememberConversationView=function(){};
  const originalOlder=loadOlderMessages;
  loadOlderMessages=async function(){
    if(!active()||state.historyLoading)return;
    const cid=Number(state.active.id), token=state.token,epoch=state.historyEpoch;
    try{const info=await api('/conversations/info?conversation_id='+cid,{authToken:token});if(token!==state.token||epoch!==state.historyEpoch||Number(state.active?.id)!==cid)return;Object.assign(state.active,info);await originalOlder();}
    catch(error){if(token===state.token&&[401,403,404,409].includes(error.status))invalidate(cid,'access');}
  };
  function onPacket(packet){
    if(packet.type==='connection.error'&&packet.status===401){state.socket?.close();localStorage.removeItem(GO.tokenKey);state.token='';state.user=null;GO.session('');renderLogin();return;}
    if(packet.type==='ready'){state.socketLastReceivedAt=Date.now();if(state.socket)state.socket.readyState=1;schedule();return;}
    if(packet.type==='connection.lost'){if(state.socket)state.socket.readyState=0;if(visible())schedule(false,true,Number(state.active.id));return;}
    if(packet.type==='membership.changed'){
      void revalidateMembership(GO.local('conversation',packet.conversation_id));return;
    }
    if(packet.type==='personal.changed'){
      const id=GO.local('conversation',packet.conversation_id);
      // Personal hints include reminders and single-message deletions. Reconcile
      // their authorized snapshot in place; the hint cannot revoke every row.
      schedule(false,Number(state.active?.id)===Number(id),id);return;
    }
    if(packet.type==='receipts.changed'){if(typeof messageReceipts !== 'undefined')messageReceipts.refresh();return;}
    const id=packet.conversation_id?GO.local('conversation',packet.conversation_id):0;
    if(packet.type==='state.changed'){schedule(false,false,id);return;}
    // 其他会话的消息只更新相应摘要；当前窗口无需重复拉取和重画历史。
    if(packet.type.endsWith('.changed'))schedule(false,!id||Number(state.active?.id)===Number(id),id);
  }
  connectSocket=function(){
    if(state.socket||!state.token||!state.user||state.updateRequired)return;
    GO.session(state.token);const token=state.token,epoch=++socketEpoch;
    const holder={readyState:0,close(){if(state.socket===holder)state.socket=null;socketEpoch++;realtime?.close();realtime=null;},send(){}};
    state.socket=holder;
    void PulseGoRealtime.connect({api:GO,token,onPacket:p=>{if(epoch===socketEpoch&&state.token===token&&state.socket===holder)onPacket(p);}}).then(connection=>{
      if(epoch!==socketEpoch||state.token!==token||state.socket!==holder)connection.close();else realtime=connection;
    }).catch(error=>{if(state.socket===holder){holder.close();composerFeedback(error.message);}});
  };
  restartSocketConnection=function(){state.socket?.close();connectSocket();};
  resumeRealtime=function(){if(!state.token||!state.user||document.hidden)return;composerPermissions.check(true);if(!state.socket)connectSocket();if(active())void revalidateMembership(Number(state.active.id));schedule();};
  async function probeDirectory(){
    if(disposed||directoryProbeRunning||typeof GO.directoryChanges!=='function')return;
    directoryProbeRunning=true;const token=state.token;
    const current=()=>!disposed&&state.token===token&&!document.hidden&&state.desktopAccountVisible!==false&&!state.updateRequired&&!readPasscodeSettings().locked;
    try{
      const ids=await GO.directoryChanges(state.conversations,{signal:AbortSignal.timeout(15000),current});if(!current())return;
      if(ids.length>100)schedule(false,false);
      else for(const id of ids)schedule(false,false,id);
    }catch(error){if(state.token===token&&error.status===401)unauthorized(token);}
    finally{directoryProbeRunning=false;}
  }
  let networkCheck=null;
  function observeClientNetwork(){
    if(disposed||typeof GO.raw!=='function'||(typeof isDetachedConversation!=='undefined'&&isDetachedConversation))return;
    const token=state.token,user=state.user,now=Date.now();
    if(!token||!user||document.hidden||state.desktopAccountVisible===false||state.updateRequired||readPasscodeSettings().locked)return;
    if(networkCheck?.token===token&&networkCheck.user===user.id&&(networkCheck.running||now<networkCheck.next))return;
    const task={token,user:user.id,running:true,next:now+300000};networkCheck=task;
    const current=()=>!disposed&&networkCheck===task&&state.token===token&&state.user?.id===task.user&&!document.hidden&&state.desktopAccountVisible!==false&&!state.updateRequired&&!readPasscodeSettings().locked;
    void (async()=>{
      const probe=window.pulseDesktop?.checkNetworkExit;
      let exit=null;
      if(typeof probe==='function'){
        const capability=await GO.raw('/client/network-observation',{authToken:token,signal:AbortSignal.timeout(5000)});
        if(capability.ippure_url&&current())exit=await probe(capability.ippure_url).catch(()=>null);
      }
      if(!current())return;
      const client_version=typeof CLIENT_VERSION==='string'?CLIENT_VERSION:'';
      await GO.raw('/client/network-observation',{method:'POST',authToken:token,signal:AbortSignal.timeout(5000),body:{client_version,...(exit||{})}});
      task.next=Date.now()+1800000;
    })().catch(()=>{}).finally(()=>{task.running=false;});
  }
  const catchUpTimer=setInterval(()=>{
    if(!state.token||!state.user||document.hidden||state.desktopAccountVisible===false||state.updateRequired||readPasscodeSettings().locked)return;
    observeClientNetwork();
    if(Date.now()-lastCatchUp<15000)return;lastCatchUp=Date.now();
    // Keep the active event cursor moving even if realtime hints are lost.
    // Most idle ticks need only metadata clocks, not summaries/unread/media work.
    if(active()){if(state.initialHistory)state.initialHistory.goHistoryDirty=true;refreshAgain=true;historyAgain=true;armRefresh();}
    void probeDirectory();
    // Preferences, avatars and folders are not all represented by the clocks.
    // A low-frequency full read retains recovery for those missed hints too.
    if(Date.now()-lastFullDirectory>=300000){lastFullDirectory=Date.now();schedule(false,false);}
  },5000);
  window.addEventListener?.('pagehide',()=>{disposed=true;clearInterval(catchUpTimer);clearTimeout(refreshTimer);clearTimeout(directoryTimer);},{once:true});
  let readTimer=null,readFlight=null;
  function applyRead(){
    readTimer=null;if(disposed)return;const token=state.token;
    void markMessagesRead().catch(error=>{if(error.status===401)unauthorized(token);});
  }
  function scheduleRead(){if(readTimer===null&&!disposed)readTimer=setTimeout(applyRead,80);}
  markMessagesRead=async function(_messages,options={}){
    if(!visible()||!document.hasFocus()||state.historyReadyEpoch!==state.historyEpoch)return;
    const box=$('messages')?.getBoundingClientRect();if(!box)return;
    const seq=[...$('messages').querySelectorAll('[data-message-id]')].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>box.top&&r.top<box.bottom;}).reduce((n,e)=>Math.max(n,Number(e.dataset.messageId)||0),0);
    if(!seq)return;const cid=Number(state.active.id),token=state.token,key=token+':'+cid;
    if(typeof conversationReads !== 'undefined')return conversationReads.mark(cid,seq,{...options,force:options.force===true||state.active.state?.reminder===true});
    if(state.goRead?.key===key&&state.goRead.seq>=seq)return;
    if(readFlight?.key===key){readFlight.again=readFlight.again||seq>readFlight.seq;return;}
    const flight={key,seq,again:false};readFlight=flight;
    try{
      await api('/messages/receipt',{method:'POST',authToken:token,signal:AbortSignal.timeout(15000),body:JSON.stringify({conversation_id:cid,through_message_id:seq,status:'read'})});
      if(state.token===token&&Number(state.active?.id)===cid)state.goRead={key,seq};
    }finally{
      if(readFlight===flight){readFlight=null;if(flight.again&&state.token===token&&Number(state.active?.id)===cid)scheduleRead();}
    }
  };
  markReceipt=async function(){return markMessagesRead();};
  document.addEventListener('scroll',e=>{if(e.target.id==='messages'){clearTimeout(readTimer);readTimer=setTimeout(()=>{applyRead();if(typeof messageReceipts !== 'undefined')messageReceipts.refresh();},150);}},true);
  const originalClear=clearConversationHistory;
  clearConversationHistory=function(c){return originalClear({...c,message_seq:c.message_seq});};
  async function logout(){
    if(!state.token)return;
    try{await api('/auth/logout',{method:'POST'});state.socket?.close();localStorage.removeItem(GO.tokenKey);GO.session('');state.token='';state.user=null;location.reload();}
    catch(error){alert('退出未完成：'+error.message);}
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('#logout,#classic-account-logout,#passcode-lock-logout');
    if(button){event.preventDefault();event.stopImmediatePropagation();void logout();}
  },true);
  function dialog(title,content,submit){
    closeFeatureModal();const modal=document.createElement('div');modal.className='modal-backdrop feature-modal';modal.dataset.featureModal='';
    modal.innerHTML='<section class="feature-card classic-folder-dialog" role="dialog" aria-modal="true"><header><h2>'+escapeHtml(title)+'</h2><button type="button" data-close-modal aria-label="关闭">×</button></header><form class="classic-folder-form">'+content+'<p class="form-feedback" role="status"></p><footer><button type="button" data-close-modal>取消</button><button type="submit" class="primary">保存</button></footer></form></section>';
    document.body.append(modal);bindFeatureModal();const token=state.token;
    modal.querySelector('form').onsubmit=async e=>{e.preventDefault();const button=modal.querySelector('[type=submit]'),feedback=modal.querySelector('[role=status]');if(button.disabled||token!==state.token)return;button.disabled=true;try{await submit(modal);if(token===state.token&&modal.isConnected)closeFeatureModal();}catch(error){if(modal.isConnected)feedback.textContent=error.message;}finally{button.disabled=false;}};
    modal.querySelector('input,select,textarea')?.focus();return modal;
  }
  joinGroup=async function(){dialog('通过邀请码加入群聊','<label>邀请码<input name="code" maxlength="64" required autocomplete="off"></label>',async modal=>{const c=await api('/conversations/groups/join',{method:'POST',body:JSON.stringify({invite_code:modal.querySelector('input').value.trim()})});await loadConversations();await openConversation(c.id);});};
  copyGroupInviteCode=async function(){
    if(!active()||!state.active.can_manage)return;
    const id=state.active.id;if(!confirm('生成新邀请码后，旧邀请码立即失效，是否继续？'))return;
    try{const r=await api('/go/invite-code',{method:'POST',body:JSON.stringify({conversation_id:id})});dialog('新的群邀请码','<label>复制并分享<input readonly value="'+escapeHtml(r.invite_code)+'"></label>',async()=>{});}
    catch(error){alert(error.message);}
  };
  async function privacy(){
    try{
      const token=state.token,data=await api('/go/privacy');if(token!==state.token)return;
      const users=new Map((data.exception_users||[]).map(u=>[u.id,u.account]));
      const rule=(key,title,disabled=false)=>{const r=data[key];const list=k=>r[k].map(id=>users.get(id)||id).join('\n');return '<fieldset '+(disabled?'disabled':'')+'><legend>'+title+'</legend><label>允许范围<select name="'+key+'">'+[['everyone','所有人'],['contacts','联系人'],['nobody','无人']].map(([v,t])=>'<option value="'+v+'" '+(r.visibility===v?'selected':'')+'>'+t+'</option>').join('')+'</select></label><label>允许的账号（每行一个）<textarea name="'+key+'_allow">'+escapeHtml(list('allow'))+'</textarea></label><label>拒绝的账号（每行一个）<textarea name="'+key+'_deny">'+escapeHtml(list('deny'))+'</textarea></label></fieldset>';};
      dialog('临时聊天与群邀请隐私',rule('temporary_chat','临时聊天')+rule('group_invites','群邀请',!data.can_manage_group_invites)+'<p>拉黑优先。好友聊天不受临时聊天范围限制；群邀请权限由服务端校验。</p>',async modal=>{
        const patch={expected_version:data.version};
        for(const key of ['temporary_chat',...(data.can_manage_group_invites?['group_invites']:[])]){
          const rule={visibility:modal.querySelector('[name="'+key+'"]').value,allow:[],deny:[]};
          for(const list of ['allow','deny']){
            const accounts=modal.querySelector('[name="'+key+'_'+list+'"]').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(accounts.length>100)throw Error('每份例外名单最多 100 个账号');
            for(const account of accounts){const existing=(data.exception_users||[]).find(u=>u.account===account||u.id===account);if(existing)rule[list].push(existing.id);else{const found=await api('/contacts/search?q='+encodeURIComponent(account),{authToken:token});if(found.items.length!==1)throw Error('找不到账号：'+account);rule[list].push(GO.wire('user',found.items[0].id));}}
          }
          patch[key]=rule;
        }
        await api('/go/privacy',{authToken:token,method:'PATCH',body:JSON.stringify(patch)});
      });
    }catch(error){alert(error.message);}
  }
  const originalPrivacyBody=privacySettingsBodyHtml;
  privacySettingsBodyHtml=function(){return '<section class="classic-detail-section"><button type="button" class="classic-setting-button" data-go-privacy>临时聊天与群邀请隐私</button></section>'+originalPrivacyBody();};
  document.addEventListener('click',event=>{if(event.target.closest('[data-go-unavailable]')){event.preventDefault();event.stopImmediatePropagation();alert('当前服务暂未开放此设置');return;}if(event.target.closest('[data-go-privacy]')){event.preventDefault();event.stopImmediatePropagation();void privacy();}},true);
  function enhance(){
    const menu=document.querySelector('.session-menu nav');
    if(menu&&!menu.querySelector('[data-go-join]')){const b=document.createElement('button');b.type='button';b.dataset.goJoin='';b.textContent='通过邀请码加入群聊';b.onclick=()=>{closeSessionMenu();void joinGroup();};menu.append(b);}

    for(const add of document.querySelectorAll('[data-add-contact]')){
      if(add.parentElement?.querySelector('[data-go-chat]')||!Number(add.dataset.addContact)||Number(add.dataset.addContact)===Number(state.user?.id))continue;
      const button=document.createElement('button');button.type='button';button.dataset.goChat=add.dataset.addContact;button.textContent='临时聊天';button.onclick=()=>openContactChat(Number(button.dataset.goChat));add.after(button);
    }
    for(const modal of document.querySelectorAll('[data-group-invite],.group-modal')){
      if(modal.querySelector('[data-go-history]'))continue;
      const label=document.createElement('label');label.className='group-create-ban';label.innerHTML='<input type="checkbox" data-go-history><span>允许新成员查看入群前的历史消息</span>';
      (modal.querySelector('footer')||modal.querySelector('section')||modal).append(label);
    }
    for(const input of document.querySelectorAll('[data-group-member-mute]'))input.title='永久禁言';
    const groupTitle=document.querySelector('.group-title');
    if(groupTitle&&state.active?.can_manage&&!groupTitle.querySelector('[data-go-invite]')){const b=document.createElement('button');b.type='button';b.dataset.goInvite='';b.textContent='生成新邀请码';b.onclick=copyGroupInviteCode;groupTitle.append(b);}
    for(const button of document.querySelectorAll('[data-privacy-action]'))delete button.dataset.goUnavailable;
  }
  let enhancePending=false;
  new MutationObserver(()=>{if(enhancePending)return;enhancePending=true;queueMicrotask(()=>{enhancePending=false;enhance();});}).observe(document.body,{childList:true,subtree:true});
  window.PulseGoUI={invalidate,allowHistory:()=>document.querySelector('[data-go-history]')?.checked===true,refresh:()=>schedule(),privacy};
  window.addEventListener('pagehide',()=>{state.socket?.close();clearTimeout(refreshTimer);clearTimeout(readTimer);});
  window.addEventListener('storage',event=>{if(event.key===GO.tokenKey&&event.newValue!==state.token){state.socket?.close();GO.session('');location.reload();}});
  GO.session(state.token);
  if(state.token)void boot().then(connectSocket);else renderLogin();
})();
