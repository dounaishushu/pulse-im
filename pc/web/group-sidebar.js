/* The desktop group sidebar uses the same authoritative group APIs as group management. */
(() => {
  window.PulseGroupSidebar = Object.freeze({create({context, active, request, icon, escape, mediaUrl, publicId, presence, changed, manage, invite, profile, memberMenu, closePanel}) {
    let view = null;
    const avatars = PulseMessageView.createAvatarCache();
    const identity = c => `${c.token}:${c.userId}:${c.id}:${c.scope}:${c.base}`;
    const current = v => Boolean(v && view === v && v.panel.isConnected && active(v.info) && !context().blocked && identity(context()) === v.identity);
    const manager = p => p?.can_manage === true && ['owner','admin'].includes(p.my_role);
    const name = p => String(p.remark || p.nickname || '未命名用户');
    const restricted = v => (!manager(v.profile) && v.profile?.allow_member_add_friend !== true) || v.profile?.members_visibility === 'managers' || v.visibility === 'managers';
    const searchTerm = v => v.query.trim().replace(/^@+/, '').trim();
    const displayedMembers = v => searchTerm(v) ? v.search?.items || [] : v.members;
    function cancelSearch(v) { clearTimeout(v.searchTimer); v.searchAbort?.abort(); v.searchAbort = null; }
    function close() {
      if (!view) return;
      cancelSearch(view); view.searchInputAbort?.abort();
      view.memberMenuAbort?.abort(); view.abort.abort(); view.load?.abort(); view.panel.classList.remove('classic-group-sidebar'); view = null;
    }
    function acceptProfile(v, value) {
      if (Number(value?.id) !== v.id || value?.type !== 'group') throw Error('群组资料不匹配，请重新加载');
      v.profile = {...value};
      if (restricted(v)) v.members = v.members.filter(p => ['owner','admin'].includes(p.role) && Number(p.user_id) !== Number(v.account.userId));
      changed(value, v.account);
    }
    function memberMarkup(v) {
      const query = searchTerm(v), search = query ? v.search : null;
      const rows = displayedMembers(v);
      return rows.map(p => `<button type="button" class="gs-member" id="gs-member-${v.id}-${Number(p.user_id)}" data-gs-person="${Number(p.user_id)}" ${Number(p.user_id) === Number(v.account.userId) ? 'disabled' : `aria-haspopup="menu" aria-expanded="false" title="${manager(v.profile) ? '点击查看资料，右键打开群成员操作' : '右键@他'}"`}>
        <span class="gs-avatar"><span>${escape(Array.from(name(p))[0])}</span>${p.avatar_url ? `<img src="${escape(mediaUrl(p.avatar_url))}" alt="">` : ''}</span>
        <span class="gs-member-copy"><strong title="${escape(name(p))}">${escape(name(p))}</strong><small class="${p.online && !p.last_seen_hidden ? 'is-online' : ''}">${escape(presence(p))}</small></span>
        ${['owner','admin'].includes(p.role) ? `<em class="gs-role ${p.role}">${p.role === 'owner' ? '群主' : '管理员'}</em>` : ''}</button>`).join('')
        + (!rows.length ? `<p class="gs-empty" role="status">${escape(query ? (search?.busy ? '正在搜索…' : search?.error || (manager(v.profile) ? '没有找到匹配的群成员' : '没有找到匹配的群内好友')) : v.loading ? '正在加载群成员…' : v.memberError || '暂无可查看的群成员')}</p>` : '')
        + (query && search?.error ? `${rows.length ? `<p class="gs-empty" role="status">${escape(search.error)}</p>` : ''}<button type="button" class="gs-retry" data-gs-search-retry>重新搜索</button>` : '')
        + (!query && v.memberError ? '<button type="button" class="gs-retry" data-gs-retry>重新加载成员</button>' : '')
        + (!query && v.profile && restricted(v) ? '<p class="gs-privacy">仅显示有权查看的群主和管理员，其他成员受隐私设置保护。</p>' : '')
        + (v.profile && !manager(v.profile) ? '<p class="gs-privacy">仅搜索本群内你已添加的好友，支持备注或昵称。</p>' : '')
        + (query && rows.length ? `<p class="gs-search-count" role="status">${search?.hasMore ? '已显示' : '找到'} ${rows.length} 位成员</p>` : '')
        + (query && search?.hasMore && !search.error ? `<button type="button" class="gs-retry" data-gs-search-more ${search.busy ? 'disabled' : ''}>${search.busy ? '正在加载…' : '加载更多'}</button>` : '');
    }
    function bindMembers(v) {
      const list = v.panel.querySelector('[data-gs-list]');
      list.querySelectorAll('img').forEach(img => { img.onerror = () => img.remove(); });
      list.onscroll = () => v.memberMenuAbort?.abort();
      list.querySelectorAll('[data-gs-person]').forEach(button => {
        const person = () => current(v) && !v.loading && !v.busy
          ? displayedMembers(v).find(p => Number(p.user_id) === Number(button.dataset.gsPerson) && Number(p.user_id) !== Number(v.account.userId)) : null;
        button.onclick = () => { const selected = person(); if (selected) profile(Number(button.dataset.gsPerson), searchTerm(v) && selected.is_contact === true ? null : v.id); };
        const openMenu = event => {
          if (!person() || !memberMenu) return;
          event.preventDefault(); event.stopPropagation(); v.memberMenuAbort?.abort();
          const abort = v.memberMenuAbort = new AbortController(), rect = button.getBoundingClientRect();
          memberMenu({member:person(), opener:button, x:event.type === 'keydown' ? rect.left + 16 : event.clientX,
            y:event.type === 'keydown' ? rect.bottom : event.clientY, current:person, signal:abort.signal,
            changed:() => { if (current(v)) void reload(); }});
        };
        button.oncontextmenu = openMenu;
        button.onkeydown = event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) openMenu(event); };
      });
      const retry = list.querySelector('[data-gs-retry]'); if (retry) retry.onclick = () => reload();
      const searchRetry = list.querySelector('[data-gs-search-retry]'); if (searchRetry) searchRetry.onclick = () => beginSearch(v);
      const more = list.querySelector('[data-gs-search-more]'); if (more) more.onclick = () => loadSearch(v, v.search, v.search.page + 1);
    }
    function render(v) {
      if (!current(v)) return;
      const focus = v.panel.contains(document.activeElement) ? document.activeElement.id : '';
      const scroll = v.panel.querySelector('[data-gs-list]')?.scrollTop || 0;
      const p = v.profile, disabled = !p || v.loading || Boolean(v.busy), can = manager(p);
      if (disabled) v.memberMenuAbort?.abort();
      const fallback = context().conversation || {};
      const notificationsMuted = v.busy === 'notifications' ? v.pendingNotification : p?.notifications_muted;
      // Keep decoded images, controls and the live roster across profile/settings
      // responses. The account/group identity resets the renderer on navigation.
      v.panel.setAttribute('aria-busy', String(Boolean(v.busy)));
      PulseMessageView.render(v.panel, `<header class="classic-info-head"><h2>群组信息</h2><button id="chat-info-close" type="button" aria-label="关闭群组资料">×</button></header>
        <div class="classic-info-peer"><span class="classic-panel-avatar" data-gs-avatar></span><strong>${escape(p?.name || fallback.name || '未命名群组')}</strong></div>
        <div class="gs-actions" aria-label="群组操作">
          <button id="chat-info-notifications" type="button" role="switch" aria-label="群消息通知" title="${notificationsMuted ? '开启消息通知' : '关闭消息通知'}" aria-checked="${!notificationsMuted}" ${disabled ? 'disabled' : ''}>${notificationsMuted ? '<img class="gs-notification-muted-icon" src="./group-notifications-muted.png" width="32" height="32" alt="" aria-hidden="true">' : icon('bell')}<span>通知</span><i class="gs-status ${p && !notificationsMuted ? 'is-on' : ''}" aria-hidden="true"></i></button>
          ${can ? `<button id="chat-info-manage" type="button" ${disabled ? 'disabled' : ''} title="编辑群组及管理成员">${icon('sliders')}<span>管理</span></button>
          <button id="chat-info-mute" type="button" aria-pressed="${Boolean(p.all_muted)}" ${disabled ? 'disabled' : ''} title="设置全员禁言">${icon('lock')}<span>${p.all_muted ? '解除禁言' : '开启禁言'}</span></button>` : ''}
          <button id="chat-info-invite" type="button" ${!can || p?.can_invite === false ? 'hidden' : ''} ${disabled ? 'disabled' : ''}>${icon('contactAdd')}<span>邀请入群</span></button>
        </div>
        <p class="gs-feedback ${v.error ? 'is-error' : ''}" role="status">${escape(v.error || (v.loading && !p ? '正在加载群组信息…' : ''))}</p>
        ${v.error && !p ? '<button type="button" class="gs-retry" data-gs-retry>重新加载</button>' : ''}
        <label class="gs-search">${icon('search')}<input id="chat-info-member-search" type="search" autocomplete="off" maxlength="80" placeholder="${can ? '搜索备注/昵称/用户名/ID' : '搜索好友备注/昵称'}" aria-label="${can ? '搜索群成员备注、昵称、用户名或ID' : '搜索本群好友的备注或昵称'}" value="${escape(v.query)}" ${!p ? 'disabled' : ''}></label>
        <div class="gs-members-head">${icon('groups')}<strong>${Number(p?.member_count ?? fallback.member_count) || 0} 位群成员</strong><button id="chat-info-members-refresh" type="button" aria-label="刷新群成员" title="刷新群成员" ${v.loading || v.busy ? 'disabled' : ''}>↻</button></div>
        <div class="gs-members" data-gs-list aria-label="群成员列表">${memberMarkup(v)}</div>`, v.identity);
      v.panel.querySelector('#chat-info-close').onclick = closePanel;
      v.panel.querySelector('#chat-info-notifications').onclick = () => save(v, 'notifications');
      const mute = v.panel.querySelector('#chat-info-mute'); if (mute) mute.onclick = () => save(v, 'mute');
      const management = v.panel.querySelector('#chat-info-manage'); if (management) management.onclick = () => { if (current(v) && manager(v.profile)) manage(); };
      v.panel.querySelector('#chat-info-invite').onclick = () => { if (current(v) && manager(v.profile) && v.profile.can_invite !== false) invite(); };
      v.panel.querySelector('#chat-info-members-refresh').onclick = () => reload();
      const searchInput = v.panel.querySelector('#chat-info-member-search');
      if (v.searchInput !== searchInput) {
        v.searchInputAbort?.abort(); v.searchInputAbort = new AbortController(); v.searchInput = searchInput;
        searchInput.addEventListener('compositionstart', () => { v.composing = true; cancelSearch(v); }, {signal:v.searchInputAbort.signal});
        searchInput.addEventListener('compositionend', e => { if (current(v)) { v.composing = false; v.query = e.target.value; beginSearch(v, 200); } }, {signal:v.searchInputAbort.signal});
      }
      searchInput.oninput = e => { if (current(v)) { v.query = e.target.value; beginSearch(v, 200, v.composing || e.isComposing); } };
      const retry = v.panel.querySelector('[data-gs-retry]'); if (retry) retry.onclick = () => reload();
      const letter = Array.from(p?.name || fallback.name || '群')[0], avatarSource = p?.avatar_url || fallback.avatar_url;
      avatars.render(v.panel.querySelector('[data-gs-avatar]'), avatarSource ? mediaUrl(avatarSource) : '',
        JSON.stringify([v.account.base, v.account.token, Number(v.account.userId)]), letter);
      const avatar = v.panel.querySelector('.classic-panel-avatar img');
      if (avatar) avatar.onerror = () => { if (!PulseMessageView.retryFreshSource(avatar)) avatar.replaceWith(document.createTextNode(letter)); };
      bindMembers(v); v.panel.querySelector('[data-gs-list]').scrollTop = scroll;
      if (focus && document.activeElement.id !== focus) v.panel.querySelector('#'+focus)?.focus({preventScroll:true});
    }
    function beginSearch(v, delay = 0, composing = false) {
      if (!current(v)) return;
      cancelSearch(v); v.memberMenuAbort?.abort();
      const query = searchTerm(v);
      const search = v.search = query ? {query, items:[], page:0, hasMore:false, busy:true, error:'', scope:null} : null;
      render(v);
      const list = v.panel.querySelector('[data-gs-list]'); if (list) list.scrollTop = 0;
      if (search && !composing && !v.loading && v.profile) v.searchTimer = setTimeout(() => loadSearch(v, search, 1), delay);
    }
    async function loadSearch(v, search, page) {
      if (!current(v) || !search || v.search !== search || v.loading || !v.profile || v.searchAbort || (page > 1 && (!search.hasMore || search.busy))) return;
      const abort = v.searchAbort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 12000);
      search.busy = true; search.error = ''; render(v);
      try {
        const data = await request(`/conversations/members?conversation_id=${v.id}&q=${encodeURIComponent(search.query)}&page=${page}`, {authToken:v.account.token, signal:abort.signal});
        if (!current(v) || v.search !== search || v.searchAbort !== abort) return;
        if (abort.signal.aborted) throw Error('搜索超时，请重试');
        if (Number(data?.conversation_id) !== v.id || data.query !== search.query || Number(data.page) !== page || !['group','friends'].includes(data.search_scope) || typeof data.has_more !== 'boolean' || !Array.isArray(data.items) || data.items.length > 100 || data.items.some(p => !Number.isSafeInteger(Number(p.user_id)) || Number(p.user_id) <= 0 || (!manager(v.profile) || data.search_scope === 'friends') && p.is_contact !== true)) throw Error('搜索结果或权限已变化，请重新搜索');
        // A new role scope must never append to results obtained with the old role.
        if (page > 1 && search.scope !== data.search_scope) throw Error('搜索权限已变化，请重新搜索');
        search.items = [...new Map([...(page === 1 ? [] : search.items), ...data.items].map(p => [Number(p.user_id), p])).values()];
        search.scope = data.search_scope; search.page = page; search.hasMore = data.has_more;
      } catch (error) {
        if (current(v) && v.search === search && v.searchAbort === abort) {
          search.items = []; search.hasMore = false;
          search.error = abort.signal.aborted ? '搜索超时，请重试' : error.message || '搜索失败，请重试';
        }
      } finally {
        clearTimeout(timeout);
        if (v.searchAbort === abort) v.searchAbort = null;
        if (current(v) && v.search === search) { search.busy = false; render(v); }
      }
    }
    async function reload() {
      const v = view; if (!current(v) || v.busy) return;
      cancelSearch(v); v.search = null;
      v.load?.abort(); const load = v.load = new AbortController();
      v.loading = true; v.error = ''; v.memberError = ''; render(v);
      const options = {authToken:v.account.token,signal:load.signal};
      const [p,m] = await Promise.allSettled([request(`/conversations/groups/profile?conversation_id=${v.id}`,options), request(`/conversations/members?conversation_id=${v.id}`,options)]);
      if (!current(v) || v.load !== load) return;
      v.loading = false;
      if (p.status === 'rejected') { v.profile=null; v.members=[]; v.error=p.reason.message || '群组信息加载失败'; }
      else try {
        acceptProfile(v,p.value);
        if (m.status === 'rejected') throw m.reason;
        const data=m.value;
        if (!Array.isArray(data.items) || data.conversation_id != null && Number(data.conversation_id)!==v.id || data.items.some(p=>!Number.isSafeInteger(Number(p.user_id)) || Number(p.user_id)<=0)) throw Error('成员资料不匹配，请重新加载');
        v.visibility=data.members_visibility;
        if (restricted(v) && data.items.some(p=>!['owner','admin'].includes(p.role) || Number(p.user_id)===Number(v.account.userId))) throw Error('成员查看权限已变化，请重新加载');
        const rank={owner:0,admin:1,member:2};
        v.members=[...new Map(data.items.map(p=>[Number(p.user_id),p])).values()].sort((a,b)=>(rank[a.role]??2)-(rank[b.role]??2)||name(a).localeCompare(name(b),'zh-CN'));
      } catch(error) {
        v.members=[]; v.memberError=error.message || '成员加载失败，请重试';
        if(Number(p.value?.id)!==v.id||p.value?.type!=='group'){v.profile=null;v.error=v.memberError;}
      }
      v.info.loaded=Boolean(v.profile); render(v);
      if (v.profile && searchTerm(v)) beginSearch(v);
    }
    async function save(v,kind) {
      if (!current(v) || !v.profile || v.busy || v.loading || kind==='mute'&&!manager(v.profile)) return;
      const value=kind==='mute'?!v.profile.all_muted:!v.profile.notifications_muted;
      v.busy=kind;v.pendingNotification=kind==='notifications'?value:null;v.error='';render(v);
      try {
        if (kind==='mute') {
          const latest=await request(`/conversations/groups/profile?conversation_id=${v.id}`,{authToken:v.account.token,signal:v.abort.signal});
          if(!current(v))return;
          acceptProfile(v,latest);
          if(!manager(latest))throw Error('群管理权限已变化，请重新加载');
        }
        if(!current(v))return;
        const updated=await request(kind==='mute'?'/conversations/groups/profile':'/conversations/groups/settings', {method:'POST',authToken:v.account.token,signal:v.abort.signal,body:JSON.stringify({conversation_id:v.id,[kind==='mute'?'all_muted':'notifications_muted']:value})});
        if(current(v))acceptProfile(v,updated);
      } catch(error) { if(current(v)&&error.name!=='AbortError')v.error=error.message || '设置保存失败，请重试'; }
      finally {v.busy='';if(current(v))render(v);}
    }
    async function open(info,panel) {
      close();const account=context();if(account.blocked||account.conversation?.type!=='group')return;
      view={info,panel,id:Number(account.id),account:{...account},identity:identity(account),abort:new AbortController(),load:null,profile:null,members:[],query:'',search:null,searchAbort:null,searchTimer:null,composing:false,loading:false,error:'',memberError:'',busy:'',visibility:null};
      panel.classList.add('classic-group-sidebar');await reload();
    }
    function sync(value) {
      const v=view;if(!current(v)||v.busy||!v.profile||Number(value?.id)!==v.id)return;
      const wasManager = manager(v.profile);
      v.profile={...v.profile,...value};
      if(restricted(v))v.members=v.members.filter(p=>['owner','admin'].includes(p.role)&&Number(p.user_id)!==Number(v.account.userId));
      if (wasManager !== manager(v.profile) && searchTerm(v)) { beginSearch(v); return; }
      render(v);
    }
    return Object.freeze({open,close,reload,sync,clearAvatars:()=>avatars.clear()});
  }});
})();
