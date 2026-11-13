/* Shared by the desktop and web clients. Membership and the pin limit
 * remain authoritative on the server; local drafts never cross accounts/chats. */
(() => {
  'use strict';
  const PIN_LIMIT = 20;
  let key = '', token = '', conversationId = 0, revision = 0, request = 0;
  let pins = [], currentPin = 0, reply = null, replyRevision = 0, loading = null;
  let locating = 0, menu = null, press = null, suppressClickUntil = 0, clearedBefore = 0;
  let navigation = null, actionNavigationRevision = 0;
  const messages = new Map();
  const recalledTargets = new Set();
  const forwardTypes = new Set(['text', 'image', 'video', 'file', 'voice', 'contact_card']);
  let selecting = false, deleteDialog = null, memberDialog = null;
  const selectedMessages = new Set();
  const selectable = message => readableActionMessage(message) && forwardTypes.has(message.type);
  function selectionItems() {
    return [...selectedMessages].map(id => messages.get(id)).filter(selectable).sort((a, b) => Number(a.id) - Number(b.id));
  }
  function clearSelection() {
    selecting = false; selectedMessages.clear(); renderSelection();
  }
  function toggleSelection(message) {
    if (!selectable(message)) return;
    const id = Number(message.id);
    if (selectedMessages.has(id)) selectedMessages.delete(id);
    else if (selectedMessages.size < 100) selectedMessages.add(id);
    else { toast('一次最多选择 100 条消息'); return; }
    selecting = true; closeMenu(); clearPress(); renderSelection();
  }
  function renderSelection() {
    for (const id of selectedMessages) if (!selectable(messages.get(id))) selectedMessages.delete(id);
    let bar = document.getElementById('message-selection-bar');
    const list = document.getElementById('messages');
    if (selecting && visible() && !bar && list) {
      bar = document.createElement('section'); bar.id = 'message-selection-bar'; bar.className = 'message-selection-bar';
      bar.setAttribute('aria-label', '消息多选');
      bar.innerHTML = '<button type="button" data-selection-forward>转发</button><button type="button" data-selection-delete>删除</button><strong role="status" data-selection-count></strong><button type="button" data-selection-cancel>取消</button>';
      document.getElementById('chat-head')?.after(bar);
      bar.querySelector('[data-selection-cancel]').onclick = clearSelection;
      bar.querySelector('[data-selection-delete]').onclick = () => confirmDelete(selectionItems());
      bar.querySelector('[data-selection-forward]').onclick = () => {
        const items = selectionItems();
        if (items.length) openMessageForwardPicker(items, { onComplete: clearSelection });
      };
    }
    if (bar) {
      bar.hidden = !selecting || !visible();
      bar.querySelector('[data-selection-count]').textContent = `已选择 ${selectedMessages.size} 条消息`;
      const forward = bar.querySelector('[data-selection-forward]');
      forward.textContent = `转发 ${selectedMessages.size}`; forward.disabled = !selectedMessages.size;
      const remove = bar.querySelector('[data-selection-delete]');
      remove.textContent = `删除 ${selectedMessages.size}`; remove.disabled = !selectedMessages.size;
    }
    list?.classList.toggle('message-selection-active', selecting && visible());
    list?.querySelectorAll('.bubble[data-message-id]').forEach(node => {
      const id = Number(node.dataset.messageId), chosen = selectedMessages.has(id);
      node.classList.toggle('message-is-selected', selecting && chosen);
      let button = node.querySelector('[data-message-select]');
      if (!selecting || !visible() || !selectable(messages.get(id))) { button?.remove(); return; }
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.className = 'message-select-check'; button.dataset.messageSelect = String(id);
        node.append(button);
      }
      button.setAttribute('aria-label', chosen ? '取消选择此消息' : '选择此消息');
      button.setAttribute('aria-pressed', String(chosen)); button.textContent = chosen ? '✓' : '';
    });
  }
  const esc = value => escapeHtml(String(value ?? ''));
  const unavailable = item => !item || item.recalled_at || ['recalled', 'deleted'].includes(item.status) || messageVersionCache().get(Number(item.id))?.removed || recalledTargets.has(Number(item.id)) || (Number(item.id) > 0 && Number(item.id) <= clearedBefore);
  const activeKey = () => state.token && state.user && state.active && !state.favoriteMode && state.active.type !== 'favorites'
    ? `${state.token}:${Number(state.active.id)}` : '';
  const current = captured => captured === key && captured === activeKey();
  const visible = () => Boolean(key && key === activeKey() && state.desktopAccountVisible !== false && (!state.page || state.page === 'messages'));
  function canPublish() {
    const chat = state.active;
    if (!chat || chat.frozen_at || chat.status === 'frozen') return false;
    if (chat.can_publish === false || chat.can_publish === 0) return false;
    return chat.type !== 'channel' || chat.my_role === 'owner' || chat.my_role === 'admin';
  }
  function canManagePins() {
    return canPublish() && (state.active.type !== 'group' || ['owner', 'admin'].includes(state.active.my_role));
  }
  function copyableText(message) {
    const text = message?.body?.text;
    return typeof text === 'string' && text.trim() !== '' ? text : '';
  }
  function readableActionMessage(message) {
    return Boolean(visible() && !state.updateRequired && !unavailable(message) && Number.isSafeInteger(Number(message.id)) && Number(message.id) > 0
      && Number(message.conversation_id) === conversationId && !['system', 'red_packet'].includes(message.type));
  }
  function mutationActionAvailable(message, action, html = null) {
    if (action === 'recall' && !state.user?.internal_staff) return false;
    if (action === 'edit' && (!canEditMessage(message) || !canPublish())) return false;
    const id = Number(message.id);
    const attributes = action === 'edit' ? ['data-internal-edit'] : ['data-internal-recall', 'data-recall-id'];
    if (typeof html === 'string') return attributes.some(attribute => new RegExp(`(?:^|\\s)${attribute}="${id}"`).test(html));
    const bubble = document.querySelector(`#messages [data-message-id="${id}"]`);
    return attributes.some(attribute => bubble?.querySelector(`[${attribute}="${id}"]`));
  }
  function hasMessageActions(message, html = null) {
    return readableActionMessage(message) && (canPublish() || copyableText(message) !== '' || forwardTypes.has(message.type)
      || mutationActionAvailable(message, 'edit', html) || mutationActionAvailable(message, 'recall', html));
  }
  function captureActionContext(message) {
    return { key, token: state.token, userId: Number(state.user?.id), historyEpoch: state.historyEpoch, navigationRevision: actionNavigationRevision,
      page: state.page, sidebarMode: state.sidebarMode, messageId: Number(message.id) };
  }
  function currentActionSession(context) {
    return Boolean(context && current(context.key) && state.token === context.token && Number(state.user?.id) === context.userId
      && state.historyEpoch === context.historyEpoch && actionNavigationRevision === context.navigationRevision
      && state.page === context.page && state.sidebarMode === context.sidebarMode && visible());
  }
  function currentActionMessage(context) {
    if (!currentActionSession(context)) return null;
    const message = messages.get(context.messageId);
    const node = document.querySelector(`#messages [data-message-id="${context.messageId}"]`);
    return readableActionMessage(message) && node?.isConnected && !node.classList.contains('recalled') ? message : null;
  }
  async function copyMessageText(context, text) {
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('当前环境不支持直接复制，请使用浏览器的复制功能。');
      await navigator.clipboard.writeText(text);
      if (currentActionMessage(context)) toast('已复制');
    } catch (error) {
      if (currentActionMessage(context)) toast(error?.name === 'NotAllowedError' ? '复制失败，请允许剪贴板权限后重试。' : '复制失败，请检查剪贴板权限或使用浏览器的复制功能。');
    }
  }
  async function forwardMessage(context, message) {
    try { await openMessageForwardPicker(selecting && selectionItems().length ? selectionItems() : message, { onComplete: clearSelection }); }
    catch (error) { if (currentActionMessage(context)) toast(error.message || '暂时无法打开转发，请重试。'); }
  }

  function applyDeletion(data) {
    if (Number(data?.user_id) !== Number(state.user?.id) || !Array.isArray(data.message_ids)) return;
    const chat = Number(data.conversation_id), ids = data.message_ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
    for (const id of ids) {
      const tombstone = { id, conversation_id: chat, status: 'deleted', body: {} };
      rememberRecoveryMessage('message.deleted', tombstone);
      if (chat !== conversationId) continue;
      messages.delete(id); recalledTargets.add(id); selectedMessages.delete(id);
      document.querySelector(`#messages .bubble[data-message-id="${id}"]`)?.remove();
      pins = pins.filter(item => Number(item.id) !== id);
      if (reply?.id === id) { reply = null; replyRevision++; }
      document.querySelectorAll(`#messages [data-quote-id="${id}"]`).forEach(node => { node.outerHTML = quoteHtml({ id, unavailable: true }); });
    }
    if (chat === conversationId) { closeMenu(); renderBars(); renderSelection(); revision++; request++; refresh(); }
    void loadConversations();
  }
  function closeDeleteDialog() {
    deleteDialog?.remove(); deleteDialog = null;
  }
  function confirmDelete(items) {
    const sources = items.filter(selectable); if (!sources.length || deleteDialog) return;
    const context = captureActionContext(sources[0]), ids = sources.map(item => Number(item.id)), chat = conversationId;
    const overlay = document.createElement('div'); overlay.className = 'message-delete-backdrop'; overlay.dataset.messageDelete = '';
    overlay.innerHTML = `<section class="message-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="message-delete-title"><h2 id="message-delete-title">删除 ${ids.length} 条消息？</h2><p>仅从你的聊天记录中删除，对方的记录会保留。</p><p data-delete-feedback role="status"></p><footer><button type="button" data-delete-cancel>取消</button><button type="button" data-delete-confirm>删除</button></footer></section>`;
    const previousFocus = document.activeElement;
    const close = () => { if (deleteDialog === overlay) closeDeleteDialog(); if (currentActionSession(context)) previousFocus?.focus(); };
    let busy = false;
    overlay.onclick = async event => {
      if ((event.target === overlay || event.target.closest('[data-delete-cancel]')) && !busy) { close(); return; }
      if (!event.target.closest('[data-delete-confirm]') || busy) return;
      if (!currentActionSession(context)) { close(); return; }
      if (!ids.every(id => selectable(messages.get(id)))) { close(); toast('所选消息已变化，请重新选择'); return; }
      busy = true; overlay.querySelectorAll('button').forEach(button => { button.disabled = true; });
      const feedback = overlay.querySelector('[data-delete-feedback]'); feedback.textContent = '正在删除…';
      try {
        const data = await api('/messages/delete', { method: 'POST', authToken: context.token, signal: AbortSignal.timeout(15000), body: JSON.stringify({ conversation_id: chat, message_ids: ids }) });
        if (!currentActionSession(context)) return;
        if (Number(data.conversation_id) !== chat || Number(data.user_id) !== context.userId || !Array.isArray(data.message_ids) || ids.some(id => !data.message_ids.includes(id))) throw Error('删除结果无效，请重试');
        applyDeletion(data); clearSelection(); close(); toast(`已删除 ${ids.length} 条消息`);
      } catch (error) {
        if (currentActionSession(context) && deleteDialog === overlay) {
          if (ids.every(id => messageVersionCache().get(id)?.message?.status === 'deleted')) { clearSelection(); close(); toast(`已删除 ${ids.length} 条消息`); }
          else { feedback.textContent = error.message || '删除失败，请重试'; overlay.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
        }
      } finally { busy = false; }
    };
    overlay.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) close(); }
      if (event.key === 'Tab') {
        const buttons = [...overlay.querySelectorAll('button:not(:disabled)')];
        if (!buttons.length) { event.preventDefault(); return; }
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.body.append(overlay); deleteDialog = overlay; overlay.querySelector('[data-delete-cancel]').focus();
  }
  const menuIcon = name => {
    const paths = {
      reply: '<path d="m9 4-7 7 7 7v-4c6-1 9 1 11 5 1-8-3-13-11-12Z"/>',
      copy: '<rect x="7" y="5" width="11" height="15" rx="1.8"/><path d="M14 2H5a2 2 0 0 0-2 2v12"/>',
      forward: '<path d="m14 3 8 8-8 7v-5C7 13 4 16 2 20 1 10 6 7 14 7Z"/>',
      delete: '<path d="M4 6h16M9 3h6M6 6l1 15h10l1-15"/>',
      cancel: '<circle cx="12" cy="12" r="10"/><path d="m7 12 3 3 7-7"/>',
      select: '<circle cx="12" cy="12" r="10"/><path d="m7 12 3 3 7-7"/>',
      pin: '<path d="m8 3 9 4-3 5v4l-5-2-4 2 2-5L8 3Zm1 11-4 7"/>',
      edit: '<path d="m4 16-1 5 5-1L21 7l-4-4Z M14 6l4 4"/>',
      recall: '<path d="M4 5v6h6M4 11a8 8 0 1 1 1 7"/>',
      mute: '<path d="M10 5 6 8H3v8h3l4 3V5ZM14 9l6 6m0-6-6 6M3 3l18 18"/>',
      mention: '<circle cx="11" cy="12" r="4"/><path d="M15 8v7c0 3 6 2 6-3a10 10 0 1 0-4 8"/>',
      remove: '<path d="M4 6h16M9 3h6M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
      clock: '<path d="M8 2h4v4M5 5a9 9 0 1 0 7-2M12 8v5l-3 2"/>'
    };
    return `<svg class="message-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.select}</svg>`;
  };
  function menuTime(message) {
    const date = new Date(String(message.created_at || '').replace(' ', 'T'));
    if (!Number.isFinite(date.getTime())) return '';
    const now = new Date(), yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    const day = date.toDateString() === now.toDateString() ? '今天' : date.toDateString() === yesterday.toDateString() ? '昨天' : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
    return `${day} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  function summary(message) {
    const body = message?.body || {};
    if (unavailable(message)) return { id: Number(message?.id), unavailable: true, sender_name: '会话成员', text: '原消息已不可查看' };
    return {
      id: Number(message?.id), sender_id: Number(message?.sender_id),
      sender_id: Number(message?.sender_id) || 0,
      sender_name: message?.sender_name || message?.sender?.nickname || (Number(message?.sender_id) === Number(state.user?.id) ? state.user.nickname : '会话成员') || '我',
      type: message?.type || 'text',
      text: unavailable(message) ? '原消息已不可查看' : String(body.text || ({ image: '图片', video: '视频', voice: '语音', file: body.name || '文件', contact_card: '名片', poll: '投票', shake: '窗口抖动' }[message?.type]) || '消息'),
      thumbnail_url: message?.type === 'image' ? body.url : '', unavailable: Boolean(unavailable(message))
    };
  }
  function thumbnail(item, extra = '') {
    if (!item?.thumbnail_url || item.unavailable) return '';
    const url = mediaUrl(item.thumbnail_url);
    // Only the image element consumes this URL; no HTML, CSS or script injection.
    return `<img class="message-action-thumb ${extra}" src="${esc(url)}" alt="" loading="lazy">`;
  }
  function toast(text) {
    document.getElementById('message-action-toast')?.remove();
    const node = document.createElement('div'); node.id = 'message-action-toast';
    node.className = 'message-action-toast'; node.setAttribute('role', 'status'); node.textContent = text;
    document.body.append(node); setTimeout(() => node.remove(), 4000);
  }
  function clearPress() { if (press) clearTimeout(press.timer); press = null; }
  function closeMenu() {
    menu?.remove(); menu = null;
    document.querySelectorAll('[data-message-menu][aria-expanded="true"],[data-group-avatar-message][aria-expanded="true"]').forEach(node => node.setAttribute('aria-expanded', 'false'));
  }
  function groupAuthorName(message) {
    return contactDisplayName(message?.sender_id, message?.sender_name || message?.sender?.nickname || '会话成员');
  }
  function authorHtml(item, prefix = '') {
    const fallback = item?.sender_name || '会话成员';
    return `<strong data-contact-name-user="${Number(item?.sender_id) || 0}" data-contact-name-fallback="${esc(fallback)}" data-contact-name-prefix="${esc(prefix)}">${esc(prefix + contactDisplayName(item?.sender_id, fallback))}</strong>`;
  }
  function refreshContactNames() {
    for (const button of document.querySelectorAll('#messages [data-group-avatar-message]')) {
      const message = messages.get(Number(button.dataset.groupAvatarMessage));
      if (!message) continue;
      const name = groupAuthorName(message);
      button.title = name; button.setAttribute('aria-label', name + '的群成员操作');
      if (!button.querySelector('img') && button.textContent !== Array.from(name)[0]) button.textContent = Array.from(name)[0];
      const image = button.querySelector('img'); if (image) image.dataset.messageAvatarFallback = Array.from(name)[0];
    }
  }
  function groupMentionName(message) {
    // Mentions use the server's public nickname, never the viewer's contact remark.
    for (const value of [message?.sender_name, message?.sender_nickname, message?.sender?.nickname]) {
      const name = Array.from(String(value || '').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim()).slice(0, 80).join('');
      if (name) return name;
    }
    return '';
  }
  function groupActionMessage(context) {
    const message = currentActionMessage(context);
    return message && !selecting && state.active?.type === 'group' && Number(message.sender_id) !== Number(state.user?.id)
      && Number.isSafeInteger(Number(message.sender_id)) && Number(message.sender_id) > 0
      && (context.senderId === undefined || context.senderId === Number(message.sender_id)) ? message : null;
  }
  function mentionAvailable() {
    const input = document.getElementById('message-input');
    return Boolean(state.active?.type === 'group' && ['owner', 'admin'].includes(state.active.my_role)
      && input && !input.disabled && !input.readOnly && canPublish() && !state.updateRequired
      && !state.textSending && !state.mediaSending && !state.voiceRecording && !state.recordingOpening && !state.voiceDraft?.sending);
  }
  function mentionMember(context) {
    const message = groupActionMessage(context); if (!message) return;
    if (!mentionAvailable()) { toast('当前无法输入，请稍后再试'); return; }
    const input = document.getElementById('message-input'), start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    const name = groupMentionName(message);
    if (!name) { toast('成员昵称暂不可用，请刷新后重试'); return; }
    const mention = `${start > 0 && !/\s/u.test(input.value[start - 1]) ? ' ' : ''}@${name} `;
    if (input.maxLength > 0 && input.value.length - (end - start) + mention.length > input.maxLength) { toast('输入内容已达到长度上限'); return; }
    input.focus(); input.setRangeText(mention, start, end, 'end'); input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  async function readGroupPermission(context) {
    if (!groupActionMessage(context)) return null;
    const chat = Number(state.active.id);
    const [profile, roster] = await Promise.all([
      api(`/conversations/groups/profile?conversation_id=${chat}`, { authToken: context.token, signal: AbortSignal.timeout(12000) }),
      api(`/conversations/members?conversation_id=${chat}`, { authToken: context.token, signal: AbortSignal.timeout(12000) })
    ]);
    if (!groupActionMessage(context)) return null;
    if (Number(profile.conversation_id) !== chat || Number(roster.conversation_id) !== chat || !Array.isArray(roster.items)) throw Error('群成员信息无效，请重试');
    const target = roster.items.find(item => Number(item.user_id) === context.senderId);
    let reason = '';
    if (profile.status !== 'active') reason = '该群组已停用';
    else if (!['owner', 'admin'].includes(profile.my_role)) reason = '仅群主或管理员可操作';
    else if (!target) reason = '该成员已不在群内';
    else if (Number(profile.owner_id) === context.senderId || target.role === 'owner') reason = '不能对群主执行此操作';
    else if (profile.my_role !== 'owner' && target.role !== 'member') reason = '管理员不能管理其他管理员';
    return { profile, roster, target, allowed: reason === '', reason };
  }
  function memberIsMuted(member) {
    if (typeof member?.is_muted === 'boolean') return member.is_muted;
    return member?.muted_permanent === true || Date.parse(String(member?.muted_until || '').replace(' ', 'T')) > Date.now();
  }
  async function setMemberMute(context, permission, node) {
    if (!permission?.allowed || menu !== node || !groupActionMessage(context)) return;
    const chat = Number(state.active.id), targetId = context.senderId, minutes = memberIsMuted(permission.target) ? 0 : -1;
    node.querySelectorAll('button').forEach(button => { button.disabled = true; });
    node.querySelector('[data-member-action="mute"] .message-menu-label').textContent = minutes === 0 ? '正在解除禁言…' : '正在禁言…';
    try {
      const fresh = await readGroupPermission(context);
      if (menu !== node || !groupActionMessage(context) || !fresh) return;
      if (!fresh.allowed) throw Error(fresh.reason);
      // Preserve the displayed intent, including retries after an uncertain response.
      const result = await api('/conversations/members/mute', { method: 'POST', authToken: context.token,
        signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        body: JSON.stringify({ conversation_id: chat, user_id: targetId, minutes }) });
      if (menu !== node || !groupActionMessage(context)) return;
      if (Number(result.conversation_id) !== chat || Number(result.user_id) !== targetId ||
          (minutes === 0 ? result.muted_until !== null : result.muted_permanent !== true || !String(result.muted_until).startsWith('9999-'))) throw Error('操作结果尚未确认，请重新右键查看');
      const cached = context.rosterMember?.();
      if (cached) Object.assign(cached, {muted_until:result.muted_until, muted_permanent:result.muted_permanent, is_muted:result.is_muted});
      closeMenu(); context.memberChanged?.(); toast(minutes === 0 ? '已解除禁言' : '已永久禁言');
    } catch (error) {
      if (menu === node && groupActionMessage(context)) { closeMenu(); toast(error.message || '操作失败，请重新右键重试'); }
    }
  }
  function closeMemberDialog() { memberDialog?.remove(); memberDialog = null; }
  function confirmMemberAction(action, context, permission) {
    const message = groupActionMessage(context); if (!message || !permission?.allowed || memberDialog) return;
    const chat = Number(state.active.id), targetId = Number(message.sender_id), mute = action === 'mute';
    const overlay = document.createElement('div'); overlay.className = 'message-delete-backdrop group-member-backdrop'; overlay.dataset.groupMemberDialog = action;
    overlay.innerHTML = `<section class="message-delete-dialog group-member-dialog" role="dialog" aria-modal="true" aria-labelledby="group-member-dialog-title"><h2 id="group-member-dialog-title">${mute ? '禁言设置' : '踢出群聊'}</h2><p>${mute ? `为「${esc(groupAuthorName(message))}」设置禁言时长。` : `确定将「${esc(groupAuthorName(message))}」踢出群聊吗？`}</p>${mute ? '<label class="group-mute-label">禁言时长<select data-group-mute-minutes><option value="-1">永久禁言</option><option value="0">解除禁言</option></select></label>' : ''}<p data-member-feedback role="status"></p><footer><button type="button" data-member-cancel>取消</button><button type="button" data-member-confirm>${mute ? '禁言' : '踢出群聊'}</button></footer></section>`;
    const previousFocus = document.activeElement;
    const close = () => { if (memberDialog === overlay) closeMemberDialog(); if (groupActionMessage(context)) previousFocus?.focus(); };
    const currentDialog = () => memberDialog === overlay && overlay.isConnected && Boolean(groupActionMessage(context));
    const select = overlay.querySelector('[data-group-mute-minutes]');
    if (select) select.onchange = () => { overlay.querySelector('[data-member-confirm]').textContent = select.value === '0' ? '解除禁言' : '禁言'; };
    let busy = false, attempted = false;
    overlay.onclick = async event => {
      if ((event.target === overlay || event.target.closest('[data-member-cancel]')) && !busy) { close(); return; }
      if (!event.target.closest('[data-member-confirm]') || busy) return;
      if (!currentDialog()) { close(); return; }
      const minutes = mute ? Number(select.value) : null;
      if (mute && ![-1, 0].includes(minutes)) return;
      busy = true; overlay.querySelectorAll('button,select').forEach(control => { control.disabled = true; });
      const feedback = overlay.querySelector('[data-member-feedback]'); feedback.textContent = '正在检查群管理权限…';
      try {
        const fresh = await readGroupPermission(context);
        if (!currentDialog() || !fresh) return;
        if (!fresh.allowed) {
          if (!mute && attempted && ['owner', 'admin'].includes(fresh.profile.my_role) && !fresh.target) { close(); toast('该成员已不在群内'); return; }
          throw Error(fresh.reason);
        }
        feedback.textContent = mute ? '正在更新禁言…' : '正在移出成员…';
        attempted = true;
        const result = await api(`/conversations/members/${mute ? 'mute' : 'remove'}`, { method: 'POST', authToken: context.token, signal: AbortSignal.timeout(15000), body: JSON.stringify({ conversation_id: chat, user_id: targetId, ...(mute ? { minutes } : {}) }) });
        if (!currentDialog()) return;
        if (Number(result.conversation_id) !== chat || Number(result.user_id) !== targetId || (mute ? !Object.hasOwn(result, 'muted_until') : result.status !== 'removed')) throw Error('操作结果无效，请重试');
        if (!mute) { state.active.member_count = Math.max(0, Number(fresh.roster.member_count) - 1); updateDesktopChat(); }
        close(); toast(mute ? minutes === 0 ? '已解除禁言' : '已设置禁言' : '已踢出群聊');
      } catch (error) {
        if (currentDialog()) { feedback.textContent = error.message || '操作失败，请重试'; overlay.querySelectorAll('button,select').forEach(control => { control.disabled = false; }); }
      } finally { busy = false; }
    };
    overlay.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) close(); }
      if (event.key === 'Tab') {
        const controls = [...overlay.querySelectorAll('button:not(:disabled),select:not(:disabled)')];
        if (!controls.length) { event.preventDefault(); return; }
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.body.append(overlay); memberDialog = overlay; (select || overlay.querySelector('[data-member-cancel]')).focus();
  }
  function showGroupMemberMenu(message, x, y, opener) {
    activate(); closeMenu();
    if (!readableActionMessage(message)) return;
    const context = captureActionContext(message); context.senderId = Number(message?.sender_id);
    if (!groupActionMessage(context) || memberDialog || deleteDialog) return;
    const node = document.createElement('div'); node.className = 'message-action-menu group-member-menu'; node.setAttribute('role', 'menu'); node.setAttribute('aria-label', '群成员操作');
    const row = (action, label, disabled, title = '') => `<button type="button" role="menuitem" data-member-action="${action}"${disabled ? ' disabled' : ''} title="${esc(title)}">${menuIcon(action)}<span class="message-menu-label">${esc(label)}</span></button>`;
    node.innerHTML = row('mute', '禁言', true, '正在检查群管理权限') + (['owner', 'admin'].includes(state.active.my_role) ? row('mention', '@他', true, '正在检查群管理权限') : '') + row('remove', '踢出群聊', true, '正在检查群管理权限');
    document.body.append(node); menu = node;
    const scale = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    node.style.maxHeight = `${Math.max(1, innerHeight - 16) / scale}px`; node.style.overflowY = 'auto';
    const rect = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8)) / scale}px`;
    node.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8)) / scale}px`;
    opener?.setAttribute('aria-expanded', 'true');
    let permission = null;
    node.onclick = async event => {
      const button = event.target.closest('[data-member-action]'); if (!button || button.disabled || menu !== node || !groupActionMessage(context)) return;
      const action = button.dataset.memberAction;
      if (action === 'mute') { await setMemberMute(context, permission, node); return; }
      closeMenu();
      if (action === 'mention' && permission?.profile.status === 'active' && ['owner', 'admin'].includes(permission.profile.my_role)) mentionMember(context);
      else if (permission?.allowed) confirmMemberAction(action, context, permission);
    };
    node.onkeydown = event => {
      const buttons = [...node.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (buttons.length) buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
      }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); opener?.focus(); }
      if (event.key === 'Tab') closeMenu();
    };
    node.querySelector('button:not(:disabled)')?.focus();
    void readGroupPermission(context).then(result => {
      if (menu !== node || !node.isConnected || !groupActionMessage(context) || !result) return;
      permission = result;
      node.querySelector('[data-member-action="mute"] .message-menu-label').textContent = memberIsMuted(result.target) ? '解除禁言' : '禁言';
      const mention = node.querySelector('[data-member-action="mention"]');
      if (mention) {
        if (result.profile.status !== 'active' || !['owner', 'admin'].includes(result.profile.my_role)) mention.remove();
        else { mention.disabled = !mentionAvailable(); mention.title = mention.disabled ? '当前无法输入' : ''; }
      }
      for (const action of ['mute', 'remove']) { const button = node.querySelector(`[data-member-action="${action}"]`); button.disabled = !result.allowed || state.updateRequired; button.title = state.updateRequired ? '请先更新客户端' : result.reason; }
    }).catch(error => {
      if (menu !== node || !groupActionMessage(context)) return;
      for (const button of node.querySelectorAll('[data-member-action="mute"],[data-member-action="remove"]')) button.title = error.message || '无法检查群管理权限，请重新打开菜单';
      toast(error.message || '无法检查群管理权限，请重新打开菜单');
    });
  }
  function stopNavigation() {
    locating++;
    const previous = navigation; navigation = null;
    if (!previous) return;
    cancelAnimationFrame(previous.frame); clearTimeout(previous.highlightTimer);
    previous.mutations?.disconnect(); previous.resize?.disconnect();
    previous.list.removeEventListener('load', previous.schedule, true);
    previous.list.removeEventListener('error', previous.schedule, true);
    previous.list.removeEventListener('loadedmetadata', previous.schedule, true);
    window.removeEventListener('resize', previous.schedule);
    previous.list.style.overflowAnchor = previous.overflowAnchor;
    previous.list.style.scrollBehavior = previous.scrollBehavior;
    previous.list.querySelectorAll('.message-action-highlight').forEach(node => { node.classList.remove('message-action-highlight'); node.style.animationDelay = ''; });
  }
  function holdsNavigation(list) {
    return Boolean(navigation && navigation.list === list && current(navigation.key) && visible());
  }
  function alignNavigation() {
    const active = navigation; if (!active) return;
    active.frame = 0;
    if (!holdsNavigation(active.list) || !active.list.isConnected || unavailable({ id: active.id })) { stopNavigation(); return; }
    if (!active.ready) return;
    const target = active.list.querySelector(`[data-message-id="${active.id}"]`);
    if (!target || target.classList.contains('recalled')) { stopNavigation(); return; }
    const box = active.list.getBoundingClientRect(), rect = target.getBoundingClientRect();
    // Scroll only the message viewport. Keep the same message anchored when a
    // recovery redraw or an image above it changes the layout after the click.
    const offset = rect.height > active.list.clientHeight - 24 ? 12 : Math.max(12, (active.list.clientHeight - rect.height) / 2);
    const top = active.list.scrollTop + rect.top - box.top - active.list.clientTop - offset;
    active.list.scrollTop = Math.max(0, Math.min(top, active.list.scrollHeight - active.list.clientHeight));
    if (Date.now() < active.highlightUntil && !target.classList.contains('message-action-highlight')) {
      target.style.animationDelay = `${-Math.max(0, Date.now() - active.started)}ms`;
      target.classList.add('message-action-highlight');
    }
  }
  function scheduleNavigation() {
    if (navigation && !navigation.frame) navigation.frame = requestAnimationFrame(alignNavigation);
  }
  function navigationReady(active) {
    active.ready = true; active.started = Date.now(); active.highlightUntil = active.started + 2200;
    clearTimeout(active.highlightTimer);
    active.highlightTimer = setTimeout(() => {
      if (navigation !== active) return;
      active.list.querySelectorAll('.message-action-highlight').forEach(node => { node.classList.remove('message-action-highlight'); node.style.animationDelay = ''; });
    }, 2250);
  }
  function startNavigation(id, seq, ready) {
    const list = document.getElementById('messages'); if (!list) return;
    const active = { key, id, seq, list, ready, frame: 0, started: Date.now(), highlightUntil: Date.now() + 2200,
      overflowAnchor: list.style.overflowAnchor, scrollBehavior: list.style.scrollBehavior, schedule: scheduleNavigation };
    navigation = active; list.style.overflowAnchor = 'none'; list.style.scrollBehavior = 'auto';
    const observeSizes = () => {
      if (navigation !== active) return;
      active.resize?.disconnect(); active.resize?.observe(list);
      for (const node of list.children) active.resize?.observe(node);
    };
    if (typeof ResizeObserver === 'function') active.resize = new ResizeObserver(scheduleNavigation);
    active.mutations = new MutationObserver(() => { observeSizes(); scheduleNavigation(); });
    active.mutations.observe(list, { childList: true, subtree: true, characterData: true }); observeSizes();
    for (const event of ['load', 'error', 'loadedmetadata']) list.addEventListener(event, active.schedule, true);
    window.addEventListener('resize', active.schedule);
    if (ready) navigationReady(active);
    scheduleNavigation();
  }
  function activate() {
    const next = activeKey();
    if (next !== key) {
      selecting = false; selectedMessages.clear(); closeDeleteDialog(); closeMemberDialog();
      stopNavigation();
      key = next; token = state.token; conversationId = Number(state.active?.id || 0);
      revision++; request++; locating++; loading = null; pins = []; currentPin = 0;
      reply = null; replyRevision++; messages.clear(); recalledTargets.clear(); clearedBefore = 0; clearPress(); closeMenu();
      document.getElementById('message-pins-list')?.remove();
    }
    const cutoff = Number(state.active?.cleared_before_message_id || 0);
    if (cutoff > clearedBefore) {
      clearedBefore = cutoff; revision++; request++;
      if (navigation && navigation.id <= cutoff) stopNavigation();
      pins = pins.filter(item => Number(item.id) > cutoff);
      if (reply && reply.id <= cutoff) reply = { id: reply.id, unavailable: true, sender_name: '会话成员', text: '原消息已不可查看' };
      document.querySelectorAll('#messages [data-quote-id]').forEach(node => { if (Number(node.dataset.quoteId) <= cutoff) node.outerHTML = quoteHtml({ id: Number(node.dataset.quoteId), unavailable: true }); });
    }
    renderBars();
    renderSelection();
  }
  function mount() {
    const head = document.getElementById('chat-head'), composer = document.getElementById('composer');
    if (head && !document.getElementById('message-pins-bar')) {
      const bar = document.createElement('section'); bar.id = 'message-pins-bar';
      bar.className = 'message-pins-bar'; bar.hidden = true; bar.setAttribute('aria-label', '置顶消息');
      head.after(bar);
    }
    if (composer && !document.getElementById('message-reply-draft')) {
      const bar = document.createElement('section'); bar.id = 'message-reply-draft';
      bar.className = 'message-reply-draft'; bar.hidden = true; bar.setAttribute('aria-label', '正在引用回复');
      composer.before(bar);
    }
  }
  function renderBars() {
    if (reply && !reply.unavailable && unavailable({ id: reply.id })) {
      reply = { id: reply.id, unavailable: true, sender_name: '会话成员', text: '原消息已不可查看' }; replyRevision++;
    }
    mount();
    const bar = document.getElementById('message-pins-bar'), draft = document.getElementById('message-reply-draft');
    if (bar) {
      bar.hidden = !visible() || !pins.length;
      if (!bar.hidden) {
        currentPin = Math.min(Math.max(0, currentPin), pins.length - 1);
        const item = summary(pins[currentPin]);
        bar.innerHTML = `<button type="button" class="message-pin-open" aria-label="定位置顶消息">${thumbnail(item)}<span><strong>置顶消息${pins.length > 1 ? ` <em>${currentPin + 1}/${pins.length}</em>` : ''}</strong><small>${esc(item.text)}</small></span></button>${pins.length > 1 ? '<button type="button" class="message-pin-next" aria-label="下一条置顶消息">⌄</button>' : ''}<button type="button" class="message-pin-list-button" aria-label="查看全部置顶消息">☷</button>${canManagePins() ? '<button type="button" class="message-pin-remove" aria-label="取消这条置顶">×</button>' : ''}`;
        bar.querySelector('.message-pin-open').onclick = () => locate(item.id);
        bar.querySelector('.message-pin-next')?.addEventListener('click', () => { currentPin = (currentPin + 1) % pins.length; renderBars(); locate(pins[currentPin].id); });
        bar.querySelector('.message-pin-list-button').onclick = showPins;
        bar.querySelector('.message-pin-remove')?.addEventListener('click', () => mutatePin(pins[currentPin], false));
        bar.querySelectorAll('img').forEach(img => { img.onerror = () => img.remove(); });
      } else bar.replaceChildren();
    }
    if (draft) {
      draft.hidden = !visible() || !reply;
      if (!draft.hidden) {
        draft.innerHTML = `<span class="message-reply-arrow" aria-hidden="true">↩</span>${thumbnail(reply)}<button type="button" class="message-reply-source" ${reply.unavailable ? 'disabled' : ''}>${authorHtml(reply, '回复 ')}<small>${esc(reply.text)}</small></button><button type="button" class="message-reply-cancel" aria-label="取消引用回复">×</button>`;
        draft.querySelector('.message-reply-source').onclick = () => locate(reply.id);
        draft.querySelector('.message-reply-cancel').onclick = () => { reply = null; replyRevision++; renderBars(); };
      } else draft.replaceChildren();
    }
    if (!visible()) { if (navigation) stopNavigation(); closeMenu(); document.getElementById('message-pins-list')?.remove(); }
  }
  function applySnapshot(snapshot) {
    if (!snapshot || Number(snapshot.conversation_id) !== conversationId) return;
    const previousId = Number(pins[currentPin]?.id);
    const unique = new Map((snapshot.items || []).filter(item => Number(item.conversation_id) === conversationId && Number(item.id) > clearedBefore && !recalledTargets.has(Number(item.id)) && !unavailable(item)).map(item => [Number(item.id), item]));
    pins = [...unique.values()].slice(0, PIN_LIMIT);
    currentPin = Math.max(0, pins.findIndex(item => Number(item.id) === previousId));
    for (const item of pins) messages.set(Number(item.id), item);
    renderBars();
    if (document.getElementById('message-pins-list')) showPins();
  }
  async function refresh() {
    activate(); if (!key) return;
    if (loading?.key === key) { loading.again = true; return loading.promise; }
    const captured = key, capturedToken = token, id = conversationId, version = revision, seq = ++request;
    const task = { key: captured, again: false };
    task.promise = (async () => {
      try {
        const result = await api(`/messages/pins?conversation_id=${id}`, { authToken: capturedToken, signal: AbortSignal.timeout(12000) });
        if (current(captured) && version === revision && seq === request) applySnapshot(result);
      } catch (error) {
        if (current(captured) && version === revision) {
          // A failed authorization must not retain content cached from a former membership.
          pins = []; renderBars(); console.warn('置顶消息暂未加载：', error.message);
        }
      } finally {
        if (loading === task) { loading = null; if (task.again && current(captured)) refresh(); }
      }
    })();
    loading = task; return task.promise;
  }
  async function mutatePin(message, pin) {
    activate(); if (!key || !message || Number(message.conversation_id) !== conversationId || !canManagePins()) return;
    if (pin && !pins.some(item => Number(item.id) === Number(message.id)) && pins.length >= PIN_LIMIT) { toast(`每个会话最多置顶 ${PIN_LIMIT} 条消息，请先取消一条置顶`); return; }
    const captured = key, capturedToken = token, id = conversationId;
    if (mutatePin.busy) return;
    mutatePin.busy = true;
    const version = ++revision; request++;
    try {
      const result = await api(pin ? '/messages/pin' : '/messages/unpin', { method: 'POST', authToken: capturedToken, signal: AbortSignal.timeout(12000), body: JSON.stringify({ conversation_id: id, message_id: Number(message.id) }) });
      if (current(captured) && version === revision) { applySnapshot(result); toast(pin ? '已置顶消息' : '已取消置顶'); }
    } catch (error) { if (current(captured)) { toast(error.message || '操作失败，请重试'); refresh(); } }
    finally { mutatePin.busy = false; }
  }
  function selectReply(message) {
    activate();
    if (!current(key) || unavailable(message) || Number(message.conversation_id) !== conversationId || !canPublish()) return;
    reply = summary(message); replyRevision++; renderBars(); document.getElementById('message-input')?.focus();
  }
  function showMenu(message, x, y, opener) {
    activate(); closeMenu();
    if (!hasMessageActions(message)) return;
    const context = captureActionContext(message);
    const node = document.createElement('div'); node.className = 'message-action-menu'; node.setAttribute('role', 'menu');
    const pinned = pins.some(item => Number(item.id) === Number(message.id));
    const batch = selecting && selectionItems().length > 0;
    const items = batch ? selectionItems() : [message];
    const row = (action, label, disabled = false) => `<button type="button" role="menuitem" data-action="${action}" ${disabled ? 'disabled' : ''}>${menuIcon(action)}<span class="message-menu-label">${esc(label)}</span></button>`;
    node.innerHTML = `${batch || copyableText(message) !== '' ? row('copy', batch ? '复制所选内容' : '复制', !items.some(item => copyableText(item) !== '')) : ''}${canPublish() ? row('reply', '回复') : ''}${items.some(item => forwardTypes.has(item.type)) ? row('forward', batch ? '转发所选内容' : '转发') : ''}${row('delete', batch ? '删除所选内容' : '删除')}`;
    if (selecting) node.insertAdjacentHTML('beforeend', row('cancel', '取消选择'));
    else {
      if (canManagePins()) node.insertAdjacentHTML('beforeend', row('pin', pinned ? '取消置顶' : '置顶消息'));
      for (const [action, label] of [['edit', '编辑'], ['recall', '撤回']]) {
        if (mutationActionAvailable(message, action)) node.insertAdjacentHTML('beforeend', row(action, label));
      }
      if (selectable(message)) node.insertAdjacentHTML('beforeend', row('select', '选择此消息'));
    }
    const time = menuTime(message);
    if (time) node.insertAdjacentHTML('beforeend', `<div class="message-menu-time">${menuIcon('clock')}<time>${esc(time)}</time></div>`);
    document.body.append(node); menu = node;
    // Pointer/rect coordinates include root CSS zoom; fixed offsets do not.
    const scale = Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    node.style.maxHeight = `${Math.max(1, innerHeight - 16) / scale}px`;
    node.style.overflowY = 'auto';
    const rect = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8)) / scale}px`;
    node.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8)) / scale}px`;
    opener?.setAttribute('aria-expanded', 'true');
    node.onclick = event => {
      const action = event.target.closest('[data-action]')?.dataset.action; if (!action) return;
      const liveMessage = currentActionMessage(context);
      if (menu !== node || !node.isConnected || !liveMessage) { if (menu === node) closeMenu(); return; }
      suppressClickUntil = 0;
      closeMenu();
      if (action === 'copy') { const text = (batch ? selectionItems() : [liveMessage]).map(copyableText).filter(Boolean).join('\n'); if (text !== '') void copyMessageText(context, text); }
      else if (action === 'forward' && forwardTypes.has(liveMessage.type)) void forwardMessage(context, liveMessage);
      else if (action === 'select') toggleSelection(liveMessage);
      else if (action === 'cancel') clearSelection();
      else if (action === 'delete') confirmDelete(batch ? selectionItems() : [liveMessage]);
      else if (action === 'reply' && canPublish()) selectReply(liveMessage);
      else if (action === 'pin' && canManagePins()) mutatePin(liveMessage, !pins.some(item => Number(item.id) === context.messageId));
      else if (action === 'edit' && mutationActionAvailable(liveMessage, 'edit')) editMessage(context.messageId);
      else if (action === 'recall' && mutationActionAvailable(liveMessage, 'recall')) recallMessage(context.messageId);
    };
    node.onkeydown = event => {
      const buttons = [...node.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); }
    };
    node.querySelector('button')?.focus();
  }
  function showPins() {
    document.getElementById('message-pins-list')?.remove();
    if (!visible() || !pins.length) return;
    const backdrop = document.createElement('div'); backdrop.id = 'message-pins-list'; backdrop.className = 'message-pins-backdrop';
    backdrop.innerHTML = `<section class="message-pins-dialog" role="dialog" aria-modal="true" aria-labelledby="message-pins-title"><header><h2 id="message-pins-title">置顶消息 <small>${pins.length}/${PIN_LIMIT}</small></h2><button type="button" data-close-pins aria-label="关闭置顶消息列表">×</button></header><div>${pins.map(message => { const item = summary(message); return `<div class="message-pin-row"><button type="button" data-locate-pin="${item.id}">${thumbnail(item)}<span>${authorHtml(item)}<small>${esc(item.text)}</small></span></button>${canManagePins() ? `<button type="button" data-unpin="${item.id}" aria-label="取消这条置顶">×</button>` : ''}</div>`; }).join('')}</div><footer>每个会话最多置顶 ${PIN_LIMIT} 条消息，所有会话成员共享。</footer></section>`;
    document.body.append(backdrop);
    const close = () => { backdrop.remove(); document.querySelector('.message-pin-list-button')?.focus(); };
    backdrop.onclick = event => {
      if (event.target === backdrop || event.target.closest('[data-close-pins]')) close();
      const locateButton = event.target.closest('[data-locate-pin]'), unpinButton = event.target.closest('[data-unpin]');
      if (locateButton) { close(); locate(Number(locateButton.dataset.locatePin)); }
      if (unpinButton) mutatePin(pins.find(item => Number(item.id) === Number(unpinButton.dataset.unpin)), false);
    };
    backdrop.onkeydown = event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
      if (event.key === 'Tab') {
        const buttons = [...backdrop.querySelectorAll('button')], first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    backdrop.querySelector('button')?.focus();
  }
  async function locate(id) {
    activate(); id = Number(id); if (!key || !Number.isSafeInteger(id) || id <= 0 || unavailable({ id })) return;
    closeMenu(); stopNavigation();
    // Every click is a new intent, even if this target is already rendered.
    // An older history request must never take focus back from this target.
    const captured = key, capturedToken = token, chat = conversationId, seq = ++locating;
    let target = document.querySelector(`#messages [data-message-id="${Number(id)}"]`);
    startNavigation(id, seq, Boolean(target && !target.classList.contains('recalled')));
    if (target && !target.classList.contains('recalled')) return;
    const historyEpoch = state.historyEpoch;
    try {
      const result = await api(`/messages/locate?conversation_id=${chat}&message_id=${Number(id)}`, { authToken: capturedToken, signal: AbortSignal.timeout(12000) });
      if (!current(captured) || seq !== locating || state.historyEpoch !== historyEpoch) return;
      const items = [...new Map(initialSnapshotMessages(result.items || []).filter(item => Number(item.conversation_id) === chat && Number(item.id) > Number(state.active?.cleared_before_message_id || 0) && !unavailable(item)).map(item => [Number(item.id), item])).values()].sort((a, b) => Number(a.id) - Number(b.id));
      if (!items.some(item => Number(item.id) === Number(id))) throw Error('原消息已不可查看');
      cancelConversationRecovery();
      if (typeof resetChatHistoryLocation === 'function') resetChatHistoryLocation();
      else { state.historyRevision = (state.historyRevision || 0) + 1; document.getElementById('chat-history-location')?.remove(); }
      state.historyPage = Number(result.page) || 1; state.historyHasMore = state.historyPage * Number(result.size || 50) < Number(result.total || 0);
      state.historyLocation = { conversationId: chat, maxId: Number(result.max_id) || Math.max(...items.map(item => Number(item.id))) };
      document.getElementById('messages').innerHTML = items.map(messageHtml).join('');
      state.initialHistoryFailed = false;
      if (navigation?.seq === seq) navigationReady(navigation);
      bindMessageActions();
      state.historyReadyEpoch = state.historyEpoch; state.historyLoadedFloor = Math.min(...items.map(item => Number(item.id)));
      subscribeConversation(chat);
      document.getElementById('messages').insertAdjacentHTML('beforebegin', '<div id="chat-history-location" class="classic-history-location message-history-location"><span>已定位历史消息</span><button type="button">返回最新消息</button></div>');
      document.getElementById('chat-history-location').querySelector('button').onclick = () => openConversation(chat);
      scheduleNavigation();
    } catch (error) { if (current(captured) && seq === locating) { stopNavigation(); toast(error.message || '暂时无法定位消息'); } }
  }
  function quoteHtml(quote) {
    if (!quote || !Number(quote.id)) return '';
    if (messageVersionCache().get(Number(quote.id))?.removed || recalledTargets.has(Number(quote.id)) || Number(quote.id) <= clearedBefore) quote = { id: Number(quote.id), unavailable: true };
    return `<button type="button" class="message-quote${quote.unavailable ? ' unavailable' : ''}" data-quote-id="${Number(quote.id)}" ${quote.unavailable ? 'disabled' : ''}>${thumbnail(quote)}<span>${authorHtml(quote)}<small>${esc(quote.unavailable ? '原消息已不可查看' : quote.text || '消息')}</small></span></button>`;
  }
  function invalidateReference(message) {
    const id = Number(message.id);
    const authoritative = messageVersionCache().get(id);
    if (authoritative && authoritative.message !== message) {
      if (authoritative.removed || String(authoritative.edited || '') > String(message.edited_at || '')) message = authoritative.message;
    }
    if (recalledTargets.has(id) && !message.recalled_at && message.status !== 'recalled') return;
    messages.set(id, message);
    if (unavailable(message)) {
      recalledTargets.add(id);
      const previousPinId = Number(pins[currentPin]?.id);
      pins = pins.filter(item => Number(item.id) !== id);
      currentPin = Math.max(0, pins.findIndex(item => Number(item.id) === previousPinId));
      renderBars();
      if (document.getElementById('message-pins-list')) showPins();
    }
    const item = summary(message);
    if (reply?.id === id) { reply = item; renderBars(); }
    document.querySelectorAll(`#messages [data-quote-id="${id}"]`).forEach(node => { node.outerHTML = quoteHtml(item); });
    bindExtras();
  }
  function bindExtras() {
    activate();
    renderSelection();
    if (navigation && navigation.list !== document.getElementById('messages')) stopNavigation();
    scheduleNavigation();
    document.querySelectorAll('#messages [data-message-menu]').forEach(button => {
      button.onclick = event => {
        event.stopPropagation(); const message = messages.get(Number(button.dataset.messageMenu));
        const rect = button.getBoundingClientRect(); showMenu(message, rect.left, rect.bottom + 4, button);
      };
    });
    document.querySelectorAll('#messages [data-quote-id]').forEach(button => { button.onclick = () => { if (!button.disabled) locate(Number(button.dataset.quoteId)); }; });
    document.querySelectorAll('#messages [data-group-avatar-message]').forEach(button => {
      button.onclick = event => {
        event.preventDefault(); event.stopPropagation();
        const rect = button.getBoundingClientRect(); showGroupMemberMenu(messages.get(Number(button.dataset.groupAvatarMessage)), rect.right + 4, rect.top, button);
      };
    });
    const list = document.getElementById('messages'); if (!list || list.dataset.messagePressBound) return;
    list.dataset.messagePressBound = '1';
    for (const name of ['wheel', 'touchstart', 'pointerdown']) list.addEventListener(name, () => { if (navigation) stopNavigation(); }, { passive: true });
    const candidate = event => {
      const node = event.target.closest('.bubble[data-message-id]');
      return node && !node.classList.contains('recalled') ? { node, message: messages.get(Number(node.dataset.messageId)) } : null;
    };
    list.addEventListener('contextmenu', event => {
      const avatar = event.target.closest('[data-group-avatar-message]'); if (!avatar) return;
      event.preventDefault(); event.stopImmediatePropagation(); clearPress();
      showGroupMemberMenu(messages.get(Number(avatar.dataset.groupAvatarMessage)), event.clientX, event.clientY, avatar);
    }, true);
    list.addEventListener('contextmenu', event => {
      const item = candidate(event); if (!hasMessageActions(item?.message)) return;
      if (event.target.closest('input,textarea')) return;
      event.preventDefault(); clearPress(); showMenu(item.message, event.clientX, event.clientY, item.node.querySelector('[data-message-menu]'));
    });
    list.addEventListener('pointerdown', event => {
      clearPress(); if (event.button !== 0 || !visible() || event.target.closest('button,audio,video,input,textarea')) return;
      const item = candidate(event); if (!hasMessageActions(item?.message)) return;
      const context = captureActionContext(item.message), x = event.clientX, y = event.clientY;
      press = { x, y, timer: setTimeout(() => {
        press = null; const liveMessage = currentActionMessage(context); if (!liveMessage) return;
        suppressClickUntil = Date.now() + 700; window.getSelection()?.removeAllRanges();
        const liveNode = document.querySelector(`#messages [data-message-id="${context.messageId}"]`);
        showMenu(liveMessage, x, y, liveNode?.querySelector('[data-message-menu]'));
      }, 500) };
    });
    list.addEventListener('pointermove', event => { if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) clearPress(); });
    for (const name of ['pointerup', 'pointercancel', 'pointerleave', 'scroll']) list.addEventListener(name, clearPress, { passive: true });
    // Incoming messages and history refreshes also scroll the list. Keep the
    // fixed menu and its captured message target until the user scrolls it.
    for (const name of ['wheel', 'touchmove']) list.addEventListener(name, closeMenu, { passive: true });
    list.addEventListener('click', event => {
      if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (selecting) {
        const item = candidate(event);
        if (item) { event.preventDefault(); event.stopImmediatePropagation(); suppressClickUntil = 0; toggleSelection(item.message); return; }
      }
      if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
  }
  const baseHtml = messageHtml;
  messageHtml = function(message) {
    activate();
    if (Number(message.conversation_id) === conversationId) messages.set(Number(message.id), message);
    let html = baseHtml(message);
    if (unavailable(message) || ['system', 'red_packet'].includes(message.type)) return html;
    if (message.body?.reply_to?.unavailable) recalledTargets.add(Number(message.body.reply_to.id));
    const quote = quoteHtml(message.body?.reply_to);
    if (quote) html = html.replace(/(<article\b[^>]*>)/, (_, opening) => opening + quote);
    if (readableActionMessage(message) && state.active?.type === 'group' && Number(message.sender_id) !== Number(state.user?.id)) {
      const name = groupAuthorName(message), letter = Array.from(name)[0], url = message.sender_avatar_url ? mediaUrl(message.sender_avatar_url) : '';
      const avatar = `<button type="button" class="group-message-avatar" data-group-avatar-message="${Number(message.id)}" aria-label="${esc(name)}的群成员操作" aria-haspopup="menu" aria-expanded="false" title="${esc(name)}">${url ? `<img src="${esc(url)}" alt="" data-message-avatar-fallback="${esc(letter)}">` : esc(letter)}</button>`;
      html = html.replace(/(<article\b[^>]*class=")/, '$1group-member-message ');
      html = html.replace(/(<article\b[^>]*>)/, (_, opening) => `${opening}${avatar}<span class="group-message-sender" data-contact-name-user="${Number(message.sender_id)}" data-contact-name-fallback="${esc(message.sender_name || '会话成员')}">${esc(name)}</span>`);
    }
    if (hasMessageActions(message, html)) html = html.replace('</article>', `<button type="button" class="message-more-button" data-message-menu="${Number(message.id)}" aria-label="消息操作" aria-haspopup="menu" aria-expanded="false">⋯</button></article>`);
    return html;
  };
  const baseBind = bindMessageActions;
  bindMessageActions = function() { baseBind(); bindExtras(); };
  const baseRestoreScroll = restoreRecoveryScroll;
  restoreRecoveryScroll = function(list, position) {
    if (holdsNavigation(list)) { scheduleNavigation(); return; }
    return baseRestoreScroll(list, position);
  };
  const baseOpen = openConversation;
  openConversation = function(...args) {
    clearSelection();
    actionNavigationRevision++; clearPress(); closeMenu(); closeDeleteDialog(); closeMemberDialog(); stopNavigation();
    const result = baseOpen(...args); activate(); refresh();
    Promise.resolve(result).then(() => { activate(); bindExtras(); }).catch(() => {}); return result;
  };
  const baseUpdate = updateDesktopChat;
  updateDesktopChat = function(...args) { const result = baseUpdate(...args); activate(); return result; };
  const baseSwitch = switchPage;
  switchPage = function(...args) { clearSelection(); actionNavigationRevision++; clearPress(); closeMenu(); closeDeleteDialog(); closeMemberDialog(); const result = baseSwitch(...args); activate(); return result; };
  const baseShell = renderShell;
  renderShell = function(...args) { clearSelection(); actionNavigationRevision++; clearPress(); closeMenu(); closeDeleteDialog(); closeMemberDialog(); const result = baseShell(...args); activate(); return result; };
  const basePacket = handleSocketPacket;
  handleSocketPacket = function(packet) {
    activate();
    if (packet.type === 'message.deleted') { applyDeletion(packet.data); return; }
    if (packet.type === 'conversation.pins') {
      if (key && current(key) && Number(packet.data?.conversation_id) === conversationId) { revision++; request++; applySnapshot(packet.data); }
      return;
    }
    const result = basePacket(packet);
    if (packet.type === 'subscribe.ok' && Number(packet.conversation_id || packet.data?.conversation_id) === conversationId) refresh();
    if (['message.recalled', 'message.updated'].includes(packet.type) && Number(packet.data?.conversation_id) === conversationId) { invalidateReference(packet.data); revision++; refresh(); }
    if (packet.type === 'auth.revoked') activate();
    return result;
  };
  const baseUpdateMessage = updateInternalMessage;
  updateInternalMessage = function(message, ...args) {
    const result = baseUpdateMessage(message, ...args);
    if (Number(message.conversation_id) === conversationId) { invalidateReference(message); revision++; refresh(); }
    return result;
  };
  document.addEventListener('pointerdown', event => { if (menu && !event.target.closest('.message-action-menu,[data-message-menu],[data-group-avatar-message]')) closeMenu(); }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      clearPress();
      if (menu) closeMenu();
      else if (selecting && !document.querySelector('[data-feature-modal]')) { event.preventDefault(); clearSelection(); }
    }
    if (navigation && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) && !event.target.closest('input,textarea,[contenteditable="true"]')) stopNavigation();
  });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('online', () => { if (key) refresh(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearPress(); closeMenu(); closeMemberDialog(); } else if (key) refresh(); });
  desktop.onAccountVisibilityChanged?.(value => {
    if (!value.active) { clearSelection(); clearPress(); closeMenu(); closeDeleteDialog(); closeMemberDialog(); closeConversationFolderModal(); }
  });
  window.PulseMessageActions = {
    capture() { activate(); stopNavigation(); return reply && !reply.unavailable && !unavailable({ id: reply.id }) ? { replyToId: reply.id, replyConversationId: conversationId, replyRevision } : {}; },
    body(body, context) { return context?.replyToId && context.replyConversationId === context.conversationId ? { ...body, reply_to_id: context.replyToId } : body; },
    sent(context) { if (current(`${context.token}:${context.conversationId}`) && reply?.id === context.replyToId && replyRevision === context.replyRevision) { reply = null; replyRevision++; renderBars(); } },
    refresh, activate, refreshContactNames
  };
  activate(); if (key) refresh();
})();
