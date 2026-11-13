// Shared PC/Web group creation and invitations: contacts and recent conversations.
(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const presets = [
    ['护盾', '#42c5b5', '<path d="M20 8 9 12v9c0 8 11 13 11 13s11-5 11-13v-9Z"/>'],
    ['笑脸', '#6784f0', '<circle cx="20" cy="21" r="12"/><path d="M14 23c3 4 9 4 12 0" fill="none" stroke="white" stroke-width="2"/>'],
    ['气泡', '#a260df', '<path d="M8 19a12 12 0 0 1 24 0c0 7-6 12-13 12l-8 4 1-7a12 12 0 0 1-4-9Z"/>'],
    ['火箭', '#ea77aa', '<path d="M15 14c4-6 10-7 16-6 1 6-1 12-7 16l-5-5Z"/><path d="m15 14-6 2-2 8 10-4m7 4-2 8-8 2 4-11m-5 3c-5 0-6 4-6 7 4 0 7-1 7-6"/><circle cx="24" cy="15" r="3" fill="white"/>'],
    ['灯泡', '#edb557', '<path d="M20 7a10 10 0 0 0-7 17c2 2 3 4 3 6h8c0-2 1-4 3-6a10 10 0 0 0-7-17Zm-4 26h8v3h-8Z"/>'],
  ];
  const icon = (preset, background = false) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" aria-hidden="true">${background ? `<rect width="40" height="40" rx="20" fill="${preset[1]}"/>` : ''}<g fill="${background ? '#fff' : preset[1]}">${preset[2].replaceAll('stroke="white"', `stroke="${background ? preset[1] : '#fff'}"`).replaceAll('fill="white"', `fill="${background ? preset[1] : '#fff'}"`)}</g></svg>`;
  const limit = 499; // The owner is the 500th possible member.

  window.PulseGroupCreator = {
    create({ getAccount, request, upload, mediaUrl, onCreated, onInvited }) {
      let view = null;
      const current = candidate => {
        const account = getAccount();
        return view === candidate && !candidate.closed && candidate.modal.isConnected && !account.blocked
          && account.token === candidate.account.token && account.userId === candidate.account.userId && account.scope === candidate.account.scope;
      };
      function close(restoreFocus = true) {
        if (!view) return;
        const old = view; view = null; old.closed = true; old.controller.abort();
        document.removeEventListener('keydown', old.keydown, true);
        old.urls.forEach(url => URL.revokeObjectURL(url)); old.urls.clear(); old.modal.remove();
        if (restoreFocus && old.previousFocus?.isConnected) old.previousFocus.focus();
      }
      const feedback = (candidate, text, error = false) => {
        const node = candidate.modal.querySelector('#group-action-feedback');
        node.textContent = text; node.classList.toggle('is-error', error);
      };
      const visible = (candidate, kind) => {
        const query = candidate.queries[kind].trim().toLocaleLowerCase();
        return candidate.people.filter(person => person.kind === kind && (!query || person.search.includes(query)));
      };
      const unavailable = (candidate, person) => !candidate.group ? '' : candidate.memberIds.has(person.id) ? '已在群内'
        : !['owner', 'admin'].includes(candidate.group.my_role) && !person.contact ? '仅可邀请好友' : '';
      const selectable = (candidate, kind) => visible(candidate, kind).filter(person => !unavailable(candidate, person));
      const canInvite = group => ['owner', 'admin'].includes(group?.my_role) && group.can_invite !== false;
      const selectionLimit = candidate => candidate.group ? candidate.remaining : limit;
      function sync(candidate) {
        candidate.modal.querySelector('[data-group-selected]').textContent = `已选 ${candidate.selected.size} 人`;
        for (const kind of ['pinned', 'recent']) {
          const rows = selectable(candidate, kind), count = rows.filter(row => candidate.selected.has(row.id)).length;
          const all = candidate.modal.querySelector(`[data-group-all="${kind}"]`);
          all.checked = rows.length > 0 && count === rows.length;
          all.indeterminate = count > 0 && count < rows.length;
          all.disabled = candidate.busy || candidate.loading || candidate.loadError || !rows.length;
        }
        const unavailableIds = new Set(candidate.people.filter(person => unavailable(candidate, person)).map(person => person.id));
        candidate.modal.querySelectorAll('[data-group-user]').forEach(input => {
          input.checked = candidate.selected.has(Number(input.dataset.groupUser)); input.disabled = candidate.busy || candidate.loading || candidate.loadError || unavailableIds.has(Number(input.dataset.groupUser));
          input.closest('.group-create-person').classList.toggle('is-selected', input.checked);
        });
        candidate.modal.querySelector('[type="submit"]').disabled = candidate.busy || candidate.loading || candidate.pending || candidate.loadError || Boolean(candidate.group && !candidate.selected.size);
      }
      function renderPeople(candidate, kind) {
        const rows = visible(candidate, kind), list = candidate.modal.querySelector(`[data-group-list="${kind}"]`);
        list.innerHTML = rows.map(person => `<label class="group-create-person${unavailable(candidate, person) ? ' is-unavailable' : ''}"><input type="checkbox" data-group-user="${person.id}" aria-label="选择${escape(person.name)}"><span class="group-create-person-avatar">${person.avatar ? `<img src="${escape(mediaUrl(person.avatar))}" alt="">` : escape(Array.from(person.name)[0] || '友')}</span><span class="group-create-person-copy"><strong>${escape(person.name)}</strong><small>${escape(person.username ? '@' + person.username : person.publicId || '联系人')}</small></span>${unavailable(candidate, person) ? `<span class="group-invite-unavailable">${unavailable(candidate, person)}</span>` : ''}</label>`).join('')
          || `<p class="group-create-empty">${candidate.loading ? '正在加载用户…' : candidate.loadError ? '用户列表加载失败' : candidate.queries[kind] ? '没有匹配的用户' : kind === 'pinned' ? '暂无置顶用户' : '暂无可选择的用户'}</p>`;
        sync(candidate);
      }
      async function readAll(candidate, route) {
        const items = [];
        for (let page = 1; ; page++) {
          const result = await request(`${route}?page=${page}&size=100`, { authToken: candidate.account.token, signal: AbortSignal.any([candidate.controller.signal, AbortSignal.timeout(15000)]) });
          if (!current(candidate)) return [];
          if (!Array.isArray(result?.items)) throw Error('用户列表格式异常，请重试。');
          items.push(...result.items);
          if (result.items.length < 100 || (Number.isFinite(Number(result.total)) && items.length >= Number(result.total))) return items;
          if (page >= 1000) throw Error('用户列表过大，请联系管理员。');
        }
      }
      async function loadPeople(candidate) {
        if (!current(candidate) || candidate.loading) return;
        candidate.loading = true; candidate.loadError = false;
        candidate.modal.querySelector('[data-group-retry]').hidden = true; feedback(candidate, '');
        renderPeople(candidate, 'pinned'); renderPeople(candidate, 'recent');
        try {
          const options = { authToken: candidate.account.token, signal: AbortSignal.any([candidate.controller.signal, AbortSignal.timeout(15000)]) };
          const [contacts, conversations, membership, profile] = await Promise.all([readAll(candidate, '/contacts'), readAll(candidate, '/conversations'),
            candidate.group ? request(`/conversations/members?conversation_id=${candidate.group.id}`, options) : null,
            candidate.group ? request(`/conversations/groups/profile?conversation_id=${candidate.group.id}`, options) : null]);
          if (!current(candidate)) return;
          if (candidate.group) {
            if (!Array.isArray(membership?.items) || Number(profile?.id) !== Number(candidate.group.id) || profile.type !== 'group') throw Error('群资料加载失败，请重试。');
            if (!canInvite(profile)) { candidate.group = { ...candidate.group, ...profile }; candidate.people = []; candidate.selected.clear(); throw Error('只有群主或管理员可以邀请新成员。'); }
            const manager = ['owner', 'admin'].includes(profile.my_role);
            if ((manager && membership.members_visibility !== 'all') || (!manager && (membership.members_visibility !== 'managers'
              || membership.items.some(person => !['owner', 'admin'].includes(person.role) || Number(person.user_id) === candidate.account.userId)))) throw Error('群成员权限已变化，请重新打开邀请页面。');
            candidate.group = { ...candidate.group, ...profile };
            candidate.memberIds = new Set(membership.items.map(person => Number(person.user_id)));
            const actualCount = Math.max(Number(membership.member_count) || 0, candidate.memberIds.size);
            const count = Number.isSafeInteger(Number(profile.member_count)) && Number(profile.member_count) >= 0 ? Number(profile.member_count) : actualCount;
            candidate.group.member_count = count;
            candidate.remaining = Math.max(0, (Number(profile.max_members) || 500) - actualCount);
            candidate.modal.querySelector('[data-invite-group-name]').textContent = profile.name || '群聊';
            candidate.modal.querySelector('[data-invite-group-count]').textContent = `${count} 名成员`;
          }
          const people = new Map();
          for (const contact of contacts) {
            const id = Number(contact.user_id);
            if (!Number.isSafeInteger(id) || id <= 0 || id === candidate.account.userId) continue;
            people.set(id, { id, name: contact.remark || contact.nickname || contact.username || '未命名用户', username: contact.username || '', publicId: contact.public_id || '', avatar: contact.avatar_url || '', pinned: false, contact: true, time: '', contactTime: contact.created_at || '' });
          }
          for (const conversation of conversations) {
            const id = Number(conversation.peer_user_id);
            if (conversation.type !== 'direct' || !Number.isSafeInteger(id) || id <= 0 || id === candidate.account.userId || conversation.status === 'deleted') continue;
            const old = people.get(id), time = conversation.last_message?.created_at || conversation.updated_at || '';
            const person = old || { id, name: conversation.remark || conversation.name || '未命名用户', username: '', publicId: conversation.peer_public_id || '', avatar: conversation.avatar_url || '', contact: false, contactTime: '' };
            person.pinned ||= Boolean(conversation.is_pinned);
            if (!person.time || time > person.time) person.time = time;
            people.set(id, person);
          }
          candidate.people = [...people.values()].map(person => ({ ...person, kind: person.pinned ? 'pinned' : 'recent', search: [person.name, person.username, person.publicId, person.id].join(' ').toLocaleLowerCase() }))
            .sort((a, b) => (b.time || '').localeCompare(a.time || '') || (b.contactTime || '').localeCompare(a.contactTime || '') || a.id - b.id);
          const known = new Set(candidate.people.filter(person => !unavailable(candidate, person)).map(person => person.id));
          candidate.selected.forEach(id => { if (!known.has(id)) candidate.selected.delete(id); });
        } catch (error) {
          if (!current(candidate)) return;
          candidate.loadError = true; feedback(candidate, error.message || '用户列表加载失败，请重试。', true);
          candidate.modal.querySelector('[data-group-retry]').hidden = false;
        } finally {
          candidate.loading = false;
          if (current(candidate)) { renderPeople(candidate, 'pinned'); renderPeople(candidate, 'recent'); }
        }
      }
      function updateAvatar(candidate) {
        candidate.modal.querySelectorAll('[data-group-preset]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.groupPreset) === candidate.preset)));
        const button = candidate.modal.querySelector('#group-action-avatar');
        button.innerHTML = candidate.preview ? `<img src="${escape(candidate.preview)}" alt="自定义群头像">` : '<span aria-hidden="true">＋</span>';
        button.setAttribute('aria-pressed', String(candidate.preset === null));
      }
      async function selectFile(candidate, file) {
        if (!file || !current(candidate) || candidate.busy) return;
        const revision = ++candidate.avatarRevision;
        let preview;
        candidate.pending = true; sync(candidate); feedback(candidate, '');
        try {
          if (!/\.(jpe?g|png|gif|webp)$/i.test(file.name) || (file.type && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type))) throw Error('请选择 JPG、PNG、GIF 或 WebP 图片。');
          if (!file.size || file.size > 10 * 1024 * 1024) throw Error('群头像不能为空，且不能超过 10 MB。');
          preview = URL.createObjectURL(file); candidate.urls.add(preview);
          await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => image.naturalWidth && image.naturalHeight ? resolve() : reject(Error('图片内容无效。')); image.onerror = () => reject(Error('图片无法读取，请重新选择。')); image.src = preview; });
          if (!current(candidate) || candidate.avatarRevision !== revision) return;
          if (candidate.preview) { URL.revokeObjectURL(candidate.preview); candidate.urls.delete(candidate.preview); }
          candidate.file = file; candidate.preview = preview; candidate.preset = null; candidate.uploadedUrl = null; updateAvatar(candidate);
        } catch (error) { if (current(candidate) && candidate.avatarRevision === revision) feedback(candidate, error.message, true); }
        finally {
          if (preview && candidate.preview !== preview) { URL.revokeObjectURL(preview); candidate.urls.delete(preview); }
          if (candidate.avatarRevision === revision) { candidate.pending = false; if (current(candidate)) sync(candidate); }
        }
      }
      async function presetFile(candidate) {
        const url = URL.createObjectURL(new Blob([icon(presets[candidate.preset], true)], { type: 'image/svg+xml' })); candidate.urls.add(url);
        try {
          const image = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(Error('群头像生成失败，请重试。')); image.src = url; });
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 160; canvas.getContext('2d').drawImage(image, 0, 0, 160, 160);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
          if (!blob) throw Error('群头像生成失败，请重试。');
          return new File([blob], 'group-avatar.png', { type: 'image/png' });
        } finally { URL.revokeObjectURL(url); candidate.urls.delete(url); }
      }
      async function submit(candidate, event) {
        event.preventDefault();
        if (!current(candidate) || candidate.busy || candidate.loading || candidate.loadError || candidate.pending) return;
        if (candidate.group) return invite(candidate);
        const name = candidate.modal.querySelector('#group-action-value').value.trim();
        if (!name) { feedback(candidate, '请输入群名称。', true); candidate.modal.querySelector('#group-action-value').focus(); return; }
        candidate.busy = true;
        const controls = [...candidate.modal.querySelectorAll('input,button:not([data-close-modal])')]; controls.forEach(node => { node.disabled = true; });
        try {
          const signal = AbortSignal.any([candidate.controller.signal, AbortSignal.timeout(45000)]);
          if (!candidate.uploadedUrl) {
            feedback(candidate, '头像上传中，请稍候…');
            const file = candidate.file || await presetFile(candidate);
            if (!current(candidate)) return;
            const result = await upload(file, candidate.account.token, signal);
            if (!current(candidate)) return;
            if (!result?.url) throw Error('头像上传失败，请重试。');
            candidate.uploadedUrl = result.url;
          }
          feedback(candidate, '正在创建群聊，请稍候…');
          const group = await request('/conversations/groups', { method: 'POST', authToken: candidate.account.token, signal,
            body: JSON.stringify({ name, avatar_url: candidate.uploadedUrl, member_ids: [...candidate.selected], allow_member_add_friend: !candidate.modal.querySelector('#group-no-add').checked }) });
          if (!current(candidate)) return;
          if (!Number.isSafeInteger(Number(group?.id)) || Number(group.id) <= 0 || group.type !== 'group') throw Error('创建结果异常，请刷新群聊列表确认。');
          close(false); await onCreated(group, candidate.account);
        } catch (error) { if (current(candidate)) feedback(candidate, error.message || '创建群聊失败，请重试。', true); }
        finally { candidate.busy = false; if (current(candidate)) { controls.forEach(node => { node.disabled = false; }); sync(candidate); } }
      }
      async function invite(candidate) {
        if (!canInvite(candidate.group)) { feedback(candidate, '只有群主或管理员可以邀请新成员。', true); return; }
        const ids = [...candidate.selected];
        if (!ids.length) return;
        if (ids.length > candidate.remaining) { feedback(candidate, `当前群聊还可邀请 ${candidate.remaining} 人，请减少选择人数。`, true); return; }
        candidate.busy = true;
        const controls = [...candidate.modal.querySelectorAll('input,button:not([data-close-modal])')]; controls.forEach(node => { node.disabled = true; });
        const failures = []; let successes = 0;
        try {
          for (const id of ids) {
            if (!current(candidate)) return;
            feedback(candidate, `正在邀请 ${successes + failures.length + 1}/${ids.length}…`);
            try {
              const result = await request('/conversations/members', { method: 'POST', authToken: candidate.account.token,
                signal: AbortSignal.any([candidate.controller.signal, AbortSignal.timeout(15000)]),
                body: JSON.stringify({ conversation_id: Number(candidate.group.id), user_id: id, allow_history: window.PulseGoUI?.allowHistory() === true }) });
              if (!current(candidate)) return;
              if (Number(result?.conversation_id) !== Number(candidate.group.id) || Number(result?.user_id) !== id || result.status !== 'joined') throw Error('邀请结果异常，请刷新群成员后确认。');
              candidate.memberIds.add(id); candidate.selected.delete(id); candidate.remaining = Math.max(0, candidate.remaining - 1); successes++;
              candidate.group.member_count++;
              candidate.modal.querySelector('[data-invite-group-count]').textContent = `${candidate.group.member_count} 名成员`;
            } catch (error) {
              if (!current(candidate)) return;
              failures.push(`${candidate.people.find(person => person.id === id)?.name || '用户'}：${error.message || '邀请失败'}`);
            }
          }
          renderPeople(candidate, 'pinned'); renderPeople(candidate, 'recent');
          feedback(candidate, `已邀请 ${successes} 人` + (failures.length ? `；${failures.length} 人未成功：${failures.slice(0, 3).join('；')}${failures.length > 3 ? '等' : ''}` : ''), failures.length > 0);
          if (successes && current(candidate)) {
            try { await onInvited?.(candidate.group, candidate.account); }
            catch { if (current(candidate)) feedback(candidate, '邀请已完成，群资料刷新失败，请稍后重新打开。', true); }
          }
        } finally {
          candidate.busy = false;
          if (current(candidate)) { controls.forEach(node => { node.disabled = false; }); sync(candidate); }
        }
      }
      function open(group = null) {
        if (group && !canInvite(group)) return;
        close(false); const account = getAccount();
        if (!account.token || account.userId <= 0 || account.blocked) return;
        const previousFocus = document.activeElement;
        const column = (kind, title) => `<section class="group-create-column" aria-labelledby="group-create-${kind}-title"><h3 id="group-create-${kind}-title">${title}</h3><div class="group-create-search-row"><input type="search" data-group-search="${kind}" placeholder="搜索昵称/用户名/ID" aria-label="搜索${title}" autocomplete="off"><label class="group-create-all"><input type="checkbox" data-group-all="${kind}"><span>全选</span></label></div><div class="group-create-people" data-group-list="${kind}"></div></section>`;
        const modal = document.createElement('div'); modal.className = 'modal-backdrop feature-modal group-create-backdrop'; modal.dataset.featureModal = '';
        modal.innerHTML = `<section class="group-create-dialog" role="dialog" aria-modal="true" aria-labelledby="group-create-title"><header class="group-create-head"><h2 id="group-create-title">创建群聊</h2><button type="button" data-close-modal aria-label="关闭创建群聊">×</button></header><form id="group-action-form"><div class="group-create-fields"><label for="group-action-value">群名称</label><input id="group-action-value" placeholder="请输入群名称" aria-label="群名称" maxlength="128" required autocomplete="off"><span class="group-create-avatar-label">群头像</span><div class="group-create-avatars" role="group" aria-label="设置群头像">${presets.map((preset, index) => `<button type="button" data-group-preset="${index}" class="group-create-preset" style="--preset-color:${preset[1]}" aria-label="${preset[0]}群头像" aria-pressed="${index === 0}">${icon(preset)}</button>`).join('')}<button id="group-action-avatar" class="group-create-upload" type="button" aria-label="上传群头像" aria-pressed="false"><span aria-hidden="true">＋</span></button><input id="group-action-avatar-file" type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden></div></div><div class="group-create-members">${column('pinned', '置顶用户列表')}${column('recent', '最新消息用户列表')}</div><div class="group-create-status"><p id="group-action-feedback" role="status" aria-live="polite"></p><button type="button" data-group-retry hidden>重新加载</button></div><footer class="group-create-footer"><label class="group-create-privacy"><input id="group-no-add" type="checkbox"><span>禁止群成员互加好友</span></label><span data-group-selected>已选 0 人</span><button type="button" class="group-create-cancel" data-close-modal>取消</button><button type="submit" class="group-create-submit">创建</button></footer></form></section>`;
        if (group) {
          modal.dataset.groupInvite = String(group.id);
          modal.querySelector('.group-create-dialog').classList.add('group-invite-dialog');
          modal.querySelector('#group-create-title').textContent = '邀请新成员';
          modal.querySelector('.group-create-head [data-close-modal]').setAttribute('aria-label', '关闭邀请新成员');
          const context = document.createElement('div'); context.className = 'group-invite-context';
          context.innerHTML = `<span class="group-invite-avatar">${group.avatar_url ? `<img src="${escape(mediaUrl(group.avatar_url))}" alt="群头像">` : escape(Array.from(group.name || '群')[0])}</span><div><strong data-invite-group-name>${escape(group.name || '群聊')}</strong><small data-invite-group-count>${Number(group.member_count) || 0} 名成员</small></div>`;
          modal.querySelector('.group-create-fields').replaceWith(context);
          const hint = document.createElement('p'); hint.className = 'group-invite-hint'; hint.textContent = '邀请将遵循对方的隐私设置';
          modal.querySelector('.group-create-privacy').replaceWith(hint);
          modal.querySelector('[type="submit"]').textContent = '邀请';
        }
        document.body.append(modal);
        const candidate = view = { modal, account, group, memberIds: new Set(), remaining: 0, previousFocus, controller: new AbortController(), closed: false, busy: false, loading: false, loadError: false, pending: false, people: [], selected: new Set(), queries: { pinned: '', recent: '' }, preset: 0, file: null, preview: null, uploadedUrl: null, urls: new Set(), avatarRevision: 0 };
        modal.querySelectorAll('[data-close-modal]').forEach(button => { button.onclick = () => close(); });
        modal.onclick = event => { if (event.target === modal) close(); };
        modal.querySelectorAll('[data-group-search]').forEach(input => { input.oninput = () => { candidate.queries[input.dataset.groupSearch] = input.value; renderPeople(candidate, input.dataset.groupSearch); }; });
        modal.onchange = event => {
          const input = event.target;
          if (!current(candidate) || candidate.busy || !(input instanceof HTMLInputElement)) return;
          if (input.matches('[data-group-user]')) {
            const id = Number(input.dataset.groupUser);
            const person = candidate.people.find(person => person.id === id);
            if (!person || unavailable(candidate, person)) return sync(candidate);
            if (input.checked && candidate.selected.size >= selectionLimit(candidate)) feedback(candidate, candidate.group ? `当前群聊还可邀请 ${candidate.remaining} 人，请减少选择人数。` : '每个群聊最多 500 人（含群主），请减少选择人数。', true);
            else { if (input.checked) candidate.selected.add(id); else candidate.selected.delete(id); feedback(candidate, ''); }
          } else if (input.matches('[data-group-all]')) {
            const rows = selectable(candidate, input.dataset.groupAll), missing = rows.filter(row => !candidate.selected.has(row.id));
            if (input.checked && candidate.selected.size + missing.length > selectionLimit(candidate)) feedback(candidate, candidate.group ? `当前群聊还可邀请 ${candidate.remaining} 人，请先搜索或减少选择人数。` : '每个群聊最多 500 人（含群主），请先搜索或减少选择人数。', true);
            else { rows.forEach(row => { if (input.checked) candidate.selected.add(row.id); else candidate.selected.delete(row.id); }); feedback(candidate, ''); }
          }
          sync(candidate);
        };
        modal.querySelectorAll('[data-group-preset]').forEach(button => { button.onclick = () => {
          if (!current(candidate) || candidate.busy) return;
          candidate.avatarRevision++; candidate.pending = false; candidate.preset = Number(button.dataset.groupPreset); candidate.file = null; candidate.uploadedUrl = null;
          if (candidate.preview) { URL.revokeObjectURL(candidate.preview); candidate.urls.delete(candidate.preview); candidate.preview = null; }
          updateAvatar(candidate); sync(candidate); feedback(candidate, '');
        }; });
        const fileInput = modal.querySelector('#group-action-avatar-file');
        if (fileInput) {
          modal.querySelector('#group-action-avatar').onclick = () => { if (!candidate.busy) fileInput.click(); };
          fileInput.onchange = () => { const file = fileInput.files?.[0]; fileInput.value = ''; void selectFile(candidate, file); };
        }
        modal.querySelector('[data-group-retry]').onclick = () => { void loadPeople(candidate); };
        modal.querySelector('form').onsubmit = event => { void submit(candidate, event); };
        candidate.keydown = event => {
          if (!current(candidate)) return;
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          if (event.key === 'Tab') {
            const controls = [...modal.querySelectorAll('button:not(:disabled):not([hidden]),input:not(:disabled):not([hidden])')].filter(node => node.getClientRects().length);
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        };
        document.addEventListener('keydown', candidate.keydown, true);
        modal.querySelector(group ? '[data-group-search="pinned"]' : '#group-action-value').focus(); void loadPeople(candidate);
      }
      return { open, close, openInvite(group) { if (group?.type === 'group' && Number.isSafeInteger(Number(group.id)) && Number(group.id) > 0) open({ ...group, id: Number(group.id) }); } };
    },
  };
})();
