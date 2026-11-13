/* Group administration uses existing conversation APIs and their authoritative roles. */
(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths = {
    camera:'M4 7h4l2-3h4l2 3h4v13H4z M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    type:'M3 6h4m4 0h10M3 18h10m4 0h4M11 6a2 2 0 1 1-4 0 2 2 0 0 1 4 0M17 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    announcement:'M4 5h16v12H9l-5 4z', key:'M14 14a6 6 0 1 0-4-4L3 17v4h4v-3h3l4-4',
    link:'m9 15 6-6M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
    shield:'m12 2 9 4-1 9-8 7-8-7-1-9z m0 5 2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z',
    people:'M9 9a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 22v-5a7 7 0 0 1 14 0v5M17 2a4 4 0 0 1 0 8M19 13a6 6 0 0 1 3 5v4',
    search:'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0m-2 4 7 7',
    bell:'M5 17h14l-2-4V8a5 5 0 0 0-10 0v5z M10 21h4', pin:'m8 2 9 3-3 5 2 5-5-1-4 8 1-9-4-3 5-3z',
    copy:'M9 8h12v14H9z M5 17H2V2h13v3', share:'m12 3 9 7-9 7v-4c-6 0-8 4-9 7 0-9 3-13 9-13z',
    lock:'M6 10h12v11H6z M9 10V6a3 3 0 0 1 6 0v4', plus:'M12 3v18M3 12h18'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.people}"/></svg>`;
  window.PulseGroupManager = Object.freeze({ create({ context, request, upload, mediaUrl, changed, exited, openProfile }) {
    let view = null;
    const fingerprint = c => `${c.token}:${c.userId}:${c.groupId}:${c.scope}:${c.base || ''}`;
    const current = v => Boolean(v && view === v && v.root.isConnected && !v.closed && !context().blocked && fingerprint(context()) === v.identity);
    const manager = v => v.manage && v.profile.can_manage === true && ['owner','admin'].includes(v.profile.my_role);
    const canInvite = v => manager(v) && v.profile.can_invite !== false;
    const owner = v => manager(v) && v.profile.is_owner === true && v.profile.my_role === 'owner' && Number(v.profile.owner_id) === Number(v.account.userId);
    const manageable = (v, person) => manager(v) && Number(person.user_id) > 0 && Number(person.user_id) !== Number(v.account.userId) && ['admin','member'].includes(person.role) && (owner(v) || person.role === 'member');
    const string = (value, key) => value?.[key] == null || value?.[key] === 'null' ? '' : String(value[key]);
    const personName = p => string(p,'nickname') || string(p,'remark') || '未命名用户';
    const presence = p => p.online ? '在线' : string(p,'last_seen_at') ? `最近上线：${string(p,'last_seen_at')}` : '最近上线时间不可见';
    const role = p => p.role === 'owner' ? '群主' : p.role === 'admin' ? '管理员' : '';
    const muted = p => { const until=Date.parse(String(p.muted_until || '').replace(' ','T'));return Number.isFinite(until)&&until>Date.now(); };
    function avatar(p, big = false) {
      const url = string(p,'avatar_url'), name = personName(p);
      return `<span class="gm-avatar${big?' gm-avatar-large':''}"><span>${escape(Array.from(name)[0])}</span>${url?`<img src="${escape(mediaUrl(url))}" alt="">`:''}</span>`;
    }
    function close(restore = true) {
      const v = view; if (!v) return;
      view = null; v.closed = true; v.abort.abort(); v.observer?.disconnect(); v.root.remove();
      if (v.preview) URL.revokeObjectURL(v.preview);
      if (restore && v.previous?.isConnected && fingerprint(context()) === v.identity) v.previous.focus();
    }
    function feedback(v, text, error = true) {
      if (!current(v)) return;
      const node = v.root.querySelector('.gm-layer:last-child .gm-feedback');
      if (node) { node.textContent = text; node.classList.toggle('is-success', !error); }
    }
    function controls(v) {
      if (!current(v)) return;
      v.root.querySelector('.gm-layer:last-child')?.querySelectorAll('button,input,textarea,select').forEach(n => { n.disabled = v.busy || n.dataset.locked === 'true'; });
      v.root.setAttribute('aria-busy', String(v.busy));
    }
    async function api(v, route, body) {
      if (!current(v)) throw Error('群组页面已关闭，请重新打开。');
      return request(route, { authToken: v.account.token, signal: v.abort.signal, ...(body ? { method:'POST', body:JSON.stringify({ ...body, conversation_id:v.id }) } : {}) });
    }
    function accept(v, profile, members) {
      if (Number(profile.id) !== v.id || profile.type !== 'group' || !Array.isArray(members.items)) throw Error('群组资料不完整，请重试。');
      if (members.conversation_id != null && Number(members.conversation_id) !== v.id) throw Error('成员资料不匹配，请重试。');
      const restricted = profile.members_visibility === 'managers' || (!['owner','admin'].includes(profile.my_role) && profile.allow_member_add_friend !== true);
      if (restricted && members.items.some(p => !['owner','admin'].includes(p.role) || Number(p.user_id) === Number(v.account.userId))) throw Error('成员查看权限已变化，请重新打开群组资料。');
      v.profile = profile; v.members = members.items; changed?.(profile, v.account);
    }
    function updateProfile(v, profile) {
      if(Number(profile.id)!==v.id||profile.type!=='group')throw Error('群组资料不匹配。');
      v.profile=profile;
      if(profile.members_visibility==='managers'||(!['owner','admin'].includes(profile.my_role)&&profile.allow_member_add_friend!==true))v.members=v.members.filter(m=>['owner','admin'].includes(m.role)&&Number(m.user_id)!==Number(v.account.userId));
      changed?.(profile,v.account);
    }
    async function reload(v) {
      const [profile, members] = await Promise.all([api(v,`/conversations/groups/profile?conversation_id=${v.id}`),api(v,`/conversations/members?conversation_id=${v.id}`)]);
      if (current(v)) accept(v,profile,members);
    }
    async function perform(v, work, done) {
      if (!current(v) || v.busy) return;
      v.busy = true; controls(v); feedback(v,'正在保存…',false);
      try { await work(); if (current(v)) await done?.(); }
      catch (e) { if (current(v) && e.name !== 'AbortError') feedback(v,e.message || '操作失败，请重试。'); }
      finally { v.busy = false; if (current(v)) controls(v); }
    }
    function push(v, kind, data = {}) {
      if (!current(v) || v.busy) return;
      v.pages.push({ kind, ...data }); render(v);
      if (kind === 'invite-members' || kind === 'share') void loadContacts(v, v.pages.at(-1), kind === 'share');
    }
    function back(v) {
      if (!current(v) || v.busy) return;
      if (v.pages.length > 1) { v.pages.pop(); render(v); } else close();
    }
    const heading = name => `<header class="gm-heading"><h2>${escape(name)}</h2></header>`;
    const note = text => `<p class="gm-note">${escape(text)}</p>`;
    const buttons = (cancel = '取消', save = '保存', action = 'save') => `<footer class="gm-footer"><button type="button" data-gm="back">${cancel}</button>${save?`<button type="button" data-gm="${action}">${save}</button>`:''}</footer>`;
    const row = (name, value, glyph, action, danger = false) => `<button type="button" class="gm-setting${danger?' gm-danger':''}" data-gm="${action}">${icon(glyph)}<span>${escape(name)}</span><small>${escape(value)}</small></button>`;
    const toggle = (name, checked, field, locked = false) => `<label class="gm-toggle-row"><span>${escape(name)}</span><span class="gm-toggle${checked?' is-on':''}${locked?' is-locked':''}"><input type="checkbox" data-flag="${field}" aria-label="${escape(name)}" ${checked?'checked':''} ${locked?'disabled data-locked="true"':''}><i>${locked?icon('lock'):checked?'✓':'×'}</i></span></label>`;
    function radio(name, value, selected, label, detail = '') {
      return `<label class="gm-radio"><input type="radio" name="${name}" value="${value}" ${selected===value?'checked':''}><span><b>${escape(label)}</b>${detail?`<small>${escape(detail)}</small>`:''}</span></label>`;
    }
    function people(v, rows, page, action) {
      const q = String(page.query || '').trim().toLocaleLowerCase();
      const filtered = rows.filter(p => [personName(p),p.username,p.public_id].some(value => String(value || '').toLocaleLowerCase().includes(q)));
      return filtered.map(p => `<button type="button" class="gm-person" data-person="${Number(p.user_id || p.id)}" data-person-action="${action}" ${page.kind==='invite-members'?`aria-pressed="${Boolean(page.selected?.has(Number(p.user_id || p.id)))}"`:''}>${page.kind==='invite-members'?`<span class="gm-selection${page.selected?.has(Number(p.user_id || p.id))?' is-checked':''}" aria-hidden="true">${page.selected?.has(Number(p.user_id || p.id))?'✓':''}</span>`:''}${avatar(p)}<span class="gm-person-copy"><strong>${escape(personName(p))}</strong><small class="${p.online?'is-online':''}">${escape(p.role==='owner'&&page.kind==='admins'?'创建者':presence(p))}</small></span>${role(p)?`<em class="gm-role ${p.role}">${role(p)}</em>`:''}</button>`).join('') || `<p class="gm-empty">${page.loading?'正在加载…':page.loadError?'加载失败，请重试':'未找到符合条件的用户'}</p>`;
    }
    const search = page => `<label class="gm-search">${icon('search')}<input type="search" data-search value="${escape(page.query || '')}" placeholder="搜索" aria-label="搜索用户" autocomplete="off"></label>`;
    function content(v, p) {
      const profile = v.profile;
      if (!profile) return heading('群组管理')+'<p class="gm-empty">正在加载群组资料…</p>'+buttons('关闭','');
      if (p.kind === 'root') {
        const can = manager(v), adminCount = v.members.filter(m=>['owner','admin'].includes(m.role)).length;
        return heading(can?'编辑群组':'群组资料')+`<div class="gm-identity"><button class="gm-photo" type="button" data-gm="avatar" ${can?'':'disabled data-locked="true"'} aria-label="修改群头像">${v.preview||profile.avatar_url?`<img src="${escape(v.preview || mediaUrl(profile.avatar_url))}" alt="群头像">`:icon('camera')}</button><label class="gm-name"><span>群组名称</span><input data-draft="name" aria-label="群组名称" maxlength="128" value="${escape(v.draft.name)}" ${can?'':'readonly'}></label><input type="file" accept="image/jpeg,image/png,image/gif,image/webp" data-avatar-file hidden></div><textarea class="gm-description" data-draft="description" maxlength="500" rows="1" aria-label="群简介" placeholder="简介（可选）" ${can?'':'readonly'}>${escape(v.draft.description)}</textarea>`+
          `<div class="gm-divider"></div>`+row('群组类型',({free:'公开加入',invite:'私密',approval:'审核加入'})[profile.join_method] || '公开加入','type','type')+row('群公告',profile.announcement?'已设置':'未设置','announcement','announcement')+
          `<div class="gm-divider"></div>`+row('权限',profile.all_muted?'全员禁言':'可发送消息','key','permissions')+(canInvite(v)?row('邀请链接',profile.invite_code?'1':'0','link','invites'):'')+row('管理员',String(adminCount),'shield','admins')+row('成员',String(profile.member_count || 0),'people','members')+
          `<div class="gm-divider"></div>`+row('个人设置','','bell','personal')+
          (owner(v)?`<div class="gm-divider"></div>`+row('删除群组','','people','dissolve',true):'')+
          `<div class="gm-feedback" role="status"></div>`+buttons(can?'取消':'关闭',can?'保存':'');
      }
      if (p.kind === 'type') return heading('群组类型')+`<div class="gm-section">${radio('join','free',p.method,'公开群组','允许用户通过群号加入。')}${radio('join','invite',p.method,'私密群组','需要有效邀请码，由群成员邀请加入。')}${radio('join','approval',p.method,'审核加入','新成员由群主或管理员邀请加入。')}</div><div class="gm-divider"></div>`+inviteBox(v)+note('邀请成员时会遵循对方的隐私设置。')+buttons('取消',manager(v)?'保存':'');
      if (p.kind === 'announcement') return heading('群公告')+`<textarea class="gm-announcement" data-announcement maxlength="10000" rows="10" aria-label="群公告" ${manager(v)?'':'readonly'}>${escape(p.text || '')}</textarea>`+buttons('取消',manager(v)?'保存':'');
      if (p.kind === 'permissions') return heading('权限')+`<div class="gm-section"><h3>这个群组的成员可以做什么？</h3>${toggle('发送消息',!p.allMuted,'send',!manager(v))}${toggle('禁止群成员互加好友',!p.addFriend,'friends',!manager(v))}${toggle('邀请新成员',false,'invite',true)}${toggle('置顶消息',false,'pin',true)}${toggle('修改群组信息',false,'edit',true)}</div>`+note('置顶消息和修改群组信息仅允许群主及管理员操作。')+(manager(v)?row('例外',String(v.members.filter(m=>muted(m)&&manageable(v,m)).length),'key','exceptions'):'')+buttons('取消',manager(v)?'保存':'');
      if (p.kind === 'personal') return heading('个人设置')+`<div class="gm-section">${toggle('消息免打扰',p.muted,'notifications')}${toggle('置顶会话',p.pinned,'conversation-pin')}</div>`+note('这些设置只对当前账号生效。')+buttons();
      if (p.kind === 'invites') return heading('邀请链接')+inviteBox(v)+note('通过群号邀请：复制或分享群号，对方可在“加入群组”中使用。')+buttons('确定','');
      if (p.kind === 'admins' || p.kind === 'members' || p.kind === 'admin-add') {
        const admins = p.kind === 'admins', add = p.kind === 'admin-add';
        const list = v.members.filter(m=>admins?['owner','admin'].includes(m.role):add?m.role==='member'&&Number(m.user_id)!==Number(v.account.userId):true);
        return heading(add?'添加管理员':admins?'管理员':'成员')+search(p)+`<div class="gm-people">${people(v,list,p,add?'admin-add':admins?'admin':'member')}${profile.members_visibility==='managers'&&!admins&&!add?'<p class="gm-privacy">其他成员设置隐私，无法查看</p>':''}</div>`+
          `<footer class="gm-footer gm-footer-split">${admins&&owner(v)?'<button data-gm="admin-add" type="button">添加管理员</button>':!add&&!admins&&canInvite(v)?'<button data-gm="invite-members" type="button">邀请新成员</button>':'<span></span>'}<button type="button" data-gm="back">${add?'取消':'关闭'}</button></footer>`;
      }
      if(p.kind==='exceptions'||p.kind==='exception-add'){
        const add=p.kind==='exception-add',list=v.members.filter(m=>manageable(v,m)&&(add?!muted(m):muted(m)));
        return heading(add?'添加例外':'例外')+search(p)+`<div class="gm-people">${people(v,list,p,add?'exception-add':'exception')}</div>`+
          `<footer class="gm-footer gm-footer-split">${add?'<span></span>':'<button data-gm="exception-add" type="button">添加例外</button>'}<button type="button" data-gm="back">${add?'取消':'关闭'}</button></footer>`;
      }
      if (p.kind === 'invite-members' || p.kind === 'share') return heading(p.kind==='share'?'分享邀请':`邀请新成员  ${profile.member_count} / ${profile.max_members || 500}`)+search(p)+
        (p.kind==='invite-members'?row('通过链接邀请','','link','invites'):'')+`<div class="gm-people">${people(v,p.items || [],p,p.kind==='share'?'share':'invite')}</div>`+(p.loadError?'<button class="gm-retry" type="button" data-gm="retry">重新加载</button>':'')+
        `<label><input type="checkbox" data-go-history>允许新成员查看入群前的历史消息</label><div class="gm-feedback" role="status"></div>`+buttons('取消',p.kind==='share'?'':'邀请',p.kind==='share'?'back':'invite-save');
      if (p.kind === 'admin-detail' || p.kind === 'member-detail') {
        const person = v.members.find(m=>Number(m.user_id)===p.userId); if (!person) return heading('成员已离开')+buttons('关闭','');
        const admin = p.kind==='admin-detail', can = manageable(v,person), mine = Number(person.user_id)===Number(v.account.userId);
        const privileged = ['owner','admin'].includes(person.role) || admin;
        return heading(admin?(person.role==='admin'?'管理员权限':'添加管理员'):'用户权限')+`<div class="gm-person-header">${avatar(person,true)}<span><strong>${escape(personName(person))}</strong><small>${escape(presence(person))}</small></span></div><div class="gm-divider"></div><div class="gm-section"><h3>${admin?'这位管理员可以做什么？':'这位成员可以做什么？'}</h3>`+
          (admin?toggle('修改群组信息',true,'admin-edit',true)+toggle('封禁普通成员',true,'admin-mute',true)+toggle('生成邀请',true,'admin-invite',true)+toggle('置顶消息',true,'admin-pin',true)+toggle('添加新管理员',false,'admin-add',true):
            toggle('发送消息',!p.muted,'member-send',!can)+toggle('邀请新成员',privileged,'member-invite',true)+toggle('置顶消息',privileged,'member-pin',true)+toggle('修改群组信息',privileged,'member-edit',true))+'</div>'+
          (admin?note('管理员按群组角色拥有统一权限；只有群主可以任免管理员。'):(profile.all_muted&&!privileged?note('群组已开启全员禁言，普通成员仍受统一禁言限制。'):'')+`<div class="gm-divider"></div><div class="gm-section gm-duration"><h3>禁言持续时间</h3>${[['-1','永久']].map(([value,label])=>radio('duration',value,p.duration,label)).join('')}<input type="number" class="gm-custom-duration" data-duration min="1" max="43200" aria-label="自定义禁言分钟数" value="${escape(p.custom || '')}" placeholder="分钟数（1 至 43200）" ${p.duration==='custom'?'':'hidden'}></div>`)+
          (!mine&&openProfile&&(['owner','admin'].includes(profile.my_role)||profile.allow_member_add_friend===true)?row('查看资料 / 添加好友','','people','profile'):'')+
          (!admin&&can?row('移出群组','','people','remove',true):'')+(!admin&&owner(v)&&!mine&&person.role!=='owner'?row('转让群主','','shield','transfer',true):'')+
          `<div class="gm-feedback" role="status"></div>`+buttons('取消',admin?(owner(v)&&!mine&&person.role!=='owner'?(person.role==='admin'?'取消管理员':'保存'):''):can?'保存':'');
      }
      if (p.kind === 'confirm') return heading(p.title)+`<p class="gm-confirm-copy">${escape(p.description)}</p><div class="gm-feedback" role="status"></div>`+buttons('取消',p.label,'confirm');
      return '';
    }
    function inviteBox(v) {
      if (!canInvite(v)) return '';
      return `<div class="gm-section gm-invite"><h3>群号邀请</h3><div class="gm-code" tabindex="0">${escape(v.profile.invite_code || '暂无可用群号')}</div><div class="gm-invite-actions"><button type="button" data-gm="copy">${icon('copy')}复制群号</button><button type="button" data-gm="share">${icon('share')}分享群号</button></div></div>`;
    }
    async function loadContacts(v,p,shares=false) {
      p.loading=true; p.loadError=false; p.items=[]; render(v);
      try {
        if (shares) {
          const seen=new Set();let page=1;
          while(current(v)){
            const data=await api(v,`/conversations?page=${page}&size=100`);if(!Array.isArray(data.items))throw Error('会话列表不完整。');
            let added=0;for(const m of data.items){const id=Number(m.id);if(id>0&&!seen.has(id)){seen.add(id);added++;if(id!==v.id)p.items.push({...m,user_id:id,nickname:m.name||'会话'});}}
            if(!added||data.items.length<100||page*100>=Number(data.total ?? Infinity))break;page++;
          }
        } else {
          const seen=new Set(); let page=1;
          while(current(v)) {
            const data=await api(v,`/contacts?page=${page}&size=50`); if(!Array.isArray(data.items)) throw Error('联系人列表不完整。');
            let added=0; for(const m of data.items) { const id=Number(m.user_id || m.id); if(id>0&&!seen.has(id)) { seen.add(id); added++; if(!v.members.some(p=>Number(p.user_id)===id)) p.items.push({...m,user_id:id}); } }
            if(!added||data.items.length<50||page*50>=Number(data.total ?? Infinity)) break; page++;
          }
        }
      } catch(e) { p.loadError=true; p.error=e.message; }
      finally { p.loading=false; if(current(v)&&v.pages.includes(p)) { render(v); if(p.loadError) feedback(v,p.error); } }
    }
    function render(v, preserve = null) {
      if (!current(v)) return;
      PulseMessageView.render(v.root,v.pages.map((p,index)=>{
        let markup=content(v,p);
        if(!markup.includes('class="gm-feedback"'))markup=markup.replace('<footer class="gm-footer','<div class="gm-feedback" role="status"></div><footer class="gm-footer');
        return `<div class="gm-layer${index?' gm-child-layer':''}" style="z-index:${index}" data-layer="${index}" ${index<v.pages.length-1?'inert aria-hidden="true"':''}><section class="gm-dialog${['admins','members','admin-add','invite-members','share','exceptions','exception-add'].includes(p.kind)?' gm-list-dialog':''}" role="dialog" aria-modal="true" aria-label="群组管理"><div class="gm-scroll">${markup}</div></section></div>`;
      }).join(''),v.identity);
      const layer=v.root.lastElementChild, p=v.pages.at(-1); layer.querySelector('.gm-dialog').setAttribute('aria-label',layer.querySelector('h2')?.textContent || '群组管理');
      layer.querySelectorAll('img').forEach(img=>{img.onerror=()=>img.remove();});
      layer.querySelectorAll('[data-gm]').forEach(button=>{button.onclick=()=>void action(v,p,button.dataset.gm);});
      layer.querySelectorAll('[data-draft]').forEach(input=>{input.oninput=()=>{v.draft[input.dataset.draft]=input.value;};});
      const searchInput=layer.querySelector('[data-search]');if(searchInput)searchInput.oninput=e=>{p.query=e.target.value; const point=e.target.selectionStart;render(v,{query:true,point});};
      layer.querySelectorAll('[data-person]').forEach(button=>{button.onclick=()=>choose(v,p,Number(button.dataset.person),button.dataset.personAction);});
      layer.querySelectorAll('[data-flag]').forEach(input=>{input.onchange=()=>{
        const key=input.dataset.flag,value=input.checked;
        if(key==='send')p.allMuted=!value; if(key==='friends')p.addFriend=!value;
        if(key==='notifications')p.muted=value;if(key==='conversation-pin')p.pinned=value;
        if(key==='member-send')p.muted=!value;
        render(v);
      };});
      layer.querySelectorAll('[name="join"]').forEach(input=>{input.dataset.locked=String(!manager(v));input.onchange=()=>{p.method=input.value;};});
      layer.querySelectorAll('[name="duration"]').forEach(input=>{input.dataset.locked=String(!manageable(v,v.members.find(m=>Number(m.user_id)===p.userId)||{}));input.onchange=()=>{p.duration=input.value;p.muted=true;render(v);};});
      const duration=layer.querySelector('[data-duration]'); if(duration)duration.oninput=()=>{p.custom=duration.value;};
      const announcement=layer.querySelector('[data-announcement]');if(announcement)announcement.oninput=()=>{p.text=announcement.value;};
      const file=layer.querySelector('[data-avatar-file]');if(file)file.onchange=()=>{
        const selected=file.files?.[0];if(!selected)return;if(!/^image\/(jpeg|png|gif|webp)$/i.test(selected.type)){feedback(v,'请选择 JPG、PNG、GIF 或 WebP 图片。');return;}
        if(selected.size>20*1024*1024){feedback(v,'群头像不能超过 20 MB。');return;}
        if(v.preview)URL.revokeObjectURL(v.preview);v.preview=URL.createObjectURL(selected);v.file=selected;v.uploaded=null;render(v);
      };
      layer.onclick=e=>{if(e.target===layer)back(v);};controls(v);
      if(preserve?.query){const input=layer.querySelector('[data-search]');input?.focus();try{input?.setSelectionRange(preserve.point,preserve.point);}catch{}}
      else (layer.querySelector('input:not([type="file"]):not([type="checkbox"]):not([type="radio"]),textarea,button:not(:disabled)')||layer.querySelector('.gm-dialog')).focus({preventScroll:true});
    }
    function choose(v,p,id,kind) {
      if(!current(v)||v.busy)return;
      if(kind==='invite'){p.selected ||=new Set();if(p.selected.has(id))p.selected.delete(id);else p.selected.add(id);render(v);return;}
      if(kind==='share'){
        const target=p.items.find(m=>Number(m.user_id)===id);if(!target)return;
        push(v,'confirm',{title:'分享群号',description:`将「${v.profile.name}」的群号分享至「${personName(target)}」？`,label:'分享',operation:'share',target:id,requestId:crypto.randomUUID()});return;
      }
      const member=v.members.find(m=>Number(m.user_id)===id);if(!member)return;
      if(kind==='admin-add'&&!owner(v))return;
      if(kind==='admin'||kind==='admin-add'){push(v,'admin-detail',{userId:id});return;}
      if((kind==='exception'||kind==='exception-add')&&!manageable(v,member))return;
      const until=Date.parse(String(member.muted_until || '').replace(' ','T')),restricted=muted(member);
      push(v,'member-detail',{userId:id,muted:restricted||kind==='exception-add',duration:member.muted_permanent===true||String(member.muted_until||'').startsWith('9999-')?'-1':restricted?'custom':'-1',custom:restricted?String(Math.min(43200,Math.max(1,Math.ceil((until-Date.now())/60000)))):''});
    }
    async function action(v,p,name) {
      if(!current(v)||v.busy)return;
      if (['invites','invite-members','share','copy','invite-save'].includes(name) && !canInvite(v)) return feedback(v,'只有群主或管理员可以邀请新成员。');
      if(name==='back')return back(v);
      if(name==='profile'){
        const member=v.members.find(m=>Number(m.user_id)===p.userId);
        if(!openProfile||!member||Number(member.user_id)===Number(v.account.userId)||(!['owner','admin'].includes(v.profile.my_role)&&v.profile.allow_member_add_friend!==true))return;
        const sourceId=v.id,targetId=Number(member.user_id);close(false);return openProfile(targetId,sourceId);
      }
      if(name==='avatar'){if(manager(v))v.root.lastElementChild.querySelector('[data-avatar-file]')?.click();return;}
      if(name==='type')return push(v,'type',{method:v.profile.join_method || 'free'});
      if(name==='announcement')return push(v,'announcement',{text:v.profile.announcement || ''});
      if(name==='permissions')return push(v,'permissions',{allMuted:Boolean(v.profile.all_muted),addFriend:v.profile.allow_member_add_friend!==false});
      if(name==='personal')return push(v,'personal',{muted:Boolean(v.profile.notifications_muted),pinned:Boolean(v.profile.is_pinned)});
      if(['invites','admins','members'].includes(name))return push(v,name);
      if(name==='admin-add'){if(owner(v))push(v,name);return;}
      if(name==='exceptions'||name==='exception-add'){if(manager(v))push(v,name);return;}
      if(name==='invite-members')return push(v,name,{items:[],selected:new Set()});
      if(name==='share'){if(!v.profile.invite_code)return feedback(v,'暂无可用群号。');return push(v,'share',{items:[]});}
      if(name==='retry')return loadContacts(v,p,p.kind==='share');
      if(name==='copy'){
        const code=string(v.profile,'invite_code');if(!code)return feedback(v,'暂无可用群号。');
        try{await navigator.clipboard.writeText(code);if(current(v))feedback(v,'群号已复制。',false);}catch{if(current(v))feedback(v,'请选择上方群号后复制。');}return;
      }
      if(name==='dissolve'||name==='remove'||name==='transfer'){
        const target=v.members.find(m=>Number(m.user_id)===p.userId);
        if(name==='dissolve'&&!owner(v)||['remove','transfer'].includes(name)&&!target)return;
        if(name==='remove'&&!manageable(v,target)||name==='transfer'&&!owner(v))return;
        const text={dissolve:['删除群组','删除后群成员将不能继续在此群聊天。确定删除这个群组吗？','删除群组'],remove:['移出群组',`确定将「${personName(target || {})}」移出群组吗？`,'移出'],transfer:['转让群主',`将群主转让给「${personName(target || {})}」后，你将成为普通成员。确定继续吗？`,'转让']}[name];
        return push(v,'confirm',{title:text[0],description:text[1],label:text[2],operation:name,userId:p.userId});
      }
      if(name==='invite-save')return perform(v,async()=>{
        if(!p.selected?.size)throw Error('请先选择要邀请的联系人。');
        const failed=[];let successes=0;
        const result=await window.PulseGroupInvitations.create({request}).add({group:v.profile,ids:[...p.selected],account:v.account,signal:v.abort.signal,current:()=>current(v),apply:batch=>{
          for(const item of batch.items)if(item.status==='joined'){p.selected.delete(item.user_id);p.items=p.items.filter(m=>Number(m.user_id)!==item.user_id);successes++;}
          if(Number.isSafeInteger(batch.member_count))v.profile.member_count=batch.member_count;
        }});
        if(!current(v)||result.abandoned)return;
        for(const item of result.items)if(item.status!=='joined')failed.push(item.message||'邀请失败');
        render(v);feedback(v,`已邀请 ${successes} 人`+(failed.length?'；'+failed.join('；'):''),failed.length>0);
        void reload(v).then(()=>{if(current(v)){render(v);feedback(v,`已邀请 ${successes} 人`+(failed.length?'；'+failed.join('；'):''),failed.length>0);}}).catch(()=>{});
      });
      if(name==='confirm')return perform(v,async()=>{
        if(p.operation==='share'){
          if (!canInvite(v)) throw Error('只有群主或管理员可以邀请新成员。');
          await request('/messages',{authToken:v.account.token,signal:v.abort.signal,method:'POST',body:JSON.stringify({conversation_id:p.target,type:'text',body:{text:`邀请你加入「${v.profile.name}」\n群号：${v.profile.invite_code}\n请在“加入群组”中输入群号。`},request_id:p.requestId})});
        } else {
          const route={dissolve:'/conversations/groups/dissolve',remove:'/conversations/members/remove',transfer:'/conversations/groups/transfer'}[p.operation];
          if(p.operation==='dissolve'&&!owner(v)||p.operation==='transfer'&&!owner(v)||p.operation==='remove'&&!manageable(v,v.members.find(m=>Number(m.user_id)===p.userId)||{}))throw Error('没有操作权限。');
          await api(v,route,p.userId?{user_id:p.userId}:{});
        }
        if(!current(v))return;
        if(p.operation==='dissolve'){const id=v.id;close(false);await exited?.(id,v.account);return;}
        if(p.operation==='share'){v.pages.pop();render(v);feedback(v,'邀请群号已分享。',false);return;}
        await reload(v);v.pages=[{kind:'root'},{kind:'members'}];render(v);
      });
      if(name!=='save')return;
      return perform(v,async()=>{
        if(p.kind==='personal'){const updated=await api(v,'/conversations/groups/settings',{notifications_muted:p.muted,is_pinned:p.pinned});if(current(v))updateProfile(v,updated);v.pages.pop();render(v);return;}
        if(!manager(v))throw Error('只有群主或管理员可以修改群组。');
        if(p.kind==='member-detail'){
          const member=v.members.find(m=>Number(m.user_id)===p.userId);if(!member||!manageable(v,member))throw Error('不能修改这位成员的权限。');
          const minutes=p.muted?Number(p.duration==='custom'?p.custom:p.duration):0;if(!Number.isInteger(minutes)||minutes< -1||minutes>43200||p.muted&&minutes===0)throw Error('禁言时长需为永久或 1 至 43200 分钟。');
          await api(v,'/conversations/members/mute',{user_id:p.userId,minutes});await reload(v);v.pages.pop();if(v.pages.at(-1)?.kind==='exception-add')v.pages.pop();render(v);return;
        }
        if(p.kind==='admin-detail'){
          const member=v.members.find(m=>Number(m.user_id)===p.userId);if(!owner(v)||!member||member.role==='owner'||Number(member.user_id)===Number(v.account.userId))throw Error('只有群主可以任免管理员。');
          await api(v,'/conversations/members/role',{user_id:p.userId,role:member.role==='admin'?'member':'admin'});await reload(v);v.pages.pop();if(v.pages.at(-1)?.kind==='admin-add')v.pages.pop();render(v);return;
        }
        let body;
        if(p.kind==='root'){
          const name=v.draft.name.trim();if(!name||Array.from(name).length>128)throw Error('群组名称需为 1 至 128 个字符。');
          if(Array.from(v.draft.description).length>500)throw Error('简介不能超过 500 个字符。');
          if(v.file&&!v.uploaded){const result=await upload(v.file,v.account.token,v.abort.signal);if(!current(v))return;v.uploaded=result.url;}
          body={name,description:v.draft.description.trim(),...(v.uploaded?{avatar_url:v.uploaded}:{})};
        }else if(p.kind==='type')body={join_method:p.method};else if(p.kind==='permissions')body={all_muted:p.allMuted,allow_member_add_friend:p.addFriend};else if(p.kind==='announcement')body={announcement:p.text.trim()};else return;
        const updated=await api(v,'/conversations/groups/profile',body);if(!current(v))return;
        updateProfile(v,updated);
        if(p.kind==='root')close();else{v.pages.pop();render(v);}
      });
    }
    async function open(group, manage = true) {
      close(false);const account=context();if(account.blocked||!account.token||!account.userId||Number(group?.id)!==Number(account.groupId))return;
      const root=document.createElement('div');root.className='gm-backdrop';root.dataset.featureModal='';root.dataset.groupManager='';root.setAttribute('role','presentation');document.body.append(root);
      const v=view={root,id:Number(group.id),identity:fingerprint(account),account:{...account},manage,abort:new AbortController(),pages:[{kind:'root'}],profile:null,members:[],busy:false,closed:false,previous:document.activeElement,draft:{name:'',description:''},file:null,preview:null,uploaded:null};
      v.observer=new MutationObserver(()=>{if(view===v&&!current(v))close(false);});v.observer.observe(document.body,{childList:true,subtree:true});render(v);
      try{await reload(v);if(!current(v))return;v.draft={name:v.profile.name || '',description:v.profile.description || ''};render(v);}catch(e){if(current(v)){root.querySelector('.gm-empty').textContent=e.message || '群组资料加载失败。';}}
    }
    document.addEventListener('keydown',e=>{
      const v=view;if(!v)return;if(!current(v)){close(false);return;}
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();back(v);return;}
      if(e.key==='Tab'){
        const layer=v.root.lastElementChild,nodes=[...layer.querySelectorAll('button:not(:disabled),input:not(:disabled):not([hidden]):not([type="file"]),textarea:not(:disabled),[tabindex="0"]')].filter(n=>n.getClientRects().length),first=nodes[0],last=nodes.at(-1);
        if(first&&(e.shiftKey&&document.activeElement===first||!e.shiftKey&&document.activeElement===last||!layer.contains(document.activeElement))){e.preventDefault();(e.shiftKey?last:first).focus();}
      }
    },true);
    document.addEventListener('focusin',e=>{const v=view;if(current(v)&&!v.root.lastElementChild.contains(e.target))v.root.lastElementChild.querySelector('button:not(:disabled),input:not(:disabled)')?.focus();});
    return Object.freeze({open,close});
  }});
})();
