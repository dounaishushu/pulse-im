/* Bind the retained pages to the same server-authoritative Go contract. */
(() => {
  'use strict';
  if (!GO) return;
  let refreshTimer=null, realtime=null, socketEpoch=0, refreshRunning=false, refreshAgain=false;
  const originalOpen=openConversation;
  const active=()=>Boolean(state.token&&state.user&&state.active&&!state.favoriteMode&&!readPasscodeSettings().locked);
  const visible=()=>active()&&!document.hidden&&state.desktopAccountVisible!==false;
  function wipe(id){
    conversationViews.clear();
    if(Number(state.active?.id)!==Number(id))return;
    cancelConversationRecovery();state.messageVersions=new Map();syncPulseMessageCache().clear();
    state.initialHistoryFailed=true;
    if($('messages'))$('messages').innerHTML='<p class="empty">正在校验会话权限…</p>';
  }
  function invalidate(id,reason){
    wipe(id);
    if(active()&&Number(state.active.id)===Number(id))schedule(true);
  }
  async function refreshDirectory(){
    await loadConversations();
    if(active()&&!state.conversations.some(c=>Number(c.id)===Number(state.active.id))){wipe(state.active.id);state.active=null;if($('messages'))$('messages').innerHTML='<p class="empty">已退出或无权访问该会话</p>';updateDesktopChat();}
  }
  function schedule(authorize=false){
    if(authorize&&active())wipe(state.active.id);
    refreshAgain=true;clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{void refresh().catch(e=>console.warn(e.message));},80);
  }
  async function refresh(){
    if(refreshRunning||!state.token||!state.user)return;
    refreshRunning=true;refreshAgain=false;
    const token=state.token;
    try{
      await refreshDirectory();if(state.token!==token||!visible())return;
      if(state.initialHistory)return;
      if(state.initialHistoryFailed||state.historyReadyEpoch!==state.historyEpoch){await openConversation(Number(state.active.id),{focusInput:false});return;}
      const cid=Number(state.active.id),epoch=state.historyEpoch,container=$('messages');if(!container)return;
      const position=recoveryScrollAnchor(container),ids=[...container.querySelectorAll('[data-message-id]')].map(n=>Number(n.dataset.messageId));
      const floor=ids.length?Math.min(...ids):Math.max(1,Number(state.active.message_seq)-49);
      const current=()=>state.token===token&&Number(state.active?.id)===cid&&state.historyEpoch===epoch&&visible();
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
          // This complete authorized window replaces cache entries including personal deletions.
          state.messageVersions=new Map();syncPulseMessageCache().clear();
          renderConversationMessages(initialSnapshotMessages(messages));bindMessageActions();renderOlderHistoryControl();restoreRecoveryScroll(container,position);
          await markMessagesRead(messages);return;
        }
        if(page.next_after_id<=after)throw GO.fail('invalid_response');after=page.next_after_id;
      }
    }catch(error){
      if(state.token!==token)return;
      if([401,403,404,409].includes(error.status)&&state.active){wipe(state.active.id);if([403,404].includes(error.status)){state.active=null;if($('messages'))$('messages').innerHTML='<p class="empty">当前会话不可访问</p>';updateDesktopChat();}}
      if(error.status===401){state.socket?.close();localStorage.removeItem(GO.tokenKey);state.token='';state.user=null;GO.session('');renderLogin();}
      else if(error.code==='membership_changed')schedule(true);
    }finally{refreshRunning=false;if(refreshAgain&&state.token)schedule();}
  }
  openConversation=async function(id,options={}){
    if(Number(state.active?.id)===Number(id))state.initialHistoryFailed=true;
    await originalOpen(id,options);
    if(active()&&Number(state.active.id)===Number(id)&&state.initialHistoryFailed===false)await markMessagesRead(visibleConversationMessages());
  };
  const originalInitial=fetchInitialHistory;
  fetchInitialHistory=async function(context){
    try{
      const page=await originalInitial(context);if(!page)return page;
      GO.requireVersion(context.conversationId,page.membership_version);
      if(state.token===context.token&&Number(state.active?.id)===context.conversationId&&state.historyEpoch===context.epoch){state.active.cleared_before_message_id=page.cleared_before_message_id;state.active.membership_version=page.membership_version;}
      return page;
    }catch(error){if([401,403,404].includes(error.status)&&state.token===context.token){wipe(context.conversationId);if($('messages'))$('messages').innerHTML='<p class="empty">当前会话不可访问</p>';}throw error;}
  };
  recoverConversation=function(){schedule();};
  subscribeConversation=function(){if(!state.initialHistory)schedule();};
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
    if(packet.type==='ready'){state.socketLastReceivedAt=Date.now();if(state.socket)state.socket.readyState=1;schedule(true);return;}
    if(packet.type==='connection.lost'){if(state.socket)state.socket.readyState=0;return;}
    if(packet.type==='membership.changed'||packet.type==='personal.changed'){
      const id=GO.local('conversation',packet.conversation_id);invalidate(id,packet.type);
    }
    if(packet.type==='receipts.changed'){if(typeof messageReceipts !== 'undefined')messageReceipts.refresh();return;}
    if(packet.type.endsWith('.changed'))schedule();
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
  resumeRealtime=function(){if(!state.token||!state.user||document.hidden)return;composerPermissions.check(true);if(!state.socket)connectSocket();schedule(true);};
  let readTimer=null;
  markMessagesRead=async function(){
    if(!visible()||!document.hasFocus()||state.historyReadyEpoch!==state.historyEpoch)return;
    const box=$('messages')?.getBoundingClientRect();if(!box)return;
    const seq=[...$('messages').querySelectorAll('[data-message-id]')].filter(n=>{const r=n.getBoundingClientRect();return r.bottom>box.top&&r.top<box.bottom;}).reduce((n,e)=>Math.max(n,Number(e.dataset.messageId)||0),0);
    if(!seq)return;const cid=Number(state.active.id),token=state.token,key=token+':'+cid;
    if(state.goRead?.key===key&&state.goRead.seq>=seq)return;
    await api('/messages/receipt',{method:'POST',authToken:token,body:JSON.stringify({conversation_id:cid,through_message_id:seq,status:'read'})});
    if(state.token===token)state.goRead={key,seq};
  };
  markReceipt=async function(){return markMessagesRead();};
  document.addEventListener('scroll',e=>{if(e.target.id==='messages'){clearTimeout(readTimer);readTimer=setTimeout(()=>{void markMessagesRead().catch(()=>{});if(typeof messageReceipts !== 'undefined')messageReceipts.refresh();},150);}},true);
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
  async function inviteAccount(){
    if(!active()||!state.active.can_manage)return;const cid=Number(state.active.id),token=state.token;
    dialog('按账号邀请入群','<label>完整账号<input name="account" required maxlength="64"></label><label><input type="checkbox" name="history">允许查看入群前的历史消息</label>',async modal=>{
      const found=await api('/contacts/search?q='+encodeURIComponent(modal.querySelector('[name=account]').value.trim()),{authToken:token});
      if(found.items.length!==1)throw Error('没有找到该账号');
      await api('/conversations/members',{method:'POST',authToken:token,body:JSON.stringify({conversation_id:cid,user_id:found.items[0].id,allow_history:modal.querySelector('[name=history]').checked})});schedule();
    });
  }
  function enhance(){
    const header=document.querySelector('#chat-head');
    if(header){
      let controls=header.querySelector('[data-go-group-controls]');
      if(!state.active||state.active.type!=='group'||!state.active.can_manage)controls?.remove();
      else if(!controls){controls=document.createElement('span');controls.dataset.goGroupControls='';
        for(const [label,action] of [['按账号邀请',inviteAccount],['生成邀请码',copyGroupInviteCode]]){const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=action;controls.append(b);}header.append(controls);}
    }
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
