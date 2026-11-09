const desktop = window.pulseDesktop || {};
// Share the PC interface while retaining the real browser platform for network and native capabilities.
const PC_LAYOUT = true;
const localDev = location.port === '8098';
const API = desktop.production || desktop.localPreview ? desktop.apiBaseUrl : localStorage.getItem('pulse_api') || desktop.apiBaseUrl || (localDev ? 'http://127.0.0.1:8099/index.php' : `${location.origin}/api`);
const WS = desktop.production || desktop.localPreview ? desktop.websocketUrl : localStorage.getItem('pulse_ws') || desktop.websocketUrl || (localDev ? 'ws://127.0.0.1:8282' : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
const interfaceScaleOptions = [1, 1.25, 1.5, 2, 2.5, 3];
const chatThemeOptions = ['classic', 'day', 'color', 'night'];
function getInterfaceScale() {
  const value = Number(localStorage.getItem('pulse_interface_scale') || 1);
  return interfaceScaleOptions.includes(value) ? value : 1;
}
function updateInterfaceScaleControls() {
  const current = getInterfaceScale();
  document.querySelectorAll('.classic-settings-scale-labels span').forEach((node, index) => {
    const value = interfaceScaleOptions[index];
    node.classList.toggle('is-active', value === current);
    node.setAttribute('aria-pressed', value === current ? 'true' : 'false');
  });
  const slider = document.querySelector('.classic-settings-slider');
  if (slider) {
    const index = interfaceScaleOptions.indexOf(current);
    const start = index * 20;
    slider.style.background = `linear-gradient(90deg, var(--pc-scale-track, #edf0f1) 0 ${start}%, var(--pc-scale-accent, #43a9d4) ${start}% ${start + 20}%, var(--pc-scale-track, #edf0f1) ${start + 20}% 100%)`;
  }
}
function setInterfaceScale(value) {
  const scale = Number(value);
  if (!interfaceScaleOptions.includes(scale)) return;
  localStorage.setItem('pulse_interface_scale', String(scale));
  document.documentElement.dataset.interfaceScale = String(scale);
  document.documentElement.style.setProperty('--interface-scale', String(scale));
  if (desktop.setZoomFactor) desktop.setZoomFactor(scale);
  else document.documentElement.style.zoom = String(scale);
  updateConversationSidebarWidth?.();
  updateInterfaceScaleControls();
}
function bindInterfaceScaleControls() {
  document.querySelectorAll('.classic-settings-scale-labels span').forEach((node, index) => {
    node.onclick = () => setInterfaceScale(interfaceScaleOptions[index]);
    node.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setInterfaceScale(interfaceScaleOptions[index]); }
    };
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
  });
  updateInterfaceScaleControls();
}
document.documentElement.dataset.interfaceScale = String(getInterfaceScale());
document.documentElement.style.setProperty('--interface-scale', String(getInterfaceScale()));
if (desktop.setZoomFactor) desktop.setZoomFactor(getInterfaceScale());
else if (getInterfaceScale() !== 1) document.documentElement.style.zoom = String(getInterfaceScale());
const state = { token: localStorage.getItem('pulse_token') || '', user: null, conversations: [], conversationFolders: [], contactCache: {}, active: null, favoriteMode: false, sidebarMode: 'messages', archiveView: false, archiveFeedback: '', ungroupedCollapsed: localStorage.getItem('pulse_ungrouped_collapsed') !== '0', socket: null, recorder: null, recordingStartedAt: 0, recordingChunks: [], reconnectTimer: null, heartbeatTimer: null, reconnectDelay: 1000, historyPage: 1, historyLoading: false, historyHasMore: true };
const $ = (id) => document.getElementById(id);
const contactNames = PulseContactNames.create({
  context: () => ({ base: API, token: state.token, userId: Number(state.user?.id), nickname: state.user?.nickname,
    allowed: Boolean(state.token && state.user && !state.updateRequired && !readPasscodeSettings().locked) }),
  request: (path, options) => api(path, options), changed: () => refreshContactNameLabels(),
});
function contactDisplayName(userId, fallback = '会话成员') { return contactNames.resolve(userId, fallback); }
function refreshContactNameLabels() {
  document.querySelectorAll('[data-contact-name-user]').forEach(node => {
    const next = (node.dataset.contactNamePrefix || '') + contactDisplayName(node.dataset.contactNameUser, node.dataset.contactNameFallback || '会话成员');
    if (node.textContent !== next) node.textContent = next;
  });
  window.PulseMessageActions?.refreshContactNames();
}

const composerDrafts = PulseConversationDrafts.create();
let disposeAuthView = null;
let disposeConversationSidebarResize = null;
let updateConversationSidebarWidth = null;
let contactActionRevision = 0;
const pendingInternalContactAdds = new Map();

const CLIENT_VERSION = desktop.appVersion || document.querySelector('meta[name="pulse-client-version"]')?.content || '2.4.10';
function captureSendContext(targetConversation = state.active) {
  const conversationId = Number(targetConversation?.id);
  if (!state.token || !state.user || !Number.isSafeInteger(conversationId) || conversationId <= 0) throw new Error('请先登录并选择会话');
  return { token: state.token, userId: Number(state.user.id), conversationId, ...(conversationId !== Number(state.active?.id) || typeof PulseMessageActions === 'undefined' ? {} : PulseMessageActions.capture()) };
}
function messageBodyWithReply(body, context) { return typeof PulseMessageActions === 'undefined' ? body : PulseMessageActions.body(body, context); }
function completeReplySend(context) { if (typeof PulseMessageActions !== 'undefined') PulseMessageActions.sent(context); }
function sameSendAccount(context) { return Boolean(context && state.token === context.token && Number(state.user?.id) === context.userId); }
function assertSendAccount(context) {
  if (!sameSendAccount(context) || state.updateRequired) throw new Error('账号或客户端状态已改变，本次发送已取消');
  if (context.conversationId) assertConversationCanSend(context.conversationId);
}
function assertConversationCanSend(id) {
  const chat = Number(state.active?.id) === Number(id) ? state.active : state.conversations.find(item => Number(item.id) === Number(id));
  composerPermissions.assert(chat || { id: Number(id) });
}
const composerPermissions = PulseComposerPermissions.create({
  context: () => ({ token: state.token, userId: Number(state.user?.id), conversation: state.active,
    visible: Boolean(state.token && state.user && state.page === 'messages' && !state.favoriteMode && !document.hidden && state.desktopAccountVisible !== false && !state.updateRequired) }),
  load: (id, token) => api(`/conversations/info?conversation_id=${id}`, { authToken: token, signal: AbortSignal.timeout(10000) }),
  changed: () => updateComposerConversationTools(),
  blocked: () => { closeComposerEmoji(); cancelComposerRecording(); if (state.screenshotBusy) desktop.cancelScreenshot?.(); }
});
setInterval(() => composerPermissions.check(), 1000);

function newMessageRequestId(prefix) { return `${prefix}-${crypto.randomUUID()}`; }

function textOutboxAccount() { return { token: state.token, userId: Number(state.user?.id) }; }
let textOutboxRefreshTimer;
function scheduleTextConversationRefresh() {
  clearTimeout(textOutboxRefreshTimer);
  textOutboxRefreshTimer = setTimeout(() => { if (state.token && state.user) void loadConversations().catch(() => {}); }, 120);
}
const textOutbox = PulseTextOutbox.create({
  store: PulsePendingTextStore.create({ base: API }),
  storageError: (error, account) => { console.warn('本地待发恢复暂不可用：', error.message); if (sameSendAccount(account)) composerFeedback('本地待发恢复暂不可用，请在消息发送完成后再关闭客户端。'); },
  send: item => api('/messages', { method: 'POST', authToken: item.account.token, signal: AbortSignal.timeout(15000), body: JSON.stringify(item.payload) }),
  allowed: account => sameSendAccount(account) && !state.updateRequired,
  changed: () => renderTextOutbox(),
  accepted: (item, message) => {
    if (!sameSendAccount(item.account)) return;
    if (Number(state.active?.id) === Number(item.payload.conversation_id)) appendMessage(message);
    scheduleTextConversationRefresh();
  }
});
function renderTextOutbox() {
  const container = $('messages'); if (!container) return;
  const pending = textOutbox.pending(textOutboxAccount(), state.active?.id);
  const ids = new Set(pending.map(item => item.id));
  container.querySelectorAll('[data-outbox-id]').forEach(node => { if (!ids.has(node.dataset.outboxId)) node.remove(); });
  if (!pending.length) return;
  const follow = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
  container.querySelector('.empty')?.remove();
  for (const item of pending) {
    let node = container.querySelector('[data-outbox-id="' + item.id + '"]');
    if (!node) { node = document.createElement('article'); node.className = 'bubble mine text-message text-outbox-message'; node.dataset.outboxId = item.id; container.append(node); }
    const failed = item.status === 'failed';
    const status = failed ? '发送未确认，点击重试' : item.status === 'sending' ? '发送中…' : '等待发送…';
    const html = escapeHtml(item.payload.body.text) + '<small class="classic-message-meta">' + (failed ? '<button type="button" class="text-outbox-retry" title="' + escapeHtml(item.error) + '">重试发送</button> <button type="button" class="text-outbox-remove" aria-label="移除待发送消息">移除</button>' : '<span>' + status + '</span>') + '</small>';
    renderStableConversationContent(node, html, item.id);
    node.dataset.sendState = item.status;
    node.setAttribute('aria-label', status);
    const retry = node.querySelector('.text-outbox-retry');
    if (retry) retry.onclick = () => textOutbox.retry(item.id, textOutboxAccount());
    const remove = node.querySelector('.text-outbox-remove');
    if (remove) remove.onclick = () => textOutbox.discard(item.id, textOutboxAccount());
  }
  if (follow) container.scrollTop = container.scrollHeight;
}

const mediaSendDrafts = new WeakMap();
function mediaSendDraft(kind, file, context) {
  let draft = mediaSendDrafts.get(file);
  if (!draft || draft.kind !== kind || draft.context.token !== context.token || draft.context.conversationId !== context.conversationId || draft.context.replyToId !== context.replyToId || draft.context.replyRevision !== context.replyRevision) {
    draft = { kind, file, context, requestId: newMessageRequestId('media'), uploaded: null, sending: false };
    mediaSendDrafts.set(file, draft);
  }
  return draft;
}
function compareClientVersions(left, right) {
  const a = String(left || '0').replace(/^v/i, '').split('.').map(Number);
  const b = String(right || '0').replace(/^v/i, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const delta = (a[i] || 0) - (b[i] || 0); if (delta) return delta > 0 ? 1 : -1; }
  return 0;
}
async function enforceClientUpdate() {
  try {
    const config = await api('/client/config', { signal: AbortSignal.timeout(10000) });
    if (!config.force_update || compareClientVersions(CLIENT_VERSION, config.latest_version) >= 0) return true;
    state.updateRequired = true; state.socket?.close();
    disposeAuthView?.(); disposeAuthView = null;
    const rawUrl = desktop.isDesktop ? config.pc_download_url || '' : '';
    let download = ''; try { const url = new URL(rawUrl); if (url.protocol === 'https:') download = url.href; } catch {}
    disposeConversationSidebarResize?.();
    document.body.innerHTML = `<main class="login-shell"><section class="login-card"><h1>需要更新客户端</h1><p>当前版本 ${escapeHtml(CLIENT_VERSION)}，服务要求 ${escapeHtml(config.latest_version)}。</p><p>${escapeHtml(config.update_description || '请更新后继续使用。')}</p>${desktop.isDesktop ? (download ? '<button id="required-update-download" class="primary" type="button">下载新版电脑端</button>' : '<p>尚未配置新版电脑端下载地址，请联系管理员。</p>') : '<button id="required-update-refresh" class="primary" type="button">刷新并加载新版</button>'}<button id="required-update-retry" type="button">重新检查</button></section></main>`;
    if ($('required-update-download')) $('required-update-download').onclick = () => desktop.openUpdate(download);
    if ($('required-update-refresh')) $('required-update-refresh').onclick = () => location.reload();
    $('required-update-retry').onclick = () => location.reload();
    return false;
  } catch (error) { throw new Error(`无法检查客户端版本：${error.message}`); }
}

state.chatSearch = null;
state.chatInfo = null;
state.imageDraft = null;
applyChatTheme(getChatTheme(), false);
const messageTypeMap = { text: '文字', image: '图片', video: '视频', file: '文件', voice: '语音', contact_card: '名片', shake: '窗口抖动', red_packet: '历史红包（已停用）', system: '系统' };
const deviceMap = { web: '网页端', android: '安卓端', ios: '苹果端', pc: '电脑端' };
const roleMap = { owner: '群主', admin: '管理员', member: '成员' };
const messageType = (value) => messageTypeMap[value] || '消息';
const deviceName = (value) => deviceMap[value] || '其他设备';
const roleName = (value) => roleMap[value] || '成员';

async function api(path, options = {}) {
  const { authToken = state.token, ...requestOptions } = options;
  const permissionTicket = composerPermissions.ticket();
  if (path === '/messages' && requestOptions.method === 'POST') {
    if (authToken !== state.token) throw new Error('账号已改变，本次发送已取消');
    assertConversationCanSend(JSON.parse(requestOptions.body || '{}').conversation_id);
  }
  if (state.updateRequired && requestOptions.method && requestOptions.method !== 'GET' && path !== '/auth/logout') throw new Error('请先更新客户端');
  const headers = { 'Content-Type': 'application/json', 'X-Client-Platform': desktop.isDesktop ? 'pc' : 'web', 'X-Client-Version': CLIENT_VERSION, ...(requestOptions.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetch(API + path, { ...requestOptions, headers });
  const data = await response.json();
  if (response.status === 426 || data.error?.code === 'UPGRADE_REQUIRED') requireClientUpgrade(data.error?.message);
  if (!response.ok || data.ok === false) { const requestId = String(data.error?.request_id || response.headers.get('X-Pulse-Request-ID') || ''); let message = data.error?.message || '请求失败，请检查网络和服务状态'; if (/^[a-f0-9]{24}$/.test(requestId) && !message.includes(requestId)) message += '（请求编号：' + requestId + '）'; const error = new Error(message); error.requestId = requestId; error.status = response.status; error.code = data.error?.code; throw error; }
  composerPermissions.receive(path, data.data, permissionTicket, authToken);
  return data.data;
}

async function uploadMedia(kind, file, authToken = state.token, signal) {
  const form = new FormData(); form.append('kind', kind); form.append('file', file);
  const response = await fetch(API + '/uploads', { method: 'POST', signal, headers: { Authorization: `Bearer ${authToken}`, 'X-Client-Platform': desktop.isDesktop ? 'pc' : 'web', 'X-Client-Version': CLIENT_VERSION }, body: form });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error?.message || '文件上传失败');
  return data.data;
}

const groupCreator = PulseGroupCreator.create({
  getAccount: () => ({ token: state.token, userId: Number(state.user?.id), scope: `${state.page}:${state.sidebarMode}:${messageForwardNavigationRevision}`,
    blocked: Boolean(state.updateRequired || readPasscodeSettings().locked || state.desktopAccountVisible === false) }),
  request: (route, options) => api(route, options),
  upload: (file, token, signal) => uploadMedia('image', file, token, signal),
  mediaUrl: value => mediaUrl(value),
  onInvited: async (group, account) => {
    if (!sameSendAccount(account)) return;
    await loadConversations();
  },
  onCreated: async (group, account) => {
    if (!sameSendAccount(account)) return;
    try { await loadConversations(); }
    catch { if (sameSendAccount(account)) composerFeedback('群聊已创建，列表刷新失败，请稍后重试。'); }
    if (!sameSendAccount(account)) return;
    if (!state.conversations.some(item => Number(item.id) === Number(group.id))) {
      state.conversations.unshift({ ...group, type: 'group', my_role: 'owner', can_manage: true, member_count: group.member_ids?.length || 1 });
    }
    renderConversationList(); updateDesktopChat();
  },
});



const friendChats = PulseFriendChats.create({
  context: () => ({ base: API, token: state.token, userId: Number(state.user?.id),
    syncAllowed: Boolean(state.token && state.user && !document.hidden && state.desktopAccountVisible !== false && !state.updateRequired
      && !readPasscodeSettings().locked && !$('passcode-lock-screen')),
    allowed: Boolean(state.token && state.user && !document.hidden && state.desktopAccountVisible !== false && !state.updateRequired
      && !readPasscodeSettings().locked && !$('passcode-lock-screen') && $('messages') && !state.imageDraft
      && state.recorder?.state !== 'recording') }),
  storage: localStorage,
  request: (path, options) => api(path, { ...options, signal: AbortSignal.timeout(12000) }),
  synchronize: async (event, account, current) => {
    state.conversationListLoad = null;
    const complete = await loadConversations();
    return current() && complete === true && state.conversations.some(item => Number(item.id) === Number(event.conversation_id));
  },
  open: async (event, account, current) => {
    const conversation = await api(`/conversations/info?conversation_id=${Number(event.conversation_id)}`, { authToken: account.token, signal: AbortSignal.timeout(12000) });
    if (!current()) return false;
    if (Number(conversation.id) !== Number(event.conversation_id) || conversation.type !== 'direct' || Number(conversation.peer_user_id) !== Number(event.peer_user_id)) throw new Error('好友会话资料无效');
    state.conversationListLoad = null; // Ignore list snapshots captured before acceptance.
    const index = state.conversations.findIndex(item => Number(item.id) === Number(conversation.id));
    if (index < 0) state.conversations.unshift(conversation);
    else state.conversations[index] = { ...state.conversations[index], ...conversation };
    closeFeatureModal();
    await switchPage('messages');
    if (!current()) return false;
    await openConversation(Number(conversation.id));
    if (!current()) return false;
    void loadConversations().catch(() => {});
    return Number(state.active?.id) === Number(conversation.id);
  },
});
setInterval(() => { void friendChats.refresh(); }, 5000);

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function publicUserId(user) {
  const value = user?.public_id;
  return typeof value === 'string' && value.length === 16 && /^[A-Za-z0-9]{16}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value) ? value : '';
}
const pinyinInitialLetters = 'ABCDEFGHJKLMNOPQRSTWXYZ'.split('');
const pinyinInitialChars = ['阿', '八', '擦', '搭', '饿', '发', '嘎', '哈', '基', '卡', '拉', '妈', '拿', '哦', '趴', '七', '然', '撒', '他', '挖', '西', '压', '杂'];
const pinyinCollator = new Intl.Collator('zh-Hans-u-co-pinyin', { sensitivity: 'base' });
function contactInitial(value) {
  const first = String(value || '?').trim().charAt(0) || '?';
  if (/^[a-z]$/i.test(first)) return first.toUpperCase();
  if (/^[0-9]$/.test(first)) return '#';
  if (!/[\u3400-\u9fff]/.test(first)) return '#';
  let index = 0;
  for (let i = 1; i < pinyinInitialChars.length; i += 1) {
    if (pinyinCollator.compare(first, pinyinInitialChars[i]) < 0) break;
    index = i;
  }
  return pinyinInitialLetters[index];
}
function contactCompare(a, b) {
  const aInitial = contactInitial(a.nickname); const bInitial = contactInitial(b.nickname);
  const aIndex = aInitial === '#' ? -1 : pinyinInitialLetters.indexOf(aInitial);
  const bIndex = bInitial === '#' ? -1 : pinyinInitialLetters.indexOf(bInitial);
  return aIndex - bIndex || pinyinCollator.compare(String(a.nickname || ''), String(b.nickname || ''));
}
function friendContactHtml(item) {
  const initial = contactInitial(item.nickname);
  const avatar = item.avatar_url ? `<img src="${escapeHtml(mediaUrl(item.avatar_url))}" alt="">` : escapeHtml(initial);
  return `<article class="friend-row" data-profile-user="${item.user_id}" tabindex="0"><span class="friend-card-avatar">${avatar}</span><span class="contact-info"><strong><span data-contact-name-user="${Number(item.user_id)}" data-contact-name-fallback="${escapeHtml(item.nickname || '未命名用户')}">${escapeHtml(contactDisplayName(item.user_id, item.nickname))}</span> <em class="${item.online ? 'online-label' : 'offline-label'}" style="color:${item.online ? '#15946f' : '#8c979d'}">（${item.online ? '在线' : '离线'}）</em></strong>${item.remark ? `<small>${escapeHtml(item.remark)}</small>` : ''}</span><span class="friend-card-arrow">›</span></article>`;
}
function friendDirectoryHtml(items) {
  const groups = new Map();
  [...items].sort(contactCompare).forEach((item) => {
    const initial = contactInitial(item.nickname);
    if (!groups.has(initial)) groups.set(initial, []);
    groups.get(initial).push(item);
  });
  return groups.size ? [...groups.entries()].map(([initial, contacts]) => `<section class="friend-letter-group"><h3>${escapeHtml(initial)}</h3><div class="friend-contact-list">${contacts.map(friendContactHtml).join('')}</div></section>`).join('') : desktopEmpty('暂无好友', '搜索用户并添加为好友');
}
function mediaUrl(value) { try { return new URL(String(value || ''), API).href; } catch { return String(value || ''); } }

const conversationViews = PulseMessageView.createCache();
function conversationViewAccount() { return JSON.stringify([state.token, Number(state.user?.id)]); }
function renderStableConversationContent(container, html, conversationId = null) {
  PulseMessageView.render(container, html, JSON.stringify([state.token, Number(state.user?.id), conversationId]));
}
function visibleConversationMessages() {
  const versions = messageVersionCache(), cleared = Number(state.active?.cleared_before_message_id || 0);
  return [...$('messages').querySelectorAll('[data-message-id]')].flatMap(node => {
    const entry = versions.get(Number(node.dataset.messageId));
    return entry && !entry.removed && Number(entry.message.conversation_id) === Number(state.active?.id) && Number(entry.message.id) > cleared ? [entry.message] : [];
  });
}
function rememberConversationView() {
  if (!state.active || state.favoriteMode || state.historyLocation) return;
  const container = $('messages'); if (!container) return;
  conversationViews.remember(conversationViewAccount(), state.active.id, container, {
    page: state.historyPage, hasMore: state.historyHasMore, floor: state.historyLoadedFloor, position: recoveryScrollAnchor(container),
  });
}
function renderConversationMessages(messages, container = $('messages')) {
  const html = messages.map(messageHtml).join('');
  // A recovery snapshot must not discard submissions still awaiting an ACK.
  const pending = new Set(textOutbox.pending(textOutboxAccount(), state.active?.id).map(item => item.id));
  const outbox = [...container.querySelectorAll('[data-outbox-id]')].filter(node => pending.has(node.dataset.outboxId)).map(node => node.outerHTML).join('');
  renderStableConversationContent(container, html + outbox || '<p class="empty">暂无消息</p>');
  if (!state.favoriteMode && !state.historyLocation) conversationViews.claim(conversationViewAccount(), state.active.id, container);
  renderOlderHistoryControl();
}
function navIcon(name) {
  const paths = {
    messages: '<path d="M20 11a7 7 0 0 1-7 7H9l-5 3v-6a7 7 0 0 1 0-10 7 7 0 0 1 10 0"/><path d="M14 7a5 5 0 0 1 7 7v4l-3-2"/>',
    center: '<circle cx="12" cy="11" r="8"/><path d="M12 6v5h4M9 19l3 3 3-3"/>',
    friends: '<circle cx="10" cy="7" r="4"/><path d="M2 21v-3a6 6 0 0 1 12 0M19 12v8M15 16h8"/>',
    person: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2Z"/>',
    groups: '<circle cx="9" cy="7" r="3"/><circle cx="18" cy="9" r="3"/><path d="M2 21v-3a7 7 0 0 1 14 0v3H2ZM16 14a6 6 0 0 1 7 6v1h-4"/>',
    blacklist: '<circle cx="10" cy="7" r="4"/><path d="M2 21v-3a7 7 0 0 1 11-6"/><circle cx="18" cy="18" r="4"/><path d="m15 21 6-6"/>',
    group: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M2 21v-3a7 7 0 0 1 14 0v3M16 15a5 5 0 0 1 6 5v1"/>',
    channel: '<path d="M4 5h16v11H8l-4 4Z"/><path d="M8 9h8M8 12h5"/>',
    calls: '<path d="M6 3h3l2 5-2 2a14 14 0 0 0 5 5l2-2 5 2v3c0 1-1 2-2 2C11 19 5 13 4 5c0-1 1-2 2-2Z"/>',
    edit: '<path d="m4 16-1 5 5-1L19 9l-4-4Z"/><path d="m13 6 4 4"/>',
    bell: '<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    sliders: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="11" cy="18" r="2" fill="currentColor"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/>',
    gender: '<circle cx="10" cy="14" r="5"/><path d="M14 10 20 4M16 4h4v4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.1h-2.6v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1A1.7 1.7 0 0 0 8 15a1.7 1.7 0 0 0-1.5-1H6v-2.6h.5A1.7 1.7 0 0 0 8 10a1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V5h2.6v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v2.6h-.1a1.7 1.7 0 0 0-1.5 1.4Z"/>',
    moon: '<path d="M20 15.5A8 8 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
    translate: '<path d="M4 5h8M8 3v2a9 9 0 0 1-5 8M5 9c1 2 2 3 4 4M14 14h7M17.5 11l-3.5 9M16 17h5"/>',
    camera: '<path d="M4 7h3l1.5-2h7L17 7h3v11H4Z"/><circle cx="12" cy="12" r="3.5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 17 5-5 3 3 2-2 6 6"/>',
    video: '<path d="M4 6h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/><path d="m17 10 5-3v10l-5-3Z"/>',
    contactCard: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="2"/><path d="M5.5 15a3 3 0 0 1 5 0M13 9h5M13 13h5"/>',
    shake: '<path d="M6 8 3 5m3 11-3 3M18 8l3-3m-3 11 3 3"/><path d="M9 5v14M15 5v14"/>',
    folder: '<path d="M3 7.5h6l2 2h10v9.5H3Z"/><path d="M3 7.5V5h6l2 2h8"/>',
    scissors: '<circle cx="6" cy="7" r="2.3"/><circle cx="6" cy="17" r="2.3"/><path d="m8 8.5 12 9M8 15.5 20 6"/>',
    smile: '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r=".7" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r=".7" fill="currentColor" stroke="none"/><path d="M8 14c1 3 7 3 8 0"/>',
    microphone: '<rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.4 2.4 0 1 1 4.3 1.5c-.7.8-2 1.1-2 2.5M12 16.5v.1"/>',
    qr: '<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><path d="M14 14h3v3h-3zM18 18h2v2h-2z"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>',
    menu: '<path d="M3 6h12M3 12h12M3 18h12m15-6-5-5m5 5-5 5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.1"/><path d="m15 15 4.5 4.5"/>',
    hamburger: '<path d="M5 6h14M5 12h14M5 18h14"/>',
    contactAdd: '<circle cx="9" cy="7.5" r="3.2"/><path d="M3 20v-1.5a6 6 0 0 1 12 0V20Z"/><path d="M19 9v7M15.5 12.5h7"/>',
    sidebar: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M14 5v14"/>',
    more: '<circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.messages}</svg>`;
}
function classicTabIcon(name) {
  const shapes = {
    messages: '<path class="classic-tab-accent" d="M12 3.5a8 8 0 0 1 8 8c0 2.1-.8 4-2.1 5.4l.7 3.2-3.7-1.2A8 8 0 1 1 12 3.5Z"/><path class="classic-tab-shine" d="M6 10.6A6 6 0 0 1 12 5.5"/>',
    friends: '<circle class="classic-tab-accent" cx="12" cy="7.1" r="3.4"/><path class="classic-tab-accent" d="M6.8 14.2h10.4a3 3 0 0 1 3 3v2.1H3.8v-2.1a3 3 0 0 1 3-3Z"/>',
    groups: '<path d="M15 3.9a3.4 3.4 0 0 1 0 6.6M18.1 13.3a3.5 3.5 0 0 1 3.2 3.5v2.5h-2.1"/><circle class="classic-tab-accent" cx="9.2" cy="7.1" r="3.4"/><path class="classic-tab-accent" d="M4.8 14.2h8.8a3 3 0 0 1 3 3v2.1H1.8v-2.1a3 3 0 0 1 3-3Z"/>',
  };
  return `<svg class="classic-tab-symbol" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${shapes[name] || shapes.messages}</svg>`;
}

function desktopEmpty(title, subtitle = '') {
  return `<div class="desktop-empty"><svg viewBox="0 0 160 112" aria-hidden="true"><ellipse cx="80" cy="100" rx="37" ry="4" fill="#dde7f3"/><path d="M45 23h68v48H82L66 84V71H45Z" fill="#f2f6fc" stroke="#7b9dc5" stroke-width="2"/><path d="M29 48h63v38H69L56 98V86H29Z" fill="#d6e6ff" stroke="#3786f6" stroke-width="2"/><circle cx="47" cy="67" r="3" fill="#3786f6"/><circle cx="60" cy="67" r="3" fill="#3786f6"/><circle cx="73" cy="67" r="3" fill="#3786f6"/><path d="m129 36 5-8m-2 21h9M31 20l-5-6" stroke="#95a8be" stroke-width="2" stroke-linecap="round"/></svg><strong>${escapeHtml(title)}</strong>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>`;
}

function classicMenuUserHtml() {
  const user = state.user || {};
  const nickname = user.nickname || '我的账号';
  const account = String(user.username || '').trim() || '未设置账号';
  const avatar = user.avatar_url
    ? `<img src="${escapeHtml(mediaUrl(user.avatar_url))}" alt="">`
    : escapeHtml(nickname.slice(0, 1));
  return `<div class="classic-drawer-avatar">${avatar}</div><div class="classic-drawer-user"><strong title="${escapeHtml(nickname)}">${escapeHtml(nickname)}</strong><small title="${escapeHtml(account)}">${escapeHtml(account)}</small></div>`;
}

function openClassicMenu() {
  closeSessionMenu();
  const nightMode = document.body.classList.contains('desktop-night-mode');
  document.body.insertAdjacentHTML('beforeend', `<div class="classic-menu-backdrop" id="classic-menu-backdrop"><aside class="classic-profile-drawer" role="dialog" aria-modal="true" aria-label="个人菜单"><header class="classic-drawer-profile"><div class="classic-drawer-profile-main">${classicMenuUserHtml()}</div><div class="classic-drawer-profile-actions"><button type="button" data-classic-menu-action="qr" aria-label="我的二维码">${navIcon('qr')}</button><button type="button" data-classic-menu-action="star" aria-label="我的收藏">${navIcon('star')}</button></div></header><nav class="classic-drawer-nav"><button type="button" data-classic-menu-action="group"><span class="classic-drawer-icon">${navIcon('group')}</span><span>新建群组</span></button><button type="button" data-classic-menu-action="channel"><span class="classic-drawer-icon">${navIcon('channel')}</span><span>新建频道</span></button><button type="button" data-classic-menu-action="contacts"><span class="classic-drawer-icon">${navIcon('friends')}</span><span>联系人</span></button><button type="button" data-classic-menu-action="calls"><span class="classic-drawer-icon">${navIcon('calls')}</span><span>通话记录</span></button><button type="button" data-classic-menu-action="settings"><span class="classic-drawer-icon">${navIcon('settings')}</span><span>设置</span></button><button type="button" class="classic-drawer-switch-row" data-classic-menu-action="night"><span class="classic-drawer-icon">${navIcon('moon')}</span><span>夜间模式</span><span class="classic-drawer-switch ${nightMode ? 'on' : ''}"><i></i></span></button><button type="button" class="classic-drawer-switch-row" data-classic-menu-action="translate"><span class="classic-drawer-icon">${navIcon('translate')}</span><span>自动翻译</span><span class="classic-drawer-switch is-disabled"><i></i></span></button></nav><footer class="classic-drawer-footer"><span>小猿答疑<br>版本 ${escapeHtml(desktop.appVersion || CLIENT_VERSION)} – 关于</span></footer></aside></div>`);
  const backdrop = $('classic-menu-backdrop');
  syncNightModeControls();
  const avatarImage = backdrop.querySelector('.classic-drawer-avatar img');
  avatarImage?.addEventListener('error', () => {
    avatarImage.remove();
    backdrop.querySelector('.classic-drawer-avatar').textContent = (state.user?.nickname || '猿').slice(0, 1);
  });
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeSessionMenu(); });
  backdrop.querySelectorAll('[data-classic-menu-action]').forEach((button) => { button.onclick = () => handleClassicMenuAction(button.dataset.classicMenuAction); });
}

async function handleClassicMenuAction(action) {
  // 切换主题时保留菜单，立即显示绿色开关和整页配色，方便继续切回。
  if (action === 'night') return toggleNightMode();
  closeSessionMenu();
  if (action === 'group') return createGroup();
  if (action === 'channel') return openChannelNotice();
  if (action === 'contacts') return openContacts();
  if (action === 'calls') return openCallRecords();
  if (action === 'settings') return openSettings();
  if (action === 'translate') return toggleAutoTranslate();
  if (action === 'qr') return openQrCode();
  if (action === 'star') return openFavorites();
}

function openChannelNotice() {
  openGroupForm('channel');
}

function openCallRecords() {
  const previousFocus = document.activeElement;
  closeSessionMenu(); closeSettings(); closeSettingsDetail(); closeFeatureModal();
  // 当前项目不启用实时通话，不将录音、设备检测或拍照伪装成通话记录。
  const gear = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal classic-call-backdrop" data-feature-modal><section class="feature-card classic-call-dialog" role="dialog" aria-modal="true" aria-labelledby="classic-call-title" tabindex="-1"><header><h2 id="classic-call-title">通话记录</h2><button type="button" class="classic-call-settings" aria-label="音频设备设置" title="音频设备设置">${gear}</button></header><p class="classic-call-empty">您还没有拨打过任何电话。</p><button type="button" class="classic-call-close" data-close-modal>关闭</button></section></div>`);
  const modal = document.querySelector('.classic-call-backdrop');
  const close = () => {
    if (!modal.isConnected) return;
    closeFeatureModal();
    (previousFocus?.isConnected && previousFocus !== document.body ? previousFocus : $('classic-menu-button'))?.focus();
  };
  modal.querySelector('[data-close-modal]').onclick = close;
  modal.onclick = event => { if (event.target === modal) close(); };
  modal.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const buttons = [...modal.querySelectorAll('button:not(:disabled)')];
    if (event.shiftKey && (!buttons.includes(document.activeElement) || document.activeElement === buttons[0])) { event.preventDefault(); buttons.at(-1).focus(); }
    else if (!event.shiftKey && (!buttons.includes(document.activeElement) || document.activeElement === buttons.at(-1))) { event.preventDefault(); buttons[0].focus(); }
  };
  modal.querySelector('.classic-call-settings').onclick = async event => {
    if (!modal.isConnected || event.currentTarget.disabled) return;
    event.currentTarget.disabled = true;
    const opening = openComposerAudioDevices(), audio = state.audioDeviceSession;
    await opening;
    if (state.audioDeviceSession === audio) audio?.modal.querySelector('[data-close-modal]')?.focus();
  };
  modal.querySelector('section').focus();
}

function openSimpleDrawerFeature(title, message) {
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal><section class="feature-card classic-simple-feature" role="dialog" aria-modal="true"><header><h2>${escapeHtml(title)}</h2><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header><div class="classic-simple-feature-body"><span class="classic-simple-feature-icon">${navIcon(title === '我的二维码' ? 'qr' : title === '我的收藏' ? 'star' : title === '通话记录' ? 'calls' : 'channel')}</span><p>${escapeHtml(message)}</p></div></section></div>`);
  bindFeatureModal();
}

async function openQrCode() {
  closeFeatureModal();
  const user = state.user || {};
  const account = { token: state.token, userId: Number(user.id) };
  const nickname = user.nickname || '我的账号';
  const publicId = publicUserId(user);
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal data-public-id-qr><section class="classic-qr-dialog" role="dialog" aria-modal="true" aria-label="我的二维码"><header><h2>二维码 - ${escapeHtml(nickname)}</h2></header><div class="classic-qr-body" aria-live="polite"><p>正在生成二维码…</p></div><p class="classic-qr-public-id">用户 ID：${escapeHtml(publicId || '暂不可用')}</p><button class="classic-qr-close" type="button" data-close-modal>关闭</button></section></div>`);
  bindFeatureModal();
  const modal = document.querySelector('[data-public-id-qr]');
  const body = modal.querySelector('.classic-qr-body');
  const current = () => modal.isConnected && document.querySelector('[data-feature-modal]') === modal && sameSendAccount(account);
  if (!publicId) { body.textContent = '用户 ID 暂不可用，请稍后重新登录后重试。'; return; }
  const generateQrCode = typeof desktop.generateQrCode === 'function' ? desktop.generateQrCode.bind(desktop) : window.PulseBrowser?.generateQrCode;
  if (typeof generateQrCode !== 'function') { body.textContent = '当前环境暂时无法生成二维码，请稍后重试。'; return; }
  try {
    const qrImage = await generateQrCode(`pulse://add-friend?public_id=${encodeURIComponent(publicId)}`);
    if (!current()) return;
    const image = document.createElement('img'); image.src = qrImage; image.alt = nickname + '的二维码';
    body.replaceChildren(image);
  } catch (error) {
    if (current()) body.textContent = error.message || '二维码生成失败，请关闭后重试。';
  }
}

function syncNightModeControls() {
  const enabled = document.body.classList.contains('desktop-night-mode');
  document.querySelectorAll('[data-classic-menu-action="night"]').forEach(button => {
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(enabled));
    button.querySelector('.classic-drawer-switch')?.classList.toggle('on', enabled);
  });
  const theme = document.body.dataset.theme || getChatTheme();
  document.querySelectorAll('[data-chat-theme]').forEach(button => {
    const selected = button.dataset.chatTheme === theme;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

function getChatTheme() {
  const saved = localStorage.getItem('pulse_chat_theme');
  if (chatThemeOptions.includes(saved)) return saved;
  return localStorage.getItem('pulse_night_mode') === '1' ? 'night' : 'classic';
}

function getLightChatTheme() {
  const current = document.body.dataset.theme;
  if (chatThemeOptions.includes(current) && current !== 'night') return current;
  const saved = localStorage.getItem('pulse_chat_light_theme');
  if (chatThemeOptions.includes(saved) && saved !== 'night') return saved;
  const preferred = getChatTheme();
  return preferred !== 'night' ? preferred : 'classic';
}

function applyChatTheme(theme, persist = true) {
  if (!chatThemeOptions.includes(theme)) return false;
  const previous = document.body.dataset.theme;
  const enabled = theme === 'night';
  document.body.dataset.theme = theme;
  document.body.classList.toggle('desktop-night-mode', enabled);
  document.documentElement.dataset.colorMode = enabled ? 'night' : 'day';
  document.documentElement.style.colorScheme = enabled ? 'dark' : 'light';
  if (persist) {
    if (theme !== 'night') localStorage.setItem('pulse_chat_light_theme', theme);
    else if (chatThemeOptions.includes(previous) && previous !== 'night') localStorage.setItem('pulse_chat_light_theme', previous);
    localStorage.setItem('pulse_chat_theme', theme);
    localStorage.setItem('pulse_night_mode', enabled ? '1' : '0');
  }
  desktop.setNightMode?.(enabled);
  syncNightModeControls();
  updateInterfaceScaleControls();
  return true;
}

function applyNightMode(enabled, persist = true) {
  return applyChatTheme(enabled ? 'night' : getLightChatTheme(), persist);
}

function toggleNightMode() {
  applyNightMode(!document.body.classList.contains('desktop-night-mode'));
}

function toggleAutoTranslate() {
  const enabled = localStorage.getItem('pulse_auto_translate') === '1';
  localStorage.setItem('pulse_auto_translate', enabled ? '0' : '1');
}

function chatHeaderToolsHtml() {
  return `<span id="chat-user-meta" aria-hidden="true"></span><button id="chat-search-button" type="button" title="搜索聊天记录" aria-label="搜索聊天记录">${navIcon('search')}</button><button id="chat-info-button" type="button" title="查看资料" aria-label="查看资料">${navIcon('sidebar')}</button><button id="chat-more-button" type="button" title="更多操作" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">${navIcon('more')}</button><button id="group-manage" class="secondary-button" type="button" hidden>群组管理</button>`;
}

const autoHideScrollbarTimers = new WeakMap();
document.addEventListener('scroll', (event) => {
  const element = event.target;
  if (!(element instanceof Element) || !element.matches('.messages, .classic-emoji-groups, .classic-emoji-search-results')) return;
  element.classList.add('is-scrolling');
  clearTimeout(autoHideScrollbarTimers.get(element));
  autoHideScrollbarTimers.set(element, setTimeout(() => {
    element.classList.remove('is-scrolling');
    autoHideScrollbarTimers.delete(element);
  }, 700));
}, true);

function bindConversationSidebarResize() {
  const shell = document.querySelector('.desktop-app-shell');
  const sidebar = shell?.querySelector(':scope > .sidebar');
  if (!shell || !sidebar || document.body.classList.contains('conversation-window')) return;
  const storageKey = 'pulse_sidebar_width', defaultWidth = 334, minimumWidth = 170, maximumWidth = 500, minimumMain = 280;
  const raw = localStorage.getItem(storageKey);
  const stored = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  let preferred = Number.isFinite(stored) && stored >= minimumWidth && stored <= maximumWidth ? stored : defaultWidth;
  let active = null;
  const controller = new AbortController(), info = $('chat-info-panel');
  const handle = document.createElement('div');
  handle.id = 'conversation-sidebar-resizer';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', '调整会话列表宽度');
  shell.append(handle);
  const scale = () => shell.getBoundingClientRect().width / shell.clientWidth || 1;
  const bounds = () => {
    const infoWidth = info && !info.hidden && getComputedStyle(info).display !== 'none' ? info.getBoundingClientRect().width / scale() : 0;
    const max = Math.max(0, Math.min(maximumWidth, shell.clientWidth - infoWidth - minimumMain));
    return { min: Math.min(minimumWidth, max), max };
  };
  const clamp = (width, limits) => Math.max(limits.min, Math.min(limits.max, width));
  const rounded = value => Math.round(value * 1000) / 1000;
  const apply = () => {
    const localWidth = shell.clientWidth;
    shell.classList.toggle('is-compact-chat-layout', localWidth <= 900);
    const infoWidth = localWidth <= 900 ? Math.max(170, Math.min(264, localWidth * .25)) : 264;
    const infoValue = infoWidth + 'px', heightValue = rounded(window.innerHeight / scale()) + 'px';
    if (shell.style.getPropertyValue('--chat-info-width') !== infoValue) shell.style.setProperty('--chat-info-width', infoValue);
    if (shell.style.height !== heightValue) shell.style.height = heightValue;
    handle.hidden = sidebar.hidden || getComputedStyle(sidebar).display === 'none';
    if (handle.hidden) return;
    const limits = bounds(), width = rounded(clamp(preferred, limits)), value = width + 'px';
    if (shell.style.getPropertyValue('--conversation-sidebar-width') !== value) shell.style.setProperty('--conversation-sidebar-width', value);
    handle.setAttribute('aria-valuemin', String(rounded(limits.min)));
    handle.setAttribute('aria-valuemax', String(rounded(limits.max)));
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuetext', Math.round(width) + ' 像素');
  };
  const persist = () => { try { localStorage.setItem(storageKey, String(rounded(preferred))); } catch { /* Width still works when browser storage is unavailable. */ } };
  const finish = commit => {
    if (!active) return;
    const previous = active; active = null;
    shell.classList.remove('is-resizing-sidebar');
    if (!commit || !previous.moved) preferred = previous.preferred;
    else persist();
    if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
    apply();
  };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false || handle.hidden) return;
    event.preventDefault(); event.stopPropagation();
    active = { id: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width / scale(), preferred, moved: false };
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    shell.classList.add('is-resizing-sidebar');
  }, { signal: controller.signal });
  handle.addEventListener('pointermove', event => {
    if (!active || active.id !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const delta = (event.clientX - active.x) / scale();
    if (Math.abs(delta) > .5) active.moved = true;
    if (!active.moved) return;
    preferred = clamp(active.width + delta, bounds());
    apply();
  }, { signal: controller.signal });
  handle.addEventListener('pointerup', event => {
    if (!active || active.id !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); finish(true);
  }, { signal: controller.signal });
  for (const name of ['pointercancel', 'lostpointercapture']) handle.addEventListener(name, () => finish(false), { signal: controller.signal });
  handle.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); }, { signal: controller.signal });
  handle.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    finish(false);
    const limits = bounds(), current = sidebar.getBoundingClientRect().width / scale();
    preferred = clamp(event.key === 'Home' ? limits.min : event.key === 'End' ? limits.max : current + (event.key === 'ArrowRight' ? 10 : -10), limits);
    apply(); persist();
  }, { signal: controller.signal });
  window.addEventListener('resize', apply, { signal: controller.signal });
  window.addEventListener('blur', () => finish(false), { signal: controller.signal });
  const observer = new ResizeObserver(apply);
  observer.observe(shell); observer.observe(sidebar);
  if (info) observer.observe(info);
  updateConversationSidebarWidth = apply;
  disposeConversationSidebarResize = () => {
    finish(false); controller.abort(); observer.disconnect(); handle.remove();
    if (updateConversationSidebarWidth === apply) updateConversationSidebarWidth = null;
    disposeConversationSidebarResize = null;
  };
  apply();
}

function renderShell() {
  if (state.token && state.user) void textOutbox.restore(textOutboxAccount()).then(() => renderTextOutbox());
  state.archiveView = false; state.archiveFeedback = '';
  contactActionRevision++;
  disposeConversationSidebarResize?.();
  disposeAuthView?.(); disposeAuthView = null;
  resetChatHistoryLocation();
  resetComposerForNavigation();
  closeImageSendPreview();
  if (state.groupInfoDialog) closeFeatureModal();
  clearTimeout(state.chatSearch?.timer);
  state.chatSearch = null;
  state.chatInfo = null;
  document.body.classList.toggle('desktop-mode', PC_LAYOUT);
  document.body.classList.toggle('web-client', !desktop.isDesktop);
  document.body.classList.remove('web-conversation-open');
  state.page = 'messages';
  const nav = PC_LAYOUT ? '<nav class="desktop-nav" aria-hidden="true"></nav>' : '';
  document.body.innerHTML = `<main class="chat-shell${PC_LAYOUT ? ' desktop-app-shell' : ''}">${nav}<aside class="sidebar"><div class="side-head"><div class="side-title"><div><h1>小猿答疑</h1><p>即时通讯工作台</p></div><button id="new-group" class="icon-button" type="button" title="创建群组">+</button></div><div class="side-actions"><button id="contacts-button" type="button">联系人</button></div><input id="message-search" class="search" placeholder="搜索消息"></div><div id="conversation-list" class="conversation-list"></div><div class="profile"><button id="profile-settings" class="profile-name" type="button"><span id="profile-name"></span><small>账户设置</small></button><button id="logout">退出登录</button></div></aside><section class="main"><header id="chat-head" class="chat-head"><div class="chat-peer"><span id="chat-avatar" class="avatar">聊</span><div><h2 id="chat-title">请选择会话</h2><small id="chat-subtitle">消息会实时同步</small></div></div><div class="chat-head-tools"><span id="chat-user-meta" aria-hidden="true"></span><button type="button" title="搜索聊天记录">⌕</button><button type="button" title="查看资料">▣</button><button type="button" title="更多操作">•••</button><button id="group-manage" class="secondary-button" type="button" hidden>群组管理</button></div></header><div id="messages" class="messages"><p class="empty">请选择一个会话开始聊天</p></div><form id="composer" class="composer"><input id="image-picker" type="file" accept="image/*" hidden><input id="file-picker" type="file" hidden><button id="file-button" type="button" title="发送文件" aria-label="发送文件">${navIcon('folder')}</button><button id="image-button" type="button" title="发送图片" aria-label="发送图片">${navIcon('scissors')}</button><button type="button" class="visual-tool" title="表情" aria-label="表情">${navIcon('smile')}</button><button id="record-button" type="button" title="录音" aria-label="录音">${navIcon('microphone')}</button><button type="button" class="visual-tool" title="语音通话" aria-label="语音通话">${navIcon('calls')}</button><button type="button" class="visual-tool" title="视频通话" aria-label="视频通话">${navIcon('camera')}</button><textarea id="message-input" rows="3" placeholder="输入消息" aria-label="输入消息" autocomplete="off"></textarea><button class="primary">发送</button></form><section id="directory-panel" class="directory-panel" hidden></section></section></main>`;
  const composer = $('composer');
  composer.querySelectorAll('#file-picker, #file-button, #record-button, [title="语音通话"], [title="视频通话"]').forEach((node) => node.remove());
  $('image-button').innerHTML = navIcon('image');
  $('image-button').title = '图片'; $('image-button').setAttribute('aria-label', '发送图片');
  composer.insertAdjacentHTML('afterbegin', '<input id="video-picker" type="file" accept="video/*" hidden>');
  const emojiButton = composer.querySelector('[title="表情"]');
  emojiButton.id = 'emoji-button';
  emojiButton.insertAdjacentHTML('afterend', `<button id="video-button" type="button" title="视频" aria-label="发送视频">${navIcon('video')}</button><button id="contact-card-button" type="button" title="发送名片" aria-label="发送站内名片">${navIcon('contactCard')}</button><button id="shake-button" type="button" title="窗口抖动" aria-label="发送窗口抖动">${navIcon('shake')}</button>`);
  $('logout').onclick = () => { state.token = ''; state.user = null; state.recorder?.stop?.(); state.socket?.close(); localStorage.removeItem('pulse_token'); localStorage.removeItem(passcodeStorageKey); location.reload(); };
  applyChatTheme(getChatTheme(), false);
  $('profile-settings').onclick = openSettings;
  $('new-group').onclick = createGroup;
  $('contacts-button').onclick = () => PC_LAYOUT ? switchPage('friends') : openContacts();
  if (PC_LAYOUT) {
    document.querySelector('.desktop-app-shell').insertAdjacentHTML('beforeend', '<aside id="chat-info-panel" class="classic-info-panel" aria-label="会话资料" hidden></aside><button id="chat-info-collapse" class="classic-info-collapse" type="button" aria-controls="chat-info-panel" title="收起资料" hidden><span aria-hidden="true">›</span><span>收起</span></button>');
    $('chat-info-collapse').onclick = () => { closeChatInfo(); $('chat-info-button')?.focus(); };
    $('conversation-list').insertAdjacentHTML('beforebegin', '<section id="chat-search-panel" class="classic-search-panel" aria-label="搜索消息" hidden></section>');
    document.querySelector('.side-head').innerHTML = `<div class="session-toolbar"><button id="classic-menu-button" class="classic-menu-button" type="button" aria-label="打开菜单">${navIcon('hamburger')}</button><label class="session-search" for="message-search"><span class="classic-search-icon" aria-hidden="true">${navIcon('search')}</span><input id="message-search" class="search" placeholder="搜索" aria-label="搜索会话" autocomplete="off" spellcheck="false"></label><button id="session-add" class="session-add" type="button" aria-label="联系人">${navIcon('contactAdd')}</button></div><div class="classic-tabs"><button class="classic-tab active" type="button" data-page="messages" aria-current="page"><span class="classic-tab-icon">${classicTabIcon('messages')}</span><span>聊天</span></button><button class="classic-tab" type="button" data-page="friends"><span class="classic-tab-icon">${classicTabIcon('friends')}</span><span>好友</span></button><button class="classic-tab" type="button" data-page="groups"><span class="classic-tab-icon">${classicTabIcon('groups')}</span><span>群聊</span></button></div>`;
    $('session-add').onclick = () => openContacts();
    $('classic-menu-button').onclick = toggleSessionMenu;
    document.querySelector('.classic-tabs').insertAdjacentHTML('afterend', '<div id="group-sidebar-actions" class="group-sidebar-actions" aria-label="群聊操作" hidden><button id="sidebar-create-group" type="button">创建群聊</button><button id="sidebar-join-group" type="button">加入群聊</button></div>');
    $('sidebar-create-group').onclick = createGroup;
    $('sidebar-join-group').onclick = joinGroup;
    document.querySelector('.session-search').insertAdjacentHTML('beforeend', `<span id="chat-search-filters" class="classic-search-filters" hidden><button id="chat-search-sender" type="button" aria-label="按发送者筛选" title="按发送者筛选" aria-expanded="false">${navIcon('friends')}</button><button id="chat-search-date" type="button" aria-label="按日期筛选" title="按日期筛选" aria-expanded="false">${navIcon('calendar')}</button></span>`);
    $('chat-search-sender').innerHTML = navIcon('person');
    $('chat-search-sender').onclick = (event) => { event.preventDefault(); openChatSearchFilter('sender'); };
    $('chat-search-date').onclick = (event) => { event.preventDefault(); openChatSearchFilter('date'); };
    
  }
  document.querySelector('.chat-head-tools').innerHTML = chatHeaderToolsHtml();
  $('group-manage').onclick = openGroupManager;
  $('chat-search-button').onclick = openChatHistorySearch;
  $('chat-info-button').onclick = openChatConversationInfo;
  $('chat-more-button').onclick = toggleChatMoreMenu;
  $('chat-head').addEventListener('keydown', (event) => { if (event.key === 'Escape') closeChatMoreMenu(); });
  $('composer').onsubmit = sendMessage;
  if ($('message-input').tagName === 'TEXTAREA') {
    let composing = false;
    $('message-input').addEventListener('compositionstart', () => { composing = true; });
    $('message-input').addEventListener('compositionend', () => { composing = false; });
    $('message-input').addEventListener('keydown', event => {
      if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || composing || event.keyCode === 229) return;
      event.preventDefault();
      composer.requestSubmit();
    });
  }
  bindComposerTools();
  $('image-picker').onchange = (event) => sendMediaFile('image', event.target.files[0]);
  $('video-picker').onchange = (event) => sendMediaFile('video', event.target.files[0]);
  if (PC_LAYOUT) {
    $('image-picker').accept = 'image/jpeg,image/png,image/gif,image/webp';
    $('composer').addEventListener('paste', (event) => {
      const file = [...(event.clipboardData?.files || [])].find(item => item.type.startsWith('image/'));
      if (file && state.active) { event.preventDefault(); sendMediaFile('image', file); }
    });
    $('messages').addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
    $('messages').addEventListener('drop', (event) => {
      if (!event.dataTransfer?.files.length || !state.active) return;
      event.preventDefault();
      if (event.dataTransfer.files.length !== 1) { alert('请每次选择一张图片或一个视频发送。'); return; }
      const file = event.dataTransfer.files[0];
      if (file.type.startsWith('image/')) sendMediaFile('image', file);
      else if (file.type.startsWith('video/')) sendMediaFile('video', file);
      else composerFeedback('这里只支持图片和视频。');
    });
  }
  $('message-search').onkeydown = (event) => { if (event.key === 'Enter') searchMessages(event.target.value); };
  if (PC_LAYOUT) {
    $('message-search').oninput = (event) => state.chatSearch ? queueChatSearch(event.target.value) : filterConversationList(event.target.value);
    $('message-search').onkeydown = (event) => {
      if (event.key === 'Enter') { event.preventDefault(); if (state.chatSearch) { clearTimeout(state.chatSearch.timer); runChatSearch(); } else filterConversationList(event.target.value); }
      if (event.key === 'Escape' && state.chatSearch) { event.stopPropagation(); closeChatSearch(); }
    };
    document.addEventListener('click', (event) => { if (!event.target.closest('.session-toolbar,.classic-profile-drawer,.classic-menu-backdrop')) closeSessionMenu(); });
  }
  $('messages').onscroll = () => { if ($('messages').scrollTop < 48) loadOlderMessages(); };
  document.querySelectorAll('[data-page]').forEach((button) => { button.onclick = () => switchPage(button.dataset.page); });
  refreshFriendRequestBadge();
  updateDesktopChat();
  composerDrafts.bind({ state, input: $('message-input'), changed: refreshConversationDraftPreviews });
  bindConversationSidebarResize();
}

function closeChatMoreMenu() {
  $('chat-more-menu')?.remove();
  $('chat-more-button')?.setAttribute('aria-expanded', 'false');
}

async function toggleChatMoreMenu() {
  if ($('chat-more-menu')) { closeChatMoreMenu(); return; }
  const conversation = state.active;
  if (!conversation) return;
  document.querySelector('.chat-head-tools').insertAdjacentHTML('beforeend', '<div id="chat-more-menu" class="classic-chat-menu" role="menu" aria-label="会话操作"><span class="classic-menu-loading">正在加载…</span></div>');
  const menu = $('chat-more-menu');
  $('chat-more-button').setAttribute('aria-expanded', 'true');
  let actions = [['search', '搜索聊天记录'], ['info', '查看资料']];
  if (conversation.type === 'group') {
    try {
      const profile = await api(`/conversations/groups/profile?conversation_id=${Number(conversation.id)}`);
      if (!menu.isConnected || Number(state.active?.id) !== Number(conversation.id)) return;
      Object.assign(conversation, profile);
      actions = [['info', '查看群组信息'], ['mute', profile.notifications_muted ? '开启消息通知' : '关闭消息通知'], ['invite', '邀请新成员'], ['poll', '发起投票'], ['clear', '清空历史记录']];
      if (!canInviteGroup(profile)) actions = actions.filter(([action]) => action !== 'invite');
      if (profile.can_manage) actions.splice(1, 0, ['manage', '管理群组']);
    } catch (error) {
      if (menu.isConnected) { closeChatMoreMenu(); alert(error.message); }
      return;
    }
  }
  if (!menu.isConnected) return;
  menu.innerHTML = actions.map(([action, label]) => `<button type="button" role="menuitem" data-chat-menu="${action}">${label}</button>`).join('');
  menu.querySelectorAll('[data-chat-menu]').forEach((button) => {
    button.onclick = () => {
      closeChatMoreMenu();
      const handlers = { search: openChatHistorySearch, info: openChatMenuConversationInfo, manage: openGroupManager,
        mute: toggleGroupNotifications, invite: openGroupInvite, poll: openGroupPollForm, clear: clearActiveChatHistory };
      return handlers[button.dataset.chatMenu]?.();
    };
  });
}

function openChatMenuConversationInfo() {
  if (PC_LAYOUT && state.active?.type === 'group') return openGroupInfoDialog();
  return openChatConversationInfo();
}

function closeGroupInfoMenu() {
  if (state.groupInfoDialog) state.groupInfoDialog.menuOpen = false;
  $('group-info-menu')?.remove();
  $('group-info-more')?.setAttribute('aria-expanded', 'false');
}

function closeGroupInfoDialog() {
  const opener = state.groupInfoDialog?.opener;
  closeFeatureModal();
  if (opener?.isConnected) opener.focus();
}

function renderGroupInfoMenu(info) {
  if (state.groupInfoDialog !== info || !info.modal.isConnected || !info.loaded) return;
  $('group-info-menu')?.remove();
  $('group-info-more').setAttribute('aria-expanded', info.menuOpen ? 'true' : 'false');
  if (!info.menuOpen) return;
  const actions = [['invite', '邀请新成员'], ['poll', '发起投票'], ['clear', '清空历史记录']];
  if (!canInviteGroup(info.conversation)) actions.splice(0, 1);
  if (info.conversation.can_manage) actions.unshift(['manage', '管理群组']);
  info.modal.querySelector('.classic-group-info-dialog').insertAdjacentHTML('beforeend', `<div id="group-info-menu" class="classic-group-info-menu" role="menu" aria-label="群组操作">${actions.map(([action, label]) => `<button type="button" role="menuitem" data-group-info-action="${action}">${label}</button>`).join('')}</div>`);
  $('group-info-menu').querySelectorAll('[data-group-info-action]').forEach(button => {
    button.onclick = () => {
      if (state.groupInfoDialog !== info || Number(state.active?.id) !== info.id) return;
      const action = button.dataset.groupInfoAction;
      closeFeatureModal();
      const handlers = { invite: openGroupInvite, poll: openGroupPollForm, clear: clearActiveChatHistory, manage: openGroupManager };
      return handlers[action]?.();
    };
  });
}

function renderGroupInfoDialog(info) {
  if (state.groupInfoDialog !== info || !info.modal.isConnected || Number(state.active?.id) !== info.id) return;
  const conversation = info.conversation;
  const focusedId = info.modal.contains(document.activeElement) ? document.activeElement.id : '';
  info.modal.querySelector('.classic-group-info-dialog').innerHTML = `<header class="classic-group-info-header"><h2 id="group-info-title">群组信息</h2><button id="group-info-more" type="button" aria-label="群组更多操作" aria-haspopup="menu" aria-expanded="${info.menuOpen ? 'true' : 'false'}" ${!info.loaded ? 'disabled' : ''}>${navIcon('more')}</button><button id="group-info-close" type="button" aria-label="关闭群组信息"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="classic-group-info-peer"><span class="classic-group-info-avatar">${panelAvatarHtml(conversation)}</span><strong title="${escapeHtml(conversation.name || '未命名群组')}">${escapeHtml(conversation.name || '未命名群组')}</strong></div><div class="classic-group-info-divider"></div><label class="classic-group-info-notification">${navIcon('bell')}<span>通知</span><input id="group-info-notifications" type="checkbox" role="switch" aria-label="群消息通知" ${!conversation.notifications_muted ? 'checked' : ''} ${!info.loaded || info.saving ? 'disabled' : ''}><span class="classic-group-info-switch" aria-hidden="true"></span></label><p id="group-info-feedback" class="classic-group-info-feedback" role="status">${escapeHtml(info.error || (!info.loaded ? '正在读取群组信息…' : ''))}</p>${info.error && !info.loaded ? '<button id="group-info-retry" class="classic-group-info-retry" type="button">重新加载</button>' : ''}<div class="classic-group-info-divider classic-group-info-bottom"></div>`;
  $('group-info-close').onclick = closeGroupInfoDialog;
  $('group-info-more').onclick = () => { info.menuOpen = !info.menuOpen; renderGroupInfoMenu(info); };
  $('group-info-notifications').onchange = event => saveGroupInfoNotification(info, !event.target.checked);
  $('group-info-retry')?.addEventListener('click', () => loadGroupInfoDialogProfile(info));
  const avatar = info.modal.querySelector('.classic-group-info-avatar img');
  if (avatar) avatar.onerror = () => {
    if (avatar.isConnected && avatar.parentElement) avatar.parentElement.textContent = (conversation.name || '群').slice(0, 1);
  };
  renderGroupInfoMenu(info);
  if (focusedId) {
    const target = $(focusedId);
    (target && !target.disabled ? target : $('group-info-close'))?.focus();
  }
}

async function saveGroupInfoNotification(info, muted) {
  if (state.groupInfoDialog !== info || !info.loaded || info.saving) return;
  info.saving = true;
  info.error = '';
  renderGroupInfoDialog(info);
  try {
    const profile = await api('/conversations/groups/settings', { method: 'POST', body: JSON.stringify({ conversation_id: info.id, notifications_muted: muted }) });
    Object.assign(info.conversation, profile);
    if (Number(state.active?.id) === info.id) Object.assign(state.active, profile);
    const listed = state.conversations.find(item => Number(item.id) === info.id);
    if (listed) Object.assign(listed, profile);
  } catch (error) { info.error = error.message || '通知设置保存失败，请重试'; }
  finally {
    info.saving = false;
    renderGroupInfoDialog(info);
    syncChatInfoNotification();
  }
}

async function loadGroupInfoDialogProfile(info) {
  if (state.groupInfoDialog !== info || info.loading) return;
  info.loading = true;
  info.error = '';
  renderGroupInfoDialog(info);
  try {
    const profile = await api(`/conversations/groups/profile?conversation_id=${info.id}`);
    if (state.groupInfoDialog !== info || !info.modal.isConnected || Number(state.active?.id) !== info.id) return;
    Object.assign(info.conversation, profile);
    info.loaded = true;
  } catch (error) { info.error = error.message || '群组信息加载失败，请重试'; }
  finally { info.loading = false; renderGroupInfoDialog(info); }
}

async function openGroupInfoDialog() {
  const conversation = state.active;
  if (conversation?.type !== 'group') return;
  closeChatMoreMenu();
  closeChatInfo();
  closeGroupManager();
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', '<div class="modal-backdrop feature-modal classic-group-info-backdrop" data-feature-modal><section class="classic-group-info-dialog" role="dialog" aria-modal="true" aria-labelledby="group-info-title" tabindex="-1"></section></div>');
  const info = { id: Number(conversation.id), conversation, loaded: false, loading: false, saving: false, error: '', menuOpen: false, modal: document.querySelector('[data-feature-modal]'), opener: $('chat-more-button') };
  state.groupInfoDialog = info;
  info.modal.addEventListener('click', event => { if (event.target === info.modal) closeGroupInfoDialog(); });
  info.modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (info.menuOpen) { closeGroupInfoMenu(); $('group-info-more')?.focus(); }
      else closeGroupInfoDialog();
      return;
    }
    if (info.menuOpen && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = [...$('group-info-menu').querySelectorAll('button')];
      const current = items.indexOf(document.activeElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1) % items.length : (current <= 0 ? items.length : current) - 1;
      items[index]?.focus();
    }
    if (event.key === 'Tab') {
      const nodes = [...info.modal.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter(node => node.getClientRects().length);
      const index = nodes.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && (index < 0 || index === nodes.length - 1)) { event.preventDefault(); nodes[0]?.focus(); }
    }
  });
  renderGroupInfoDialog(info);
  $('group-info-close').focus();
  await loadGroupInfoDialogProfile(info);
  if (state.groupInfoDialog === info && (document.activeElement === document.body || !info.modal.contains(document.activeElement))) $('group-info-close')?.focus();
}

document.addEventListener('pointerdown', event => {
  if (event.target instanceof Element && !event.target.closest('#group-info-more,#group-info-menu')) closeGroupInfoMenu();
});

async function toggleGroupNotifications() {
  const conversation = state.active;
  if (conversation?.type !== 'group') return;
  try {
    const profile = await api('/conversations/groups/settings', { method: 'POST', body: JSON.stringify({ conversation_id: conversation.id, notifications_muted: !conversation.notifications_muted }) });
    Object.assign(conversation, profile);
    syncChatInfoNotification();
    await loadConversations();
  } catch (error) { alert(error.message); }
}

function canInviteGroup(group) { return group?.type === 'group' && ['owner', 'admin'].includes(group.my_role) && group.can_invite !== false; }

async function openGroupInvite() {
  const conversation = state.active;
  if (!canInviteGroup(conversation)) return;
  closeGroupManager(); closeFeatureModal();
  groupCreator.openInvite(conversation);
}

function confirmGroupAction(title, description, actionLabel, action) {
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal><section class="feature-card classic-group-action" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><header><h2>${escapeHtml(title)}</h2><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header><p class="classic-action-hint">${escapeHtml(description)}</p><p id="group-action-feedback" class="form-feedback" role="status"></p><footer><button type="button" data-group-cancel class="secondary-button">取消</button><button type="button" id="group-action-confirm" class="danger-button">${escapeHtml(actionLabel)}</button></footer></section></div>`);
  bindFeatureModal();
  const modal = document.querySelector('[data-feature-modal]');
  modal.querySelector('[data-group-cancel]').onclick = closeFeatureModal;
  $('group-action-confirm').onclick = async () => {
    const button = $('group-action-confirm'); button.disabled = true;
    try { await action(); modal.remove(); }
    catch (error) { if (modal.isConnected) $('group-action-feedback').textContent = error.message; }
    finally { button.disabled = false; }
  };
}

function clearActiveChatHistory() {
  const conversation = state.active;
  if (!conversation) return;
  confirmGroupAction('清空历史记录', '仅清空当前账号在此会话中的历史记录，其他群员的消息不受影响。清空后无法恢复，是否继续？', '清空记录', async () => {
    const result = await api('/messages/clear-history', { method: 'POST', body: JSON.stringify({ conversation_id: conversation.id }) });
    conversation.cleared_before_message_id = result.cleared_before_message_id;
    if (Number(state.active?.id) === Number(conversation.id)) {
      resetChatHistoryLocation();
      state.historyPage = 1; state.historyHasMore = false;
      $('messages').innerHTML = '<p class="empty">历史记录已清空，新消息将显示在这里</p>';
      if (state.chatSearch) runChatSearch();
    }
    await loadConversations();
  });
}

function openGroupPollForm() {
  const conversation = state.active;
  if (conversation?.type !== 'group') return;
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal><section class="feature-card classic-group-action" role="dialog" aria-modal="true" aria-label="发起投票"><header><h2>发起投票</h2><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header><form id="group-poll-form" class="inline-form"><label>投票问题<input id="group-poll-question" maxlength="200" required placeholder="输入投票问题"></label><label>投票选项（每行一个，2—10 项）<textarea id="group-poll-options" rows="5" maxlength="1010" required placeholder="选项一&#10;选项二"></textarea></label><label class="classic-poll-choice"><input id="group-poll-multiple" type="checkbox">允许多选</label><label>投票时长<select id="group-poll-duration"><option value="0">不限时，手动结束</option><option value="1">1 小时</option><option value="24">24 小时</option><option value="72">3 天</option></select></label><small class="classic-action-hint">匿名投票，可重新选择；发起人和群管理员可以结束投票。</small><p id="group-poll-feedback" class="form-feedback" role="status"></p><button class="primary" type="submit">发起投票</button></form></section></div>`);
  bindFeatureModal();
  const modal = document.querySelector('[data-feature-modal]');
  const requestId = `pc-poll-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  $('group-poll-form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget || $('group-poll-form');
    const button = form.querySelector('button[type="submit"]');
    const options = $('group-poll-options').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (options.length < 2 || options.length > 10 || new Set(options).size !== options.length || options.some(value => value.length > 100)) { $('group-poll-feedback').textContent = '请填写 2—10 个不同的选项，每项不超过 100 个字符'; return; }
    button.disabled = true;
    try {
      const result = await api('/conversations/groups/polls', { method: 'POST', body: JSON.stringify({ conversation_id: conversation.id, question: $('group-poll-question').value.trim(), options, multiple_choice: $('group-poll-multiple').checked, duration_hours: Number($('group-poll-duration').value), request_id: requestId }) });
      groupPollCache.set(Number(result.poll.id), result.poll);
      if (Number(state.active?.id) === Number(conversation.id)) appendMessage(result.message);
      modal.remove();
      await loadConversations();
    } catch (error) { if (modal.isConnected) $('group-poll-feedback').textContent = error.message; }
    finally { button.disabled = false; }
  };
  $('group-poll-question').focus();
}

const groupPollCache = new Map();
let groupPollRefreshBusy = false;

function groupPollHtml(poll) {
  const selected = poll.selected_option_ids || [];
  const results = poll.closed || selected.length > 0;
  return `<strong>${escapeHtml(poll.question)}</strong><small>匿名投票 · ${poll.multiple_choice ? '多选' : '单选'}${poll.closed ? ' · 已结束' : ''}</small><form data-poll-vote="${Number(poll.id)}">${(poll.options || []).map(option => `<label class="classic-poll-option ${selected.includes(Number(option.id)) ? 'is-selected' : ''}"><input type="${poll.multiple_choice ? 'checkbox' : 'radio'}" name="poll-${Number(poll.id)}" value="${Number(option.id)}" ${selected.includes(Number(option.id)) ? 'checked' : ''} ${poll.closed ? 'disabled' : ''}><span>${escapeHtml(option.label)}${results ? `<small>${Number(option.votes)} 票 · ${Number(option.percent)}%</small><i style="width:${Math.min(100, Math.max(0, Number(option.percent)))}%"></i>` : ''}</span></label>`).join('')}<div class="classic-poll-footer"><span>${Number(poll.voter_count)} 人已投票</span>${!poll.closed ? `<button type="submit">${selected.length ? '更新选择' : '投票'}</button>` : ''}${poll.can_close && !poll.closed ? `<button type="button" data-poll-close="${Number(poll.id)}">结束投票</button>` : ''}</div><p class="form-feedback" data-poll-feedback role="status"></p></form>`;
}

function updateGroupPollCards(poll) {
  groupPollCache.set(Number(poll.id), poll);
  document.querySelectorAll(`[data-group-poll="${Number(poll.id)}"]`).forEach(card => {
    // 刷新结果时保留尚未提交的选择，不打断用户操作。
    const choices = [...card.querySelectorAll('input:checked')].map(input => input.value);
    const dirty = card.dataset.dirty === 'true';
    card.innerHTML = groupPollHtml(poll);
    if (dirty && !poll.closed) card.querySelectorAll('input').forEach(input => { input.checked = choices.includes(input.value); });
    if (poll.closed) delete card.dataset.dirty;
  });
  bindGroupPollActions();
}

function bindGroupPollActions() {
  document.querySelectorAll('[data-group-poll] input').forEach(input => { input.onchange = () => { input.closest('[data-group-poll]').dataset.dirty = 'true'; }; });
  document.querySelectorAll('[data-poll-vote]').forEach(form => {
    form.onsubmit = async event => {
      event.preventDefault();
      const choices = [...form.querySelectorAll('input:checked')].map(input => Number(input.value));
      const feedback = form.querySelector('[data-poll-feedback]');
      if (!choices.length) { feedback.textContent = '请先选择一个选项'; return; }
      const button = form.querySelector('button[type="submit"]'); button.disabled = true;
      try {
        const poll = await api('/conversations/groups/polls/vote', { method: 'POST', body: JSON.stringify({ poll_id: Number(form.dataset.pollVote), option_ids: choices }) });
        delete form.closest('[data-group-poll]').dataset.dirty;
        updateGroupPollCards(poll);
      } catch (error) { feedback.textContent = error.message; }
      finally { button.disabled = false; }
    };
  });
  document.querySelectorAll('[data-poll-close]').forEach(button => {
    button.onclick = () => confirmGroupAction('结束投票', '结束后所有群员都不能再投票，是否继续？', '结束投票', async () => {
      const poll = await api('/conversations/groups/polls/close', { method: 'POST', body: JSON.stringify({ poll_id: Number(button.dataset.pollClose) }) });
      updateGroupPollCards(poll);
    });
  });
  document.querySelectorAll('[data-poll-retry]').forEach(button => { button.onclick = () => refreshGroupPollCards(); });
}

async function refreshGroupPollCards() {
  const conversationId = Number(state.active?.id);
  if (state.active?.type !== 'group' || groupPollRefreshBusy) return;
  const cards = [...document.querySelectorAll('[data-group-poll]')].slice(-50);
  const ids = [...new Set(cards.map(card => Number(card.dataset.groupPoll)))];
  if (!ids.length) return;
  groupPollRefreshBusy = true;
  try {
    const result = await api(`/conversations/groups/polls?conversation_id=${conversationId}&ids=${ids.join(',')}`);
    if (Number(state.active?.id) !== conversationId) return;
    (result.items || []).forEach(updateGroupPollCards);
    const found = new Set((result.items || []).map(poll => Number(poll.id)));
    cards.filter(card => !found.has(Number(card.dataset.groupPoll))).forEach(card => { card.innerHTML = '<small>该投票已不可用</small>'; });
  } catch (error) {
    if (Number(state.active?.id) === conversationId) cards.filter(card => !card.querySelector('form')).forEach(card => { card.innerHTML = `<small>${escapeHtml(error.message)}</small><button type="button" data-poll-retry>重新加载</button>`; });
    bindGroupPollActions();
  } finally { groupPollRefreshBusy = false; }
}

// 每次批量刷新当前聊天的投票；窗口隐藏时不请求，不随每张卡片创建计时器。
setInterval(() => { if (state.token && !document.hidden && state.page === 'messages') refreshGroupPollCards(); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token) refreshGroupPollCards(); });

document.addEventListener('pointerdown', (event) => {
  if (event.target instanceof Element && !event.target.closest('#chat-more-button,#chat-more-menu')) closeChatMoreMenu();
});

function syncChatInfoToggle() {
  const expanded = Boolean(state.chatInfo && !$('chat-info-panel')?.hidden);
  const label = state.active?.type === 'group' ? '群组资料' : '会话资料';
  const toggle = $('chat-info-button');
  if (toggle) {
    if (state.active?.type === 'direct') {
      toggle.removeAttribute('aria-controls');
      toggle.removeAttribute('aria-expanded');
      toggle.setAttribute('aria-haspopup', 'dialog');
      toggle.setAttribute('aria-label', '查看个人资料');
      toggle.title = '查看个人资料';
    } else {
      toggle.removeAttribute('aria-haspopup');
    toggle.setAttribute('aria-controls', 'chat-info-panel');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', (expanded ? '收起' : '展开') + label);
    toggle.title = (expanded ? '收起' : '展开') + label;
    }
  }
  const collapse = $('chat-info-collapse');
  if (collapse) { collapse.hidden = !expanded; collapse.setAttribute('aria-label', '收起' + label); }
}

function closeChatInfo() {
  state.chatInfo = null;
  const panel = $('chat-info-panel');
  if (panel) { panel.hidden = true; panel.innerHTML = ''; }
  document.querySelector('.desktop-app-shell')?.classList.remove('has-chat-info');
  updateConversationSidebarWidth?.();
  syncChatInfoToggle();
}

function closeChatSearchFilter() {
  closeClassicChatSearchFilter();
}

function closeChatSearch() {
  const search = state.chatSearch;
  if (!search) return;
  clearTimeout(search.timer);
  state.chatSearch = null;
  closeChatSearchFilter();
  $('chat-search-panel').hidden = true;
  $('chat-search-panel').innerHTML = '';
  $('conversation-list').hidden = false;
  $('chat-search-filters').hidden = true;
  $('chat-search-button')?.setAttribute('aria-expanded', 'false');
  const input = $('message-search');
  input.value = search.previousQuery;
  input.placeholder = '搜索';
  input.setAttribute('aria-label', '搜索会话');
  renderConversationList();
  filterConversationList(input.value);
}

function closeChatPanels() { closeChatInfo(); closeChatSearch(); }

function panelAvatarHtml(conversation) {
  return conversation.avatar_url ? `<img src="${escapeHtml(mediaUrl(conversation.avatar_url))}" alt="">` : escapeHtml((conversation.name || '群').slice(0, 1));
}

function renderChatInfoPanel(info) {
  if (state.chatInfo !== info || Number(state.active?.id) !== info.id) return;
  const conversation = state.active;
  const title = conversation.type === 'group' ? '群组信息' : '会话信息';
  $('chat-info-panel').innerHTML = `<header class="classic-info-head"><h2>${title}</h2><button id="chat-info-close" type="button" aria-label="关闭会话资料">×</button></header><div class="classic-info-peer"><span class="classic-panel-avatar">${panelAvatarHtml(conversation)}</span><strong>${escapeHtml(conversation.name || '未命名会话')}</strong></div><div class="classic-panel-divider"></div>${conversation.type === 'group' ? `<label class="classic-info-notification">${navIcon('bell')}<span>通知</span><input id="chat-info-notifications" type="checkbox" role="switch" aria-label="群消息通知" ${!conversation.notifications_muted ? 'checked' : ''} ${!info.loaded || info.saving ? 'disabled' : ''}><span class="classic-panel-switch" aria-hidden="true"></span></label><div class="classic-panel-divider"></div>` : ''}<p id="chat-info-feedback" class="classic-panel-feedback" role="status">${escapeHtml(info.error || (!info.loaded ? '正在读取群组信息…' : ''))}</p>${info.error && !info.loaded ? '<button id="chat-info-retry" class="classic-panel-retry" type="button">重新加载</button>' : ''}`;
  $('chat-info-close').onclick = () => { closeChatInfo(); $('chat-info-button')?.focus(); };
  $('chat-info-retry')?.addEventListener('click', () => loadChatInfoProfile(info));
  if ($('chat-info-notifications')) $('chat-info-notifications').onchange = async (event) => {
    const muted = !event.target.checked;
    info.saving = true;
    info.error = '';
    event.target.disabled = true;
    try {
      const profile = await api('/conversations/groups/settings', { method: 'POST', body: JSON.stringify({ conversation_id: info.id, notifications_muted: muted }) });
      Object.assign(conversation, profile);
      const listed = state.conversations.find(item => Number(item.id) === info.id);
      if (listed) Object.assign(listed, profile);
    } catch (error) { info.error = error.message || '通知设置保存失败，请重试'; }
    finally { info.saving = false; renderChatInfoPanel(info); }
  };
}

function syncChatInfoNotification() {
  const dialog = state.groupInfoDialog;
  if (dialog?.loaded && !dialog.saving && Number(state.active?.id) === dialog.id) renderGroupInfoDialog(dialog);
  const info = state.chatInfo;
  if (!info || info.saving || !info.loaded || Number(state.active?.id) !== info.id) return;
  const input = $('chat-info-notifications');
  if (input) input.checked = !state.active.notifications_muted;
}

async function loadChatInfoProfile(info) {
  info.error = '';
  renderChatInfoPanel(info);
  try {
    const profile = await api(`/conversations/groups/profile?conversation_id=${info.id}`);
    if (state.chatInfo !== info || Number(state.active?.id) !== info.id) return;
    Object.assign(state.active, profile);
    info.loaded = true;
  } catch (error) { info.error = error.message || '群组信息加载失败'; }
  renderChatInfoPanel(info);
}

async function openDesktopChatInfo(conversation) {
  if (state.chatInfo?.id === Number(conversation.id)) { closeChatInfo(); return; }
  closeChatInfo();
  closeFeatureModal();
  const info = { id: Number(conversation.id), loaded: conversation.type !== 'group', saving: false, error: '' };
  state.chatInfo = info;
  document.querySelector('.desktop-app-shell').classList.add('has-chat-info');
  $('chat-info-panel').hidden = false;
  updateConversationSidebarWidth?.();
  syncChatInfoToggle();
  renderChatInfoPanel(info);
  if (conversation.type === 'group') await loadChatInfoProfile(info);
}

function openDesktopChatSearch(conversation) {
  if (state.chatSearch?.id === Number(conversation.id)) { closeChatSearch(); return; }
  closeChatSearch();
  closeFeatureModal();
  const search = { id: Number(conversation.id), conversation, previousQuery: $('message-search').value, keyword: '', senderId: 0, senderName: '', date: '', items: [], total: 0, page: 0, request: 0, loading: false, status: '', timer: null };
  state.chatSearch = search;
  $('conversation-list').hidden = true;
  $('chat-search-panel').hidden = false;
  $('chat-search-filters').hidden = false;
  $('chat-search-sender').hidden = conversation.type !== 'group';
  $('chat-search-button').setAttribute('aria-expanded', 'true');
  const input = $('message-search');
  input.value = '';
  input.placeholder = '搜索';
  input.setAttribute('aria-label', '搜索当前会话的消息');
  renderChatSearchPanel(search);
  input.focus();
}

function highlightChatSearchText(value, keyword) {
  if (!keyword) return escapeHtml(value);
  const text = String(value || '');
  const lower = text.toLowerCase();
  const term = keyword.toLowerCase();
  let offset = 0, result = '', index;
  while ((index = lower.indexOf(term, offset)) !== -1) {
    result += escapeHtml(text.slice(offset, index)) + `<mark>${escapeHtml(text.slice(index, index + term.length))}</mark>`;
    offset = index + term.length;
  }
  return result + escapeHtml(text.slice(offset));
}

function renderChatSearchPanel(search) {
  if (state.chatSearch !== search) return;
  const conversation = search.conversation;
  const filters = `${search.senderId ? `<button type="button" data-clear-search-filter="sender">${escapeHtml(search.senderName)} ×</button>` : ''}${search.date ? `<button type="button" data-clear-search-filter="date">${escapeHtml(search.date)} ×</button>` : ''}`;
  $('chat-search-panel').innerHTML = `<div class="classic-search-heading">搜索消息</div><div class="classic-search-scope"><span class="classic-panel-avatar">${panelAvatarHtml(conversation)}</span><span class="classic-search-scope-name">${navIcon(conversation.type === 'group' ? 'groups' : 'friends')}<strong>${escapeHtml(conversation.name || '当前会话')}</strong></span><button id="chat-search-close" type="button" title="关闭搜索" aria-label="关闭消息搜索">×</button></div>${filters ? `<div class="classic-search-active-filters">${filters}</div>` : ''}<div class="classic-search-heading classic-search-summary">${search.page ? `搜索消息 · ${search.total} 条` : '搜索消息'}</div><div class="classic-sidebar-search-results" aria-live="polite">${search.items.map(message => `<article class="classic-sidebar-search-result"><header><strong>${escapeHtml(message.sender_nickname || (Number(message.sender_id) === Number(state.user.id) ? state.user.nickname : '群成员'))}</strong><time>${escapeHtml(message.created_at || '')}</time></header><p>${highlightChatSearchText(message.body?.text || message.body?.name || `[${messageType(message.type)}消息]`, search.keyword)}</p></article>`).join('')}<p class="classic-search-status" role="status">${escapeHtml(search.status || (search.loading ? '正在搜索…' : search.page && !search.items.length ? '没有找到相关消息' : ''))}</p>${search.page && search.items.length < search.total ? `<button id="chat-search-more" class="classic-search-more" type="button" ${search.loading ? 'disabled' : ''}>${search.loading ? '正在加载…' : '加载更多'}</button>` : ''}</div>`;
  $('chat-search-close').onclick = () => { closeChatSearch(); $('chat-search-button')?.focus(); };
  $('chat-search-more')?.addEventListener('click', () => runChatSearch(true));
  $('chat-search-panel').querySelectorAll('.classic-sidebar-search-result').forEach((row, index) => {
    row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-label', '定位这条消息');
    row.onclick = () => locateChatSearchMessage({ messageId: Number(search.items[index].id) });
    row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); } };
  });
  $('chat-search-panel').querySelectorAll('[data-clear-search-filter]').forEach(button => {
    button.onclick = () => { if (button.dataset.clearSearchFilter === 'sender') { search.senderId = 0; search.senderName = ''; } else search.date = ''; runChatSearch(); };
  });
  $('chat-search-sender').classList.toggle('is-selected', Boolean(search.senderId));
  $('chat-search-date').classList.toggle('is-selected', Boolean(search.date));
}

function queueChatSearch(keyword) {
  const search = state.chatSearch;
  if (!search) return;
  clearTimeout(search.timer);
  search.locateRequest = (search.locateRequest || 0) + 1;
  search.request += 1; // 立即作废上一关键词的在途响应。
  search.keyword = String(keyword).trim();
  search.items = []; search.total = 0; search.page = 0; search.status = '';
  search.loading = Boolean(search.keyword || search.senderId || search.date);
  renderChatSearchPanel(search);
  search.timer = setTimeout(() => { if (state.chatSearch === search) runChatSearch(); }, 280);
}

async function runChatSearch(append = false) {
  const search = state.chatSearch;
  if (!search || (append && search.loading)) return;
  if (!append) search.locateRequest = (search.locateRequest || 0) + 1;
  clearTimeout(search.timer);
  const request = ++search.request;
  search.keyword = $('message-search').value.trim();
  if (!append) { search.items = []; search.page = 0; search.total = 0; }
  search.status = '';
  if (!search.keyword && !search.senderId && !search.date) { search.loading = false; renderChatSearchPanel(search); return; }
  const page = append ? search.page + 1 : 1;
  search.loading = true;
  renderChatSearchPanel(search);
  try {
    const params = new URLSearchParams({ q: search.keyword, conversation_id: String(search.id), page: String(page), size: '20' });
    if (search.senderId) params.set('sender_id', String(search.senderId));
    if (search.date) params.set('date', search.date);
    const result = await api(`/messages/search?${params}`);
    if (state.chatSearch !== search || search.request !== request || Number(state.active?.id) !== search.id) return;
    search.items = append ? [...search.items, ...(result.items || [])] : (result.items || []);
    search.total = Number(result.total ?? search.items.length);
    search.page = page;
  } catch (error) { if (state.chatSearch === search && search.request === request) search.status = error.message || '搜索失败，请重试'; }
  finally { if (state.chatSearch === search && search.request === request) { search.loading = false; renderChatSearchPanel(search); } }
}

async function openChatSearchFilter(kind) {
  return openClassicChatSearchFilter(kind);
}

document.addEventListener('pointerdown', (event) => {
  if (event.target instanceof Element && !event.target.closest('#chat-search-filter-popover,#chat-search-filters')) closeChatSearchFilter();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if ($('chat-search-filter-popover')) closeChatSearchFilter();
  else if (!document.querySelector('.modal-backdrop')) { if (state.chatInfo) closeChatInfo(); else if (state.chatSearch) closeChatSearch(); }
});

function openChatHistorySearch() {
  closeChatMoreMenu();
  const conversation = state.active;
  if (!conversation) return;
  if (PC_LAYOUT) return openDesktopChatSearch(conversation);
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal><section class="feature-card classic-history-search" role="dialog" aria-modal="true" aria-labelledby="chat-history-search-title"><header><h2 id="chat-history-search-title">搜索聊天记录</h2><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header><form id="chat-history-search-form" class="inline-search"><input id="chat-history-search-input" placeholder="搜索当前会话" aria-label="搜索当前会话" required><button type="submit" class="primary">搜索</button></form><div id="chat-history-search-results" class="classic-history-results" aria-live="polite"><p class="modal-empty">输入关键词，搜索当前会话的聊天记录</p></div></section></div>`);
  bindFeatureModal();
  const form = $('chat-history-search-form');
  const input = $('chat-history-search-input');
  const results = $('chat-history-search-results');
  form.onsubmit = async (event) => {
    event.preventDefault();
    const keyword = input.value.trim();
    if (!keyword) return;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    results.textContent = '正在搜索…';
    try {
      const response = await api(`/messages/search?q=${encodeURIComponent(keyword)}&conversation_id=${Number(conversation.id)}`);
      results.innerHTML = (response.items || []).map((message) => `<article class="classic-history-result"><p>${escapeHtml(message.body?.text || `[${messageType(message.type)}消息]`)}</p><small>${escapeHtml(message.created_at || '')}</small></article>`).join('') || '<p class="modal-empty">没有找到相关消息</p>';
    } catch (error) { results.textContent = error.message || '搜索失败'; }
    finally { submit.disabled = false; }
  };
  input.focus();
}

function openChatConversationInfo() {
  closeChatMoreMenu();
  const conversation = state.active;
  if (!conversation) return;
  if (conversation.type === 'direct') {
    const peerId = Number(conversation.peer_user_id);
    if (!Number.isSafeInteger(peerId) || peerId <= 0) return composerFeedback('未取得联系人资料，请重新打开会话后重试。');
    closeChatInfo();
    return openContactProfile(peerId);
  }
  if (PC_LAYOUT) return openDesktopChatInfo(conversation);
  if (conversation.type === 'group') return openGroupManager(false);
  closeFeatureModal();
  const name = conversation.name || '未命名会话';
  const avatar = conversation.avatar_url ? `<img src="${escapeHtml(mediaUrl(conversation.avatar_url))}" alt="">` : escapeHtml(name.slice(0, 1));
  const type = conversation.type === 'favorites' ? '我的收藏' : conversation.type === 'channel' ? '频道' : '单聊';
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal><section class="feature-card classic-conversation-info" role="dialog" aria-modal="true" aria-label="会话资料"><header><h2>会话资料</h2><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header><div class="classic-conversation-info-body"><span class="avatar">${avatar}</span><h3>${escapeHtml(name)}</h3><p>${type}</p><small>创建时间：${escapeHtml(conversation.created_at || '暂无记录')}</small></div></section></div>`);
  bindFeatureModal();
}

async function refreshFriendRequestBadge() {
  if (!PC_LAYOUT || !$('friend-request-badge')) return;
  try { const result = await api('/contact-requests?direction=received&size=100'); const cleared = loadClearedNewFriendIds(); const count = (result.items || []).filter((item) => item.status === 'pending' && !cleared.has(Number(item.id))).length; const badge = $('friend-request-badge'); badge.textContent = count; badge.hidden = count === 0; } catch { /* 登录状态变化时由启动流程处理 */ }
}

function renderDesktopChatHeader(conversation) {
  if (!PC_LAYOUT || !conversation) return;
  syncChatInfoToggle();
  const title = conversation.name || (conversation.type === 'direct' ? '单聊' : '会话');
  const isMemberConversation = ['group', 'channel'].includes(conversation.type);
  const internalProfile = conversation.type === 'direct' && state.user?.internal_staff ? conversation.internal_profile : null;
  const titleNode = $('chat-title');
  titleNode.textContent = title;
  const peerId = Number(conversation.peer_user_id);
  if (conversation.type === 'direct' && Number.isSafeInteger(peerId) && peerId > 0 && peerId !== Number(state.user?.id)) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'chat-peer-title'; button.textContent = title;
    button.setAttribute('aria-label', `查看${title}的个人资料`);
    button.onclick = () => openContactProfile(peerId);
    titleNode.replaceChildren(button);
  }
  $('chat-subtitle').textContent = isMemberConversation
    ? (conversation.member_count != null && Number.isSafeInteger(Number(conversation.member_count)) && Number(conversation.member_count) >= 0 ? `${Number(conversation.member_count)} 位成员` : '成员数加载中…')
    : (conversation.type === 'favorites' ? '' : internalProfile ? internalChatHeaderText(internalProfile) : '最近上线时间和资料信息');
  // 顶部只保留头像、名称和副标题，避免重复显示“用户信息／群组：xxx”。
  $('chat-user-meta').textContent = '';
  renderStableConversationContent($('chat-avatar'), conversation.avatar_url
    ? `<img src="${escapeHtml(mediaUrl(conversation.avatar_url))}" alt="">`
    : escapeHtml(title.slice(0, 1)), Number(conversation.id));
  $('group-manage').hidden = conversation.type !== 'group';
}

function formatInternalLoginTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const date = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return raw;
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function internalChatHeaderText(profile) {
  return [profile.online ? '在线' : '离线', formatInternalLoginTime(profile.last_login_at), profile.last_login_ip, profile.last_login_location]
    .filter(value => String(value || '').trim())
    .join(' · ') || '暂无登录记录';
}

async function refreshChatHeaderProfile(conversationId) {
  const conversation = state.active;
  if (!conversation || Number(conversation.id) !== Number(conversationId)) return;
  if (conversation.type === 'direct') {
    if (!state.user?.internal_staff || !conversation.peer_user_id) return;
    try {
      const profile = await api(`/contacts/internal-profile?user_id=${Number(conversation.peer_user_id)}`);
      if (Number(state.active?.id) !== Number(conversationId)) return;
      conversation.internal_profile = profile;
      renderDesktopChatHeader(conversation);
    } catch {
      // 内部资料接口失败时保留普通聊天头部，不影响消息收发。
    }
    return;
  }
  if (conversation.type !== 'group') return;
  try {
    const profile = await api(`/conversations/groups/profile?conversation_id=${Number(conversationId)}`);
    if (Number(state.active?.id) !== Number(conversationId)) return;
    // 服务端资料响应不能改变当前会话的身份；这样即使旧请求迟到，也不会把会话切回另一条记录。
    Object.assign(state.active, profile, { id: Number(conversationId), type: 'group' });
    const listed = state.conversations.find(item => Number(item.id) === Number(conversationId));
    if (listed) Object.assign(listed, profile, { id: Number(conversationId), type: 'group' });
    renderDesktopChatHeader(state.active);
  } catch {
    // 群资料接口不可用时仍保留会话列表中的名称和成员数，聊天不应被阻断。
  }
}

function updateComposerConversationTools() {
  composerPermissions.update();
  const shakeButton = $('shake-button');
  if (!shakeButton) return;
  const canShake = Boolean(state.user?.internal_staff === true && state.active && !state.favoriteMode && state.active.type === 'direct');
  shakeButton.hidden = !canShake;
  shakeButton.disabled = !canShake || Boolean(composerPermissions.reason(state.active));
  shakeButton.setAttribute('aria-hidden', canShake ? 'false' : 'true');
}

function updateDesktopChat() {
  composerDrafts.refresh();
  renderTextOutbox(); textOutbox.resume();
  updateComposerConversationTools();
  if (!PC_LAYOUT || state.page !== 'messages') return;
  if (!state.active) closeChatPanels();
  if (state.favoriteMode) {
    $('chat-head').hidden = false;
    $('composer').hidden = false;
    $('messages').hidden = false;
    $('chat-title').textContent = '我的收藏';
    $('chat-subtitle').textContent = '';
    $('chat-user-meta').textContent = '';
    $('chat-avatar').innerHTML = navIcon('star');
    $('group-manage').hidden = true;
    return;
  }
  $('chat-head').hidden = !state.active;
  $('composer').hidden = !state.active;
  if (state.active) renderDesktopChatHeader(state.active);
  if (!state.active) $('messages').innerHTML = desktopEmpty('暂无聊天', '选择一个会话开始聊天');
}

async function openFavorites() {
  state.archiveView = false; state.archiveFeedback = '';
  closeContactProfile();
  resetChatHistoryLocation();
  resetComposerForNavigation();
  if (!PC_LAYOUT) return openSimpleDrawerFeature('我的收藏', '请使用电脑端查看收藏内容。');
  closeSessionMenu();
  closeChatMoreMenu();
  closeFeatureModal();
  closeChatPanels();
  try {
    const favorite = await api('/conversations/favorites', { method: 'POST', body: JSON.stringify({}) });
    state.page = 'messages';
    state.sidebarMode = 'messages';
    state.favoriteMode = true;
    state.active = favorite;
    if (!desktop.isDesktop) document.body.classList.add('web-conversation-open');
    state.historyPage = 1;
    state.historyHasMore = true;
    document.body.classList.remove('directory-page', 'friends-directory-page');
    document.body.classList.add('favorite-mode');
    document.querySelectorAll('.desktop-nav-item,.classic-tab').forEach((node) => { node.classList.toggle('active', node.dataset.page === 'messages'); node.setAttribute('aria-current', node.dataset.page === 'messages' ? 'page' : 'false'); });
    $('directory-panel').hidden = true;
    $('messages').hidden = false;
    $('chat-head').hidden = false;
    $('composer').hidden = false;
    document.querySelector('.sidebar').hidden = false;
    $('messages').innerHTML = '';
    $('chat-title').textContent = '我的收藏';
    $('chat-subtitle').textContent = '收藏的消息和文件';
    $('chat-user-meta').textContent = '';
    $('chat-avatar').innerHTML = navIcon('star');
    $('group-manage').hidden = true;
    subscribeConversation(Number(favorite.id));
    const result = await api(`/messages/history?conversation_id=${favorite.id}&size=50`);
    const messages = (result.items || []).reverse();
    $('messages').innerHTML = messages.map(messageHtml).join('') || '<p class="empty">暂无收藏内容</p>';
    bindMessageActions();
    $('messages').scrollTop = $('messages').scrollHeight;
    await markMessagesRead(messages);
    await loadConversations();
    updateDesktopChat();
  } catch (error) {
    alert(error.message || '打开我的收藏失败');
  }
}

function toggleSessionMenu() { if ($('classic-menu-backdrop')) closeSessionMenu(); else openClassicMenu(); }
function closeSessionMenu() { $('classic-menu-backdrop')?.remove(); }
async function handleSessionAction(action) { closeSessionMenu(); if (action === 'friend') await openContacts(); else if (action === 'group') await createGroup(); else if (action === 'join') await joinGroup(); }

async function switchPage(page) {
  state.archiveView = false; state.archiveFeedback = '';
  closeConversationFolderModal();
  closeContactProfile();
  resetComposerForNavigation();
  closeContactCardPicker();
  closeChatMoreMenu();
  closeImageSendPreview();
  if (state.groupInfoDialog) closeFeatureModal();
  closeChatPanels();
  if (!PC_LAYOUT && page !== 'messages') return openContacts();
  if (page === 'profile') { await openSettings(); return; }
  const allowed = ['messages', 'center', 'friends', 'groups', 'blacklist'];
  if (!allowed.includes(page)) page = 'messages';
  if (PC_LAYOUT && ['messages', 'friends', 'groups'].includes(page)) {
    state.page = 'messages';
    state.sidebarMode = page;
    closeSessionMenu();
    document.body.classList.remove('directory-page', 'friends-directory-page');
    document.querySelectorAll('.desktop-nav-item,.classic-tab').forEach((node) => { node.classList.toggle('active', node.dataset.page === page); node.setAttribute('aria-current', node.dataset.page === page ? 'page' : 'false'); });
    const directory = $('directory-panel');
    const conversationSidebar = document.querySelector('.sidebar');
    directory.hidden = true;
    $('chat-head').hidden = !state.active;
    $('messages').hidden = false;
    $('composer').hidden = !state.active;
    conversationSidebar.hidden = false;
    renderConversationList();
    updateDesktopChat();
    return;
  }
  state.page = page;
  document.querySelectorAll('.desktop-nav-item,.classic-tab').forEach((node) => { node.classList.toggle('active', node.dataset.page === page); node.setAttribute('aria-current', node.dataset.page === page ? 'page' : 'false'); });
  document.body.classList.toggle('directory-page', page !== 'messages');
  document.body.classList.toggle('friends-directory-page', page === 'friends');
  const directory = $('directory-panel');
  const chatHead = $('chat-head');
  const messages = $('messages');
  const composer = $('composer');
  const conversationSidebar = document.querySelector('.sidebar');
  if (page === 'messages') {
    state.favoriteMode = false;
    state.active = null;
    document.body.classList.remove('favorite-mode');
    directory.hidden = true; chatHead.hidden = false; messages.hidden = false; composer.hidden = false; conversationSidebar.hidden = false;
    updateDesktopChat();
    await loadConversations();
    return;
  }
  directory.hidden = false; chatHead.hidden = true; messages.hidden = true; composer.hidden = true; conversationSidebar.hidden = true;
  directory.innerHTML = '<p class="directory-loading" role="status">正在加载…</p>';
  if (page === 'friends') await renderFriendsPage();
  else if (page === 'groups') await renderGroupsPage();
  else if (page === 'blacklist') await renderBlacklistPage();
  else if (page === 'center') await renderMessageCenter();
  refreshFriendRequestBadge();
}

function directoryLayout(title, subtitle, content, action = '') {
  $('directory-panel').innerHTML = `<div class="directory-inner"><header class="directory-header"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</header>${content}</div>`;
}
function bindDirectoryActions() {
  document.querySelectorAll('[data-contact-chat]').forEach((button) => { button.onclick = () => openContactChat(Number(button.dataset.contactChat)); });
  document.querySelectorAll('[data-add-contact]').forEach((button) => { button.onclick = () => sendFriendRequest(Number(button.dataset.addContact), button); });
  document.querySelectorAll('[data-request-action]').forEach((button) => { button.onclick = () => handleContactRequest(Number(button.dataset.requestId), button.dataset.requestAction); });
  document.querySelectorAll('[data-unblock-directory]').forEach((button) => { button.onclick = () => unblockDirectoryUser(Number(button.dataset.unblockDirectory)); });
  document.querySelectorAll('[data-block-directory]').forEach((button) => { button.onclick = () => blockDirectoryUser(Number(button.dataset.blockDirectory)); });
  document.querySelectorAll('[data-directory-chat]').forEach((button) => { button.onclick = async () => { await switchPage('messages'); await openConversation(Number(button.dataset.directoryChat)); }; });
  document.querySelectorAll('[data-group-chat]').forEach((button) => { button.onclick = async () => { await switchPage('messages'); await openConversation(Number(button.dataset.groupChat)); }; });
  document.querySelectorAll('[data-profile-user]').forEach((card) => { card.onclick = (event) => { if (event.target.closest('button')) return; openContactProfile(Number(card.dataset.profileUser)); }; });
}
async function renderFriendsPage() {
  try {
    const [contacts, requests] = await Promise.all([api('/contacts?size=100'), api('/contact-requests?direction=received&size=50')]);
    state.contactCache = Object.fromEntries((contacts.items || []).map((item) => [Number(item.user_id), item]));
    const pending = (requests.items || []).filter((item) => item.status === 'pending');
    const contactHtml = friendDirectoryHtml(contacts.items || []);
    directoryLayout('我的好友', '点击好友名片查看资料，再从资料卡发起聊天', `<form id="directory-contact-search" class="directory-search"><input id="directory-contact-keyword" placeholder="输入完整用户名"><button class="primary" type="submit">搜索</button></form><div id="directory-contact-results" class="directory-list"></div><section class="directory-section"><h2>我的好友</h2><div class="friend-card-list">${contactHtml}</div></section>`);
    $('directory-contact-search').onsubmit = async (event) => { event.preventDefault(); const keyword = $('directory-contact-keyword').value.trim(); if (!keyword) return; try { const result = await api(`/contacts/search?q=${encodeURIComponent(keyword)}&size=20`); const users = exactUsernameUsers(result.items, keyword).filter((item) => Number(item.id) !== Number(state.user.id)); users.forEach((item) => { state.contactCache[Number(item.id)] = item; }); $('directory-contact-results').innerHTML = users.map((item) => `<article class="friend-card search-result-card" data-profile-user="${item.id}" tabindex="0"><span class="friend-card-avatar">${item.avatar_url ? `<img src="${escapeHtml(mediaUrl(item.avatar_url))}" alt="">` : escapeHtml((item.nickname || '?').slice(0, 1))}</span><span class="contact-info"><strong>${escapeHtml(item.nickname)}</strong><small>${escapeHtml(publicUserId(item) ? 'ID：' + publicUserId(item) : item.username || '点击查看资料')}</small></span><button type="button" data-add-contact="${item.id}">加好友</button></article>`).join('') || '<p class="directory-empty">用户不存在</p>'; bindDirectoryActions(); } catch (error) { alert(error.message); } };
    bindDirectoryActions();
  } catch (error) { directoryLayout('我的好友', '联系人加载失败', `<p class="directory-empty">${escapeHtml(error.message)}</p>`); }
}
async function renderMessageCenter() {
  try {
    const result = await api('/contact-requests?direction=received&size=100');
    const requests = (result.items || []).filter((item) => item.status === 'pending');
    const rows = requests.map((item) => `<article class="verification-card"><span class="friend-card-avatar">${item.avatar_url ? `<img src="${escapeHtml(mediaUrl(item.avatar_url))}" alt="">` : escapeHtml((item.nickname || '?').slice(0, 1))}</span><span class="contact-info"><strong>${escapeHtml(item.nickname)}</strong><small>${escapeHtml(item.message || '请求添加你为好友')} · ${escapeHtml(item.created_at || '')}</small></span><span class="request-actions"><button type="button" data-request-action="accept" data-request-id="${item.id}">同意</button><button type="button" data-request-action="reject" data-request-id="${item.id}">拒绝</button></span></article>`).join('') || desktopEmpty('暂无验证消息', '有人添加你为好友时，会在这里显示好友验证');
    directoryLayout('消息中心', '这里仅显示别人添加你的好友验证', `<div class="verification-list">${rows}</div>`);
    bindDirectoryActions();
  } catch (error) { directoryLayout('消息中心', '消息加载失败', `<p class="directory-empty">${escapeHtml(error.message)}</p>`); }
}
function loadClearedNewFriendIds() {
  try { const ids = JSON.parse(localStorage.getItem('pulse_new_friend_cleared_ids') || '[]'); return new Set(Array.isArray(ids) ? ids.map(Number) : []); } catch { return new Set(); }
}
function saveClearedNewFriendIds(ids) {
  localStorage.setItem('pulse_new_friend_cleared_ids', JSON.stringify([...ids].slice(-300)));
}
function newFriendRequestRowHtml(item) {
  const avatar = item.avatar_url ? `<img src="${escapeHtml(mediaUrl(item.avatar_url))}" alt="">` : escapeHtml((item.nickname || '?').slice(0, 1));
  return `<article class="new-friend-request-row" data-new-friend-request="${Number(item.id)}"><span class="new-friend-request-avatar">${avatar}</span><span class="new-friend-request-copy"><strong>${escapeHtml(item.nickname || '未命名用户')}</strong><small>${escapeHtml(item.message || '请求添加你为好友')}</small><time>${escapeHtml(item.created_at || '')}</time></span><span class="new-friend-request-actions"><button type="button" data-new-friend-action="accept" data-request-id="${Number(item.id)}">同意</button><button type="button" data-new-friend-action="reject" data-request-id="${Number(item.id)}">拒绝</button></span></article>`;
}
async function openNewFriendsModal() {
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal new-friends-backdrop" data-feature-modal><section class="new-friends-modal" role="dialog" aria-modal="true" aria-labelledby="new-friends-title"><header><h2 id="new-friends-title">新的朋友</h2></header><div id="new-friends-list" class="new-friends-list"><p class="modal-empty">正在加载…</p></div><footer><button id="clear-new-friends" type="button">清除</button><button id="close-new-friends" type="button">关闭</button></footer></section></div>`);
  const modal = document.querySelector('.new-friends-backdrop');
  const list = $('new-friends-list');
  const cleared = loadClearedNewFriendIds();
  const render = (items) => {
    const visible = items.filter(item => !cleared.has(Number(item.id)));
    list.innerHTML = visible.map(newFriendRequestRowHtml).join('') || '<p class="new-friends-empty">暂无新的朋友通知</p>';
    list.querySelectorAll('[data-new-friend-action]').forEach(button => {
      button.onclick = async () => {
        button.disabled = true;
        try {
          const account = { token: state.token, userId: Number(state.user?.id) };
          const result = await api('/contact-requests/handle', { method: 'POST', authToken: account.token, body: JSON.stringify({ request_id: Number(button.dataset.requestId), action: button.dataset.newFriendAction }) });
          if (!sameSendAccount(account)) return;
          if (result.status === 'accepted') { await friendChats.offer(result.friend_chat, account); friendChats.changed(); return; }
          document.querySelector(`[data-new-friend-request="${Number(button.dataset.requestId)}"]`)?.remove();
          if (!list.querySelector('[data-new-friend-request]')) list.innerHTML = '<p class="new-friends-empty">暂无新的朋友通知</p>';
          refreshFriendRequestBadge();
        } catch (error) { button.disabled = false; alert(error.message); }
      };
    });
  };
  $('close-new-friends').onclick = closeFeatureModal;
  $('clear-new-friends').onclick = () => {
    modal.querySelectorAll('[data-new-friend-request]').forEach(row => cleared.add(Number(row.dataset.newFriendRequest)));
    saveClearedNewFriendIds(cleared);
    list.innerHTML = '<p class="new-friends-empty">暂无新的朋友通知</p>';
    refreshFriendRequestBadge();
  };
  modal.onclick = event => { if (event.target === modal) closeFeatureModal(); };
  modal.onkeydown = event => { if (event.key === 'Escape') closeFeatureModal(); };
  try {
    const result = await api('/contact-requests?direction=received&size=100');
    if (modal.isConnected) render((result.items || []).filter(item => item.status === 'pending'));
  } catch (error) { if (modal.isConnected) list.innerHTML = `<p class="new-friends-empty">${escapeHtml(error.message || '加载失败')}</p>`; }
}
async function renderGroupsPage() {
  try {
    const result = await api('/conversations');
    state.conversations = result.items || [];
    const groups = (result.items || []).filter((item) => item.type === 'group');
    const rows = groups.map((item) => `<div class="directory-row group-directory-row"><span class="group-avatar">${escapeHtml((item.name || '群').slice(0, 1))}</span><span class="contact-info"><strong>${escapeHtml(item.name || '未命名群组')}</strong><small>${item.unread_count ? `${item.unread_count} 条未读消息` : escapeHtml(item.last_message?.body?.text || '暂无消息')}</small></span><button type="button" data-group-chat="${item.id}">打开群聊</button></div>`).join('') || '<div class="directory-empty-state"><div class="directory-illustration">♧</div><strong>暂无群聊</strong><p>创建群组后会显示在这里</p></div>';
    directoryLayout('我的群组', '查看和进入你加入的群聊', rows, '<button id="directory-new-group" class="primary" type="button">创建群组</button>');
    $('directory-new-group').onclick = createGroup;
    bindDirectoryActions();
  } catch (error) { directoryLayout('我的群组', '群组加载失败', `<p class="directory-empty">${escapeHtml(error.message)}</p>`); }
}
async function renderBlacklistPage() {
  try {
    const result = await api('/blocks?page=1&size=100');
    const rows = (result.items || []).map((item) => `<div class="directory-row"><span class="contact-avatar muted-avatar">⊘</span><span class="contact-info"><strong>${escapeHtml(item.nickname || '未知用户')}</strong><small>${escapeHtml(item.phone || item.reason || '已加入黑名单')}</small></span><button type="button" data-unblock-directory="${item.blocked_id}">移出黑名单</button></div>`).join('') || '<div class="directory-empty-state"><div class="directory-illustration">⊘</div><strong>黑名单为空</strong><p>被屏蔽的联系人会显示在这里</p></div>';
    directoryLayout('黑名单', '管理已屏蔽的联系人', rows);
    bindDirectoryActions();
  } catch (error) { directoryLayout('黑名单', '黑名单加载失败', `<p class="directory-empty">${escapeHtml(error.message)}</p>`); }
}
async function unblockDirectoryUser(userId) { try { await api('/blocks/unblock', { method: 'POST', body: JSON.stringify({ user_id: userId }) }); await renderBlacklistPage(); } catch (error) { alert(error.message); } }
async function blockDirectoryUser(userId) { const reason = window.prompt('请输入屏蔽原因（可选）', '不想再接收对方消息'); if (reason === null) return; try { await api('/blocks', { method: 'POST', body: JSON.stringify({ user_id: userId, reason: reason.trim() }) }); await renderFriendsPage(); } catch (error) { alert(error.message); } }

function classicSettingsModalHtml(sessionRows, blockRows) {
  const user = state.user || {};
  const nickname = user.nickname || '我的账号';
  const avatar = user.avatar_url ? `<img src="${escapeHtml(mediaUrl(user.avatar_url))}" alt="">` : escapeHtml(nickname.slice(0, 1));
  const row = (icon, label, action, suffix = '') => `<button type="button" class="classic-settings-row" data-setting-action="${action}">${navIcon(icon)}<span>${label}</span>${suffix ? `<em>${suffix}</em>` : ''}</button>`;
  return `<div class="modal-backdrop" id="settings-modal"><section class="classic-settings-modal" role="dialog" aria-modal="true" aria-label="设置"><div class="classic-settings-scroll"><header class="classic-settings-head"><h2>设置</h2><button id="close-settings" type="button" aria-label="关闭">×</button><button id="classic-settings-more" class="classic-settings-more" type="button" aria-label="更多">⋮</button><div id="classic-account-menu" class="classic-account-menu" hidden><button id="classic-account-edit" type="button">编辑资料</button><button id="classic-account-logout" type="button">注销</button></div><div class="classic-settings-account-wrap"><span class="classic-settings-avatar">${avatar}</span><div class="classic-settings-account"><strong>${escapeHtml(nickname)}</strong><small>在线</small></div></div></header><section class="classic-settings-list">${row('edit', '编辑资料', 'profile')}${row('bell', '通知', 'notifications')}${row('lock', '隐私和安全', 'privacy')}${row('messages', '对话设置', 'chat')}${row('calls', '通话设置', 'media')}${row('sliders', '高级', 'advanced')}${row('globe', '语言', 'language', '简体中文')}</section><section class="classic-settings-scale"><div class="classic-settings-scale-title"><span>${navIcon('eye')}默认界面缩放</span><span class="classic-settings-switch on"><i></i></span></div><div class="classic-settings-slider"></div><div class="classic-settings-scale-labels"><span>100%</span><span>125%</span><span>150%</span><span>200%</span><span>250%</span><span>300%</span></div></section><section class="classic-settings-list classic-settings-help">${row('help', '常见问题', 'faq')}${row('help', '我有疑问', 'question')}</section><section class="settings-section"><h3>登录设备</h3><div id="session-list">${sessionRows}</div></section><section class="settings-section"><h3>已屏蔽联系人</h3><div id="block-list">${blockRows}</div></section></div></section></div>`;
}

function classicSettingsCheck(label, checked = true) {
  return `<label class="classic-detail-check"><input type="checkbox" ${checked ? 'checked' : ''}><span class="classic-check-box">✓</span><span>${label}</span></label>`;
}

function classicSettingsSwitch(label, checked = true) {
  return `<label class="classic-detail-switch-row"><span>${label}</span><input type="checkbox" ${checked ? 'checked' : ''}><i class="classic-detail-switch"><b></b></i></label>`;
}

const appProductName = desktop.appName || '小猿答疑';
const appProductVersion = desktop.appVersion || '2.4.10';
const privacyChoices = [
  ['everyone', '所有人'],
  ['contacts', '我的联系人'],
  ['nobody', '不允许任何人'],
];
const privacySearchChoices = [
  ['everyone', '所有人'],
  ['contacts', '我的联系人'],
];
const privacyDefaults = {
  phone_visibility: 'nobody',
  phone_search_visibility: 'everyone',
  last_seen_visibility: 'everyone',
  voice_call_visibility: 'everyone',
  voice_call_peer_to_peer: 'everyone',
  invite_visibility: 'everyone',
  show_active_sessions: true,
  account_auto_delete_days: 180,
  privacy_exceptions: {
    phone_visibility_always: [],
    phone_search_always: [],
    last_seen_never: [],
    voice_call_never: [],
    invite_never: [],
  },
};
let privacyBlockCount = 0;
let privacySettingsCache = {};
const passcodeStorageKey = 'pulse_lock_settings';
const autoDeleteDayOptions = [[0, '永不'], [30, '1 月'], [90, '3 月'], [180, '6 月'], [365, '1 年']];
function readPasscodeSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(passcodeStorageKey) || '');
    if (value && typeof value === 'object' && value.enabled === true && typeof value.hash === 'string' && value.hash) return { enabled: true, hash: value.hash, locked: value.locked !== false };
  } catch { /* 使用未设置状态 */ }
  return { enabled: false, hash: '', locked: false };
}
function writePasscodeSettings(patch) {
  const current = readPasscodeSettings();
  const next = { ...current, ...patch, enabled: Boolean(patch.enabled ?? current.enabled) };
  if (!next.enabled) localStorage.removeItem(passcodeStorageKey);
  else localStorage.setItem(passcodeStorageKey, JSON.stringify(next));
  return next;
}
async function hashPasscode(value) {
  const source = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', source);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}
function passcodeIsEnabled() { return readPasscodeSettings().enabled; }
function autoDeleteDays() {
  const value = Number(privacySetting('account_auto_delete_days'));
  return autoDeleteDayOptions.some(([days]) => days === value) ? value : 180;
}
function autoDeleteDaysLabel(value = autoDeleteDays()) { return autoDeleteDayOptions.find(([days]) => days === Number(value))?.[1] || '6 月'; }
function closePasscodeEditor() { document.querySelector('#passcode-editor-modal')?.remove(); }
function passcodeEditorHtml() {
  const changing = passcodeIsEnabled();
  return `<div class="modal-backdrop classic-passcode-editor-backdrop" id="passcode-editor-modal"><section class="classic-passcode-editor" role="dialog" aria-modal="true" aria-labelledby="passcode-editor-title"><header><h2 id="passcode-editor-title">${changing ? '修改锁定码' : '设置锁定码'}</h2></header><div class="classic-passcode-editor-body">${changing ? '<label class="classic-passcode-field"><span>当前锁定码</span><input id="passcode-current" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12"></label>' : ''}<label class="classic-passcode-field"><span>新的锁定码</span><input id="passcode-new" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12"></label><label class="classic-passcode-field"><span>再次输入锁定码</span><input id="passcode-confirm" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12"></label><p class="classic-passcode-hint">锁定码仅保存在这台电脑上，用于打开 ${escapeHtml(appProductName)}。</p><p id="passcode-editor-feedback" class="classic-privacy-editor-feedback" role="status"></p></div><footer><button type="button" id="passcode-editor-cancel">取消</button><button type="button" id="passcode-editor-save">保存</button></footer></section></div>`;
}
async function openPasscodeEditor() {
  closePasscodeEditor();
  document.body.insertAdjacentHTML('beforeend', passcodeEditorHtml());
  const modal = $('passcode-editor-modal');
  const close = () => closePasscodeEditor();
  $('passcode-editor-cancel').onclick = close;
  modal.onclick = (event) => { if (event.target === modal) close(); };
  (modal.querySelector('#passcode-current') || modal.querySelector('#passcode-new'))?.focus();
  $('passcode-editor-save').onclick = async () => {
    const feedback = $('passcode-editor-feedback');
    const save = $('passcode-editor-save');
    const current = readPasscodeSettings();
    const currentValue = $('passcode-current')?.value || '';
    const nextValue = $('passcode-new').value;
    const confirmValue = $('passcode-confirm').value;
    feedback.textContent = '';
    if (!/^\d{4,12}$/.test(nextValue)) { feedback.textContent = '锁定码必须为 4 到 12 位数字。'; return; }
    if (nextValue !== confirmValue) { feedback.textContent = '两次输入的锁定码不一致。'; return; }
    save.disabled = true;
    try {
      if (current.enabled && (await hashPasscode(currentValue)) !== current.hash) throw new Error('当前锁定码不正确。');
      writePasscodeSettings({ enabled: true, hash: await hashPasscode(nextValue), locked: false });
      close();
      await openSettingsDetail('privacy');
    } catch (error) {
      feedback.textContent = error.message || '锁定码保存失败。';
      save.disabled = false;
    }
  };
}
function passcodeDisableHtml() {
  return `<div class="modal-backdrop classic-passcode-editor-backdrop" id="passcode-disable-modal"><section class="classic-passcode-editor" role="dialog" aria-modal="true" aria-labelledby="passcode-disable-title"><header><h2 id="passcode-disable-title">关闭锁定码</h2></header><div class="classic-passcode-editor-body"><label class="classic-passcode-field"><span>当前锁定码</span><input id="passcode-disable-value" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12"></label><p class="classic-passcode-hint">关闭后，打开 ${escapeHtml(appProductName)} 将不再需要输入锁定码。</p><p id="passcode-disable-feedback" class="classic-privacy-editor-feedback" role="status"></p></div><footer><button type="button" id="passcode-disable-cancel">取消</button><button type="button" id="passcode-disable-save">关闭锁定码</button></footer></section></div>`;
}
async function disablePasscode() {
  if (!passcodeIsEnabled()) return;
  document.body.insertAdjacentHTML('beforeend', passcodeDisableHtml());
  const modal = $('passcode-disable-modal');
  const close = () => modal?.remove();
  $('passcode-disable-cancel').onclick = close;
  modal.onclick = (event) => { if (event.target === modal) close(); };
  $('passcode-disable-value').focus();
  $('passcode-disable-save').onclick = async () => {
    const feedback = $('passcode-disable-feedback');
    const button = $('passcode-disable-save');
    button.disabled = true;
    try {
      const settings = readPasscodeSettings();
      if ((await hashPasscode($('passcode-disable-value').value)) !== settings.hash) throw new Error('当前锁定码不正确。');
      writePasscodeSettings({ enabled: false, hash: '', locked: false });
      close();
      await openSettingsDetail('privacy');
    } catch (error) { feedback.textContent = error.message || '锁定码关闭失败。'; button.disabled = false; }
  };
}
function passcodeLockScreenHtml() {
  return `<div class="classic-passcode-lock-screen" id="passcode-lock-screen"><section class="classic-passcode-lock-card" role="dialog" aria-modal="true" aria-labelledby="passcode-lock-title"><div class="classic-passcode-lock-logo"><img src="./app-icon.png" alt="小猿答疑"></div><h2 id="passcode-lock-title">${escapeHtml(appProductName)} 已锁定</h2><p>请输入锁定码以继续使用</p><form id="passcode-unlock-form"><input id="passcode-unlock-value" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12" placeholder="锁定码" aria-label="锁定码"><button type="submit">解锁</button></form><p id="passcode-unlock-feedback" class="classic-passcode-unlock-feedback" role="alert"></p><button type="button" id="passcode-lock-logout">退出登录</button></section></div>`;
}
function openPasscodeLockScreen() {
  if (!passcodeIsEnabled() || $('passcode-lock-screen')) return;
  contactActionRevision++;
  closeContactProfile();
  document.body.insertAdjacentHTML('beforeend', passcodeLockScreenHtml());
  const screen = $('passcode-lock-screen');
  $('passcode-unlock-value').focus();
  $('passcode-unlock-form').onsubmit = async (event) => {
    event.preventDefault();
    const feedback = $('passcode-unlock-feedback');
    try {
      if ((await hashPasscode($('passcode-unlock-value').value)) !== readPasscodeSettings().hash) throw new Error('锁定码不正确。');
      writePasscodeSettings({ locked: false });
      screen.remove();
    } catch (error) { feedback.textContent = error.message || '锁定码不正确。'; $('passcode-unlock-value').select(); }
  };
  $('passcode-lock-logout').onclick = () => { state.socket?.close(); localStorage.removeItem('pulse_token'); localStorage.removeItem(passcodeStorageKey); location.reload(); };
}
function lockApplication() {
  if (!passcodeIsEnabled()) return;
  writePasscodeSettings({ locked: true });
  closeSettings();
  closeSettingsDetail();
  closePasscodeEditor();
  openPasscodeLockScreen();
}
function lockApplicationAtStartup() {
  const settings = readPasscodeSettings();
  if (settings.enabled) {
    writePasscodeSettings({ locked: true });
    openPasscodeLockScreen();
  }
}
function localSetting(key, fallback = false) {
  const value = localStorage.getItem(`pulse_setting_${key}`);
  return value === null ? fallback : value === '1';
}
function setLocalSetting(key, value) {
  localStorage.setItem(`pulse_setting_${key}`, value ? '1' : '0');
}
function localProxySettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('pulse_proxy_settings') || '');
    if (saved && typeof saved === 'object') return saved;
  } catch { /* 使用旧版代理设置 */ }
  const legacy = localStorage.getItem('pulse_proxy') || '';
  return { mode: legacy ? 'custom' : 'direct', proxyUrl: legacy, useIpv6: false, saved: [], activeProxyId: null };
}
let proxySettings = localProxySettings();
function storeProxySettings(settings) {
  proxySettings = settings || { mode: 'direct', proxyUrl: '', useIpv6: false, saved: [], activeProxyId: null };
  localStorage.setItem('pulse_proxy_settings', JSON.stringify(proxySettings));
  if (proxySettings.mode === 'custom' && proxySettings.proxyUrl) localStorage.setItem('pulse_proxy', proxySettings.proxyUrl);
  else localStorage.removeItem('pulse_proxy');
  const summary = $('proxy-summary');
  if (summary) summary.textContent = proxySummary(proxySettings);
  return proxySettings;
}
async function loadProxySettings() {
  if (!desktop.getProxySettings) return proxySettings;
  const remote = await desktop.getProxySettings();
  const legacy = localStorage.getItem('pulse_proxy') || '';
  if (remote?.mode === 'direct' && legacy) {
    return storeProxySettings(await desktop.setProxy({ mode: 'custom', proxyUrl: legacy, useIpv6: false, saved: [], activeProxyId: null }));
  }
  return storeProxySettings(remote);
}
async function applyClientProxySettings(settings) {
  const result = desktop.setProxy ? await desktop.setProxy(settings) : settings;
  const applied = storeProxySettings(result || settings);
  if (state.socket) state.socket.close();
  return applied;
}
loadProxySettings().catch(() => {});
if (desktop.setTrayVisible) desktop.setTrayVisible(localSetting('tray_icon', true));
if (desktop.setSkipTaskbar) desktop.setSkipTaskbar(!localSetting('taskbar_icon', true));
if (desktop.setAutoLaunch) desktop.setAutoLaunch(localSetting('auto_launch', false));
if (desktop.setSpellcheck) desktop.setSpellcheck(localSetting('spellcheck', true));
if (desktop.setAutoUpdate) desktop.setAutoUpdate(localSetting('auto_update', true));
document.body.classList.toggle('disable-motion', !localSetting('animations', true));
desktop.onUpdateAvailable?.((result) => {
  if (!result?.updateAvailable || !localSetting('auto_update', true)) return;
  const message = result.message || `发现新版本 ${result.latestVersion}`;
  if (result.downloadUrl && window.confirm(`${message}\n是否打开下载地址？`)) desktop.openUpdate?.(result.downloadUrl);
  else if (!result.downloadUrl) alert(message);
});
function privacySetting(key) {
  const stored = localStorage.getItem(`pulse_privacy_${key}`);
  if (stored !== null) return stored;
  const value = privacySettingsCache[key] ?? privacyDefaults[key];
  return typeof value === 'boolean' ? (value ? '1' : '0') : value;
}
async function loadRemotePrivacySettings() {
  try {
    const settings = await api('/auth/settings');
    privacySettingsCache = settings && typeof settings === 'object' ? settings : {};
    Object.keys(privacyDefaults).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(settings || {}, key)) return;
      const value = settings[key];
      if (key === 'privacy_exceptions') localStorage.setItem('pulse_privacy_exceptions', JSON.stringify(value || privacyDefaults.privacy_exceptions));
      else localStorage.setItem(`pulse_privacy_${key}`, key === 'show_active_sessions' ? (value ? '1' : '0') : value);
    });
  } catch { /* 旧数据库未执行设置迁移时继续使用本地设置 */ }
}
function privacyExceptions() {
  try {
    const value = JSON.parse(localStorage.getItem('pulse_privacy_exceptions') || '');
    if (value && typeof value === 'object') return { ...privacyDefaults.privacy_exceptions, ...value };
  } catch { /* 使用默认例外 */ }
  return { ...privacyDefaults.privacy_exceptions };
}
function privacyChoiceLabel(key) {
  const value = privacySetting(key);
  const choices = key === 'phone_search_visibility' ? privacySearchChoices : privacyChoices;
  return choices.find(([item]) => item === value)?.[1] || '所有人';
}
function privacySettingRow(key, label, action) {
  return `<button type="button" class="classic-privacy-row classic-privacy-action-row" data-privacy-action="${action}" data-privacy-setting="${key}"><span>${label}</span><em>${privacyChoiceLabel(key)}</em></button>`;
}
async function loadPrivacyPageData() {
  await loadRemotePrivacySettings();
  try {
    const result = await api('/blocks?page=1&size=1');
    privacyBlockCount = Number(result?.total || 0);
  } catch {
    privacyBlockCount = null;
  }
}
function privacySelect(key) {
  const current = privacySetting(key);
  return `<select class="classic-privacy-select" data-privacy-key="${key}">${privacyChoices.map(([value, label]) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
}
function settingsToggleRow(key, label, checked = false, description = '') {
  return `<label class="classic-real-switch-row"><span><strong>${label}</strong>${description ? `<small>${description}</small>` : ''}</span><input type="checkbox" data-setting-toggle="${key}" ${localSetting(key, checked) ? 'checked' : ''}><i></i></label>`;
}
const mediaDownloadScopeMeta = {
  private: { label: '在私聊中', short: '私聊' },
  group: { label: '在群组里', short: '群组' },
  channel: { label: '在频道中', short: '频道' },
};
const mediaDownloadCategoryMeta = {
  photos: { label: '照片' },
  videos: { label: '视频' },
  files: { label: '文件' },
};
const mediaDownloadMaxOptions = [1, 5, 10, 50, 100, 200, 500];
function mediaDownloadCategoryKey(scope, category) {
  return `media_download_${scope}_${category}`;
}
function mediaDownloadCategoryEnabled(scope, category) {
  return localSetting(mediaDownloadCategoryKey(scope, category), localSetting(`auto_download_${scope}`, true));
}
function mediaDownloadMaxMb(scope) {
  const value = Number(localStorage.getItem(`pulse_media_download_${scope}_max_mb`) || 50);
  return mediaDownloadMaxOptions.includes(value) ? value : 50;
}
function mediaDownloadWithinLimit(message, scope) {
  const size = Number(message?.body?.size || 0);
  return !size || size <= mediaDownloadMaxMb(scope) * 1024 * 1024;
}
function mediaDownloadSummary(scope) {
  const selected = Object.keys(mediaDownloadCategoryMeta).filter((category) => mediaDownloadCategoryEnabled(scope, category));
  if (!selected.length) return '关闭';
  if (selected.length === Object.keys(mediaDownloadCategoryMeta).length) return `全部媒体 · ${mediaDownloadMaxMb(scope)} MB`;
  return `${selected.map((category) => mediaDownloadCategoryMeta[category].label).join('、')} · ${mediaDownloadMaxMb(scope)} MB`;
}
function mediaDownloadScopeRow(scope) {
  const meta = mediaDownloadScopeMeta[scope];
  return `<button type="button" class="classic-setting-action-row classic-setting-action-button classic-media-download-row" data-media-download-scope="${scope}"><span>${meta.label}</span><em id="media-download-summary-${scope}">${escapeHtml(mediaDownloadSummary(scope))}</em></button>`;
}
function mediaDownloadToggleRow(scope, category) {
  const meta = mediaDownloadCategoryMeta[category];
  return `<label class="classic-real-switch-row"><span><strong>${meta.label}</strong></span><input type="checkbox" data-media-download-toggle="${scope}:${category}" ${mediaDownloadCategoryEnabled(scope, category) ? 'checked' : ''}><i></i></label>`;
}
function mediaDownloadSettingsBodyHtml(scope) {
  const meta = mediaDownloadScopeMeta[scope];
  const max = mediaDownloadMaxMb(scope);
  const options = mediaDownloadMaxOptions.map((value) => `<option value="${value}" ${value === max ? 'selected' : ''}>${value} MB</option>`).join('');
  return `<section class="classic-detail-section classic-media-download-settings"><h3>自动下载媒体文件</h3><p class="classic-detail-hint-inline">${meta.label}接收到的媒体可以按类型自动加载。关闭后，消息仍会保留，点击消息中的加载按钮即可查看。</p>${mediaDownloadToggleRow(scope, 'photos')}${mediaDownloadToggleRow(scope, 'videos')}${mediaDownloadToggleRow(scope, 'files')}<p id="media-download-feedback" class="classic-device-feedback" role="status"></p></section><section class="classic-detail-section"><h3>文件大小限制</h3><div class="classic-setting-value-row"><span>自动加载最大文件</span><select class="classic-media-download-max" data-media-download-max="${scope}">${options}</select></div><p class="classic-detail-hint-inline">超过限制的照片、视频或文件需要手动点击加载，不会自动占用本地磁盘空间。</p></section>`;
}
function proxySummary(settings = proxySettings) {
  if (settings?.mode === 'system') return '使用系统代理';
  if (settings?.mode === 'custom' && settings.proxyUrl) return `使用自定义代理：${settings.proxyUrl}`;
  return '默认（已使用 TCP 连接）';
}
function proxyLabel(settings = proxySettings) {
  if (settings?.mode === 'system') return '已使用系统代理';
  if (settings?.mode === 'custom' && settings.proxyUrl) return '已配置自定义代理';
  return '未配置代理';
}
function mediaOutputVolume() {
  const value = Number(localStorage.getItem('pulse_output_volume') ?? 100);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 100;
}
function mediaInputVolume() {
  const value = Number(localStorage.getItem('pulse_input_volume') ?? 100);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 100;
}
function mediaOutputDevice() {
  return localStorage.getItem('pulse_audio_output') || 'default';
}
async function applyMediaOutputToElement(element) {
  if (!element || !('volume' in element)) return;
  element.volume = mediaOutputVolume() / 100;
  const sink = mediaOutputDevice();
  if (sink !== 'default' && typeof element.setSinkId === 'function') {
    try { await element.setSinkId(sink); } catch { /* 设备被拔出时继续使用系统默认设备 */ }
  }
}
function applyMediaOutputSettings(root = document) {
  root.querySelectorAll?.('audio,video').forEach((element) => { applyMediaOutputToElement(element); });
}
function stopCallSettingsTest() {
  const session = state.callSettingsSession;
  if (!session) return;
  session.generation += 1;
  clearInterval(session.timer);
  clearTimeout(session.stopTimer);
  session.stream?.getTracks?.().forEach((track) => track.stop());
  session.context?.close?.().catch(() => {});
  state.callSettingsSession = null;
  const meter = $('media-input-meter');
  if (meter) { meter.style.setProperty('--meter-level', '0%'); meter.setAttribute('aria-valuenow', '0'); }
  const button = $('media-test-microphone');
  if (button) { button.disabled = false; button.textContent = '测试麦克风'; }
}
async function startCallSettingsMicrophoneTest() {
  const button = $('media-test-microphone');
  const feedback = $('media-device-feedback');
  if (!button || !feedback) return;
  if (state.callSettingsSession) { stopCallSettingsTest(); feedback.textContent = '麦克风测试已停止。'; return; }
  if (!navigator.mediaDevices?.getUserMedia) { feedback.textContent = '当前环境不支持麦克风检测。'; return; }
  const session = { generation: 0, stream: null, context: null, timer: null, stopTimer: null };
  state.callSettingsSession = session;
  const generation = session.generation;
  try {
    const deviceId = $('media-input-device')?.value || 'default';
    const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true });
    if (state.callSettingsSession !== session || generation !== session.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw Error('当前环境不支持实时音量检测。');
    session.stream = stream;
    session.context = new AudioContextClass();
    await session.context.resume();
    const source = session.context.createMediaStreamSource(stream);
    const analyser = session.context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    button.textContent = '停止测试';
    feedback.textContent = '请说话，下面显示实时音量；5秒后自动停止。';
    session.timer = setInterval(() => {
      if (state.callSettingsSession !== session) return;
      analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
      const meterValue = Math.min(100, Math.round(rms * 300));
      const meter = $('media-input-meter');
      if (meter) { meter.style.setProperty('--meter-level', `${meterValue}%`); meter.setAttribute('aria-valuenow', String(meterValue)); }
    }, 100);
    session.stopTimer = setTimeout(() => {
      stopCallSettingsTest();
      if (feedback.isConnected) feedback.textContent = '麦克风测试结束。';
    }, 5000);
  } catch (error) {
    stopCallSettingsTest();
    feedback.textContent = mediaErrorText(error, '麦克风');
  }
}
function mediaDeviceOptionHtml(device, selected, fallback) {
  const value = device?.deviceId || 'default';
  const label = device?.label || fallback;
  return `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}
function mediaDeviceBodyHtml() {
  const outputVolume = mediaOutputVolume();
  const inputVolume = mediaInputVolume();
  return `<section class="classic-detail-section classic-call-settings">
    <div class="classic-call-settings-group">
      <h3>扬声器和耳机</h3>
      <label class="classic-call-device-row"><span>输出设备</span><select id="media-output-device" aria-label="输出设备"><option value="default" selected>默认</option></select></label>
      <label class="classic-call-volume-row" for="media-output-volume"><span>输出音量</span><strong id="media-output-volume-value">${outputVolume}%</strong></label>
      <input id="media-output-volume" class="classic-call-volume" type="range" min="0" max="100" step="1" value="${outputVolume}" aria-label="输出音量">
    </div>
    <div class="classic-call-settings-group">
      <h3>麦克风</h3>
      <label class="classic-call-device-row"><span>输入设备</span><select id="media-input-device" aria-label="输入设备"><option value="default" selected>默认</option></select></label>
      <label class="classic-call-volume-row" for="media-input-volume"><span>输入音量</span><strong id="media-input-volume-value">${inputVolume}%</strong></label>
      <input id="media-input-volume" class="classic-call-volume" type="range" min="0" max="100" step="1" value="${inputVolume}" aria-label="输入音量">
      <button id="media-test-microphone" class="classic-call-test" type="button">测试麦克风</button>
      <div id="media-input-meter" class="classic-call-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="实时麦克风音量"><i></i></div>
    </div>
    <div class="classic-call-settings-group classic-call-other-settings">
      <h3>其他设置</h3>
      <button id="media-open-system-sound" class="classic-call-system-button" type="button">打开系统声音设置</button>
    </div>
    <p id="media-device-feedback" class="classic-device-feedback" role="status"></p>
  </section>`;
}
function privacySettingsBodyHtml() {
  const blockedLabel = privacyBlockCount === null ? '—' : privacyBlockCount > 0 ? `${privacyBlockCount} 人` : '无';
  return `<section class="classic-detail-section classic-privacy-section">
    <h3>隐私</h3>
    <button type="button" class="classic-privacy-row classic-privacy-action-row" data-privacy-action="blacklist"><span>已屏蔽的用户</span><em>${blockedLabel}</em></button>
    ${privacySettingRow('phone_visibility', '手机号码', 'phone')}
    ${privacySettingRow('last_seen_visibility', '最后上线时间', 'last-seen')}
    ${privacySettingRow('voice_call_visibility', '语音通话', 'voice-call')}
    ${privacySettingRow('invite_visibility', '邀请权限控制', 'invite')}
    <p class="classic-privacy-description">控制谁能邀请您进入群组或频道。</p>
  </section>
  <section class="classic-detail-section classic-privacy-section">
    <h3>活跃会话</h3>
    <button type="button" class="classic-privacy-row classic-privacy-action-row" data-privacy-action="sessions"><span>显示所有活跃会话</span></button>
    <p class="classic-privacy-description">控制您在其它设备上的会话。</p>
  </section>
  <section class="classic-detail-section classic-privacy-section">
    <h3>设置锁定码</h3>
    <button type="button" class="classic-privacy-row classic-privacy-action-row" data-privacy-action="passcode"><span>${passcodeIsEnabled() ? '修改锁定码' : '开启锁定码'}</span><em>${passcodeIsEnabled() ? '已开启' : '未设置'}</em></button>
    ${passcodeIsEnabled() ? '<button type="button" class="classic-privacy-row classic-privacy-action-row" data-privacy-action="lock-now"><span>立即锁定</span></button><button type="button" class="classic-privacy-row classic-privacy-action-row classic-privacy-danger-row" data-privacy-action="disable-passcode"><span>关闭锁定码</span></button>' : ''}
    <p class="classic-privacy-description">锁定码只保存在这台电脑上，关闭应用后再次打开时需要输入。</p>
  </section>
  <section class="classic-detail-section classic-privacy-section">
    <h3>删除我的帐号</h3>
    <button type="button" class="classic-privacy-row classic-privacy-action-row" data-privacy-action="auto-delete"><span>如果离线时间超过...</span><em>${autoDeleteDaysLabel()}</em></button>
    <p class="classic-privacy-description">账号在设定时间内没有登录或活动后会自动注销。注销后可以保留历史消息和账务记录。</p>
  </section>`;
}
function advancedSettingsBodyHtml() {
  return `<section class="classic-detail-section"><h3>网络与代理</h3><div class="classic-setting-action-row"><span>连接类型</span><em id="proxy-summary">${escapeHtml(proxySummary())}</em></div><button type="button" class="classic-setting-button" data-advanced-action="proxy">配置代理 <small>${proxyLabel()}</small></button></section><section class="classic-detail-section"><h3>数据与存储</h3>${settingsToggleRow('download_ask', '下载前询问保存目录', true)}<button type="button" class="classic-setting-action-row classic-setting-action-button" data-advanced-action="download-directory"><span>下载目录</span><em id="download-directory-value">${escapeHtml(localStorage.getItem('pulse_download_directory') || '默认目录')}</em></button><button type="button" class="classic-setting-button" data-advanced-action="clear-cache">管理本地缓存</button><button type="button" class="classic-setting-button" data-advanced-action="export-data">导出 ${escapeHtml(appProductName)} 数据</button></section><section class="classic-detail-section"><h3>自动下载媒体文件</h3>${mediaDownloadScopeRow('private')}${mediaDownloadScopeRow('group')}${mediaDownloadScopeRow('channel')}</section><section class="classic-detail-section"><h3>系统集成</h3><button type="button" class="classic-setting-action-row classic-setting-action-button" data-advanced-action="media"><span>通话设置</span><em>扬声器、耳机和麦克风</em></button>${settingsToggleRow('tray_icon', '显示托盘图标', true)}${settingsToggleRow('taskbar_icon', '显示任务栏图标', true)}${settingsToggleRow('auto_launch', `开机自动启动 ${escapeHtml(appProductName)}`, false)}${settingsToggleRow('send_to_menu', `在“发送到”菜单中显示 ${escapeHtml(appProductName)}`, false)}</section><section class="classic-detail-section"><h3>性能</h3>${settingsToggleRow('animations', '动画切换效果', true)}${settingsToggleRow('animated_gif', '自动播放 GIF', true)}</section><section class="classic-detail-section"><h3>拼写检查器</h3>${settingsToggleRow('spellcheck', '使用系统拼写检查器', true)}</section><section class="classic-detail-section"><h3>版本和更新</h3>${settingsToggleRow('auto_update', '自动更新', true)}<div class="classic-setting-action-row"><span>当前版本</span><em>${escapeHtml(appProductVersion)}</em></div><button type="button" class="classic-setting-action-row classic-setting-action-button" data-advanced-action="check-update"><span>检查更新</span><em>立即检查</em></button></section>`;
}
function languageSettingsBodyHtml() {
  const languages = [['zh-CN', '简体中文', '简体中文'], ['zh-TW', '繁體中文', '繁體中文'], ['en', 'English', 'English'], ['ko', '한국어', '한국어'], ['id', 'Indonesia', 'Indonesia'], ['th', 'ภาษาไทย', 'ภาษาไทย'], ['fr', 'Français', 'Français'], ['de', 'Deutsch', 'Deutsch']];
  const current = localStorage.getItem('pulse_language') || 'zh-CN';
  return `<section class="classic-detail-section classic-language-section"><div class="classic-language-search">⌕<input id="language-search" placeholder="搜索语言"></div><div id="language-options" class="classic-language-options">${languages.map(([value, name, native]) => `<label class="classic-language-option" data-language-name="${value} ${name} ${native}"><input type="radio" name="pulse-language" value="${value}" ${value === current ? 'checked' : ''}><i></i><span><strong>${name}</strong><small>${native}</small></span></label>`).join('')}</div><footer class="classic-detail-footer"><button id="language-confirm" class="classic-detail-primary" type="button">确定</button></footer></section>`;
}
function mediaDeviceOption(device, kind, selected) {
  const label = device.label || (device.deviceId === 'default' ? '系统默认设备' : '未命名设备');
  return `<label class="classic-device-option"><input type="radio" name="${kind}" value="${escapeHtml(device.deviceId)}" ${device.deviceId === selected ? 'checked' : ''}><i></i><span>${escapeHtml(label)}</span></label>`;
}
async function loadMediaDeviceSettings() {
  const feedback = $('media-device-feedback');
  const input = $('media-input-device');
  const output = $('media-output-device');
  const inputVolume = $('media-input-volume');
  const outputVolume = $('media-output-volume');
  if (!input || !output) return;
  const selectedInput = localStorage.getItem('pulse_audio_input') || 'default';
  const selectedOutput = localStorage.getItem('pulse_audio_output') || 'default';
  input.value = selectedInput;
  output.value = selectedOutput;
  inputVolume.value = String(mediaInputVolume());
  outputVolume.value = String(mediaOutputVolume());
  inputVolume.oninput = () => { const value = Math.round(Number(inputVolume.value)); localStorage.setItem('pulse_input_volume', String(value)); $('media-input-volume-value').textContent = `${value}%`; };
  outputVolume.oninput = () => { const value = Math.round(Number(outputVolume.value)); localStorage.setItem('pulse_output_volume', String(value)); $('media-output-volume-value').textContent = `${value}%`; applyMediaOutputSettings(); };
  input.onchange = () => localStorage.setItem('pulse_audio_input', input.value || 'default');
  output.onchange = () => { localStorage.setItem('pulse_audio_output', output.value || 'default'); applyMediaOutputSettings(); };
  $('media-test-microphone').onclick = startCallSettingsMicrophoneTest;
  $('media-open-system-sound').onclick = async () => {
    try {
      if (desktop.openSystemSoundSettings) { await desktop.openSystemSoundSettings(); feedback.textContent = '已打开系统声音设置。'; }
      else feedback.textContent = '请在电脑安装版中打开系统声音设置。';
    } catch (error) { feedback.textContent = error.message || '打开系统声音设置失败。'; }
  };
  applyMediaOutputSettings();
  try {
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error('当前系统不支持读取本地设备');
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((device) => device.kind === 'audioinput');
    const audioOutputs = devices.filter((device) => device.kind === 'audiooutput');
    const render = (node, items, selected, fallback) => {
      const unique = []; const seen = new Set();
      for (const item of items) { const value = item.deviceId || 'default'; if (!seen.has(value)) { seen.add(value); unique.push(item); } }
      node.innerHTML = `<option value="default" ${selected === 'default' || !unique.some((item) => item.deviceId === selected) ? 'selected' : ''}>默认</option>${unique.filter((item) => item.deviceId !== 'default').map((item) => mediaDeviceOptionHtml(item, selected, fallback)).join('')}`;
      if (selected !== 'default' && !unique.some((item) => item.deviceId === selected)) { node.value = 'default'; localStorage.setItem(node === input ? 'pulse_audio_input' : 'pulse_audio_output', 'default'); }
    };
    render(input, audioInputs, selectedInput, '未命名麦克风');
    render(output, audioOutputs, selectedOutput, '未命名扬声器');
  } catch (error) { if (feedback) feedback.textContent = error.message; }
}
const privacyEditorConfigs = {
  phone: {
    title: '手机号隐私',
    fields: [{ key: 'phone_visibility', title: '谁可以看到您的手机号', choices: privacyChoices, description: '已将您的手机号保存至联系人中的用户可以在小猿答疑上看到该号码。' }, { key: 'phone_search_visibility', title: '谁可以通过您的手机号找到我？', choices: privacySearchChoices, description: '' }],
    exception: { kind: 'phone_visibility_always', label: '总是共享给', description: '添加用户或群组以覆盖上面的设置。' },
  },
  'last-seen': {
    title: '最后上线时间隐私设置',
    fields: [{ key: 'last_seen_visibility', title: '谁可以看到您的最后上线时间', choices: privacyChoices, description: '您不会看到与您不共享的人的最后上线时间。取而代之的是最大上线时间（最近一周、两周或一个月内）。' }],
    exception: { kind: 'last_seen_never', label: '从不共享给', description: '您可以将用户或群组添加为覆盖上述设置的例外。' },
  },
  'voice-call': {
    title: '语音通话隐私设置',
    fields: [{ key: 'voice_call_visibility', title: '谁可以呼叫您', choices: privacyChoices, description: '' }],
    exception: { kind: 'voice_call_never', label: '从不允许', description: '无论上面的设置，这些用户都能或不能呼叫您。' },
    staticSection: '<section class="classic-privacy-static-section"><h3>端到端</h3><div class="classic-privacy-static-row"><span>使用端到端连接与</span><em>所有人</em></div></section>',
  },
  invite: {
    title: '邀请权限控制',
    fields: [{ key: 'invite_visibility', title: '谁可以邀请您到群组或频道', choices: privacySearchChoices, description: '' }],
    exception: { kind: 'invite_never', label: '从不允许', description: '无论上面的设置，这些用户将能或不能将您添加到群组或频道。' },
  },
};
function storePrivacySettingsLocally(patch) {
  privacySettingsCache = { ...privacySettingsCache, ...patch };
  Object.entries(patch).forEach(([key, value]) => {
    if (key === 'privacy_exceptions') localStorage.setItem('pulse_privacy_exceptions', JSON.stringify(value));
    else localStorage.setItem(`pulse_privacy_${key}`, typeof value === 'boolean' ? (value ? '1' : '0') : value);
  });
}
async function savePrivacySettings(patch) {
  const result = await api('/auth/settings', { method: 'POST', body: JSON.stringify({ settings: patch }) });
  storePrivacySettingsLocally(patch);
  return result;
}
function privacyRadioGroupHtml(field) {
  const current = privacySetting(field.key);
  return `<section class="classic-privacy-choice-group"><h3>${field.title}</h3><div class="classic-privacy-choice-list">${field.choices.map(([value, label]) => `<label class="classic-privacy-choice"><input type="radio" name="privacy-${field.key}" value="${value}" ${value === current ? 'checked' : ''}><i></i><span>${label}</span></label>`).join('')}</div>${field.description ? `<p>${field.description}</p>` : ''}</section>`;
}
function privacyExceptionSummary(kind) {
  const count = privacyExceptions()[kind]?.length || 0;
  return count ? `添加用户（${count}）` : '添加用户';
}
function refreshPrivacyBlockCountLabel() {
  const label = document.querySelector('[data-privacy-action="blacklist"] em');
  if (label) label.textContent = privacyBlockCount > 0 ? `${privacyBlockCount} 人` : '无';
}
function privacyEditorHtml(config, action) {
  const exception = config.exception;
  return `<div class="modal-backdrop classic-privacy-editor-backdrop" id="privacy-editor-modal"><section class="classic-privacy-editor" role="dialog" aria-modal="true" aria-labelledby="privacy-editor-title"><header><h2 id="privacy-editor-title">${config.title}</h2></header><div class="classic-privacy-editor-body">${config.fields.map(privacyRadioGroupHtml).join('')}<section class="classic-privacy-exception"><button type="button" class="classic-privacy-exception-title" data-privacy-add-exception="${exception.kind}">添加例外</button><div class="classic-privacy-exception-row"><span>${exception.label}</span><button type="button" data-privacy-add-exception="${exception.kind}" data-privacy-exception-summary="${exception.kind}">${privacyExceptionSummary(exception.kind)}</button></div><p>${exception.description}</p></section>${config.staticSection || ''}<p id="privacy-editor-feedback" class="classic-privacy-editor-feedback" role="status"></p></div><footer><button type="button" id="privacy-editor-cancel">取消</button><button type="button" id="privacy-editor-save">保存</button></footer></section></div>`;
}
function privacyEditorPatch(config) {
  const patch = {};
  config.fields.forEach((field) => {
    const selected = document.querySelector(`input[name="privacy-${field.key}"]:checked`);
    if (selected) patch[field.key] = selected.value;
  });
  patch.privacy_exceptions = privacyExceptions();
  return patch;
}
function closePrivacyEditor() {
  document.querySelector('#privacy-exception-picker')?.remove();
  document.querySelector('#privacy-editor-modal')?.remove();
}
async function openPrivacyEditor(action) {
  const config = privacyEditorConfigs[action];
  if (!config) return;
  closePrivacyEditor();
  document.body.insertAdjacentHTML('beforeend', privacyEditorHtml(config, action));
  const modal = $('privacy-editor-modal');
  const close = () => closePrivacyEditor();
  $('privacy-editor-cancel').onclick = close;
  modal.onclick = (event) => { if (event.target === modal) close(); };
  modal.querySelectorAll('[data-privacy-add-exception]').forEach((button) => { button.onclick = () => openPrivacyExceptionPicker(button.dataset.privacyAddException); });
  $('privacy-editor-save').onclick = async () => {
    const save = $('privacy-editor-save');
    const feedback = $('privacy-editor-feedback');
    save.disabled = true;
    feedback.textContent = '正在保存…';
    try {
      await savePrivacySettings(privacyEditorPatch(config));
      close();
      await openSettingsDetail('privacy');
    } catch (error) {
      feedback.textContent = error.message || '隐私设置保存失败';
      save.disabled = false;
    }
  };
}
function privacyPickerContactHtml(item, selected = false, blockMode = false) {
  const id = Number(item.user_id || item.id);
  const avatar = item.avatar_url ? `<img src="${escapeHtml(mediaUrl(item.avatar_url))}" alt="">` : escapeHtml((item.nickname || '?').slice(0, 1));
  return `<button type="button" class="classic-privacy-picker-row${selected ? ' is-selected' : ''}" data-privacy-picker-user="${id}"><span class="classic-privacy-picker-avatar">${avatar}</span><span><strong>${escapeHtml(item.nickname || '未命名用户')}</strong><small>${escapeHtml(item.phone || (blockMode ? '点击屏蔽此用户' : '联系人'))}</small></span><i>${selected ? '✓' : blockMode ? '屏蔽' : ''}</i></button>`;
}
async function openPrivacyExceptionPicker(kind) {
  document.querySelector('#privacy-exception-picker')?.remove();
  let contacts = [];
  try { contacts = (await api('/contacts?size=100')).items || []; } catch (error) { alert(error.message || '读取联系人失败'); return; }
  const selected = new Set((privacyExceptions()[kind] || []).map(Number));
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop classic-privacy-picker-backdrop" id="privacy-exception-picker"><section class="classic-privacy-picker" role="dialog" aria-modal="true" aria-labelledby="privacy-exception-title"><header><h2 id="privacy-exception-title">选择用户</h2></header><div class="classic-privacy-picker-search">⌕<input id="privacy-exception-search" placeholder="搜索" aria-label="搜索联系人"></div><div class="classic-privacy-picker-list"></div><footer><button type="button" id="privacy-exception-cancel">取消</button><button type="button" id="privacy-exception-save">完成</button></footer></section></div>`);
  const modal = $('privacy-exception-picker');
  const list = modal.querySelector('.classic-privacy-picker-list');
  const render = () => { const keyword = $('privacy-exception-search').value.trim().toLowerCase(); list.innerHTML = contacts.filter((item) => `${item.nickname || ''} ${item.phone || ''}`.toLowerCase().includes(keyword)).map((item) => privacyPickerContactHtml(item, selected.has(Number(item.user_id || item.id)))).join('') || '<p class="classic-privacy-picker-empty">暂无联系人</p>'; list.querySelectorAll('[data-privacy-picker-user]').forEach((button) => { button.onclick = () => { const id = Number(button.dataset.privacyPickerUser); if (selected.has(id)) { selected.delete(id); button.classList.remove('is-selected'); button.querySelector('i').textContent = ''; } else { selected.add(id); button.classList.add('is-selected'); button.querySelector('i').textContent = '✓'; } }; }); };
  $('privacy-exception-search').oninput = render;
  $('privacy-exception-cancel').onclick = () => modal.remove();
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  $('privacy-exception-save').onclick = async () => {
    const save = $('privacy-exception-save'); save.disabled = true;
    const next = privacyExceptions(); next[kind] = [...selected];
    try { await savePrivacySettings({ privacy_exceptions: next }); modal.remove(); const summary = document.querySelector(`[data-privacy-exception-summary="${kind}"]`); if (summary) summary.textContent = privacyExceptionSummary(kind); } catch (error) { alert(error.message || '例外设置保存失败'); save.disabled = false; }
  };
  render();
}
function privacyBlockedModalHtml(items) {
  const rows = items.map((item) => `<div class="classic-privacy-blocked-row"><span class="classic-privacy-picker-avatar">${item.avatar_url ? `<img src="${escapeHtml(mediaUrl(item.avatar_url))}" alt="">` : escapeHtml((item.nickname || '?').slice(0, 1))}</span><span><strong>${escapeHtml(item.nickname || '未知用户')}</strong><small>${escapeHtml(item.reason || '已屏蔽联系人')}</small></span><button type="button" data-privacy-unblock="${Number(item.blocked_id)}">解除</button></div>`).join('');
  return `<div class="modal-backdrop classic-privacy-blocked-backdrop" id="privacy-blocked-modal"><section class="classic-privacy-blocked-modal" role="dialog" aria-modal="true" aria-labelledby="privacy-blocked-title"><header><h2 id="privacy-blocked-title">已屏蔽的用户</h2></header><div class="classic-privacy-blocked-body">${rows}<p class="classic-privacy-blocked-description">被屏蔽的用户不能向您发送消息或将您添加到群组。他们也不能查看您的头像、在线状态和最后在线时间。</p></div><footer><button type="button" id="privacy-block-add">屏蔽此用户</button><button type="button" id="privacy-block-close">关闭</button></footer></section></div>`;
}
async function openPrivacyBlockedUsers() {
  document.querySelector('#privacy-blocked-modal')?.remove();
  let items = [];
  try {
    const result = await api('/blocks?page=1&size=100');
    items = result.items || [];
    privacyBlockCount = Number(result.total ?? items.length);
    refreshPrivacyBlockCountLabel();
  } catch (error) { alert(error.message || '读取已屏蔽用户失败'); return; }
  document.body.insertAdjacentHTML('beforeend', privacyBlockedModalHtml(items));
  const modal = $('privacy-blocked-modal');
  const close = () => modal?.remove();
  $('privacy-block-close').onclick = close;
  $('privacy-block-add').onclick = () => openPrivacyBlockPicker();
  modal.onclick = (event) => { if (event.target === modal) close(); };
  modal.querySelectorAll('[data-privacy-unblock]').forEach((button) => { button.onclick = async () => { try { await api('/blocks/unblock', { method: 'POST', body: JSON.stringify({ user_id: Number(button.dataset.privacyUnblock) }) }); privacyBlockCount = Math.max(0, (privacyBlockCount || 0) - 1); refreshPrivacyBlockCountLabel(); await openPrivacyBlockedUsers(); } catch (error) { alert(error.message || '解除屏蔽失败'); } }; });
}
async function openPrivacyBlockPicker() {
  document.querySelector('#privacy-block-picker')?.remove();
  let contacts = [];
  try { contacts = (await api('/contacts?size=100')).items || []; } catch (error) { alert(error.message || '读取联系人失败'); return; }
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop classic-privacy-picker-backdrop" id="privacy-block-picker"><section class="classic-privacy-picker classic-privacy-block-picker" role="dialog" aria-modal="true" aria-labelledby="privacy-block-picker-title"><header><h2 id="privacy-block-picker-title">选择要屏蔽的用户</h2></header><div class="classic-privacy-picker-search">⌕<input id="privacy-block-search" placeholder="搜索" aria-label="搜索联系人"></div><div class="classic-privacy-picker-list"></div><footer><button type="button" id="privacy-block-picker-cancel">取消</button></footer></section></div>`);
  const modal = $('privacy-block-picker'); const list = modal.querySelector('.classic-privacy-picker-list');
  const render = () => { const keyword = $('privacy-block-search').value.trim().toLowerCase(); list.innerHTML = contacts.filter((item) => `${item.nickname || ''} ${item.phone || ''}`.toLowerCase().includes(keyword)).map((item) => privacyPickerContactHtml(item, false, true)).join('') || '<p class="classic-privacy-picker-empty">暂无联系人</p>'; list.querySelectorAll('[data-privacy-picker-user]').forEach((button) => { button.onclick = async () => { const id = Number(button.dataset.privacyPickerUser); button.disabled = true; try { await api('/blocks', { method: 'POST', body: JSON.stringify({ user_id: id, reason: '隐私设置中屏蔽' }) }); privacyBlockCount = Number(privacyBlockCount || 0) + 1; refreshPrivacyBlockCountLabel(); modal.remove(); await openPrivacyBlockedUsers(); } catch (error) { button.disabled = false; alert(error.message || '屏蔽用户失败'); } }; }); };
  $('privacy-block-search').oninput = render;
  $('privacy-block-picker-cancel').onclick = () => modal.remove();
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  render();
}
function privacySessionsModalHtml(items) {
  const rows = items.map((item) => `<div class="classic-privacy-session-row"><span class="classic-privacy-session-icon">${navIcon(item.device_type === 'pc' ? 'sidebar' : 'globe')}</span><span class="classic-privacy-session-main"><strong>${escapeHtml(deviceName(item.device_type))}${item.is_current ? '（当前设备）' : ''}</strong><small>创建时间：${escapeHtml(item.created_at || '—')} · 最近使用：${escapeHtml(item.last_used_at || '—')}</small></span>${item.is_current ? '<em>当前设备</em>' : `<button type="button" class="classic-privacy-session-revoke" data-privacy-revoke-session="${Number(item.id)}">移除</button>`}</div>`).join('');
  return `<div class="modal-backdrop classic-privacy-sessions-backdrop" id="privacy-sessions-modal"><section class="classic-privacy-sessions-modal" role="dialog" aria-modal="true" aria-labelledby="privacy-sessions-title"><header><h2 id="privacy-sessions-title">活跃会话</h2><button id="privacy-sessions-close" type="button" aria-label="关闭">×</button></header><div class="classic-privacy-sessions-body">${rows || '<p class="classic-privacy-sessions-empty">暂无活跃会话</p>'}</div></section></div>`;
}
async function openPrivacySessions() {
  document.querySelector('#privacy-sessions-modal')?.remove();
  let items = [];
  try {
    const result = await api('/auth/sessions');
    items = Array.isArray(result?.items) ? result.items : [];
  } catch (error) {
    alert(error.message || '读取活跃会话失败');
    return;
  }
  document.body.insertAdjacentHTML('beforeend', privacySessionsModalHtml(items));
  const modal = $('privacy-sessions-modal');
  const close = () => modal?.remove();
  $('privacy-sessions-close').onclick = close;
  modal.onclick = (event) => { if (event.target === modal) close(); };
  modal.querySelectorAll('[data-privacy-revoke-session]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api('/auth/sessions/revoke', { method: 'POST', body: JSON.stringify({ session_id: Number(button.dataset.privacyRevokeSession) }) });
        await openPrivacySessions();
      } catch (error) {
        button.disabled = false;
        alert(error.message || '移除设备失败');
      }
    };
  });
}
function bindPrivacySettings() {
  document.querySelectorAll('[data-privacy-key]').forEach((node) => { node.onchange = async () => { const key = node.dataset.privacyKey; localStorage.setItem(`pulse_privacy_${key}`, node.value); try { await api('/auth/settings', { method: 'POST', body: JSON.stringify({ settings: { [key]: node.value } }) }); } catch { /* 本地设置仍然立即生效 */ } }; });
  document.querySelectorAll('[data-setting-toggle]').forEach((node) => { node.onchange = () => setLocalSetting(node.dataset.settingToggle, node.checked); });
  document.querySelectorAll('[data-privacy-action]').forEach((node) => {
    node.onclick = async () => {
      const action = node.dataset.privacyAction;
      if (action === 'sessions') return openPrivacySessions();
      if (action === 'blacklist') return openPrivacyBlockedUsers();
      if (action === 'passcode') return openPasscodeEditor();
      if (action === 'lock-now') return lockApplication();
      if (action === 'disable-passcode') return disablePasscode();
      if (action === 'auto-delete') return openAutoDeleteEditor();
      if (privacyEditorConfigs[action]) return openPrivacyEditor(action);
    };
  });
}
function autoDeleteEditorHtml() {
  const current = autoDeleteDays();
  const choices = autoDeleteDayOptions.map(([days, label]) => `<label class="classic-privacy-choice"><input type="radio" name="account-auto-delete-days" value="${days}" ${days === current ? 'checked' : ''}><i></i><span>${label}</span></label>`).join('');
  return `<div class="modal-backdrop classic-passcode-editor-backdrop" id="auto-delete-editor-modal"><section class="classic-passcode-editor classic-auto-delete-editor" role="dialog" aria-modal="true" aria-labelledby="auto-delete-editor-title"><header><h2 id="auto-delete-editor-title">自动删除账号</h2></header><div class="classic-passcode-editor-body"><p class="classic-auto-delete-intro">如果您在设定的时间内没有上线，账号将被自动注销。</p><section class="classic-privacy-choice-group"><h3>如果离线时间超过...</h3><div class="classic-privacy-choice-list">${choices}</div></section><p class="classic-passcode-hint">账号注销后将无法登录。历史消息和账务记录会保留，方便群聊和账目正常显示。</p><p id="auto-delete-editor-feedback" class="classic-privacy-editor-feedback" role="status"></p></div><footer><button type="button" id="auto-delete-editor-cancel">取消</button><button type="button" id="auto-delete-editor-save">保存</button></footer></section></div>`;
}
async function openAutoDeleteEditor() {
  document.querySelector('#auto-delete-editor-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', autoDeleteEditorHtml());
  const modal = $('auto-delete-editor-modal');
  const close = () => modal?.remove();
  $('auto-delete-editor-cancel').onclick = close;
  modal.onclick = (event) => { if (event.target === modal) close(); };
  $('auto-delete-editor-save').onclick = async () => {
    const button = $('auto-delete-editor-save');
    const feedback = $('auto-delete-editor-feedback');
    const selected = document.querySelector('input[name="account-auto-delete-days"]:checked');
    const days = Number(selected?.value);
    if (!autoDeleteDayOptions.some(([value]) => value === days)) { feedback.textContent = '请选择有效的自动删除时间。'; return; }
    button.disabled = true;
    try {
      await savePrivacySettings({ account_auto_delete_days: days });
      close();
      await openSettingsDetail('privacy');
    } catch (error) { feedback.textContent = error.message || '自动删除设置保存失败。'; button.disabled = false; }
  };
}
function bindLanguageSettings() {
  const search = $('language-search');
  search?.addEventListener('input', () => { const keyword = search.value.trim().toLowerCase(); document.querySelectorAll('.classic-language-option').forEach((node) => { node.hidden = keyword !== '' && !node.dataset.languageName.toLowerCase().includes(keyword); }); });
  $('language-confirm')?.addEventListener('click', () => { const selected = document.querySelector('input[name="pulse-language"]:checked'); if (selected) localStorage.setItem('pulse_language', selected.value); closeSettingsDetail(); });
}
async function clearLocalCache() {
  try { if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.map((key) => caches.delete(key))); } await desktop.clearCache?.(); localStorage.removeItem('pulse_conversation_folders'); alert('本地缓存已清理'); } catch (error) { alert(error.message || '清理缓存失败'); }
}
function exportLocalData() {
  const payload = { exported_at: new Date().toISOString(), app: appProductName, settings: Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith('pulse_') && key !== 'pulse_token').map((key) => [key, localStorage.getItem(key)])) };
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); link.download = `${appProductName}-设置备份.json`; link.click(); URL.revokeObjectURL(link.href);
}
function proxyManagerHtml() {
  const settings = proxySettings || localProxySettings();
  const saved = Array.isArray(settings.saved) ? settings.saved : [];
  const rows = saved.map((item) => `<div class="classic-proxy-row"><div class="classic-proxy-row-main"><strong>${escapeHtml(item.url)}</strong><small>${String(item.id) === String(settings.activeProxyId) && settings.mode === 'custom' ? '当前使用' : '已保存'}</small></div><div class="classic-proxy-row-actions"><button type="button" data-proxy-use="${escapeHtml(item.id)}">使用</button><button type="button" data-proxy-edit="${escapeHtml(item.id)}">编辑</button><button type="button" data-proxy-delete="${escapeHtml(item.id)}" aria-label="删除代理">×</button></div></div>`).join('') || '<p class="classic-proxy-empty">已保存的代理会显示在这里。</p>';
  return `<div class="modal-backdrop proxy-manager-backdrop" id="proxy-manager-modal"><section class="classic-proxy-manager" role="dialog" aria-modal="true" aria-labelledby="proxy-manager-title"><header><h2 id="proxy-manager-title">代理设置</h2><button id="proxy-manager-close" type="button" aria-label="关闭">×</button></header><div class="classic-proxy-manager-body"><label class="classic-proxy-check"><input id="proxy-ipv6" type="checkbox" ${settings.useIpv6 ? 'checked' : ''}><i></i><span>尝试通过 IPv6 连接</span></label><label class="classic-proxy-radio"><input name="proxy-mode" type="radio" value="direct" ${settings.mode === 'direct' ? 'checked' : ''}><i></i><span>禁用代理</span></label><label class="classic-proxy-radio"><input name="proxy-mode" type="radio" value="system" ${settings.mode === 'system' ? 'checked' : ''}><i></i><span>使用系统代理</span></label><label class="classic-proxy-radio"><input name="proxy-mode" type="radio" value="custom" ${settings.mode === 'custom' ? 'checked' : ''}><i></i><span>使用自定义代理</span></label><p class="classic-proxy-hint">代理链接支持 http://、https://、socks4:// 和 socks5://，修改后会立即应用到本客户端。</p><div class="classic-proxy-list-title">已保存的代理</div><div class="classic-proxy-list">${rows}</div><p id="proxy-manager-feedback" class="classic-proxy-feedback" role="alert"></p></div><footer><button id="proxy-manager-test" type="button" class="classic-proxy-test">测试当前连接</button><button id="proxy-manager-add" type="button" class="classic-proxy-add">添加代理</button><button id="proxy-manager-done" type="button" class="classic-proxy-done">关闭</button></footer></section></div>`;
}
function proxyLinkIsValid(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(url.protocol.toLowerCase()) && Boolean(url.hostname) && (!url.port || Number(url.port) >= 1 && Number(url.port) <= 65535);
  } catch { return false; }
}
function openProxyLinkEditor(index = -1) {
  document.querySelector('#proxy-link-editor')?.remove();
  const item = index >= 0 ? proxySettings.saved?.[index] : null;
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop proxy-editor-backdrop" id="proxy-link-editor"><section class="classic-proxy-editor" role="dialog" aria-modal="true" aria-labelledby="proxy-editor-title"><header><h2 id="proxy-editor-title">${item ? '编辑代理' : '添加代理'}</h2><button id="proxy-editor-close" type="button" aria-label="关闭">×</button></header><form id="proxy-editor-form"><label>代理链接<input id="proxy-link-value" type="text" required value="${escapeHtml(item?.url || '')}" placeholder="例如 socks5://127.0.0.1:1080" autocomplete="off"></label><p class="classic-proxy-editor-hint">可填写带账号密码的链接，例如 http://用户名:密码@服务器:端口。</p><p id="proxy-editor-feedback" class="classic-proxy-feedback" role="alert"></p><footer><button id="proxy-editor-cancel" type="button">取消</button><button class="classic-proxy-done" type="submit">保存并使用</button></footer></form></section></div>`);
  const editor = $('proxy-link-editor');
  const close = () => editor?.remove();
  $('proxy-editor-close').onclick = close;
  $('proxy-editor-cancel').onclick = close;
  editor.onclick = (event) => { if (event.target === editor) close(); };
  $('proxy-link-value').focus();
  $('proxy-editor-form').onsubmit = async (event) => {
    event.preventDefault();
    const value = $('proxy-link-value').value.trim();
    const feedback = $('proxy-editor-feedback');
    if (!proxyLinkIsValid(value)) { feedback.textContent = '代理链接格式不正确，请检查协议、服务器地址和端口。'; return; }
    const saved = [...(proxySettings.saved || [])];
    const id = item?.id || `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = { id, url: value, updatedAt: new Date().toISOString() };
    if (index >= 0) saved[index] = { ...saved[index], ...record };
    else saved.push({ ...record, createdAt: record.updatedAt });
    const next = { ...proxySettings, saved, mode: 'custom', proxyUrl: value, activeProxyId: id };
    const submit = event.submitter;
    submit.disabled = true;
    try {
      await applyClientProxySettings(next);
      close();
      openProxyManager();
    } catch (error) {
      feedback.textContent = error.message || '代理设置失败。';
      submit.disabled = false;
    }
  };
}
async function openProxyManager() {
  try { await loadProxySettings(); } catch (error) { alert(error.message || '读取代理设置失败。'); return; }
  document.querySelector('#proxy-manager-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', proxyManagerHtml());
  const modal = $('proxy-manager-modal');
  const feedback = $('proxy-manager-feedback');
  const close = () => modal?.remove();
  $('proxy-manager-close').onclick = close;
  $('proxy-manager-done').onclick = close;
  modal.onclick = (event) => { if (event.target === modal) close(); };
  $('proxy-manager-add').onclick = () => openProxyLinkEditor();
  $('proxy-ipv6').onchange = async (event) => { try { await applyClientProxySettings({ ...proxySettings, useIpv6: event.target.checked }); } catch (error) { event.target.checked = !event.target.checked; feedback.textContent = error.message || '代理设置失败。'; } };
  document.querySelectorAll('[name="proxy-mode"]').forEach((node) => { node.onchange = async () => { if (node.value === 'custom' && !proxySettings.proxyUrl) { openProxyLinkEditor(); return; } try { await applyClientProxySettings({ ...proxySettings, mode: node.value }); openProxyManager(); } catch (error) { feedback.textContent = error.message || '代理设置失败。'; } }; });
  document.querySelectorAll('[data-proxy-use]').forEach((node) => { node.onclick = async () => { const item = proxySettings.saved?.find((entry) => String(entry.id) === String(node.dataset.proxyUse)); if (!item) return; try { await applyClientProxySettings({ ...proxySettings, mode: 'custom', proxyUrl: item.url, activeProxyId: item.id }); openProxyManager(); } catch (error) { feedback.textContent = error.message || '代理设置失败。'; } }; });
  document.querySelectorAll('[data-proxy-edit]').forEach((node) => { node.onclick = () => { const index = (proxySettings.saved || []).findIndex((item) => String(item.id) === String(node.dataset.proxyEdit)); if (index >= 0) openProxyLinkEditor(index); }; });
  document.querySelectorAll('[data-proxy-delete]').forEach((node) => { node.onclick = async () => { const index = (proxySettings.saved || []).findIndex((item) => String(item.id) === String(node.dataset.proxyDelete)); if (index < 0 || !window.confirm('确定删除这个代理吗？')) return; const saved = [...proxySettings.saved]; const deleted = saved.splice(index, 1)[0]; const next = { ...proxySettings, saved }; if (String(deleted.id) === String(proxySettings.activeProxyId)) { next.mode = 'direct'; next.proxyUrl = ''; next.activeProxyId = null; } try { await applyClientProxySettings(next); openProxyManager(); } catch (error) { feedback.textContent = error.message || '代理设置失败。'; } }; });
  $('proxy-manager-test').onclick = async (event) => { const button = event.currentTarget; button.disabled = true; feedback.textContent = '正在测试代理连接…'; try { const result = await desktop.testProxy?.(); feedback.textContent = result?.ok ? `连接成功，延迟 ${result.latencyMs} 毫秒。` : '连接测试完成。'; } catch (error) { feedback.textContent = error.message || '代理连接失败。'; } finally { button.disabled = false; } };
}
function bindAdvancedSettings() {
  document.querySelectorAll('[data-setting-toggle]').forEach((node) => { node.onchange = async () => { const key = node.dataset.settingToggle; setLocalSetting(key, node.checked); if (key === 'tray_icon') desktop.setTrayVisible?.(node.checked); if (key === 'taskbar_icon') desktop.setSkipTaskbar?.(!node.checked); if (key === 'auto_launch') desktop.setAutoLaunch?.(node.checked); if (key === 'spellcheck') desktop.setSpellcheck?.(node.checked); if (key === 'send_to_menu') { try { await desktop.setSendToMenu?.(node.checked); } catch (error) { node.checked = !node.checked; setLocalSetting(key, node.checked); alert(error.message || '发送到菜单设置失败'); } } document.body.classList.toggle('disable-motion', key === 'animations' && !node.checked); }; });
  document.querySelectorAll('[data-media-download-scope]').forEach((node) => { node.onclick = () => openSettingsDetail(`media-download-${node.dataset.mediaDownloadScope}`, 'advanced'); });
  document.querySelectorAll('[data-advanced-action]').forEach((node) => { node.onclick = async () => { const action = node.dataset.advancedAction; if (action === 'clear-cache') return clearLocalCache(); if (action === 'export-data') return exportLocalData(); if (action === 'media') { closeSettingsDetail(); return openSettingsDetail('media', 'advanced'); } if (action === 'check-update') { try { const result = await desktop.checkForUpdate?.(); if (result?.updateAvailable && result.downloadUrl && window.confirm(`${result.message || `发现新版本 ${result.latestVersion}`}\n是否打开下载地址？`)) await desktop.openUpdate?.(result.downloadUrl); else alert(result?.message || `当前已是最新版本（${appProductVersion}）`); } catch (error) { alert(error.message || '检查更新失败'); } return; } if (action === 'proxy') { return openProxyManager(); } if (action === 'download-directory') { const value = await desktop.selectDownloadDirectory?.(); if (value) { localStorage.setItem('pulse_download_directory', value); const label = $('download-directory-value'); if (label) label.textContent = value; } } }; });
}

function bindAdvancedSettingsExtra() {
  document.querySelectorAll('[data-setting-toggle]').forEach((node) => {
    node.onchange = async () => {
      const key = node.dataset.settingToggle;
      setLocalSetting(key, node.checked);
      if (key === 'tray_icon') desktop.setTrayVisible?.(node.checked);
      if (key === 'taskbar_icon') desktop.setSkipTaskbar?.(!node.checked);
      if (key === 'auto_launch') desktop.setAutoLaunch?.(node.checked);
      if (key === 'spellcheck') desktop.setSpellcheck?.(node.checked);
      if (key === 'auto_update') desktop.setAutoUpdate?.(node.checked);
      if (key === 'animations') document.body.classList.toggle('disable-motion', !node.checked);
      if (key === 'animated_gif') applyAnimatedGifSetting();
      if (key === 'send_to_menu') {
        try { await desktop.setSendToMenu?.(node.checked); }
        catch (error) { node.checked = !node.checked; setLocalSetting(key, node.checked); alert(error.message || '发送到菜单设置失败'); }
      }
    };
  });
}

function bindMediaDownloadSettings(scope) {
  document.querySelectorAll('[data-media-download-toggle]').forEach((node) => {
    node.onchange = () => {
      const [rowScope, category] = String(node.dataset.mediaDownloadToggle || '').split(':');
      if (rowScope !== scope || !mediaDownloadCategoryMeta[category]) return;
      setLocalSetting(mediaDownloadCategoryKey(scope, category), node.checked);
      const feedback = $('media-download-feedback');
      if (feedback) feedback.textContent = '设置已保存，新的媒体消息会立即按此规则处理。';
    };
  });
  document.querySelector(`[data-media-download-max="${scope}"]`)?.addEventListener('change', (event) => {
    localStorage.setItem(`pulse_media_download_${scope}_max_mb`, String(Number(event.target.value) || 50));
    const feedback = $('media-download-feedback');
    if (feedback) feedback.textContent = '文件大小限制已保存。';
  });
}

function classicSettingsDetailHtml(type) {
  const user = state.user || {};
  const nickname = user.nickname || '我的账号';
  const avatar = user.avatar_url ? `<img src="${escapeHtml(mediaUrl(user.avatar_url))}" alt="">` : escapeHtml(nickname.slice(0, 1));
  const birthday = user.birthday || '未设置';
  const gender = user.gender || '未设置';
  const signature = user.signature || '未设置';
  const profileRow = (icon, field, value, label, locked = false) => `<div class="classic-info-row${locked ? ' locked' : ''}"${locked ? '' : ` data-profile-field="${field}" tabindex="0"`}><span class="classic-info-icon">${navIcon(icon)}</span><p><strong>${escapeHtml(value)}</strong><small>${label}</small></p>${locked ? '' : `<button class="classic-edit-pencil" type="button" data-profile-edit="${field}" aria-label="编辑${label}">✎</button>`}</div>`;
  const usernameLocked = Boolean(user.username);
  const birthdayLocked = Number(user.birthday_change_count || 0) >= 1;
  const layouts = {
    profile: { title: '个人信息', body: `<section class="classic-profile-detail"><div class="classic-profile-detail-avatar">${avatar}</div><button id="classic-avatar-button" class="classic-avatar-button" type="button">设置头像</button><input id="classic-avatar-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden><div class="classic-info-list">${profileRow('friends', 'nickname', nickname, '昵称')}${profileRow('messages', 'username', user.username || '未设置', '账号', usernameLocked)}${profileRow('friends', 'public_id', publicUserId(user) || '暂不可用', '用户 ID', true)}${profileRow('calendar', 'birthday', birthday, '生日', birthdayLocked)}${profileRow('gender', 'gender', gender, '性别')}${profileRow('edit', 'signature', signature, '个性签名')}</div></section>` },
    notifications: { title: '通知', body: `<section class="classic-detail-section"><h3>聊天通知</h3>${classicSettingsCheck('启用通知')}${classicSettingsCheck('显示发送者昵称')}${classicSettingsCheck('显示消息预览')}${classicSettingsCheck('播放提示音')}</section><section class="classic-detail-section"><h3>未读消息数量提示</h3>${classicSettingsCheck('包含已关闭通知的对话')}${classicSettingsCheck('按消息数统计未读')}</section><section class="classic-detail-section"><h3>原生通知</h3>${classicSettingsCheck('使用 Windows 原生通知', false)}</section><section class="classic-detail-section classic-notification-position"><h3>在屏幕上的位置</h3><div class="classic-notification-monitor"><div></div><i></i></div><h3>通知计数</h3><div class="classic-number-scale"><span>1</span><span>2</span><b>3</b><span>4</span><span>5</span></div></section>` },
    privacy: { title: '隐私和安全', body: `<section class="classic-detail-section"><h3>隐私</h3><div class="classic-value-row"><span>已屏蔽的用户</span><em>无</em></div><div class="classic-value-row"><span>手机号码</span><em>不允许任何人</em></div><div class="classic-value-row"><span>最后上线时间</span><em>所有人</em></div><div class="classic-value-row"><span>语音通话</span><em>所有人</em></div><div class="classic-value-row"><span>邀请权限控制</span><em>所有人</em></div><p class="classic-detail-hint">控制谁能邀请你进入群组或频道。</p></section><section class="classic-detail-section"><h3>活跃会话</h3><div class="classic-value-row"><span>显示所有活跃会话</span></div><p class="classic-detail-hint">控制你在其它设备上的会话。</p></section><section class="classic-detail-section"><h3>设置锁定码</h3><div class="classic-value-row"><span>开启锁定码</span></div></section><section class="classic-detail-section"><h3>删除我的帐号</h3><div class="classic-value-row"><span>如果离线时间超过...</span><em>6 月</em></div></section>` },
    chat: { title: '对话设置', body: `<section class="classic-detail-section"><h3>主题</h3><div class="classic-theme-list"><button type="button" class="classic-theme-card classic-theme-green" data-chat-theme="classic" aria-pressed="false"><i></i><i></i><b></b><span>经典</span></button><button type="button" class="classic-theme-card classic-theme-blue" data-chat-theme="day" aria-pressed="false"><i></i><i></i><b></b><span>白天</span></button><button type="button" class="classic-theme-card classic-theme-color" data-chat-theme="color" aria-pressed="false"><i></i><i></i><b></b><span>有色</span></button><button type="button" class="classic-theme-card classic-theme-night" data-chat-theme="night" aria-pressed="false"><i></i><i></i><b></b><span>夜间模式</span></button></div></section><section class="classic-detail-section"><h3>聊天背景</h3><button class="classic-file-choice" type="button">从文件中选择</button>${classicSettingsCheck('平铺背景', false)}</section><section class="classic-detail-section"><h3>表情和 emoji</h3>${classicSettingsCheck('大号 Emoji')}${classicSettingsCheck('替换字符表情为 emoji')}${classicSettingsCheck('根据 emoji 联想表情')}${classicSettingsCheck('通过 emoji 推荐热门表情')}${classicSettingsCheck('循环播放动画贴纸')}${classicSettingsCheck('管理表情包', false)}</section><section class="classic-detail-section"><h3>消息</h3><label class="classic-detail-radio"><input type="radio" name="send-key" checked><span></span>按回车键发送消息</label><label class="classic-detail-radio"><input type="radio" name="send-key"><span></span>按 Ctrl+Enter 键发送消息</label></section>` },
    advanced: { title: '高级', body: advancedSettingsBodyHtml() },
  };
  const customPages = {
    media: { title: '通话设置', body: mediaDeviceBodyHtml() },
    privacy: { title: '隐私和安全', body: privacySettingsBodyHtml() },
    advanced: { title: '高级', body: advancedSettingsBodyHtml() },
    language: { title: '语言', body: languageSettingsBodyHtml() },
  };
  const mediaScope = /^media-download-(private|group|channel)$/.exec(type)?.[1];
  const page = mediaScope
    ? { title: mediaDownloadScopeMeta[mediaScope].label, body: mediaDownloadSettingsBodyHtml(mediaScope) }
    : (customPages[type] || layouts[type] || layouts.profile);
  return `<div class="modal-backdrop" id="settings-detail-modal"><section class="classic-settings-detail" role="dialog" aria-modal="true" aria-label="${page.title}" data-settings-type="${escapeHtml(type)}"><header class="classic-detail-head"><button id="classic-detail-back" type="button" aria-label="返回">‹</button><h2>${page.title}</h2><button id="classic-detail-close" type="button" aria-label="关闭">×</button></header><div class="classic-detail-scroll">${page.body}</div></section></div>`;
}

function closeSettingsDetail() {
  stopCallSettingsTest();
  document.querySelectorAll('#settings-detail-modal').forEach((node) => node.remove());
}

async function openSettingsDetail(type, parentType = '') {
  closeSettings();
  closeSettingsDetail();
  if (type === 'privacy') await loadPrivacyPageData();
  if (type === 'advanced') await loadProxySettings().catch(() => {});
  document.body.insertAdjacentHTML('beforeend', classicSettingsDetailHtml(type));
  const detailModal = $('settings-detail-modal');
  if (detailModal) detailModal.dataset.parentType = parentType;
  const detailScroll = detailModal?.querySelector('.classic-detail-scroll');
  if (detailScroll) detailScroll.scrollTop = 0;
  const closeDetail = (event) => {
    event?.preventDefault();
    event?.stopPropagation();
    stopCallSettingsTest();
    detailModal?.remove();
  };
  const returnToSettings = (event) => {
    event?.preventDefault();
    event?.stopPropagation();
    const parentType = detailModal?.dataset.parentType || '';
    stopCallSettingsTest();
    detailModal?.remove();
    if (parentType) openSettingsDetail(parentType);
    else openSettings();
  };
  const backButton = $('classic-detail-back');
  const closeButton = $('classic-detail-close');
  backButton.onclick = returnToSettings;
  closeButton.onclick = closeDetail;
  backButton.onpointerdown = returnToSettings;
  closeButton.onpointerdown = closeDetail;
  detailModal.onclick = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target === detailModal) closeDetail(event);
    else if (target?.closest('#classic-detail-close')) closeDetail(event);
    else if (target?.closest('#classic-detail-back')) returnToSettings(event);
  };
  if (type === 'profile') bindProfileDetailActions();
  if (type === 'media') loadMediaDeviceSettings();
  if (type === 'privacy') bindPrivacySettings();
  if (type === 'advanced') { bindAdvancedSettings(); bindAdvancedSettingsExtra(); }
  if (type === 'language') bindLanguageSettings();
  if (/^media-download-(private|group|channel)$/.test(type)) bindMediaDownloadSettings(type.slice('media-download-'.length));
  if (type === 'chat') {
    detailModal.querySelectorAll('[data-chat-theme]').forEach(button => {
      button.onclick = () => applyChatTheme(button.dataset.chatTheme);
    });
    syncNightModeControls();
  }
}

function profileFieldConfig(field) {
  return {
    nickname: { label: '昵称', type: 'text', value: state.user?.nickname || '', maxlength: 32 },
    username: { label: '账号', type: 'text', value: state.user?.username || '', maxlength: 32, pattern: '[A-Za-z0-9_]{2,32}' },
    birthday: { label: '生日', type: 'date', value: state.user?.birthday || '' },
    gender: { label: '性别', type: 'select', value: state.user?.gender || '' },
    signature: { label: '个性签名', type: 'text', value: state.user?.signature || '', maxlength: 70 },
  }[field];
}

function profileEditorControlHtml(config) {
  const value = escapeHtml(config.value);
  const control = config.type === 'select'
    ? `<select class="classic-profile-editor-control"><option value="">未设置</option><option value="男" ${config.value === '男' ? 'selected' : ''}>男</option><option value="女" ${config.value === '女' ? 'selected' : ''}>女</option><option value="保密" ${config.value === '保密' ? 'selected' : ''}>保密</option></select>`
    : `<input class="classic-profile-editor-control" type="${config.type}" value="${value}"${config.maxlength ? ` maxlength="${config.maxlength}"` : ''}${config.pattern ? ` pattern="${config.pattern}"` : ''} required>`;
  return control;
}

function showProfileNotice(message) {
  document.getElementById('classic-profile-confirm-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="classic-profile-confirm-backdrop" id="classic-profile-confirm-modal"><section class="classic-profile-confirm-dialog" role="alertdialog" aria-modal="true"><p>${escapeHtml(message)}</p><footer><button id="classic-profile-notice-ok" type="button">确定</button></footer></section></div>`);
  $('classic-profile-notice-ok').onclick = () => $('classic-profile-confirm-modal')?.remove();
}

function showProfileConfirm(message, onConfirm) {
  document.getElementById('classic-profile-confirm-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="classic-profile-confirm-backdrop" id="classic-profile-confirm-modal"><section class="classic-profile-confirm-dialog" role="alertdialog" aria-modal="true"><p>${escapeHtml(message)}</p><footer><button id="classic-profile-confirm-cancel" type="button">取消</button><button id="classic-profile-confirm-ok" type="button">确定</button></footer></section></div>`);
  $('classic-profile-confirm-cancel').onclick = () => $('classic-profile-confirm-modal')?.remove();
  $('classic-profile-confirm-ok').onclick = () => { $('classic-profile-confirm-modal')?.remove(); onConfirm(); };
}

function openProfileEditor(field) {
  const config = profileFieldConfig(field);
  if (!config) return;
  if (field === 'username' && state.user?.username) { showProfileNotice('账号设置后不能再次修改。'); return; }
  if (field === 'birthday' && Number(state.user?.birthday_change_count || 0) >= 1) { showProfileNotice('生日只能修改一次，不能再次修改。'); return; }
  if (field === 'birthday' && state.user?.birthday) {
    showProfileConfirm('用户生日只能修改一次，是否继续修改？', () => renderProfileEditor(field, config));
    return;
  }
  renderProfileEditor(field, config);
}

function renderProfileEditor(field, config) {
  document.getElementById('classic-profile-editor-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="classic-profile-edit-backdrop" id="classic-profile-editor-modal"><section class="classic-profile-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="classic-profile-editor-title"><header><h3 id="classic-profile-editor-title">编辑您的${config.label}</h3></header><div class="classic-profile-edit-body"><label>${config.label}${profileEditorControlHtml(config)}</label><small class="classic-profile-editor-error" id="classic-profile-editor-error" aria-live="polite"></small></div><footer><button id="classic-profile-editor-cancel" type="button">取消</button><button id="classic-profile-editor-save" type="button">保存</button></footer></section></div>`);
  const modal = $('classic-profile-editor-modal');
  const control = modal.querySelector('.classic-profile-editor-control');
  control?.focus();
  $('classic-profile-editor-cancel').onclick = () => modal.remove();
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  $('classic-profile-editor-save').onclick = () => saveProfileFieldModal(field, modal);
  control?.addEventListener('keydown', (event) => { if (event.key === 'Enter' && config.type !== 'date') { event.preventDefault(); saveProfileFieldModal(field, modal); } if (event.key === 'Escape') modal.remove(); });
}

async function saveProfileFieldModal(field, modal) {
  if (modal.dataset.saving === 'true') return;
  const control = modal.querySelector('.classic-profile-editor-control');
  const errorNode = modal.querySelector('#classic-profile-editor-error');
  const saveButton = modal.querySelector('#classic-profile-editor-save');
  const value = control?.value?.trim() || '';
  if (field === 'username' && (!/^[A-Za-z0-9_]{2,32}$/.test(value) || state.user?.username)) { errorNode.textContent = state.user?.username ? '账号设置后不能再次修改。' : '账号只能使用 2 到 32 位字母、数字或下划线。'; return; }
  if (field === 'nickname' && (value.length < 2 || value.length > 32)) { errorNode.textContent = '昵称长度必须为 2 到 32 个字符。'; return; }
  if (field === 'birthday' && Number(state.user?.birthday_change_count || 0) >= 1) { errorNode.textContent = '生日只能修改一次，不能再次修改。'; return; }
  modal.dataset.saving = 'true';
  saveButton.disabled = true;
  errorNode.textContent = '';
  try {
    await saveCurrentProfile({ [field]: value });
    if (!modal.isConnected) return;
    modal.remove();
    await openSettingsDetail('profile');
  } catch (error) {
    if (modal.isConnected) errorNode.textContent = error.message || '保存失败，请稍后再试。';
  } finally {
    delete modal.dataset.saving;
    saveButton.disabled = false;
  }
}

function bindProfileDetailActions() {
  const detail = $('settings-detail-modal');
  const input = $('classic-avatar-input');
  const button = $('classic-avatar-button');
  const feedback = document.createElement('p');
  feedback.id = 'classic-avatar-feedback';
  feedback.className = 'form-feedback';
  feedback.setAttribute('role', 'status');
  button.after(feedback);
  button.onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (button.disabled) return;
    feedback.textContent = '';
    if (file.size > 8 * 1024 * 1024) { feedback.textContent = '头像图片不能超过 8MB。'; return; }
    const token = state.token, userId = Number(state.user?.id);
    let stage = '上传';
    button.disabled = true;
    button.textContent = '上传中…';
    try {
      const uploaded = await uploadMedia('image', file, token);
      if (state.token !== token || Number(state.user?.id) !== userId) return;
      stage = '保存';
      button.textContent = '保存中…';
      await saveCurrentProfile({ avatar_url: uploaded.url });
      if (detail.isConnected && $('settings-detail-modal') === detail && !$('classic-profile-editor-modal')) await openSettingsDetail('profile');
    } catch (error) {
      if (detail.isConnected && state.token === token && Number(state.user?.id) === userId) feedback.textContent = `头像${stage}失败：${error.message || '请稍后重试。'}`;
    } finally {
      button.disabled = false;
      button.textContent = '设置头像';
    }
  };
  document.querySelectorAll('[data-profile-field]').forEach((row) => {
    row.onclick = (event) => { if (!event.target.closest('button, input, select')) openProfileEditor(row.dataset.profileField); };
    row.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProfileEditor(row.dataset.profileField); } };
    row.querySelector('[data-profile-edit]')?.addEventListener('click', (event) => { event.stopPropagation(); openProfileEditor(row.dataset.profileField); });
  });
}

async function saveCurrentProfile(patch = {}) {
  const token = state.token, userId = Number(state.user?.id);
  const previous = state.profileSavePending;
  const currentAccount = () => state.token === token && Number(state.user?.id) === userId;
  // Serialize partial changes so an avatar response cannot undo a newer nickname.
  const operation = (async () => {
    if (previous) await previous.catch(() => {});
    if (!token || !currentAccount()) throw new Error('账号已切换，请重新打开个人信息。');
    const saved = await api('/auth/profile', { method: 'POST', authToken: token, body: JSON.stringify(patch), signal: AbortSignal.timeout(15000) });
    if (!currentAccount()) throw new Error('账号已切换，请重新打开个人信息。');
    state.user = saved;
    if ($('profile-name')) $('profile-name').textContent = state.user.nickname;
    document.querySelectorAll('.classic-settings-account strong').forEach((node) => { node.textContent = state.user.nickname; });
    document.querySelectorAll('.classic-settings-avatar, .classic-profile-detail-avatar').forEach((node) => { node.innerHTML = state.user.avatar_url ? `<img src="${escapeHtml(mediaUrl(state.user.avatar_url))}" alt="">` : escapeHtml((state.user.nickname || '猿').slice(0, 1)); });
    // The profile write has committed. A separate list read must not report it as failed.
    void loadConversations().catch(() => {});
    return saved;
  })();
  state.profileSavePending = operation;
  try { return await operation; }
  finally { if (state.profileSavePending === operation) state.profileSavePending = null; }
}

async function openSettings() {
  closeSessionMenu();
  closeSettings();
  closeSettingsDetail();
  try {
    const [sessions, blocks] = await Promise.all([api('/auth/sessions'), api('/blocks?page=1&size=50')]);
    const sessionRows = (sessions.items || []).map((item) => `<div class="settings-row"><span><strong>${deviceName(item.device_type)}</strong><small>创建时间：${escapeHtml(item.created_at)} · 最近使用：${escapeHtml(item.last_used_at || '-')}</small></span>${item.is_current ? '<em>当前设备</em>' : `<button class="secondary-button" data-revoke-session="${item.id}">移除设备</button>`}</div>`).join('') || '<p class="muted">暂无其他登录设备</p>';
    const blockRows = (blocks.items || []).map((item) => `<div class="settings-row"><span><strong>${escapeHtml(item.nickname || item.blocked_id)}</strong><small>${escapeHtml(item.reason || '已屏蔽联系人')}</small></span><button class="secondary-button" data-unblock-user="${item.blocked_id}">解除屏蔽</button></div>`).join('') || '<p class="muted">暂无已屏蔽联系人</p>';
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="settings-modal"><section class="settings-modal" role="dialog" aria-modal="true"><header><div><h2>账户设置</h2><p>管理个人资料、密码和登录设备。</p></div><button id="close-settings" class="icon-button" type="button">×</button></header><form id="profile-form" class="settings-form"><h3>个人资料</h3><label>昵称<input id="settings-nickname" required minlength="2" maxlength="32" value="${escapeHtml(state.user.nickname || '')}"></label><label>头像图片<input id="settings-avatar-file" type="file" accept="image/jpeg,image/png,image/gif,image/webp"></label><small id="avatar-upload-hint" class="muted">选择本地图片后保存即可上传头像</small><button class="primary" type="submit">保存资料</button><p id="profile-feedback" class="form-feedback"></p></form><form id="password-form" class="settings-form"><h3>修改密码</h3><label>当前密码<input id="current-password" type="password" required autocomplete="current-password"></label><label>新密码<input id="new-password" type="password" required minlength="8" autocomplete="new-password"></label><button class="primary" type="submit">修改密码</button><p id="password-feedback" class="form-feedback"></p></form><section class="settings-section"><h3>登录设备</h3><div id="session-list">${sessionRows}</div></section><section class="settings-section"><h3>已屏蔽联系人</h3><div id="block-list">${blockRows}</div></section></section></div>`);
    document.querySelectorAll('#settings-modal').forEach((node) => node.remove());
    document.body.insertAdjacentHTML('beforeend', classicSettingsModalHtml(sessionRows, blockRows));
    const settingsModal = $('settings-modal');
    settingsModal?.querySelector('#session-list')?.closest('.settings-section')?.remove();
    settingsModal?.querySelector('#block-list')?.closest('.settings-section')?.remove();
    const settingsScroll = settingsModal?.querySelector('.classic-settings-scroll');
    if (settingsScroll) settingsScroll.scrollTop = 0;
    bindInterfaceScaleControls();
    $('close-settings').onclick = closeSettings; $('settings-modal').onclick = (event) => { if (event.target.id === 'settings-modal') closeSettings(); };
    $('classic-settings-more').onclick = () => { $('classic-account-menu').hidden = !$('classic-account-menu').hidden; };
    $('classic-account-edit').onclick = () => { $('classic-account-menu').hidden = true; openSettingsDetail('profile'); };
    $('classic-account-logout').onclick = () => { state.socket?.close(); localStorage.removeItem('pulse_token'); localStorage.removeItem(passcodeStorageKey); location.reload(); };
    document.querySelectorAll('[data-setting-action]').forEach((button) => { button.onclick = () => { const action = button.dataset.settingAction; if (['profile', 'notifications', 'privacy', 'chat', 'media', 'advanced', 'language'].includes(action)) openSettingsDetail(action); else if (action === 'faq' || action === 'question') alert('帮助内容正在整理中'); }; });
    
    document.querySelectorAll('[data-revoke-session]').forEach((button) => button.onclick = () => revokeSession(Number(button.dataset.revokeSession)));
    document.querySelectorAll('[data-unblock-user]').forEach((button) => button.onclick = () => unblockUser(Number(button.dataset.unblockUser)));
  } catch (error) { alert(error.message); }
}

function closeSettings() {
  document.querySelectorAll('#settings-modal').forEach((node) => node.remove());
}
async function saveProfile(event) {
  event.preventDefault();
  const feedback = $('profile-feedback');
  try {
    let avatarUrl = state.user.avatar_url || '';
    const file = $('settings-avatar-file')?.files?.[0];
    if (file) { feedback.textContent = '头像上传中，请稍候…'; const uploaded = await uploadMedia('image', file); avatarUrl = uploaded.url; }
    await saveCurrentProfile({ nickname: $('settings-nickname').value.trim(), avatar_url: avatarUrl });
    feedback.textContent = '资料保存成功';
  } catch (error) { feedback.textContent = error.message; }
}
async function changePassword(event) { event.preventDefault(); try { await api('/auth/password', { method: 'POST', body: JSON.stringify({ current_password: $('current-password').value, new_password: $('new-password').value }) }); alert('密码修改成功，请在本设备重新登录。'); localStorage.removeItem('pulse_token'); state.socket?.close(); location.reload(); } catch (error) { $('password-feedback').textContent = error.message; } }
async function revokeSession(sessionId) { try { await api('/auth/sessions/revoke', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) }); await openSettings(); } catch (error) { alert(error.message); } }
async function unblockUser(userId) { try { await api('/blocks/unblock', { method: 'POST', body: JSON.stringify({ user_id: userId }) }); await openSettings(); } catch (error) { alert(error.message); } }

let conversationDataRevision = 0;
const conversationDeltaRevisions = new Map();
const conversationRefresh = PulseConversationRefresh.create({
  account: () => ({ token: state.token, userId: Number(state.user?.id) }),
  load: (ids, account) => api('/conversations/updates?ids=' + ids.join(','), { authToken: account.token, signal: AbortSignal.timeout(15000) }),
  full: () => loadConversations(),
  apply: (result, account) => {
    if (!sameSendAccount(account) || state.updateRequired) return;
    const revision = ++conversationDataRevision, ticket = null;
    const removed = new Set(result.removed_ids.map(Number));
    const changes = new Map(result.items.map(item => [Number(item.id), item]));
    const changed = [...changes.keys(), ...removed];
    for (const id of changed) conversationDeltaRevisions.set(id, revision);
    state.conversations = state.conversations.filter(item => !removed.has(Number(item.id))).map(item => {
      const id = Number(item.id), next = changes.get(id); changes.delete(id); return next || item;
    });
    state.conversations.push(...changes.values());
    state.conversations.sort((a, b) => Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned)) || String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || Number(b.id) - Number(a.id));
    if (typeof contactNames !== 'undefined') contactNames.conversations(state.conversations);
    if (typeof flushDesktopInboxNotifications === 'function') flushDesktopInboxNotifications();
    const active = state.conversations.find(item => Number(item.id) === Number(state.active?.id));
    if (active) Object.assign(state.active, active);
    if (state.desktopAccountVisible !== false && !document.hidden) { renderConversationList(); updateDesktopChat(); if (typeof syncChatInfoNotification === 'function') syncChatInfoNotification(); }
  }
});
function refreshChangedConversations(ids) { conversationRefresh.hint(ids); }

async function loadConversations() {
  if (!state.token || !state.user) return;
  const token = state.token, userId = Number(state.user.id);
  const revisionAccount = token + ':' + userId;
  if (state.conversationRevisionAccount !== revisionAccount) { state.conversationRevisionAccount = revisionAccount; conversationDeltaRevisions.clear(); conversationDataRevision = 0; conversationRefresh.reset(); }
  const current = state.conversationListLoad;
  if (current && current.token === token && current.userId === userId) { current.again = true; return current.promise; }
  const context = { token, userId, revision: conversationDataRevision, again: false, promise: null };
  state.conversationListLoad = context;
  context.promise = (async () => {
    try {
      const [conversations, folders] = await Promise.all([api('/conversations', { authToken: token, signal: AbortSignal.timeout(15000) }), api('/conversation-folders', { authToken: token, signal: AbortSignal.timeout(15000) })]);
      if (state.conversationListLoad !== context || state.token !== token || Number(state.user?.id) !== userId) return;
      const rows = [...(conversations.items || [])];
      const pageSize = Math.max(1, Math.min(100, Number(conversations.size) || 30));
      const pageCount = Math.ceil(Math.max(rows.length, Number(conversations.total) || 0) / pageSize);
      let complete = true;
      for (let page = 2; page <= pageCount; page++) {
        if (state.conversationListLoad !== context || state.token !== token || Number(state.user?.id) !== userId) return;
        const next = await api(`/conversations?page=${page}&size=${pageSize}`, { authToken: token, signal: AbortSignal.timeout(15000) });
        if (!(next.items || []).length) { complete = false; break; }
        rows.push(...next.items);
      }
      if (state.conversationListLoad !== context || state.token !== token || Number(state.user?.id) !== userId) return;
      const freshRows = new Map(rows.map(item => [Number(item.id), item]));
      for (const item of state.conversations) if ((conversationDeltaRevisions.get(Number(item.id)) || 0) > context.revision) freshRows.set(Number(item.id), item);
      for (const [id, revision] of conversationDeltaRevisions) if (revision > context.revision && !state.conversations.some(item => Number(item.id) === id)) freshRows.delete(id);
      state.conversations = [...freshRows.values()];
      flushDesktopInboxNotifications();
      if (state.active) {
        const refreshed = state.conversations.find(item => Number(item.id) === Number(state.active.id));
        if (refreshed) Object.assign(state.active, refreshed);
      }
      state.conversationFolders = folders.items || [];
      if ($('profile-name')) $('profile-name').textContent = state.user.nickname;
      renderConversationList(); updateDesktopChat(); syncChatInfoNotification();
      return complete;
    } finally {
      if (state.conversationListLoad === context) {
        state.conversationListLoad = null;
        if (context.again && state.token === token && Number(state.user?.id) === userId) void loadConversations().catch(() => {});
      }
    }
  })();
  return context.promise;
}

function conversationMessagePreview(item) {
  return item.last_message?.body?.text || '暂无消息';
}
function conversationPreviewHtml(item) {
  const draft = composerDrafts.text({ token: state.token, userId: Number(state.user?.id) }, item.id).replace(/\s+/gu, ' ').trim();
  if (draft && Number(item.id) !== Number(state.active?.id)) return '<span class="conversation-draft-label">草稿：</span><span class="conversation-draft-text">' + escapeHtml(draft) + '</span>';
  return escapeHtml(conversationMessagePreview(item));
}
function refreshConversationDraftPreviews(ids) {
  const container = $('conversation-list'); if (!container || state.chatSearch) return;
  for (const id of new Set(ids)) {
    const item = state.conversations.find(row => Number(row.id) === Number(id)); if (!item) continue;
    for (const preview of container.querySelectorAll('.conversation[data-id="' + Number(id) + '"] .conversation-copy small')) renderStableConversationContent(preview, conversationPreviewHtml(item), Number(id));
  }
}

function conversationRowHtml(item, showFolderAction = false) {
  const name = item.name || (item.type === 'direct' ? '单聊' : '会话');
  const pinned = Boolean(item.is_pinned);
  const pinBadge = pinned ? '<span class="conversation-pin" title="已置顶"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 9V4h1V2H7v2h1v5a4 4 0 0 1-2 3v2h5v7l1 1 1-1v-7h5v-2a4 4 0 0 1-2-3Z"/></svg><span>置顶</span></span>' : '';
  const muteBadge = item.notifications_muted === true || Number(item.notifications_muted) === 1
    ? '<span class="conversation-mute-indicator" role="img" aria-label="消息免打扰" title="消息免打扰"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18M10.6 4.1A6 6 0 0 1 18 10v4l2 3H8m-3.5-.5L6 14v-4a6 6 0 0 1 .8-3M10 20a2 2 0 0 0 4 0"/></svg></span>' : '';
  const folderAction = showFolderAction
    ? `<span class="conversation-folder-action" data-folder-assign="${Number(item.id)}" role="button" tabindex="0" title="设置分组" aria-label="设置分组">•••</span>`
    : '';
  return `<button class="conversation ${state.active && Number(state.active.id) === Number(item.id) ? 'active' : ''}${pinned ? ' is-pinned' : ''}" data-id="${Number(item.id)}"><span class="avatar">${item.avatar_url ? `<img src="${escapeHtml(mediaUrl(item.avatar_url))}" alt="">` : escapeHtml(name.slice(0, 1).toUpperCase())}</span><span class="conversation-copy"><strong>${escapeHtml(name)}</strong><small>${conversationPreviewHtml(item)}</small></span><span class="conversation-meta"><time>${escapeHtml((item.last_message?.created_at || item.updated_at || '').slice(11, 16))}</time><span class="conversation-flags">${muteBadge}${pinBadge}${item.unread_count ? `<b class="unread">${item.unread_count}</b>` : ''}</span></span>${folderAction}</button>`;
}

function conversationRowsHtml(items, showFolderAction = false) {
  return items.map((item) => conversationRowHtml(item, showFolderAction)).join('');
}

const pendingFolderToggles = new Map();
const pendingArchiveChanges = new Map();
function conversationIsArchived(item) { return item?.is_archived === true || Number(item?.is_archived) === 1; }
function conversationArchiveEntryHtml(items) {
  const unread = items.reduce((sum, item) => sum + Math.max(0, Math.floor(Number(item.unread_count) || 0)), 0);
  const names = items.map(item => item.name || '会话').join('、');
  return `<button id="conversation-archive-entry" class="conversation-archive-entry" type="button" aria-label="已归档对话，${items.length} 个对话，${unread} 条未读消息"><span class="conversation-archive-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 8h16v12H4zM3 4h18v4H3z"/><path d="M12 10v7m-3-3 3 3 3-3"/></svg></span><span class="conversation-archive-copy"><strong>已归档对话</strong><small title="${escapeHtml(names)}">${escapeHtml(names || '暂无归档对话')}</small></span>${unread ? `<span class="conversation-archive-badge" aria-hidden="true">${unread > 99 ? '99+' : unread}</span>` : ''}</button>`;
}
function conversationArchiveHeaderHtml(count) {
  return `<header class="conversation-archive-header"><button id="conversation-archive-back" type="button" aria-label="返回聊天列表" title="返回聊天列表"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7M7 12h14"/></svg></button><div><strong>已归档对话</strong><small>${count} 个对话</small></div></header>`;
}
function setConversationArchiveView(open) {
  closeConversationFolderModal(); closeContactProfile(); closeSessionMenu();
  state.archiveView = Boolean(open); state.archiveFeedback = '';
  if ($('message-search')) $('message-search').value = '';
  renderConversationList();
}
async function setConversationArchived(conversation) {
  if (!state.token || !state.user || state.updateRequired || conversation?.type === 'favorites') return;
  const id = Number(conversation?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  const context = { token: state.token, userId: Number(state.user.id) };
  const key = JSON.stringify([context.userId, context.token, id]);
  if (pendingArchiveChanges.has(key)) return;
  const archived = !conversationIsArchived(conversation);
  pendingArchiveChanges.set(key, context); state.archiveFeedback = '';
  try {
    const result = await api('/conversations/settings', { method: 'POST', authToken: context.token, signal: AbortSignal.timeout(15000), body: JSON.stringify({ conversation_id: id, is_archived: archived }) });
    if (!sameSendAccount(context)) return;
    if (!result || !Object.hasOwn(result, 'is_archived') || conversationIsArchived(result) !== archived) throw new Error('当前服务器暂不支持归档，请联系管理员更新服务。');
    const current = state.conversations.find(item => Number(item.id) === id);
    if (current) Object.assign(current, result);
    if (Number(state.active?.id) === id) Object.assign(state.active, result);
    // A list requested before the mutation cannot put the row back in its old section.
    state.conversationListLoad = null;
    renderConversationList();
    try { await loadConversations(); }
    catch { if (sameSendAccount(context)) { state.archiveFeedback = '归档设置已保存，列表刷新失败，请稍后重试。'; renderConversationList(); } }
  } catch (error) {
    if (sameSendAccount(context)) {
      state.archiveFeedback = String(error.message || '').includes('没有需要保存的会话设置') ? '当前服务器暂不支持归档，请联系管理员更新服务。' : error.message || '归档设置失败，请重试。';
      renderConversationList();
    }
  } finally { if (pendingArchiveChanges.get(key) === context) pendingArchiveChanges.delete(key); }
}

let messageForwardNavigationRevision = 0;
function sidebarFolderScope() { return state.sidebarMode === 'friends' ? 'direct' : state.sidebarMode === 'groups' ? 'groups' : null; }
function conversationFolderScope(conversation) { return conversation?.type === 'direct' ? 'direct' : conversation?.type === 'group' ? 'groups' : null; }
function closeConversationFolderModal() {
  messageForwardNavigationRevision++;
  contactActionRevision++;
  closeConversationContextMenu();
  if (document.querySelector('[data-folder-scope], [data-conversation-hide], [data-message-forward], [data-message-edit], [data-group-invite]')) closeFeatureModal();
}
function folderOperationContext(scope, modal = null) {
  return { scope, modal, account: { token: state.token, userId: Number(state.user?.id) }, page: state.page, sidebarMode: state.sidebarMode, archiveView: Boolean(state.archiveView),
    historyEpoch: state.historyEpoch, activeId: Number(state.active?.id) || 0, pending: false };
}
function currentFolderOperation(context) {
  return Boolean(context && sameSendAccount(context.account) && !state.updateRequired && state.page === context.page && state.sidebarMode === context.sidebarMode && Boolean(state.archiveView) === context.archiveView
    && state.historyEpoch === context.historyEpoch && (Number(state.active?.id) || 0) === context.activeId
    && (!context.modal || (context.modal.isConnected && document.querySelector('[data-feature-modal]') === context.modal)));
}
function ungroupedFolderCollapsed(scope) {
  const saved = localStorage.getItem('pulse_ungrouped_collapsed_' + scope);
  return saved === null ? (scope === 'direct' ? localStorage.getItem('pulse_ungrouped_collapsed') !== '0' : true) : saved !== '0';
}

function createConversationFolder() {
  const scope = sidebarFolderScope();
  if (!scope) return;
  closeFeatureModal();
  const label = scope === 'groups' ? '群聊' : '好友';
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal data-folder-scope="${scope}"><section class="feature-card classic-folder-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-folder-title"><header><div><h2 id="conversation-folder-title">添加${label}分组</h2><p>创建一个可折叠的${label}分类。</p></div><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header><form id="conversation-folder-form" class="classic-folder-form"><label>分组名称<input id="conversation-folder-name" maxlength="64" required autocomplete="off" placeholder="请输入分组名称"></label><p id="conversation-folder-feedback" class="form-feedback" role="status"></p><footer><button type="button" class="secondary-button" data-close-modal>取消</button><button type="submit" class="primary">保存</button></footer></form></section></div>`);
  bindFeatureModal();
  const modal = document.querySelector('[data-folder-scope]');
  modal.folderOperation = folderOperationContext(scope, modal);
  modal.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFeatureModal(); } });
  modal.querySelector('form').onsubmit = submitConversationFolder;
  modal.querySelector('input').focus();
}

async function submitConversationFolder(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const context = form.closest('[data-folder-scope]')?.folderOperation;
  if (!currentFolderOperation(context) || context.pending) return;
  const input = form.querySelector('#conversation-folder-name');
  const feedback = form.querySelector('#conversation-folder-feedback');
  const button = form.querySelector('[type="submit"]');
  const name = input.value.trim();
  if (!name) return;
  context.pending = true; button.disabled = true; feedback.textContent = '正在保存…';
  try {
    await api('/conversation-folders', { method: 'POST', authToken: context.account.token, body: JSON.stringify({ name, scope: context.scope }) });
    if (!currentFolderOperation(context)) return;
    closeFeatureModal();
    try { await loadConversations(); } catch { if (currentFolderOperation({ ...context, modal: null })) composerFeedback('分组已创建，列表刷新失败，请稍后重试。'); }
  } catch (error) {
    if (currentFolderOperation(context)) feedback.textContent = error.message || '创建分组失败';
  } finally { context.pending = false; if (context.modal.isConnected) button.disabled = false; }
}

async function toggleConversationFolder(folder) {
  if (folder.scope !== sidebarFolderScope()) return;
  const context = folderOperationContext(folder.scope);
  const pendingKey = JSON.stringify([context.account.userId, context.account.token, folder.scope, Number(folder.id)]);
  if (pendingFolderToggles.has(pendingKey)) return;
  const collapsed = !folder.collapsed;
  pendingFolderToggles.set(pendingKey, context);
  try {
    await api('/conversation-folders/toggle', { method: 'POST', authToken: context.account.token, body: JSON.stringify({ folder_id: folder.id, collapsed, scope: folder.scope }) });
    if (!currentFolderOperation(context)) return;
    const current = state.conversationFolders.find(item => Number(item.id) === Number(folder.id) && item.scope === folder.scope);
    if (current) current.collapsed = collapsed;
    renderConversationList();
  } catch (error) { if (currentFolderOperation(context)) composerFeedback(error.message || '更新分组失败'); }
  finally { if (pendingFolderToggles.get(pendingKey) === context) pendingFolderToggles.delete(pendingKey); }
}

function toggleUngroupedConversationFolder() {
  const scope = sidebarFolderScope();
  if (!scope) return;
  localStorage.setItem('pulse_ungrouped_collapsed_' + scope, ungroupedFolderCollapsed(scope) ? '0' : '1');
  renderConversationList();
}

function openConversationFolderDialog(conversation) {
  const scope = conversationFolderScope(conversation);
  if (!scope) return;
  closeFeatureModal();
  const folders = (state.conversationFolders || []).filter(folder => folder.scope === scope);
  const current = folders.find(folder => (folder.conversation_ids || []).map(Number).includes(Number(conversation.id)));
  const options = `<option value="0" ${current ? '' : 'selected'}>未分组</option>` + folders.map(folder => `<option value="${Number(folder.id)}" ${current && Number(current.id) === Number(folder.id) ? 'selected' : ''}>${escapeHtml(folder.name)}</option>`).join('');
  const body = `<form id="conversation-folder-assign-form" class="classic-folder-form"><label>选择分组<select id="conversation-folder-select" required>${options}</select></label><p id="conversation-folder-assign-feedback" class="form-feedback" role="status"></p><footer><button type="button" class="secondary-button" data-close-modal>取消</button><button type="submit" class="primary">保存</button></footer></form>`;
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal data-folder-scope="${scope}"><section class="feature-card classic-folder-dialog classic-conversation-action-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-folder-assign-title"><header><div><h2 id="conversation-folder-assign-title">设置${scope === 'groups' ? '群聊' : '好友'}分组</h2><p>${escapeHtml(conversation.name || '当前会话')}</p></div><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header>${body}</section></div>`);
  bindFeatureModal();
  const modal = document.querySelector('[data-folder-scope]');
  const context = modal.folderOperation = folderOperationContext(scope, modal);
  modal.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFeatureModal(); } });
  const form = modal.querySelector('form');
  if (!form) return;
  form.onsubmit = async event => {
    event.preventDefault();
    if (!currentFolderOperation(context) || context.pending) return;
    const button = form.querySelector('button[type="submit"]');
    const feedback = form.querySelector('#conversation-folder-assign-feedback');
    const folderId = Number(form.querySelector('#conversation-folder-select').value);
    if (folderId !== 0 && !folders.some(folder => Number(folder.id) === folderId)) return;
    context.pending = true; button.disabled = true; feedback.textContent = '正在保存…';
    try {
      await api('/conversation-folders/assign', { method: 'POST', authToken: context.account.token, body: JSON.stringify({ folder_id: folderId, conversation_id: Number(conversation.id), scope }) });
      if (!currentFolderOperation(context)) return;
      closeFeatureModal();
      try { await loadConversations(); } catch { if (currentFolderOperation({ ...context, modal: null })) composerFeedback('分组已保存，列表刷新失败，请稍后重试。'); }
    } catch (error) { if (currentFolderOperation(context)) feedback.textContent = error.message || '设置分组失败'; }
    finally { context.pending = false; if (modal.isConnected) button.disabled = false; }
  };
  form.querySelector('select').focus();
}

async function assignConversationFolder(conversationId) {
  const conversation = state.conversations.find((item) => Number(item.id) === Number(conversationId));
  if (!conversation) return;
  openConversationFolderDialog(conversation);
}

function hideConversationFromList(conversation) {
  if (conversation?.type !== 'direct') return;
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal data-conversation-hide><section class="feature-card classic-group-action" role="dialog" aria-modal="true" aria-labelledby="conversation-hide-title"><header><h2 id="conversation-hide-title">删除会话</h2><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header><p class="classic-action-hint">从你的会话列表移除「${escapeHtml(conversation.name || '当前会话')}」。聊天记录和对方的列表会保留，新消息到来时会重新显示。</p><p id="conversation-hide-feedback" class="form-feedback" role="status"></p><footer><button type="button" data-close-modal class="secondary-button">取消</button><button type="button" id="conversation-hide-confirm" class="danger-button">删除会话</button></footer></section></div>`);
  bindFeatureModal();
  const modal = document.querySelector('[data-conversation-hide]');
  const context = folderOperationContext('direct', modal);
  const conversationId = Number(conversation.id);
  const button = modal.querySelector('#conversation-hide-confirm');
  const feedback = modal.querySelector('#conversation-hide-feedback');
  modal.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFeatureModal(); } });
  button.onclick = async () => {
    if (!currentFolderOperation(context) || context.pending) return;
    context.pending = true; button.disabled = true; feedback.textContent = '正在删除…';
    try {
      await api('/conversations/hide', { method: 'POST', authToken: context.account.token, body: JSON.stringify({ conversation_id: conversationId }) });
      if (!currentFolderOperation(context)) return;
      closeFeatureModal();
      state.conversations = state.conversations.filter(item => Number(item.id) !== conversationId);
      if (Number(state.active?.id) === conversationId) {
        cancelConversationRecovery(); resetChatHistoryLocation(); resetComposerForNavigation(); closeChatPanels();
        $('message-input').value = '';
        state.active = null; state.favoriteMode = false;
        $('chat-head').hidden = true; $('composer').hidden = true; $('group-manage').hidden = true;
        $('messages').innerHTML = '<p class="empty">请选择一个会话开始聊天</p>';
      }
      renderConversationList(); updateDesktopChat();
      const refreshContext = folderOperationContext('direct');
      try { await loadConversations(); } catch { if (currentFolderOperation(refreshContext)) composerFeedback('会话已删除，列表刷新失败，请稍后重试。'); }
    } catch (error) { if (currentFolderOperation(context)) feedback.textContent = error.message || '删除会话失败'; }
    finally { context.pending = false; if (modal.isConnected) button.disabled = false; }
  };
  modal.querySelector('[data-close-modal]').focus();
}

function closeConversationContextMenu() {
  $('conversation-context-menu')?.remove();
}

function positionConversationContextMenu(menu, clientX, clientY) {
  menu.style.left = `${Math.max(8, clientX)}px`;
  menu.style.top = `${Math.max(8, clientY)}px`;
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8))}px`;
  });
}

function conversationContextActions(conversation, compact = false) {
  if (compact) {
    const actions = [['folder', '设置分组']];
    if (conversation.type === 'direct' && conversation.peer_user_id) actions.push(['remark', '修改备注名']);
    return actions;
  }
  const actions = [['pin', conversation.is_pinned ? '取消置顶' : '置顶']];
  if (conversation.type !== 'favorites') actions.push(['archive', conversationIsArchived(conversation) ? '移出归档' : '归档对话']);
  if (conversation.type === 'direct') {
    actions.push(['profile', '查看个人信息'], ['share', '分享好友名片'], ['folder', '移入分组']);
  } else if (conversation.type === 'group') {
    actions.push(['profile', '查看群组信息']);
  }
  actions.push(['mute', conversation.notifications_muted ? '开启消息通知' : '关闭消息通知'], ['unread', '标记为未读'], ['clear', '清空历史记录']);
  if (conversation.type === 'direct') actions.push(['hide', '删除会话']);
  return actions;
}

function openConversationActionMenu(event, conversation, compact = false) {
  event?.preventDefault();
  event?.stopPropagation();
  closeConversationContextMenu();
  const actions = conversationContextActions(conversation, compact);
  if (!actions.length) return;
  document.body.insertAdjacentHTML('beforeend', `<div id="conversation-context-menu" class="classic-conversation-context-menu" role="menu" aria-label="会话操作">${actions.map(([action, label]) => `<button type="button" role="menuitem" data-conversation-action="${action}">${label}</button>`).join('')}</div>`);
  const menu = $('conversation-context-menu');
  const context = folderOperationContext(conversationFolderScope(conversation));
  positionConversationContextMenu(menu, event?.clientX ?? 0, event?.clientY ?? 0);
  menu.querySelectorAll('[data-conversation-action]').forEach(button => {
    button.onclick = () => {
      if (!menu.isConnected || !currentFolderOperation(context)) { closeConversationContextMenu(); return; }
      handleConversationAction(button.dataset.conversationAction, conversation);
    };
  });
  menu.querySelector('button')?.focus();
}

async function saveConversationSetting(conversation, key, value) {
  const result = await api('/conversations/settings', { method: 'POST', body: JSON.stringify({ conversation_id: conversation.id, [key]: value }) });
  Object.assign(conversation, result || {});
  if (Number(state.active?.id) === Number(conversation.id)) Object.assign(state.active, result || {});
  await loadConversations();
}

function openConversationRemarkDialog(conversation) {
  if (!conversation || conversation.type !== 'direct' || !conversation.peer_user_id) {
    alert('当前会话没有可修改的联系人备注。');
    return;
  }
  closeFeatureModal();
  const current = conversation.remark || '';
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal><section class="feature-card classic-folder-dialog classic-conversation-action-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-remark-title"><header><div><h2 id="conversation-remark-title">修改备注名</h2><p>${escapeHtml(conversation.name || '联系人')}</p></div><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header><form id="conversation-remark-form" class="classic-folder-form"><label>备注名<input id="conversation-remark-input" maxlength="64" autocomplete="off" value="${escapeHtml(current)}" placeholder="留空可恢复原昵称"><small>备注名只对你自己显示。</small></label><p id="conversation-remark-feedback" class="form-feedback" role="status"></p><footer><button type="button" class="secondary-button" data-close-modal>取消</button><button type="submit" class="primary">保存</button></footer></form></section></div>`);
  bindFeatureModal();
  const form = $('conversation-remark-form');
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const feedback = $('conversation-remark-feedback');
    const remark = $('conversation-remark-input').value.trim();
    button.disabled = true;
    feedback.textContent = '';
    try {
      const result = await api('/contacts/remark', { method: 'POST', body: JSON.stringify({ user_id: Number(conversation.peer_user_id), remark }) });
      const cached = state.contactCache[Number(conversation.peer_user_id)] || {};
      state.contactCache[Number(conversation.peer_user_id)] = { ...cached, remark: result.remark || '' };
      conversation.remark = result.remark || '';
      contactNames.remember(Number(conversation.peer_user_id), conversation.remark);
      closeFeatureModal();
      await loadConversations();
    } catch (error) {
      feedback.textContent = error.message || '修改备注名失败';
      button.disabled = false;
    }
  };
  $('conversation-remark-input').focus();
  $('conversation-remark-input').select();
}

async function renameConversationContact(conversation) {
  openConversationRemarkDialog(conversation);
}

function clearConversationHistory(conversation) {
  if (!conversation) return;
  confirmGroupAction('清空历史记录', '只清空当前账号在此会话中的历史记录，其他成员不受影响。清空后无法恢复，是否继续？', '清空记录', async () => {
    const result = await api('/messages/clear-history', { method: 'POST', body: JSON.stringify({ conversation_id: conversation.id }) });
    conversation.cleared_before_message_id = result.cleared_before_message_id;
    if (Number(state.active?.id) === Number(conversation.id)) {
      resetChatHistoryLocation();
      state.historyPage = 1;
      state.historyHasMore = false;
      $('messages').innerHTML = '<p class="empty">历史记录已清空，新消息将显示在这里</p>';
      if (state.chatSearch) runChatSearch();
    }
    await loadConversations();
  });
}

async function handleConversationAction(action, conversation) {
  closeConversationContextMenu();
  try {
    if (action === 'folder') return assignConversationFolder(Number(conversation.id));
    if (action === 'hide') return hideConversationFromList(conversation);
    if (action === 'archive') return await setConversationArchived(conversation);
    if (action === 'remark') return renameConversationContact(conversation);
    if (action === 'pin') return await saveConversationSetting(conversation, 'is_pinned', !conversation.is_pinned);
    if (action === 'mute') return await saveConversationSetting(conversation, 'notifications_muted', !conversation.notifications_muted);
    if (action === 'unread') {
      await api('/messages/mark-unread', { method: 'POST', body: JSON.stringify({ conversation_id: conversation.id }) });
      await loadConversations();
      return;
    }
    if (action === 'clear') return clearConversationHistory(conversation);
    if (action === 'share') return openShareContactCardPicker(conversation);
    if (action === 'profile') {
      if (conversation.type === 'direct' && conversation.peer_user_id) return openContactProfile(Number(conversation.peer_user_id));
      if (conversation.type === 'group') {
        await openConversation(Number(conversation.id));
        return openGroupInfoDialog();
      }
    }
  } catch (error) {
    alert(error.message || '会话操作失败');
  }
}

document.addEventListener('pointerdown', event => {
  if (!(event.target instanceof Element) || !event.target.closest('#conversation-context-menu')) closeConversationContextMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeConversationContextMenu();
});

function renderConversationList() {
  const groupActions = $('group-sidebar-actions');
  if (groupActions) groupActions.hidden = state.sidebarMode !== 'groups' || Boolean(state.chatSearch);
  if (state.chatSearch) return;
  const mode = state.sidebarMode || 'messages';
  const scope = sidebarFolderScope();
  const allItems = state.conversations.filter(item => item.type !== 'favorites');
  const archivedItems = allItems.filter(conversationIsArchived);
  const archiveOpen = mode === 'messages' && Boolean(state.archiveView);
  let content = '';
  if (archiveOpen) {
    content = conversationArchiveHeaderHtml(archivedItems.length) + (conversationRowsHtml(archivedItems) || '<p class="classic-list-empty">暂无归档对话</p>');
  } else if (scope) {
    const items = allItems.filter(item => conversationFolderScope(item) === scope);
    const folders = state.conversationFolders.filter(folder => folder.scope === scope);
    const folderIds = new Set(folders.flatMap(folder => (folder.conversation_ids || []).map(Number)));
    const folderHtml = folders.map(folder => {
      const folderItems = items.filter(item => (folder.conversation_ids || []).map(Number).includes(Number(item.id)));
      return `<section class="classic-conversation-folder ${folder.collapsed ? 'collapsed' : ''}" data-folder-section-scope="${scope}"><button class="classic-section-title classic-folder-toggle" data-folder-id="${Number(folder.id)}" type="button"><span>${folder.collapsed ? '›' : '⌄'}</span><strong>${escapeHtml(folder.name)}</strong><em>${folderItems.length}</em></button><div class="classic-folder-items">${conversationRowsHtml(folderItems, true)}</div></section>`;
    }).join('');
    const ungrouped = items.filter(item => !folderIds.has(Number(item.id)));
    const collapsed = ungroupedFolderCollapsed(scope);
    const otherItems = scope === 'groups' ? allItems.filter(item => ['channel', 'customer_service'].includes(item.type)) : [];
    content = `<button id="classic-add-group" class="classic-add-group" type="button"><span>＋</span>添加分组</button>${folderHtml}<section class="classic-conversation-folder ${collapsed ? 'collapsed' : ''}" data-folder-section-scope="${scope}"><button class="classic-section-title classic-folder-toggle" data-ungrouped-toggle type="button"><span>${collapsed ? '›' : '⌄'}</span><strong>未分组</strong><em>${ungrouped.length}</em></button><div class="classic-folder-items">${conversationRowsHtml(ungrouped, true)}</div></section>${otherItems.length ? `<section class="classic-other-conversations"><h3 class="classic-section-title">其他会话</h3>${conversationRowsHtml(otherItems)}</section>` : ''}`;
  } else content = conversationArchiveEntryHtml(archivedItems) + (conversationRowsHtml(allItems.filter(item => !conversationIsArchived(item))) || '<p class="classic-list-empty">暂无会话</p>');
  const favoriteRow = !archiveOpen && state.favoriteMode ? `<button class="conversation favorite-conversation active" data-favorite="true"><span class="avatar favorite-avatar">${navIcon('star')}</span><span class="conversation-copy"><strong>我的收藏</strong><small>收藏的消息和文件</small></span></button>` : '';
  const archiveFeedback = state.archiveFeedback ? `<p class="conversation-archive-feedback" role="alert">${escapeHtml(state.archiveFeedback)}</p>` : '';
  renderStableConversationContent($('conversation-list'), archiveFeedback + favoriteRow + (content || '<p class="classic-list-empty">暂无会话</p>'));
  if ($('conversation-archive-entry')) $('conversation-archive-entry').onclick = () => setConversationArchiveView(true);
  if ($('conversation-archive-back')) $('conversation-archive-back').onclick = () => setConversationArchiveView(false);
  if ($('message-search')) $('message-search').placeholder = archiveOpen ? '搜索归档对话' : '搜索';
  document.querySelectorAll('.conversation').forEach((button) => {
    button.onclick = (event) => {
      const folderAction = event.target instanceof Element ? event.target.closest('[data-folder-assign]') : null;
      if (folderAction) {
        event.preventDefault();
        event.stopPropagation();
        const item = state.conversations.find(row => Number(row.id) === Number(button.dataset.id));
        if (item) openConversationActionMenu(event, item, true);
        return;
      }
      openConversation(Number(button.dataset.id));
    };
    button.oncontextmenu = event => {
      const item = state.conversations.find(row => Number(row.id) === Number(button.dataset.id));
      if (item) openConversationActionMenu(event, item);
    };
  });
  document.querySelectorAll('[data-favorite]').forEach((button) => { button.onclick = openFavorites; });
  if ($('classic-add-group')) $('classic-add-group').onclick = createConversationFolder;
  document.querySelectorAll('[data-folder-id]').forEach((button) => {
    button.onclick = () => {
      const folder = state.conversationFolders.find((item) => Number(item.id) === Number(button.dataset.folderId));
      if (folder) toggleConversationFolder(folder);
    };
  });
  document.querySelectorAll('[data-ungrouped-toggle]').forEach((button) => { button.onclick = toggleUngroupedConversationFolder; });
  document.querySelectorAll('[data-folder-assign]').forEach((node) => {
    node.onpointerdown = (event) => {
      event.stopPropagation();
    };
    node.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = state.conversations.find(row => Number(row.id) === Number(node.closest('.conversation')?.dataset.id));
      if (item) openConversationActionMenu(event, item, true);
    };
    node.onkeydown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      assignConversationFolder(Number(node.dataset.folderAssign));
    };
  });
}

function filterConversationList(keyword) { const value = String(keyword || '').trim().toLowerCase(); document.querySelectorAll('.conversation').forEach((item) => { item.hidden = Boolean(value) && !(`${item.dataset.id} ${item.textContent}`.toLowerCase().includes(value)); }); }

function focusConversationInput(id) {
  const input = $('message-input'), composer = $('composer');
  if (!desktop.isDesktop && !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (!state.token || !state.user || state.updateRequired || state.favoriteMode || state.desktopAccountVisible === false
    || Number(state.active?.id) !== Number(id) || state.page !== 'messages' || document.hidden
    || !input?.isConnected || composer?.hidden || input.disabled || input.readOnly || !input.getClientRects().length
    || document.querySelector('.modal-backdrop,.classic-menu-backdrop,.classic-passcode-lock-screen,[aria-modal="true"]')) return;
  input.focus({ preventScroll: true });
}

async function openConversation(id, { focusInput = true } = {}) {
  void contactNames.refresh().catch(() => {});
  closeConversationFolderModal();
  closeContactProfile();
  const selected = state.conversations.find(item => Number(item.id) === Number(id));
  if (!selected) return;
  if (selected.type === 'favorites') return openFavorites();
  if (!state.favoriteMode && !state.historyLocation && Number(state.active?.id) === Number(id) && !state.initialHistoryFailed
    && (state.initialHistory || (state.historyReadyEpoch != null && state.historyReadyEpoch === state.historyEpoch))) {
    document.body.classList.add('web-conversation-open'); subscribeConversation(id); updateDesktopChat(); if (focusInput) focusConversationInput(id); return;
  }
  rememberConversationView();
  cancelConversationRecovery(); const historyEpoch = state.historyEpoch; const historyToken = state.token;
  resetChatHistoryLocation();
  resetComposerForNavigation();
  closeContactCardPicker();
  closeChatMoreMenu();
  closeImageSendPreview();
  if (state.groupInfoDialog) closeFeatureModal();
  closeChatPanels();
  state.favoriteMode = false;
  document.body.classList.remove('favorite-mode');
  state.active = selected;
  if (!desktop.isDesktop) document.body.classList.add('web-conversation-open');
  const container = $('messages'), cached = conversationViews.take(conversationViewAccount(), id, container);
  const initial = { token: historyToken, epoch: historyEpoch, conversationId: Number(id), events: new Map() }; state.initialHistory = initial; state.initialHistoryFailed = false;
  state.historyPage = cached?.page || 1; state.historyHasMore = cached ? cached.hasMore : true;
  state.historyLoadedFloor = cached?.floor || 0;
  if (cached) {
    // Apply already observed recalls/clears before showing a retained view.
    renderConversationMessages(visibleConversationMessages());
    bindMessageActions();
  } else container.innerHTML = '<p class="empty">正在加载消息…</p>';
  updateDesktopChat();
  if (cached) restoreRecoveryScroll(container, cached.position);
  document.querySelectorAll('.conversation').forEach(node => { const active = Number(node.dataset.id) === Number(id); node.classList.toggle('active', active); node.setAttribute('aria-current', active ? 'true' : 'false'); });
  renderDesktopChatHeader(state.active);
  refreshChatHeaderProfile(id);
  if (focusInput) focusConversationInput(id);
  subscribeConversation(id);
  let result;
  try { result = await fetchInitialHistory(initial); }
  catch (error) {
    if (state.initialHistory !== initial || state.token !== historyToken || state.historyEpoch !== historyEpoch) return;
    state.initialHistory = null; state.initialHistoryFailed = true;
    if (cached) {
      state.historyReadyEpoch = historyEpoch; state.recoveryNeeded = true; void recoverConversation(id);
      console.warn('会话补同步暂时失败，保留当前消息并等待重连：', error.message);
    } else {
      container.innerHTML = '<p class="empty">消息加载暂时失败，将在恢复连接后重试。<button id="retry-initial-history" type="button">重新加载</button></p>';
      $('retry-initial-history').onclick = () => { void openConversation(id); };
    }
    return;
  }
  if (!result || Number(state.active?.id) !== Number(id) || state.token !== historyToken || state.historyEpoch !== historyEpoch) return;
  const cleared = Number(state.active?.cleared_before_message_id || 0);
  const fresh = initialSnapshotMessages(result.items.filter(message => Number(message.id) > cleared).reverse(), initial);
  const position = cached ? recoveryScrollAnchor(container) : { bottom: true };
  let messages = fresh;
  if (cached) {
    const floor = result.items.length ? Math.min(...result.items.map(message => Number(message.id))) : 0;
    const freshIds = new Set(fresh.map(message => Number(message.id)));
    const retained = visibleConversationMessages();
    // The latest page replaces only its range. Older loaded pages remain until
    // the authoritative recovery reconciles that entire retained range.
    for (const message of retained) if (Number(message.id) >= floor && !freshIds.has(Number(message.id))) acceptMessageVersion('message.deleted', message, 'snapshot');
    messages = [...retained.filter(message => Number(message.id) < floor), ...fresh].sort((a, b) => Number(a.id) - Number(b.id));
  }
  if (state.initialHistory === initial) state.initialHistory = null;
  renderConversationMessages(messages, container);
  state.historyReadyEpoch = historyEpoch; state.historyLoadedFloor = messages.length ? Math.min(...messages.map(message => Number(message.id))) : 0;
  void recoverConversation(id);
  bindMessageActions(); restoreRecoveryScroll(container, position);
  await markMessagesRead(messages);
  if (state.token !== historyToken || state.historyEpoch !== historyEpoch) return;
  await loadConversations();
  if (state.token !== historyToken || state.historyEpoch !== historyEpoch) return;
  renderDesktopChatHeader(state.active);
  updateDesktopChat();
}

function renderOlderHistoryControl() {
  const container = $('messages');
  if (!container || !state.active || state.favoriteMode || state.initialHistory) return;
  let button = container.querySelector('[data-history-older]');
  if (!button) {
    button = document.createElement('button'); button.type = 'button'; button.dataset.historyOlder = '';
    button.style.cssText = 'display:block;width:100%;padding:8px;border:0;background:transparent;color:var(--muted,#777);font-size:12px;cursor:pointer';
    button.onclick = () => { void loadOlderMessages(); }; container.prepend(button);
  }
  button.disabled = state.historyLoading || !state.historyHasMore;
  button.textContent = state.historyLoading ? '正在加载更早消息…' : state.olderHistoryFailed ? '加载失败，点击重试更早消息' : state.historyHasMore ? '加载更早消息' : '已到聊天记录开头';
}
function resumeQueuedOlderHistory() {
  const queued = state.olderHistoryQueued;
  if (!queued) return;
  if (queued.token !== state.token || queued.epoch !== state.historyEpoch || queued.id !== Number(state.active?.id)) { state.olderHistoryQueued = null; return; }
  if (state.recovery || state.initialHistory || state.historyLoading) return;
  state.olderHistoryQueued = null;
  void loadOlderMessages();
}
async function loadOlderMessages() {
  if (!state.active || state.favoriteMode || state.initialHistory || state.historyLoading || !state.historyHasMore) return;
  // Scrolling while socket recovery is reading must not lose the user's request.
  if (state.recovery) {
    state.olderHistoryQueued = { token: state.token, epoch: state.historyEpoch, id: Number(state.active.id) };
    return;
  }
  state.historyLoading = true; state.olderHistoryFailed = false;
  const messages = $('messages'); const conversationId = Number(state.active.id);
  const epoch = state.historyEpoch, token = state.token, revision = state.historyRevision;
  const ids = [...messages.querySelectorAll('[data-message-id]')].map(node => Number(node.dataset.messageId)).filter(id => Number.isSafeInteger(id) && id > 0);
  const before = ids.length ? Math.min(...ids) - 1 : 0;
  renderOlderHistoryControl();
  try {
    if (before <= 0) { state.historyHasMore = false; return; }
    const result = await api(`/messages/history?conversation_id=${conversationId}&page=1&size=50&max_id=${before}`, { authToken: token });
    if (state.token !== token || Number(state.active?.id) !== conversationId || state.historyEpoch !== epoch || state.historyRevision !== revision) return;
    if (!Array.isArray(result.items) || result.items.some(message => !Number.isSafeInteger(Number(message.id)) || Number(message.id) <= 0 || Number(message.id) > before || Number(message.conversation_id) !== conversationId)
      || new Set(result.items.map(message => Number(message.id))).size !== result.items.length) throw new Error('历史消息分页无效，请重试');
    const older = initialSnapshotMessages(result.items.filter(message => !messages.querySelector(`[data-message-id="${Number(message.id)}"]`)).reverse());
    // Capture after HTTP: a slow read must not undo scrolling performed while it was pending.
    const currentPosition = recoveryScrollAnchor(messages); currentPosition.bottom = false;
    if (older.length) { state.historyPage++; messages.insertAdjacentHTML('afterbegin', older.map(messageHtml).join('')); state.historyLoadedFloor = Math.min(...older.map(message => Number(message.id))); bindMessageActions(); }
    state.historyHasMore = result.items.length > 0 && (typeof result.has_more === 'boolean' ? result.has_more : Number.isFinite(Number(result.total)) ? Number(result.total) > result.items.length : true);
    if (result.items.length && Math.min(...result.items.map(message => Number(message.id))) <= 1) state.historyHasMore = false;
    renderOlderHistoryControl();
    // Keep the control before the newly prepended rows.
    messages.prepend(messages.querySelector('[data-history-older]'));
    restoreRecoveryScroll(messages, currentPosition);
  } catch (error) {
    if (state.token === token && state.historyEpoch === epoch && Number(state.active?.id) === conversationId) state.olderHistoryFailed = true;
    console.warn('加载历史消息失败：', error.message);
  } finally {
    if (state.historyEpoch === epoch) { state.historyLoading = false; renderOlderHistoryControl(); void recoverConversation(conversationId); }
  }
}

function mediaAutoDownloadKey(conversation = state.active) {
  if (conversation?.type === 'group') return 'auto_download_group';
  if (conversation?.type === 'channel') return 'auto_download_channel';
  return 'auto_download_private';
}

function mediaAutoDownloadScope(conversation = state.active) {
  if (conversation?.type === 'group') return 'group';
  if (conversation?.type === 'channel') return 'channel';
  return 'private';
}

function mediaAutoDownloadEnabled(conversation = state.active, category = 'photos', message = null) {
  const scope = mediaAutoDownloadScope(conversation);
  return mediaDownloadCategoryEnabled(scope, category) && (!message || mediaDownloadWithinLimit(message, scope));
}

async function downloadMessageFile(event, link) {
  event.preventDefault();
  const url = link.dataset.downloadUrl || link.href;
  const fileName = link.dataset.downloadName || '下载文件';
  if (!desktop.isDesktop) { const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); return; }
  let directory = localStorage.getItem('pulse_download_directory') || '';
  if (localSetting('download_ask', true) || !directory) directory = await desktop.selectDownloadDirectory?.() || '';
  if (!directory) return;
  try {
    if (desktop.downloadFile) await desktop.downloadFile(url, fileName, directory);
    else { const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); }
    link.textContent = '已保存';
  } catch (error) { alert(error.message || '文件下载失败'); }
}

function isGifMessage(message) {
  if (message?.type !== 'image' || !message.body?.url) return false;
  const mime = String(message.body.mime || '').toLowerCase();
  const name = String(message.body.name || '').toLowerCase();
  const url = String(message.body.url || '').split(/[?#]/, 1)[0].toLowerCase();
  return mime === 'image/gif' || name.endsWith('.gif') || url.endsWith('.gif');
}

function gifImageHtml(url, name, body = {}) {
  const width = Number(body.width) > 0 ? ` width="${Math.min(10000, Number(body.width))}"` : '';
  const height = Number(body.height) > 0 ? ` height="${Math.min(10000, Number(body.height))}"` : '';
  return `<a class="classic-image-media classic-gif-media" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="查看 GIF"><img class="message-image" loading="lazy" data-gif-url="${escapeHtml(url)}" data-gif-name="${escapeHtml(name)}" src="${escapeHtml(url)}" alt="${escapeHtml(name)}"${width}${height}></a>`;
}

function gifPlayButtonHtml(url, name) {
  return `<button class="classic-media-load classic-gif-load" type="button" data-gif-play="1" data-gif-url="${escapeHtml(url)}" data-gif-name="${escapeHtml(name)}">点击播放 GIF</button>`;
}

function applyAnimatedGifSetting() {
  const autoplay = localSetting('animated_gif', true);
  document.querySelectorAll('[data-gif-url]').forEach((node) => {
    const url = node.dataset.gifUrl || '';
    const name = node.dataset.gifName || 'GIF 图片';
    if (!url) return;
    const message = node.closest('[data-message-id]');
    const current = node.closest('a') || node;
    if (autoplay && node.matches('[data-gif-play]')) {
      current.outerHTML = gifImageHtml(url, name, { width: node.dataset.gifWidth, height: node.dataset.gifHeight });
    } else if (!autoplay && node.matches('img[data-gif-url]')) {
      current.outerHTML = gifPlayButtonHtml(url, name);
    }
    if (message) message.dataset.gifAutoplay = autoplay ? '1' : '0';
  });
  bindGifActions();
}

function bindGifActions() {
  document.querySelectorAll('[data-gif-play]').forEach((button) => {
    button.onclick = () => {
      const url = button.dataset.gifUrl || '';
      const name = button.dataset.gifName || 'GIF 图片';
      if (!url) return;
      const image = document.createElement('img');
      image.className = 'message-image';
      image.loading = 'lazy';
      image.dataset.gifUrl = url;
      image.dataset.gifName = name;
      image.src = url;
      image.alt = name;
      button.replaceWith(image);
    };
  });
}

function imageMessageSizeAttributes(body = {}) {
  const rawWidth = Number(body.width), rawHeight = Number(body.height);
  const width = Number.isFinite(rawWidth) && rawWidth > 0 ? Math.min(10000, rawWidth) : 0;
  const height = Number.isFinite(rawHeight) && rawHeight > 0 ? Math.min(10000, rawHeight) : 0;
  let attributes = `${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}`;
  if (width && height) {
    const displayWidth = Math.min(width, 520, 520 * width / height);
    attributes += ` style="width:${displayWidth}px;aspect-ratio:${width}/${height}"`;
  }
  return attributes;
}

function messageHtml(message) {
  if (message.recalled_at || ['recalled', 'deleted'].includes(message.status) || messageVersionCache().get(Number(message.id))?.removed) return '';
  let content;
  const mine = Number(message.sender_id) === Number(state.user.id);
  const image = message.type === 'image' && Boolean(message.body?.url);
  const caption = image && typeof message.body.text === 'string' && message.body.text.trim() ? message.body.text : '';
  const gif = isGifMessage(message);
  const redPacket = message.type === 'red_packet';
  const contactCard = message.type === 'contact_card' && Number(message.body?.user_id) > 0;
  const shake = message.type === 'shake';
  const video = Boolean(message.body?.url) && (message.type === 'video' || (message.type === 'file' && /^video\//i.test(String(message.body?.mime || ''))));
  const autoDownload = mediaAutoDownloadEnabled(state.active, image ? 'photos' : video ? 'videos' : 'files', message);
  if (Number(message.body?.poll_id) > 0) { const poll = groupPollCache.get(Number(message.body.poll_id)); content = `<section class="classic-poll-card" data-group-poll="${Number(message.body.poll_id)}">${poll ? groupPollHtml(poll) : `<strong>${escapeHtml(message.body.text || '群组投票')}</strong><small>正在加载投票…</small>`}</section>`; }
  else if (message.type === 'voice' && message.body?.url) content = `<audio controls preload="${autoDownload ? 'metadata' : 'none'}" src="${escapeHtml(mediaUrl(message.body.url))}"></audio>`;
  else if (image) {
    const url = mediaUrl(message.body.url);
    const imageHtml = autoDownload
      ? (gif && !localSetting('animated_gif', true) ? gifPlayButtonHtml(url, message.body.name || 'GIF 图片') : gif ? gifImageHtml(url, message.body.name || 'GIF 图片', message.body) : `<a class="classic-image-media" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="${message.body.original ? '查看原图' : '查看图片'}"><img class="message-image" loading="lazy" src="${escapeHtml(url)}" alt="${escapeHtml(message.body.name || '图片消息')}"${imageMessageSizeAttributes(message.body)}></a>`)
      : `<button class="classic-media-load" type="button" data-media-load-kind="image" data-media-load-url="${escapeHtml(url)}" data-media-load-name="${escapeHtml(message.body.name || '图片消息')}">点击加载图片</button>`;
    content = imageHtml;
  }
  else if (video) {
    const url = mediaUrl(message.body.url);
    content = autoDownload
      ? `<video class="message-video" controls preload="metadata" src="${escapeHtml(url)}"></video>`
      : `<button class="classic-media-load" type="button" data-media-load-kind="video" data-media-load-url="${escapeHtml(url)}" data-media-load-name="${escapeHtml(message.body.name || '视频消息')}">点击加载视频</button>`;
  }
  else if (contactCard) {
    const cardAvatar = message.body?.avatar_url ? `<img src="${escapeHtml(mediaUrl(message.body.avatar_url))}" alt="">` : escapeHtml((message.body?.nickname || '?').slice(0, 1));
    content = `<button type="button" class="contact-card-message" data-contact-card-user="${Number(message.body.user_id)}"><span class="contact-card-message-avatar">${cardAvatar}</span><span class="contact-card-message-copy"><strong>${escapeHtml(message.body?.nickname || '未命名用户')}</strong><small>${escapeHtml(message.body?.username ? '@' + message.body.username : '站内名片')}</small>${publicUserId(message.body) ? `<small class="contact-public-id">ID：${escapeHtml(publicUserId(message.body))}</small>` : ''}</span><span class="contact-card-message-label">个人名片</span></button>`;
  }
  else if (shake) content = '<div class="shake-message">窗口抖动</div>';
  else if (message.type === 'file' && message.body?.url) { const url = mediaUrl(message.body.url); content = autoDownload ? `<a class="file-link" href="${escapeHtml(url)}" data-download-url="${escapeHtml(url)}" data-download-name="${escapeHtml(message.body.name || '下载文件')}" target="_blank" rel="noreferrer">下载文件</a>` : `<button class="classic-media-load" type="button" data-media-load-kind="file" data-media-load-url="${escapeHtml(url)}" data-media-load-name="${escapeHtml(message.body.name || '下载文件')}">点击加载文件</button>`; }
  else if (redPacket) content = '<div class="red-packet-card"><strong>历史红包</strong><span>红包功能已停用</span></div>';
  else content = escapeHtml(message.body?.text || `[${messageType(message.type)}消息]`);
  const recall = !redPacket && mine && state.user?.internal_staff && !message.body?.poll_id ? `<button class="recall-button" data-recall-id="${message.id}" type="button">撤回</button>` : '';
  let avatar = '';
  if (PC_LAYOUT && mine) {
    const letter = (state.user.nickname || '我').slice(0, 1);
    avatar = `<span class="classic-message-avatar" aria-hidden="true">${state.user.avatar_url ? `<img src="${escapeHtml(mediaUrl(state.user.avatar_url))}" alt="" data-message-avatar-fallback="${escapeHtml(letter)}">` : escapeHtml(letter)}</span>`;
  }
  const time = PC_LAYOUT ? String(message.created_at || '').match(/(?:T|\s)(\d{2}:\d{2})/)?.[1] || '' : message.created_at;
  const metadata = `<small class="classic-message-meta"><time title="${escapeHtml(message.created_at || '')}">${escapeHtml(caption ? String(message.created_at || '').match(/(?:T|\s)(\d{2}:\d{2})/)?.[1] || '' : time)}</time>${recall}</small>`;
  if (caption) {
    const width = Number(message.body.width), height = Number(message.body.height);
    const cardWidth = width > 0 && height > 0 ? Math.round(Math.max(200, Math.min(320, width * 440 / height))) : 320;
    content = `<div class="image-caption-card" style="--image-card-width:${cardWidth}px"><div class="image-caption-media">${content}</div><div class="image-caption-copy"><p class="classic-image-caption">${escapeHtml(caption)}</p>${metadata}</div></div>`;
  }
  return `<article class="bubble ${mine ? 'mine' : ''}${redPacket ? ' red-packet-message' : ''}${contactCard ? ' contact-card-bubble' : ''}${shake ? ' shake-bubble' : ''}${message.type === 'text' ? ' text-message' : ''}${message.type === 'system' ? ' system-message' : ''}${image ? ' image-message' : ''}${caption ? ' has-image-caption' : ''}" data-message-id="${message.id}">${avatar}${content}${caption ? '' : metadata}</article>`;
}

function bindMessageActions() { document.querySelectorAll('[data-message-avatar-fallback]').forEach(img => { img.onerror = () => { if (!PulseMessageView.retryFreshSource(img)) img.parentElement.textContent = img.dataset.messageAvatarFallback; }; }); document.querySelectorAll('[data-recall-id]').forEach((button) => { button.onclick = () => recallMessage(Number(button.dataset.recallId)); }); document.querySelectorAll('[data-contact-card-user]').forEach((button) => { button.onclick = () => openContactProfile(Number(button.dataset.contactCardUser)); }); document.querySelectorAll('[data-media-load-url]').forEach((button) => { button.onclick = () => { const url = button.dataset.mediaLoadUrl; const name = button.dataset.mediaLoadName || '媒体消息'; const kind = button.dataset.mediaLoadKind || 'image'; if (kind === 'video') { const video = document.createElement('video'); video.className = 'message-video'; video.controls = true; video.preload = 'metadata'; video.src = url; button.replaceWith(video); applyMediaOutputToElement(video); return; } if (kind === 'file') { const link = document.createElement('a'); link.className = 'file-link'; link.href = url; link.target = '_blank'; link.rel = 'noreferrer'; link.dataset.downloadUrl = url; link.dataset.downloadName = name; link.textContent = '下载文件'; button.replaceWith(link); link.onclick = event => downloadMessageFile(event, link); return; } const image = document.createElement('img'); image.className = 'message-image'; image.loading = 'lazy'; image.src = url; image.alt = name; button.replaceWith(image); }; }); document.querySelectorAll('[data-download-url]').forEach((link) => { link.onclick = event => downloadMessageFile(event, link); }); bindGifActions(); applyMediaOutputSettings(); bindGroupPollActions(); refreshGroupPollCards(); }
function triggerWindowShake() {
  const main = document.querySelector('.main');
  if (!main) return;
  main.classList.remove('window-shaking');
  void main.offsetWidth;
  main.classList.add('window-shaking');
  clearTimeout(state.shakeTimer);
  state.shakeTimer = setTimeout(() => main.classList.remove('window-shaking'), 460);
}
function appendMessage(message, source = 'ack') { textOutbox.confirm(textOutboxAccount(), message); if (Number(message.id) <= Number(state.active?.cleared_before_message_id || 0)) return; if (!rememberRecoveryMessage(message.recalled_at ? 'message.recalled' : 'message.new', message, source)) return; if (!state.user || Number(message.conversation_id) !== Number(state.active?.id)) return; if (Number(message.id) <= Number(state.active?.cleared_before_message_id || 0) || document.querySelector(`[data-message-id="${message.id}"]`)) return; if (message.type === 'shake') triggerWindowShake(); if (state.historyLocation?.conversationId === Number(state.active?.id) && Number(message.id) > state.historyLocation.maxId) { const notice = $('chat-history-location')?.querySelector('span'); if (notice) notice.textContent = '有新消息'; return; } const scrollPosition = recoveryScrollAnchor($('messages')); const empty = $('messages').querySelector('.empty'); if (empty) empty.remove(); const next = [...$('messages').querySelectorAll('[data-message-id]')].find(node => Number(node.dataset.messageId) > Number(message.id)) || $('messages').querySelector('[data-outbox-id]'); if (next) next.insertAdjacentHTML('beforebegin', messageHtml(message)); else $('messages').insertAdjacentHTML('beforeend', messageHtml(message)); bindMessageActions(); restoreRecoveryScroll($('messages'), scrollPosition); if (message.sender_id !== state.user.id && message.conversation_id === state.active?.id) markReceipt(message.id, 'read'); }
async function markReceipt(messageId, status, refreshList = true) {
  const token = state.token;
  try {
    await api('/messages/receipt', { method: 'POST', authToken: token, body: JSON.stringify({ message_id: messageId, status }) });
    if (refreshList && state.token === token && state.user && status === 'read') loadConversations().catch(() => {});
  } catch (error) { console.warn('消息回执失败：', error.message); }
}
async function markMessagesRead(messages) { const userId = Number(state.user?.id); await Promise.all(messages.filter((message) => Number(message.sender_id) !== userId).map((message) => markReceipt(message.id, 'read', false))); }

function forwardMessageBody(message) {
  const keys = {
    text: ['text'], contact_card: ['user_id'],
    image: ['url', 'text', 'mime', 'size', 'name', 'width', 'height', 'original'],
    video: ['url', 'thumbnail_url', 'text', 'mime', 'size', 'name', 'width', 'height', 'duration_ms'],
    file: ['url', 'text', 'mime', 'size', 'name', 'file_name', 'original_name'],
    voice: ['url', 'mime', 'size', 'name', 'duration_ms'],
  }[message?.type];
  if (!keys) throw new Error('这类消息暂不支持转发。');
  const body = {};
  for (const field of keys) if (Object.prototype.hasOwnProperty.call(message.body || {}, field)) body[field] = message.body[field];
  return JSON.parse(JSON.stringify(body));
}
function canForwardSource(message) {
  if (!message || !Number.isSafeInteger(Number(message.id)) || Number(message.id) <= 0
      || Number(message.conversation_id) !== Number(state.active?.id) || Number(message.id) <= Number(state.active?.cleared_before_message_id || 0)
      || message.status === 'recalled' || message.recalled_at || messageVersionCache().get(Number(message.id))?.removed) return false;
  return ['text', 'image', 'video', 'file', 'voice', 'contact_card'].includes(message.type);
}
function forwardTargetAllowed(conversation) {
  return ['direct', 'group', 'channel', 'customer_service', 'favorites'].includes(conversation?.type)
    && !composerPermissions.reason(conversation)
    && !conversation.frozen_at && conversation.status !== 'frozen' && conversation.can_publish !== false && conversation.can_publish !== 0
    && (conversation.type !== 'channel' || ['owner', 'admin'].includes(conversation.my_role));
}
function openMessageForwardPicker(source, options = {}) {
  return window.PulseForwardRecipients.open(source, options);
}

function sendMessage(event) {
  event.preventDefault(); if (!state.active) return;
  const input = $('message-input'), text = input.value.trim(); if (!text || input.disabled) return;
  try {
    const context = captureSendContext(); assertSendAccount(context);
    const payload = { conversation_id: context.conversationId, type: 'text', body: messageBodyWithReply({ text }, context), request_id: newMessageRequestId('text') };
    textOutbox.enqueue({ token: context.token, userId: context.userId }, payload);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    completeReplySend(context);
    $('messages').scrollTop = $('messages').scrollHeight;
  } catch (error) { composerFeedback(error.message || '暂时无法发送，请重试'); }
}

async function sendWindowShake() {
  if (state.user?.internal_staff !== true) { composerFeedback('窗口抖动仅限内部人员使用。'); return; }
  if (state.favoriteMode || state.active?.type !== 'direct') { composerFeedback('窗口抖动仅支持私聊。'); return; }
  if (!state.active || state.textSending || state.shakeSending) { if (!state.active) composerFeedback('请先选择会话。'); return; }
  const conversationId = Number(state.active.id);
  state.shakeSending = true;
  try {
    const message = await api('/messages', { method: 'POST', body: JSON.stringify({ conversation_id: conversationId, type: 'shake', body: { text: '窗口抖动' }, request_id: `pc-shake-${crypto.randomUUID()}` }) });
    if (Number(state.active?.id) === conversationId) appendMessage(message);
  } catch (error) { composerFeedback(error.message || '窗口抖动发送失败，请重试。'); }
  finally { state.shakeSending = false; }
}
function contactCardRowHtml(item) {
  const userId = Number(item.user_id || item.id);
  const avatar = item.avatar_url ? `<img src="${escapeHtml(mediaUrl(item.avatar_url))}" alt="">` : escapeHtml((item.nickname || '?').slice(0, 1));
  return `<button type="button" class="contact-card-picker-row" data-send-contact-card="${userId}"><span class="contact-modal-avatar">${avatar}</span><span class="contact-modal-copy"><strong>${escapeHtml(item.nickname || '未命名用户')}</strong><small>${escapeHtml(item.username ? '@' + item.username : item.phone || '站内联系人')}</small>${publicUserId(item) ? `<small class="contact-public-id">ID：${escapeHtml(publicUserId(item))}</small>` : ''}</span><span class="contact-card-picker-arrow">发送</span></button>`;
}

function closeContactCardPicker() {
  document.querySelector('.contact-card-picker-backdrop,.share-contact-card-backdrop')?.remove();
}
function contactCardPickerState(modal, feedbackId, targetConversation = null) {
  return { modal, feedback: modal.querySelector('#' + feedbackId), account: { token: state.token, userId: Number(state.user?.id) }, targetConversation,
    context: targetConversation ? captureSendContext(targetConversation) : null, historyEpoch: state.historyEpoch, page: state.page, sidebarMode: state.sidebarMode, activeId: Number(state.active?.id) || 0, attempts: new Map(), sending: false };
}
function currentContactCardPicker(picker) {
  return Boolean(picker?.modal.isConnected && document.querySelector('[data-feature-modal]') === picker.modal && sameSendAccount(picker.account) && !state.updateRequired
    && state.historyEpoch === picker.historyEpoch && state.page === picker.page && state.sidebarMode === picker.sidebarMode && (Number(state.active?.id) || 0) === picker.activeId);
}
function setContactCardPickerBusy(picker) {
  picker.modal.querySelectorAll('[data-send-contact-card],[data-share-target],input').forEach(node => { node.disabled = picker.sending; });
}
async function openShareContactCardPicker(sourceConversation) {
  if (!sourceConversation?.peer_user_id) {
    alert('当前会话没有可分享的联系人资料。');
    return;
  }
  if (!state.token || !state.user) return;
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal share-contact-card-backdrop" data-feature-modal><section class="feature-card contact-card-picker" role="dialog" aria-modal="true" aria-labelledby="share-contact-card-title"><header><div><h2 id="share-contact-card-title">分享好友名片</h2><p>选择要发送给的会话</p></div><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header><div id="share-contact-card-list" class="contact-card-picker-list"><p class="modal-empty">正在加载会话…</p></div><p id="share-contact-card-feedback" class="form-feedback" role="status"></p></section></div>`);
  bindFeatureModal();
  const modal = document.querySelector('.share-contact-card-backdrop');
  const list = $('share-contact-card-list');
  const picker = contactCardPickerState(modal, 'share-contact-card-feedback');
  try {
    const [profile, conversations] = await Promise.all([
      api(`/contacts/profile?user_id=${Number(sourceConversation.peer_user_id)}`, { authToken: picker.account.token }),
      api('/conversations?size=100', { authToken: picker.account.token })
    ]);
    if (!currentContactCardPicker(picker)) return;
    state.contactCache[Number(sourceConversation.peer_user_id)] = { ...profile };
    const targets = (conversations.items || []).filter(item => item.type !== 'favorites' && Number(item.id) !== Number(sourceConversation.id));
    list.innerHTML = targets.map(item => `<button type="button" class="contact-card-picker-row" data-share-target="${Number(item.id)}"><span class="contact-modal-avatar">${item.avatar_url ? `<img src="${escapeHtml(mediaUrl(item.avatar_url))}" alt="">` : escapeHtml((item.name || '会').slice(0, 1))}</span><span class="contact-modal-copy"><strong>${escapeHtml(item.name || '未命名会话')}</strong><small>${item.type === 'group' ? `${Number(item.member_count || 0)} 位成员` : '私聊会话'}</small></span><span class="contact-card-picker-arrow">发送</span></button>`).join('') || '<p class="modal-empty">暂无可发送的其他会话</p>';
    list.querySelectorAll('[data-share-target]').forEach(button => {
      button.onclick = () => {
        const target = targets.find(item => Number(item.id) === Number(button.dataset.shareTarget));
        if (target) sendContactCard(Number(sourceConversation.peer_user_id), picker, target);
      };
    });
  } catch (error) {
    if (currentContactCardPicker(picker)) list.innerHTML = `<p class="modal-empty">${escapeHtml(error.message || '加载失败')}</p>`;
  }
}

async function openContactCardPicker() {
  if (!state.active || state.active.type === 'favorites') { composerFeedback('请先选择可以发送消息的会话。'); return; }
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal contact-card-picker-backdrop" data-feature-modal><section class="feature-card contact-card-picker" role="dialog" aria-modal="true" aria-labelledby="contact-card-picker-title"><header><h2 id="contact-card-picker-title">发送站内名片</h2><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header><input id="contact-card-picker-search" type="search" placeholder="搜索联系人" aria-label="搜索联系人"><div id="contact-card-picker-list" class="contact-card-picker-list"><p class="modal-empty">正在加载联系人…</p></div><p id="contact-card-picker-feedback" class="form-feedback" role="status"></p></section></div>`);
  bindFeatureModal();
  const modal = document.querySelector('.contact-card-picker-backdrop');
  const list = $('contact-card-picker-list'); const search = $('contact-card-picker-search');
  const picker = contactCardPickerState(modal, 'contact-card-picker-feedback', state.active);
  let items = [];
  const render = () => {
    if (!currentContactCardPicker(picker)) return;
    const keyword = search.value.trim().toLowerCase();
    const filtered = items.filter(item => `${item.nickname || ''} ${item.username || ''} ${item.phone || ''}`.toLowerCase().includes(keyword));
    list.innerHTML = filtered.map(contactCardRowHtml).join('') || '<p class="modal-empty">没有匹配的联系人</p>';
    list.querySelectorAll('[data-send-contact-card]').forEach(button => { button.onclick = () => sendContactCard(Number(button.dataset.sendContactCard), picker); });
    setContactCardPickerBusy(picker);
  };
  search.oninput = render;
  try { const result = await api('/contacts?size=100', { authToken: picker.account.token }); if (!currentContactCardPicker(picker)) return; items = result.items || []; render(); }
  catch (error) { if (currentContactCardPicker(picker)) list.innerHTML = `<p class="modal-empty">${escapeHtml(error.message || '联系人加载失败')}</p>`; }
}
async function sendContactCard(userId, picker, targetConversation = picker?.targetConversation) {
  userId = Number(userId);
  const conversationId = Number(targetConversation?.id);
  if (!currentContactCardPicker(picker) || picker.sending || !Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(conversationId) || conversationId <= 0) return;
  const key = `${conversationId}:${userId}`;
  let attempt = picker.attempts.get(key);
  if (!attempt) {
    attempt = { context: picker.context || captureSendContext(targetConversation), requestId: newMessageRequestId('card'), payload: null };
    picker.attempts.set(key, attempt);
  }
  const context = attempt.context;
  picker.sending = true; setContactCardPickerBusy(picker);
  picker.feedback.textContent = '正在发送名片…';
  try {
    if (!attempt.payload) {
      const profile = await api(`/contacts/profile?user_id=${userId}`, { authToken: context.token });
      if (!currentContactCardPicker(picker)) return;
      state.contactCache[userId] = { ...profile };
      attempt.payload = { conversation_id: conversationId, type: 'contact_card', body: messageBodyWithReply({ user_id: userId }, context), request_id: attempt.requestId };
    }
    if (!currentContactCardPicker(picker)) return;
    const message = await api('/messages', { method: 'POST', authToken: context.token, body: JSON.stringify(attempt.payload) });
    if (!sameSendAccount(context)) return;
    if (Number(state.active?.id) === conversationId) appendMessage(message);
    completeReplySend(context);
    if (currentContactCardPicker(picker)) picker.modal.remove();
    loadConversations().catch(() => {});
  } catch (error) { if (currentContactCardPicker(picker)) picker.feedback.textContent = error.message || '名片发送失败，请重试。'; }
  finally { picker.sending = false; if (currentContactCardPicker(picker)) setContactCardPickerBusy(picker); }
}
async function sendMediaFile(kind, file, capturedContext = null) {
  if (!file || !state.active) return;
  if (PC_LAYOUT && (kind === 'image' || /^image\//i.test(file.type) || /\.(jpe?g|png|gif|webp)$/i.test(file.name))) return openImageSendPreview(file);
  if (kind === 'video' && (!/^video\//i.test(file.type) && !/\.(mp4|webm|mov|avi|mkv|ogv|mpeg|mpg|3gp|m4v|wmv)$/i.test(file.name))) { composerFeedback('请选择有效的视频文件。'); return; }
  if (kind === 'video' && (!file.size || file.size > 100 * 1024 * 1024)) { composerFeedback('视频大小不能超过100MB。'); return; }
  if (kind === 'file' && (!/\.(pdf|txt|zip|doc|docx)$/i.test(file.name) || !file.size || file.size > 50 * 1024 * 1024)) { composerFeedback('文件仅支持PDF、TXT、ZIP、DOC、DOCX，大小不超过50MB。'); return; }
  const context = capturedContext || captureSendContext();
  const draft = mediaSendDraft(kind, file, context);
  if (draft.sending) return;
  draft.sending = true;
  try {
    assertSendAccount(context);
    if (!draft.uploaded) draft.uploaded = await uploadMedia(kind, file, context.token);
    assertSendAccount(context);
    const body = { url: mediaUrl(draft.uploaded.url), mime: draft.uploaded.mime, size: draft.uploaded.size, name: file.name };
    if (kind === 'voice' && file.durationMs) body.duration_ms = file.durationMs;
    const message = await api('/messages', { method: 'POST', authToken: context.token, body: JSON.stringify({ conversation_id: context.conversationId, type: kind, body: messageBodyWithReply(body, draft.context), request_id: draft.requestId }) });
    if (sameSendAccount(context) && Number(state.active?.id) === context.conversationId) appendMessage(message);
    completeReplySend(draft.context);
    mediaSendDrafts.delete(file);
  } catch (error) { if (sameSendAccount(context)) alert(error.message || '文件发送失败'); }
  finally { draft.sending = false; }
}

function closeImageSendPreview() { if (state.imageDraft) closeFeatureModal(); }

function openImageSendPreview(file) {
  if (!state.active || !file) return;
  if (!/\.(jpe?g|png|gif|webp)$/i.test(file.name) || (file.type && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type))) { alert('请选择 JPG、PNG、GIF 或 WebP 图片。'); return; }
  if (!file.size || file.size > 10 * 1024 * 1024) { alert('图片大小必须在 10 MB 以内。'); return; }
  if (state.imageDraft?.sending) return;
  closeFeatureModal();
  const draft = { file, conversationId: Number(state.active.id), context: captureSendContext(), previewUrl: URL.createObjectURL(file), ready: false, sending: false, uploaded: null, pendingPayload: null, original: false, width: 0, height: 0, requestId: `pc-image-${crypto.randomUUID()}` };
  state.imageDraft = draft;
  $('image-picker').value = '';
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal classic-image-send-backdrop" data-feature-modal><section class="classic-image-send-dialog" role="dialog" aria-modal="true" aria-label="发送图片"><form id="image-send-form"><div class="classic-image-send-preview"><img id="image-send-preview" src="${escapeHtml(draft.previewUrl)}" alt="待发送图片"></div><fieldset class="classic-image-send-options"><legend class="visually-hidden">图片发送方式</legend><label><input type="radio" name="image-send-mode" value="image" checked><span class="classic-image-send-radio" aria-hidden="true"></span><span>单独作为一张图片发送</span></label><label><input type="radio" name="image-send-mode" value="original"><span class="classic-image-send-radio" aria-hidden="true"></span><span>单独作为一张原图发送</span></label></fieldset><label class="classic-image-send-caption" for="image-send-caption"><span>添加说明</span></label><div class="classic-image-caption-input"><textarea id="image-send-caption" maxlength="1000" rows="1" aria-label="添加说明"></textarea><button id="image-send-emoji" type="button" aria-label="添加表情" aria-expanded="false">${navIcon('smile')}</button></div><div id="image-send-emoji-picker" class="classic-image-emoji-picker" hidden>${['😀', '😊', '😂', '🥰', '😎', '👍', '❤️', '🎉', '🙏', '🌹', '👌', '✨'].map(emoji => `<button type="button" data-image-emoji="${emoji}">${emoji}</button>`).join('')}</div><p id="image-send-feedback" class="classic-image-send-feedback" role="status"></p><footer><button id="image-send-cancel" type="button">取消</button><button id="image-send-submit" type="submit" disabled>发送</button></footer></form></section></div>`);
  const modal = document.querySelector('.classic-image-send-backdrop');
  draft.modal = modal;
  draft.image = $('image-send-preview');
  draft.image.onload = () => {
    if (state.imageDraft !== draft) return;
    draft.width = draft.image.naturalWidth; draft.height = draft.image.naturalHeight;
    if (!draft.width || !draft.height || draft.width > 10000 || draft.height > 10000 || draft.width * draft.height > 80000000) { $('image-send-feedback').textContent = '图片尺寸过大或无法读取，请选择其他图片。'; return; }
    draft.ready = true; $('image-send-submit').disabled = false;
  };
  draft.image.onerror = () => { if (state.imageDraft === draft) $('image-send-feedback').textContent = '图片无法预览，请选择有效的图片文件。'; };
  if (draft.image.complete && draft.image.naturalWidth) draft.image.onload();
  const cancel = () => { if (!draft.sending && state.imageDraft === draft) closeFeatureModal(); };
  $('image-send-cancel').onclick = cancel;
  modal.onclick = (event) => { if (event.target === modal) cancel(); };
  modal.onkeydown = (event) => { if (event.key === 'Escape') { event.stopPropagation(); cancel(); } };
  $('image-send-form').onsubmit = (event) => { event.preventDefault(); return submitImageSend(draft); };
  $('image-send-emoji').onclick = () => { const picker = $('image-send-emoji-picker'); picker.hidden = !picker.hidden; $('image-send-emoji').setAttribute('aria-expanded', String(!picker.hidden)); };
  modal.querySelectorAll('[data-image-emoji]').forEach(button => { button.onclick = () => {
    const input = $('image-send-caption');
    if (input.value.length + button.dataset.imageEmoji.length > 1000) return;
    input.setRangeText(button.dataset.imageEmoji, input.selectionStart, input.selectionEnd, 'end');
    $('image-send-emoji-picker').hidden = true; $('image-send-emoji').setAttribute('aria-expanded', 'false'); input.focus();
  }; });
  $('image-send-caption').focus();
}

async function prepareImageSendFile(draft, original) {
  // 原图始终上传原始字节；动画 GIF 同样保留，不截取第一帧。
  if (original || draft.file.type === 'image/gif' || /\.gif$/i.test(draft.file.name)) return { file: draft.file, width: draft.width, height: draft.height };
  const ratio = Math.min(1, 1600 / Math.max(draft.width, draft.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(draft.width * ratio)); canvas.height = Math.max(1, Math.round(draft.height * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境无法处理图片，请选择原图发送。');
  context.drawImage(draft.image, 0, 0, canvas.width, canvas.height);
  const mime = draft.file.type === 'image/jpeg' || /\.jpe?g$/i.test(draft.file.name) ? 'image/jpeg' : draft.file.type === 'image/webp' || /\.webp$/i.test(draft.file.name) ? 'image/webp' : 'image/png';
  const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, .85));
  if (!blob) throw new Error('图片处理失败，请选择原图发送。');
  return { file: new File([blob], draft.file.name, { type: mime }), width: canvas.width, height: canvas.height };
}

async function submitImageSend(draft) {
  if (state.imageDraft !== draft || !draft.ready || draft.sending) return;
  if (!sameSendAccount(draft.context)) { closeImageSendPreview(); return; }
  if (Number(state.active?.id) !== draft.conversationId) { closeImageSendPreview(); return; }
  draft.sending = true;
  const feedback = $('image-send-feedback'), submit = $('image-send-submit');
  const inputs = [...draft.modal.querySelectorAll('input,textarea,button')];
  inputs.forEach(input => { input.disabled = true; });
  $('image-send-emoji-picker').hidden = true;
  try {
    assertSendAccount(draft.context);
    if (!draft.pendingPayload) {
      const original = draft.modal.querySelector('[name="image-send-mode"]:checked').value === 'original';
      const text = $('image-send-caption').value.trim();
      if (draft.uploaded?.original !== original) draft.uploaded = null;
      if (!draft.uploaded) {
        feedback.textContent = original ? '正在上传原图…' : '正在处理图片…';
        const prepared = await prepareImageSendFile(draft, original);
        if (state.imageDraft !== draft || !sameSendAccount(draft.context) || Number(state.active?.id) !== draft.conversationId) return;
        assertSendAccount(draft.context);
        feedback.textContent = '正在上传图片…';
        draft.uploaded = { ...(await uploadMedia('image', prepared.file, draft.context.token)), width: prepared.width, height: prepared.height, original };
      }
      if (state.imageDraft !== draft || !sameSendAccount(draft.context) || Number(state.active?.id) !== draft.conversationId) return;
      draft.pendingPayload = { conversation_id: draft.conversationId, type: 'image', body: messageBodyWithReply({ url: mediaUrl(draft.uploaded.url), mime: draft.uploaded.mime, size: draft.uploaded.size, name: draft.file.name, width: draft.uploaded.width, height: draft.uploaded.height, text, original }, draft.context), request_id: draft.requestId };
    }
    feedback.textContent = '正在发送…'; submit.textContent = '发送中…';
    const message = await api('/messages', { method: 'POST', authToken: draft.context.token, body: JSON.stringify(draft.pendingPayload) });
    completeReplySend(draft.context);
    if (sameSendAccount(draft.context) && Number(state.active?.id) === draft.conversationId) appendMessage(message);
    if (state.imageDraft === draft) closeFeatureModal();
    loadConversations().catch(() => {});
  } catch (error) {
    if (state.imageDraft === draft) feedback.textContent = error.message || '图片发送失败，请重试';
  } finally {
    draft.sending = false;
    if (state.imageDraft === draft) {
      inputs.forEach(input => { input.disabled = Boolean(draft.pendingPayload) && (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA' || input.id === 'image-send-emoji'); });
      submit.textContent = '发送';
    }
  }
}

async function toggleRecording() {
  return toggleComposerRecording();
}

async function searchMessages(keyword) { if (!keyword.trim()) return loadConversations(); const result = await api(`/messages/search?q=${encodeURIComponent(keyword)}${state.active ? `&conversation_id=${state.active.id}` : ''}`); $('messages').innerHTML = result.items.map(messageHtml).join('') || '<p class="empty">没有找到相关消息</p>'; bindMessageActions(); }

function closeFeatureModal() { document.querySelector('[data-message-forward]')?.disposeForwardPicker?.(); groupCreator.close(false); contactActionRevision++; disposeContactProfile(); closeChatSearchFilter(); disposeComposerModal(); disposeGroupForm(); if (state.imageDraft) { URL.revokeObjectURL(state.imageDraft.previewUrl); state.imageDraft = null; } state.groupInfoDialog = null; document.querySelector('[data-feature-modal]')?.remove(); }
function bindFeatureModal() { const modal = document.querySelector('[data-feature-modal]'); if (modal) { modal.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', closeFeatureModal)); modal.addEventListener('click', (event) => { if (event.target === modal) closeFeatureModal(); }); } }
function contactRow(contact, action = 'chat') { const userId = Number(contact.user_id || contact.id); const button = action === 'chat' ? `<button type="button" data-contact-chat="${userId}">发消息</button>` : `<button type="button" data-add-contact="${userId}">加好友</button>`; return `<div class="contact-row"><span class="contact-avatar">${escapeHtml((contact.nickname || '?').slice(0, 1))}</span><span class="contact-info"><strong>${escapeHtml(contact.nickname || '未命名用户')}</strong><small>${escapeHtml(contact.phone || contact.message || '')}</small></span>${button}</div>`; }

function contactLastSeenText(item) {
  if (item.last_seen_hidden) return '最后上线时间已隐藏';
  if (item.online) return '当前在线';
  const date = String(item.last_seen_at || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return date ? `最后上线于 ${date[3]}.${date[2]}.${date[1].slice(-2)} ${date[4]}:${date[5]}` : '最后上线时间暂无记录';
}

function contactDialogRowHtml(item) {
  return `<button type="button" class="contact-modal-row" data-contact-chat="${Number(item.user_id || item.id)}" data-contact-keyword="${escapeHtml(`${item.nickname || ''} ${item.remark || ''} ${item.username || ''} ${publicUserId(item)}`.toLowerCase())}"><span class="contact-modal-avatar">${item.avatar_url ? `<img src="${escapeHtml(mediaUrl(item.avatar_url))}" alt="" data-contact-avatar-fallback="${escapeHtml((item.nickname || '?').slice(0, 1))}">` : escapeHtml((item.nickname || '?').slice(0, 1))}</span><span class="contact-modal-copy"><strong>${escapeHtml(contactDisplayName(item.user_id || item.id, item.remark || item.nickname || '未命名用户'))}</strong><small>${escapeHtml(contactLastSeenText(item))}</small>${publicUserId(item) ? `<small class="contact-public-id">ID：${escapeHtml(publicUserId(item))}</small>` : ''}</span></button>`;
}

function bindContactDialogRows(modal) {
  modal.querySelectorAll('[data-contact-chat]').forEach(button => { button.onclick = () => openContactChat(Number(button.dataset.contactChat)); });
  modal.querySelectorAll('[data-contact-avatar-fallback]').forEach(img => {
    img.addEventListener('error', () => { img.parentElement.textContent = img.dataset.contactAvatarFallback || '?'; }, { once: true });
  });
}

async function openContacts() {
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal contact-modal-backdrop" data-feature-modal><section class="feature-card desktop-contact-modal" role="dialog" aria-modal="true" aria-labelledby="contact-modal-title"><header><h2 id="contact-modal-title">联系人</h2></header><form id="contact-search-form" class="contact-modal-search"><input id="contact-search-input" placeholder="输入完整用户名" aria-label="输入完整用户名" autocomplete="off" spellcheck="false"><button class="contact-search-submit" type="submit" aria-label="搜索用户" tabindex="-1">搜索</button></form><div class="contact-modal-list"><div id="contact-search-results" class="contact-modal-results" aria-live="polite"></div><button type="button" class="contact-modal-row new-friend-row" data-open-contact-center><span class="contact-modal-avatar new-friend-avatar">${navIcon('bell')}</span><span class="contact-modal-copy"><strong>新的朋友</strong></span><span class="contact-pending-badge" hidden></span></button><div class="contact-modal-rows"><p class="modal-empty">正在加载联系人…</p></div><button id="contact-load-more" class="contact-modal-load-more" type="button" hidden>加载更多联系人</button><p class="contact-modal-count" aria-live="polite"></p></div><button type="button" class="contact-modal-close" data-close-modal>关闭</button></section></div>`);
  bindFeatureModal();
  const modal = document.querySelector('.contact-modal-backdrop');
  const list = modal.querySelector('.contact-modal-rows');
  const count = modal.querySelector('.contact-modal-count');
  const input = modal.querySelector('#contact-search-input');
  const more = modal.querySelector('#contact-load-more');
  let items = []; let page = 1; let total = 0;
  const filter = () => {
    const keyword = input.value.trim().toLowerCase();
    list.querySelectorAll('[data-contact-keyword]').forEach(row => { row.hidden = Boolean(keyword) && !row.dataset.contactKeyword.includes(keyword); });
    if (!keyword) modal.querySelector('#contact-search-results').replaceChildren();
  };
  const render = () => {
    list.innerHTML = items.map(contactDialogRowHtml).join('') || '<p class="modal-empty">暂无联系人</p>';
    count.textContent = `共${total}个联系人`;
    more.hidden = items.length >= total;
    bindContactDialogRows(modal); filter();
  };
  modal.querySelector('#contact-search-form').onsubmit = searchContacts;
  input.oninput = filter;
  modal.querySelector('[data-open-contact-center]').onclick = () => openNewFriendsModal();
  more.onclick = async () => {
    more.disabled = true;
    try {
      const contacts = await api(`/contacts?size=100&page=${page + 1}`);
      if (!modal.isConnected) return;
      page += 1; items.push(...(contacts.items || [])); total = Number(contacts.total ?? items.length);
      render();
      if (!contacts.items?.length) more.hidden = true;
    } catch (error) { if (modal.isConnected) count.textContent = error.message; }
    finally { more.disabled = false; }
  };
  try {
    const [contacts, requests] = await Promise.all([api('/contacts?size=100'), api('/contact-requests?direction=received&size=50')]);
    if (!modal.isConnected) return;
    items = contacts.items || []; total = Number(contacts.total ?? items.length);
    const pending = (requests.items || []).filter(item => item.status === 'pending');
    const badge = modal.querySelector('.contact-pending-badge');
    badge.textContent = pending.length; badge.hidden = pending.length === 0;
    modal.querySelector('[data-open-contact-center]').setAttribute('aria-label', pending.length ? `新的朋友，${pending.length} 条待处理申请` : '新的朋友');
    render();
  } catch (error) {
    if (!modal.isConnected) return;
    list.innerHTML = '<p class="modal-empty" role="alert"></p><button type="button" class="contact-modal-load-more" data-contact-retry>重新加载</button>';
    list.querySelector('p').textContent = error.message;
    list.querySelector('[data-contact-retry]').onclick = openContacts;
  }
}

// Account discovery is exact even while a server upgrade is pending.
function exactUsernameUsers(items, keyword) {
  const username = String(keyword || '').trim().toLowerCase();
  const matches = (Array.isArray(items) ? items : []).filter(item => username && typeof item?.username === 'string' && item.username.toLowerCase() === username);
  return matches.length === 1 ? matches : [];
}

async function searchContacts(event) {
  event?.preventDefault();
  const modal = document.querySelector('.contact-modal-backdrop');
  const input = modal?.querySelector('#contact-search-input');
  const results = modal?.querySelector('#contact-search-results');
  const keyword = input?.value.trim();
  if (!modal || !keyword) return;
  results.textContent = '正在搜索…';
  try {
    const result = await api(`/contacts/search?q=${encodeURIComponent(keyword)}&size=20`);
    if (!modal.isConnected || input.value.trim() !== keyword) return;
    const users = exactUsernameUsers(result.items, keyword).filter((item) => Number(item.id) !== Number(state.user.id));
    const contacts = new Set([...modal.querySelectorAll('.contact-modal-rows [data-contact-chat]')].map(row => Number(row.dataset.contactChat)));
    results.innerHTML = users.map(item => contacts.has(Number(item.id)) ? contactDialogRowHtml({ ...item, user_id: item.id }) : `<div class="contact-modal-row contact-search-user"><span class="contact-modal-avatar">${escapeHtml((item.nickname || '?').slice(0, 1))}</span><span class="contact-modal-copy"><strong>${escapeHtml(item.nickname || '未命名用户')}</strong>${publicUserId(item) ? `<small class="contact-public-id">ID：${escapeHtml(publicUserId(item))}</small>` : ''}</span><button class="contact-search-add" type="button" data-add-contact="${Number(item.id)}">加好友</button></div>`).join('') || '<p class="modal-empty">用户不存在</p>';
    bindContactDialogRows(modal);
    results.querySelectorAll('[data-add-contact]').forEach(button => { button.onclick = () => sendFriendRequest(Number(button.dataset.addContact), button); });
  } catch (error) { if (modal.isConnected && input.value.trim() === keyword) results.textContent = error.message; }
}

function contactRequestErrorText(error) {
  const message = String(error?.message || '').trim();
  const known = {
    'User is already a contact.': '你们已经是好友了。',
    'This user does not accept friend requests.': '对方不接受好友申请。',
    'Contact request is blocked.': '好友申请已被屏蔽，暂时无法发送。',
    'User not found.': '用户不存在或已注销。',
  };
  return known[message] || message || '好友申请发送失败，请稍后重试。';
}

function setContactRequestFeedback(button, message, kind = 'success') {
  if (!button) return;
  const row = button.closest('.contact-search-user, .search-result-card, .contact-row');
  if (!row) return;
  let feedback = row.querySelector('.contact-request-feedback');
  if (!feedback) {
    feedback = document.createElement('small');
    feedback.className = 'contact-request-feedback';
    feedback.setAttribute('role', 'status');
    row.appendChild(feedback);
  }
  feedback.classList.toggle('is-error', kind === 'error');
  feedback.textContent = message;
}

async function sendFriendRequest(userId, button = null) {
  const account = { token: state.token, userId: Number(state.user?.id) };
  if (button?.dataset.requestState === 'sending' || button?.dataset.requestState === 'sent') return;
  if (button) { button.dataset.requestState = 'sending'; button.disabled = true; button.textContent = '发送中…'; }
  try {
    const result = await api('/contact-requests', { method: 'POST', body: JSON.stringify({ to_user_id: userId, message: '你好，想和你成为好友' }) });
    if (result.status === 'accepted') { await friendChats.offer(result.friend_chat, { token: account.token, userId: account.userId }); friendChats.changed(); return; }
    const alreadyPending = result.status === 'pending' && result.created === false;
    const notice = result.status === 'accepted' ? '好友申请已自动通过，你们已经成为好友。' : alreadyPending ? '好友申请已经发送过了，正在等待对方验证。' : '好友申请已发送，等待对方验证。';
    if (button) { button.dataset.requestState = 'sent'; button.disabled = true; button.textContent = '已发送'; }
    setContactRequestFeedback(button, notice);
  } catch (error) {
    if (button) { button.dataset.requestState = 'error'; button.disabled = false; button.textContent = '加好友'; }
    setContactRequestFeedback(button, `发送失败：${contactRequestErrorText(error)}`, 'error');
  }
}
async function handleContactRequest(requestId, action) {
  const account = { token: state.token, userId: Number(state.user?.id) };
  try {
    const result = await api('/contact-requests/handle', { method: 'POST', authToken: account.token, body: JSON.stringify({ request_id: requestId, action }) });
    if (!sameSendAccount(account)) return;
    refreshFriendRequestBadge();
    if (result.status === 'accepted') {
      await friendChats.offer(result.friend_chat, account); friendChats.changed();
      void loadConversations().catch(() => {}); return;
    }
    if (PC_LAYOUT && state.page === 'center') await renderMessageCenter(); else await openContacts();
  } catch (error) { if (sameSendAccount(account)) alert(error.message); }
}
async function openContactChat(userId, profileDraft = null) {
  userId = Number(userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  const account = profileDraft?.account || { token: state.token, userId: Number(state.user?.id) };
  const source = { modal: document.querySelector('[data-feature-modal]'), historyEpoch: state.historyEpoch, page: state.page,
    sidebarMode: state.sidebarMode, activeId: Number(state.active?.id) || 0, contactRevision: contactActionRevision, navigationRevision: messageForwardNavigationRevision };
  const current = () => contactActionsAllowed(account) && (profileDraft ? currentContactProfile(profileDraft)
    : state.historyEpoch === source.historyEpoch && state.page === source.page && state.sidebarMode === source.sidebarMode
      && (Number(state.active?.id) || 0) === source.activeId && contactActionRevision === source.contactRevision
      && messageForwardNavigationRevision === source.navigationRevision && document.querySelector('[data-feature-modal]') === source.modal
      && (!source.modal || source.modal.isConnected));
  if (!current() || profileDraft?.busy) return;
  if (profileDraft) setContactProfileBusy(profileDraft, true);
  try {
    const conversation = await api('/conversations/direct', { authToken: account.token, method: 'POST', body: JSON.stringify({ user_id: userId }) });
    if (!current()) return;
    if (!Number.isSafeInteger(Number(conversation?.id)) || Number(conversation.id) <= 0 || Number(conversation.peer_user_id) !== userId || conversation.type !== 'direct') throw new Error('会话资料无效，请重试。');
    const index = state.conversations.findIndex(item => Number(item.id) === Number(conversation.id));
    if (index < 0) state.conversations.unshift(conversation);
    else state.conversations[index] = { ...state.conversations[index], ...conversation };
    if (profileDraft) closeContactProfile(); else closeFeatureModal();
    if (PC_LAYOUT) {
      const transition = switchPage('messages');
      const revision = messageForwardNavigationRevision;
      await transition;
      if (!contactActionsAllowed(account) || messageForwardNavigationRevision !== revision || state.page !== 'messages') return;
    }
    if (contactActionsAllowed(account)) await openConversation(Number(conversation.id));
  } catch (error) {
    if (!current()) return;
    if (profileDraft) profileDraft.modal.querySelector('#profile-feedback').textContent = error.message || '打开聊天失败，请重试。';
    else alert(error.message);
  } finally { if (profileDraft && currentContactProfile(profileDraft)) setContactProfileBusy(profileDraft, false); }
}

function disposeContactProfile(modal = document.querySelector('[data-contact-profile]')) {
  const draft = modal?.contactProfileDraft;
  if (!draft) return;
  draft.disposed = true;
  draft.revision += 1;
  draft.controller?.abort();
}

function closeContactProfile() {
  const modal = document.querySelector('[data-contact-profile]');
  disposeContactProfile(modal);
  modal?.remove();
}

function currentContactProfile(draft) {
  return Boolean(draft && !draft.disposed && draft.modal.isConnected && document.querySelector('[data-feature-modal]') === draft.modal
    && contactActionsAllowed(draft.account) && contactActionRevision === draft.contactRevision
    && messageForwardNavigationRevision === draft.navigationRevision && state.historyEpoch === draft.historyEpoch
    && state.page === draft.page && state.sidebarMode === draft.sidebarMode && (Number(state.active?.id) || 0) === draft.activeId);
}

function setContactProfileBusy(draft, busy) {
  draft.busy = busy;
  draft.modal.querySelectorAll('.profile-actions button,.profile-danger-actions button,#profile-remark').forEach(node => {
    node.disabled = busy || (!draft.isContact && ['profile-remark', 'profile-remove-contact'].includes(node.id)) || (node.id === 'profile-send-message' && draft.requestSent)
      || (node.id === 'profile-remark' && draft.remarkSaving);
  });
}

async function openContactProfile(userId, groupContextConversationId = null) {
  userId = Number(userId);
  if (groupContextConversationId !== null && (!Number.isSafeInteger(groupContextConversationId) || groupContextConversationId <= 0)) return;
  if (!contactActionsAllowed({ token: state.token, userId: Number(state.user?.id) }) || !Number.isSafeInteger(userId) || userId <= 0 || userId === Number(state.user.id)) return;
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal data-contact-profile><section class="profile-card" role="dialog" aria-modal="true" aria-label="个人资料"><header class="profile-banner"><button class="profile-close" type="button" data-close-modal aria-label="关闭个人资料">×</button></header><div class="profile-body" data-profile-content aria-live="polite"><p role="status">正在加载个人资料…</p></div></section></div>`);
  const modal = document.querySelector('[data-contact-profile]');
  const draft = { modal, userId, groupContextConversationId, account: { token: state.token, userId: Number(state.user.id) }, historyEpoch: state.historyEpoch,
    page: state.page, sidebarMode: state.sidebarMode, activeId: Number(state.active?.id) || 0, contactRevision: contactActionRevision,
    navigationRevision: messageForwardNavigationRevision, revision: 0, disposed: false, busy: false, controller: null };
  modal.contactProfileDraft = draft;
  bindFeatureModal();
  modal.querySelector('[data-close-modal]').focus();
  async function load() {
    if (!currentContactProfile(draft)) return;
    draft.controller?.abort();
    const revision = ++draft.revision;
    const controller = draft.controller = new AbortController();
    const content = modal.querySelector('[data-profile-content]');
    content.innerHTML = '<p role="status">正在加载个人资料…</p>';
    try {
      const profile = await api(`/contacts/profile?user_id=${userId}${groupContextConversationId === null ? '' : '&context_conversation_id=' + groupContextConversationId}`, { authToken: draft.account.token, signal: controller.signal });
      if (!currentContactProfile(draft) || draft.revision !== revision) return;
      if (Number(profile?.user_id) !== userId) throw new Error('个人资料不匹配，请重试。');
      // Cache only this fresh, server-authorized DTO. Older staff-only fields must not survive a permission change.
      state.contactCache[userId] = profile;
      draft.isContact = Boolean(profile.is_contact);
      const avatar = profile.avatar_url ? `<img src="${escapeHtml(mediaUrl(profile.avatar_url))}" alt="${escapeHtml(profile.nickname)}">` : escapeHtml((profile.nickname || '?').slice(0, 1));
      const statusMap = { active: '正常', frozen: '已冻结', deleted: '已注销' };
      const onlineText = profile.online ? '在线' : '离线';
      content.innerHTML = `<div class="profile-avatar">${avatar}</div><h2>${escapeHtml(profile.nickname || '未命名用户')}</h2><p class="profile-status ${profile.online ? 'online-label' : 'offline-label'}">${onlineText}</p><dl class="profile-details"><div><dt>备注名</dt><dd><input id="profile-remark" value="${escapeHtml(profile.remark || '')}" placeholder="设置备注名" aria-label="备注名" maxlength="64" ${profile.is_contact ? '' : 'disabled'}></dd></div><div><dt>账号</dt><dd>${escapeHtml(profile.username || profile.phone || '未公开')}</dd></div><div><dt>用户 ID</dt><dd>${escapeHtml(publicUserId(profile) || '暂不可用')}</dd></div><div><dt>添加时间</dt><dd>${escapeHtml(profile.added_at || profile.created_at || '—')}</dd></div><div><dt>最近登录</dt><dd>${escapeHtml(profile.last_login_at || '未公开')}</dd></div><div><dt>登录设备</dt><dd>${profile.last_login_device ? escapeHtml(deviceName(profile.last_login_device)) : '未公开'}</dd></div><div><dt>在线状态</dt><dd class="${profile.online ? 'online-label' : 'offline-label'}">${onlineText}</dd></div><div><dt>账号状态</dt><dd>${escapeHtml(statusMap[profile.status] || '未知')}</dd></div><div><dt>IP 地址</dt><dd>${escapeHtml(profile.last_login_ip || '未公开')}</dd></div><div><dt>IP 归属地</dt><dd>${escapeHtml(profile.ip_location || '未公开')}</dd></div></dl><p id="profile-feedback" class="form-feedback" role="status"></p><div class="profile-actions"><button id="profile-send-message" class="primary" type="button">发送消息</button></div><div class="profile-danger-actions"><button id="profile-remove-contact" type="button" ${profile.is_contact ? '' : 'disabled'}>删除好友</button><button id="profile-block-contact" type="button">拉黑好友</button></div>`;
      const feedback = content.querySelector('#profile-feedback');
      async function action(operation, onSuccess) {
        if (!currentContactProfile(draft) || draft.busy) return;
        setContactProfileBusy(draft, true); feedback.textContent = '';
        try {
          const result = await operation();
          if (currentContactProfile(draft)) await onSuccess(result);
        } catch (error) { if (currentContactProfile(draft)) feedback.textContent = error.message || '操作失败，请重试。'; }
        finally {
          if (currentContactProfile(draft)) {
            setContactProfileBusy(draft, false);
            content.querySelector('#profile-remove-contact').disabled = !draft.isContact;
          }
        }
      }
      const remarkInput = content.querySelector('#profile-remark');
      let savedRemark = profile.remark || '';
      remarkInput.onblur = async () => {
        const remark = remarkInput.value.trim();
        if (!currentContactProfile(draft) || draft.busy || draft.remarkSaving || !draft.isContact || remark === savedRemark) return;
        draft.remarkSaving = true;
        remarkInput.disabled = true;
        feedback.textContent = '正在保存备注…';
        try {
          const result = await api('/contacts/remark', { authToken: draft.account.token, method: 'POST',
            body: JSON.stringify({ user_id: userId, remark }), signal: AbortSignal.timeout(15000) });
          if (!currentContactProfile(draft)) return;
          savedRemark = typeof result?.remark === 'string' ? result.remark : remark;
          if (state.contactCache[userId] === profile) profile.remark = savedRemark;
          contactNames.remember(userId, savedRemark);
          remarkInput.value = savedRemark;
          if (feedback.textContent === '正在保存备注…') feedback.textContent = '备注已保存';
        } catch (error) {
          if (currentContactProfile(draft) && feedback.textContent === '正在保存备注…') {
            feedback.textContent = `备注保存失败：${error.message || '请重新点击备注后重试。'}`;
          }
        } finally {
          draft.remarkSaving = false;
          if (currentContactProfile(draft)) remarkInput.disabled = draft.busy || !draft.isContact;
        }
      };
      remarkInput.onkeydown = event => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); remarkInput.blur(); }
      };
      remarkInput.oninput = () => { feedback.textContent = ''; };
      const sendButton = content.querySelector('#profile-send-message');
      sendButton.textContent = groupContextConversationId === null || profile.is_contact ? '发送消息' : draft.requestSent ? '好友申请已发送' : '添加好友';
      sendButton.disabled = Boolean(!profile.is_contact && draft.requestSent);
      sendButton.onclick = () => {
        if (!currentContactProfile(draft) || draft.busy || draft.requestSent) return;
        if (groupContextConversationId === null || profile.is_contact) return openContactChat(userId, draft);
        return action(async () => {
          const fresh = await api(`/contacts/profile?user_id=${userId}${groupContextConversationId === null ? '' : '&context_conversation_id=' + groupContextConversationId}`, { authToken: draft.account.token });
          if (!currentContactProfile(draft)) throw Error('资料页面已关闭');
          if (fresh.is_contact) return { status: 'accepted' };
          return api('/contact-requests', { authToken: draft.account.token, method: 'POST', body: JSON.stringify({ to_user_id: userId,
            ...(groupContextConversationId === null ? {} : { context_conversation_id: groupContextConversationId }) }) });
        }, async result => {
          if (result.status === 'accepted') { draft.requestSent = false; await load(); return; }
          draft.requestSent = true; sendButton.textContent = '好友申请已发送'; sendButton.disabled = true; feedback.textContent = '好友申请已发送，等待对方通过。';
        });
      };
      content.querySelector('#profile-remove-contact').onclick = () => {
        if (!window.confirm(`确定删除好友“${profile.nickname || '该联系人'}”吗？`)) return;
        return action(() => api('/contacts/remove', { authToken: draft.account.token, method: 'POST', body: JSON.stringify({ user_id: userId }) }), async () => {
          delete state.contactCache[userId]; closeContactProfile();
          try { await loadConversations(); } catch { /* The removal is already committed. */ }
        });
      };
      content.querySelector('#profile-block-contact').onclick = () => {
        if (!window.confirm(`确定拉黑“${profile.nickname || '该联系人'}”吗？拉黑后将不能继续发起好友申请。`)) return;
        return action(() => api('/blocks', { authToken: draft.account.token, method: 'POST', body: JSON.stringify({ user_id: userId, reason: '资料卡拉黑' }) }), () => { closeContactProfile(); });
      };
    } catch (error) {
      if (!currentContactProfile(draft) || draft.revision !== revision) return;
      content.innerHTML = '<p data-profile-error role="alert"></p><button class="secondary-button" type="button" data-profile-retry>重新加载</button>';
      content.querySelector('[data-profile-error]').textContent = error.message || '个人资料加载失败，请重试。';
      content.querySelector('[data-profile-retry]').onclick = load;
    }
  }
  await load();
}


function disposeGroupForm() {
  const draft = document.querySelector('[data-feature-modal]')?.groupFormDraft;
  if (!draft) return;
  draft.disposed = true;
  draft.revision += 1;
  draft.controller?.abort();
  draft.urls.forEach(url => URL.revokeObjectURL(url));
  draft.urls.clear();
  draft.file = null;
}

function bindGroupFormAvatar(modal, draft, title) {
  const input = modal.querySelector('#group-action-avatar-file');
  const button = modal.querySelector('#group-action-avatar');
  const feedback = modal.querySelector('#group-action-feedback');
  const submit = modal.querySelector('[type="submit"]');
  const current = revision => !draft.disposed && modal.isConnected && draft.revision === revision;
  const revoke = url => { if (draft.urls.delete(url)) URL.revokeObjectURL(url); };
  button.onclick = () => { if (!draft.busy) input.click(); };
  input.onchange = async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file || draft.busy || draft.disposed) return;
    const revision = ++draft.revision;
    let previewUrl;
    draft.pending = true; submit.disabled = true; feedback.textContent = '';
    try {
      if (!/\.(jpe?g|png|gif|webp)$/i.test(file.name) || (file.type && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type))) throw new Error('请选择 JPG、PNG、GIF 或 WebP 图片。');
      if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('头像图片不能为空，且不能超过 10 MB。');
      previewUrl = URL.createObjectURL(file); draft.urls.add(previewUrl);
      await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => image.naturalWidth && image.naturalHeight ? resolve() : reject(new Error('图片内容无效，请重新选择。'));
        image.onerror = () => reject(new Error('图片无法读取，请选择有效的图片。'));
        image.src = previewUrl;
      });
      if (!current(revision)) { revoke(previewUrl); return; }
      revoke(draft.previewUrl);
      draft.file = file; draft.previewUrl = previewUrl; draft.uploadedUrl = null;
      const image = document.createElement('img'); image.src = previewUrl; image.alt = `${title}头像预览`;
      button.replaceChildren(image);
      button.title = `更换${title}头像`;
      button.setAttribute('aria-label', `更换${title}头像`);
    } catch (error) {
      revoke(previewUrl);
      if (current(revision)) feedback.textContent = error.message;
    } finally {
      if (current(revision)) { draft.pending = false; submit.disabled = draft.busy; }
    }
  };
}

function openGroupForm(mode) {
  closeFeatureModal();
  if (mode === 'create') return groupCreator.open();
  const channel = mode === 'channel';
  const account = { token: state.token, userId: Number(state.user?.id) };
  if (!contactActionsAllowed(account)) return;
  const avatarButton = `<button id="group-action-avatar" class="classic-camera-button" type="button" title="上传频道头像" aria-label="上传频道头像">${navIcon('camera')}</button><input id="group-action-avatar-file" type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden>`;
  const dialog = channel
    ? `<section class="feature-card classic-channel-dialog" role="dialog" aria-modal="true" aria-label="创建频道"><form id="group-action-form"><div class="classic-channel-main">${avatarButton}<div class="classic-channel-fields"><label>频道名称<input id="group-action-value" maxlength="128" required autofocus></label><label class="classic-description-field"><input id="channel-description" maxlength="500" placeholder="简介（可选）"></label></div></div><p id="group-action-feedback" class="form-feedback" aria-live="polite"></p><footer><button type="button" data-close-modal>取消</button><button class="classic-dialog-primary" type="submit">创建</button></footer></form></section>`
    : `<section class="feature-card compact-form-card" role="dialog" aria-modal="true" aria-label="加入群聊"><header><div><h2>加入群聊</h2><p>输入群号或群聊编号加入已有群聊。</p></div><button class="icon-button" type="button" data-close-modal aria-label="关闭加入群聊">×</button></header><form id="group-action-form" class="inline-form"><label>群号或群聊编号<input id="group-action-value" maxlength="64" required placeholder="请输入群号，例如 G123ABC456"></label><p id="group-action-feedback" class="form-feedback" role="status"></p><button class="primary" type="submit">加入群聊</button></form></section>`;
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal>${dialog}</div>`);
  bindFeatureModal();
  const modal = document.querySelector('[data-feature-modal]');
  const form = modal.querySelector('#group-action-form');
  const feedback = modal.querySelector('#group-action-feedback');
  const draft = { file: null, previewUrl: null, uploadedUrl: null, urls: new Set(), revision: 0, pending: false, busy: false, disposed: false, controller: new AbortController() };
  modal.groupFormDraft = draft;
  const current = () => !draft.disposed && modal.isConnected && contactActionsAllowed(account);
  if (channel) bindGroupFormAvatar(modal, draft, '频道');
  const nameInput = modal.querySelector('#group-action-value');
  nameInput.spellcheck = false; nameInput.focus();
  form.onsubmit = async event => {
    event.preventDefault();
    const value = nameInput.value.trim();
    if (!value || draft.busy || draft.pending || !current()) return;
    const payload = channel ? { name: value, description: modal.querySelector('#channel-description').value.trim() }
      : /^\d+$/.test(value) ? { conversation_id: Number(value) } : { invite_code: value };
    if (payload.conversation_id !== undefined && (!Number.isSafeInteger(payload.conversation_id) || payload.conversation_id <= 0)) { feedback.textContent = '请输入有效的群号或群聊编号。'; return; }
    const controls = [...form.querySelectorAll('input, button:not([data-close-modal])')];
    const signal = AbortSignal.any([draft.controller.signal, AbortSignal.timeout(45000)]);
    draft.busy = true; controls.forEach(control => { control.disabled = true; }); feedback.textContent = '';
    try {
      if (draft.file) {
        if (!draft.uploadedUrl) {
          feedback.textContent = '头像上传中，请稍候…';
          const uploaded = await uploadMedia('image', draft.file, account.token, signal);
          if (!current()) return;
          if (!uploaded?.url) throw new Error('头像上传失败，请重试。');
          draft.uploadedUrl = uploaded.url;
        }
        payload.avatar_url = draft.uploadedUrl;
      }
      if (!current()) return;
      feedback.textContent = channel ? '正在创建，请稍候…' : '正在加入，请稍候…';
      await api(channel ? '/conversations/channels' : '/conversations/groups/join', { authToken: account.token, method: 'POST', body: JSON.stringify(payload), signal });
      if (!current()) return;
      closeFeatureModal();
      if (sameSendAccount(account)) {
        try { await loadConversations(); }
        catch { if (sameSendAccount(account)) composerFeedback(channel ? '频道已创建，列表刷新失败，请稍后重试。' : '已加入群聊，列表刷新失败，请稍后重试。'); }
      }
    } catch (error) { if (current()) feedback.textContent = error.message || '操作失败，请重试。'; }
    finally { draft.busy = false; if (current()) controls.forEach(control => { control.disabled = false; }); }
  };
}
async function createGroup() { openGroupForm('create'); }
async function joinGroup() { openGroupForm('join'); }
async function openGroupManager(manage = true) {
  if (state.active?.type !== 'group') return;
  const conversationId = Number(state.active.id);
  closeGroupManager();
  closeFeatureModal();
  const request = { token: state.token, userId: Number(state.user?.id), navigation: messageForwardNavigationRevision };
  state.groupManagerRequest = request;
  const current = () => state.groupManagerRequest === request && sameSendAccount(request)
    && request.navigation === messageForwardNavigationRevision && Number(state.active?.id) === conversationId;
  try {
    const [profile, members] = await Promise.all([
      api(`/conversations/groups/profile?conversation_id=${conversationId}`, { authToken: request.token }),
      api(`/conversations/members?conversation_id=${conversationId}`, { authToken: request.token })
    ]);
    if (!current() || document.querySelector('[data-feature-modal]')) return;
    Object.assign(state.active, profile);
    renderGroupManager(profile, members.items || [], [], manage !== false);
  } catch (error) { if (current()) alert(error.message); }
}
function closeGroupManager() { state.groupManagerRequest = null; document.querySelector('.group-modal')?.closest('.modal-backdrop')?.remove(); }
function renderGroupManager(profile, members, searchResults = [], manage = true) {
  const restricted = profile.members_visibility === 'managers' || (!['owner', 'admin'].includes(profile.my_role) && profile.allow_member_add_friend !== true);
  if (restricted && members.some(member => Number(member.user_id) === Number(state.user?.id) || !['owner', 'admin'].includes(member.role))) {
    closeGroupManager();
    alert('群成员权限已变化，请重新打开群资料。');
    return;
  }
  closeGroupManager();
  const memberIds = new Set(members.map((member) => Number(member.user_id)));
  const canManage = manage && Boolean(profile.can_manage);
  const isOwner = canManage && Boolean(profile.is_owner);
  const restrictedMembers = profile.members_visibility === 'managers'
    || (!profile.members_visibility && !['owner', 'admin'].includes(profile.my_role) && profile.allow_member_add_friend !== true);
  const memberPrivacy = restrictedMembers ? '<p class="modal-empty group-members-privacy" role="status">其他成员设置隐私，无法查看</p>' : '';
  const avatar = profile.avatar_url ? `<img src="${escapeHtml(mediaUrl(profile.avatar_url))}" alt="群头像">` : escapeHtml((profile.name || '群').slice(0, 1));
  const memberHtml = members.map((member) => {
    const isOwnerRow = member.role === 'owner';
    const canRemove = !isOwnerRow && (isOwner || member.role === 'member');
    const canMute = !isOwnerRow && (isOwner || member.role === 'member');
    const muteValue = member.muted_until ? '0' : '10';
    const roleAction = isOwner && !isOwnerRow ? `<button data-group-role="toggle" data-user="${member.user_id}">${member.role === 'admin' ? '取消管理员' : '设为管理员'}</button>` : '';
    const muteAction = canMute ? `<select data-mute-minutes="${member.user_id}" aria-label="选择禁言时长"><option value="10" ${muteValue === '10' ? 'selected' : ''}>10 分钟</option><option value="60">1 小时</option><option value="1440">1 天</option><option value="0" ${muteValue === '0' ? 'selected' : ''}>${member.muted_until ? '解除禁言' : '不禁言'}</option></select><button data-group-mute="${member.user_id}">${member.muted_until ? '更新禁言' : '禁言'}</button>` : '';
    const removeAction = canRemove ? `<button class="danger-button" data-group-remove="${member.user_id}">移出群组</button>` : '';
    const transferAction = isOwner && !isOwnerRow ? `<button data-group-transfer="${member.user_id}">转让群主</button>` : '';
    return `<div class="member-row"><button type="button" class="member-main" data-group-member-profile="${Number(member.user_id)}" style="border:0;background:transparent;padding:0;text-align:left"><span class="member-avatar">${member.avatar_url ? `<img src="${escapeHtml(mediaUrl(member.avatar_url))}" alt="">` : escapeHtml((member.nickname || '?').slice(0, 1))}</span><span><strong data-contact-name-user="${Number(member.user_id)}" data-contact-name-fallback="${escapeHtml(member.nickname || '未命名用户')}">${escapeHtml(contactDisplayName(member.user_id, member.nickname || '未命名用户'))}</strong><small>${roleName(member.role)}${member.muted_until ? ' · 已禁言至 ' + escapeHtml(member.muted_until) : ''}</small></span></button>${canManage && !isOwnerRow ? `<span class="member-actions">${roleAction}${muteAction}${removeAction}${transferAction}</span>` : ''}</div>`;
  }).join('') || '<p class="modal-empty">暂无群成员</p>';
  const resultHtml = searchResults.filter((user) => !memberIds.has(Number(user.id))).map((user) => `<div class="member-row"><span class="member-main"><span class="member-avatar">${user.avatar_url ? `<img src="${escapeHtml(mediaUrl(user.avatar_url))}" alt="">` : escapeHtml((user.nickname || '?').slice(0, 1))}</span><span><strong>${escapeHtml(user.nickname || '未命名用户')}</strong><small>${escapeHtml(user.phone || '联系人')}</small></span></span><button data-add-user="${user.id}">邀请入群</button></div>`).join('') || (searchResults.length ? '<p class="modal-empty">搜索结果中的用户都已在群内</p>' : '');
  const manageHtml = canManage ? `<form id="group-profile-form" class="group-profile-form"><div class="group-avatar-editor"><span class="group-avatar-preview">${avatar}</span><label>群头像<input id="group-avatar-file" type="file" accept="image/jpeg,image/png,image/gif,image/webp"></label></div><label>群名称<input id="group-name" maxlength="128" required value="${escapeHtml(profile.name || '')}"></label><label>群简介<textarea id="group-description" maxlength="500" rows="2" placeholder="介绍一下这个群">${escapeHtml(profile.description || '')}</textarea></label><label>群公告<textarea id="group-announcement" maxlength="10000" rows="3" placeholder="发布群公告">${escapeHtml(profile.announcement || '')}</textarea></label><p id="group-profile-feedback" class="form-feedback"></p><button class="primary" type="submit">保存群资料</button></form>` : `<div class="group-readonly"><p>${escapeHtml(profile.description || '暂无群简介')}</p><p class="group-announcement">${escapeHtml(profile.announcement || '暂无群公告')}</p></div>`;
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop"><section class="group-modal" role="dialog" aria-modal="true"><header><div class="group-title"><span class="group-avatar">${avatar}</span><div><h2>${escapeHtml(profile.name || '群组')}</h2><p>${profile.member_count} 名成员 · 群号 ${escapeHtml(profile.invite_code || '暂无')}</p></div></div><button id="close-group" class="icon-button" type="button" aria-label="关闭">×</button></header><section class="group-section">${manageHtml}</section><section class="group-section group-tools"><div><strong>群设置</strong><small>只对当前账号生效</small></div><label class="group-switch"><input id="group-notifications-muted" type="checkbox" ${profile.notifications_muted ? 'checked' : ''}>消息免打扰</label><label class="group-switch"><input id="group-is-pinned" type="checkbox" ${profile.is_pinned ? 'checked' : ''}>置顶会话</label>${canManage ? `<label class="group-switch"><input id="group-allow-member-add-friend" type="checkbox" ${!profile.allow_member_add_friend ? 'checked' : ''}>禁止群成员互加好友</label>` : ''}<button id="copy-group-code" class="secondary-button" type="button">复制群号</button></section>${canManage ? `<section class="group-section"><h3>邀请成员</h3><button id="group-invite-open" class="secondary-button" type="button">邀请新成员</button></section>` : ''}<section class="group-section"><div class="group-section-heading"><h3>群成员</h3><span>${profile.member_count} 人</span></div><div class="member-list">${memberHtml}</div>${memberPrivacy}</section>${isOwner ? '<footer class="group-footer"><button id="dissolve-group" class="danger-button" type="button">解散群组</button></footer>' : ''}</section></div>`);
  $('close-group').onclick = closeGroupManager;
  document.querySelector('.group-modal')?.closest('.modal-backdrop')?.addEventListener('click', (event) => { if (event.target.classList.contains('modal-backdrop')) closeGroupManager(); });
  $('copy-group-code').onclick = copyGroupInviteCode;
  $('group-notifications-muted').onchange = (event) => updateGroupSetting('notifications_muted', event.target.checked);
  $('group-is-pinned').onchange = (event) => updateGroupSetting('is_pinned', event.target.checked);
  $('group-allow-member-add-friend')?.addEventListener('change', updateGroupFriendPermission);
  const sourceGroup = Number(profile.id || state.active?.id);
  document.querySelectorAll('[data-group-member-profile]').forEach(button => { button.onclick = () => {
    const userId = Number(button.dataset.groupMemberProfile);
    if (Number(state.active?.id) !== sourceGroup || userId === Number(state.user?.id)) return;
    closeGroupManager(); return openContactProfile(userId, sourceGroup);
  }; });
  $('dissolve-group')?.addEventListener('click', dissolveGroup);
  $('group-profile-form')?.addEventListener('submit', updateGroupProfile);
  $('group-invite-open')?.addEventListener('click', openGroupInvite);
  $('group-user-search')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); searchGroupUsers(); } });
  document.querySelectorAll('[data-add-user]').forEach((button) => { button.onclick = () => addGroupMember(Number(button.dataset.addUser)); });
  document.querySelectorAll('[data-group-role]').forEach((button) => { button.onclick = () => updateGroupRole(Number(button.dataset.user), button.textContent === '取消管理员' ? 'member' : 'admin'); });
  document.querySelectorAll('[data-group-mute]').forEach((button) => { button.onclick = () => updateGroupMute(Number(button.dataset.groupMute), Number(document.querySelector(`[data-mute-minutes="${button.dataset.groupMute}"]`).value)); });
  document.querySelectorAll('[data-group-remove]').forEach((button) => { button.onclick = () => removeGroupMember(Number(button.dataset.groupRemove)); });
  document.querySelectorAll('[data-group-transfer]').forEach((button) => { button.onclick = () => transferGroupOwnership(Number(button.dataset.groupTransfer)); });
}
async function searchGroupUsers() {
  const keyword = $('group-user-search')?.value.trim();
  const modal = document.querySelector('.group-modal'), conversationId = Number(state.active?.id);
  if (!keyword || !modal || !conversationId) return;
  const account = { token: state.token, userId: Number(state.user?.id) };
  const current = () => sameSendAccount(account) && modal.isConnected
    && document.querySelector('.group-modal') === modal && Number(state.active?.id) === conversationId;
  try {
    const [result, members] = await Promise.all([
      api(`/contacts/search?q=${encodeURIComponent(keyword)}&size=30`, { authToken: account.token }),
      api(`/conversations/members?conversation_id=${conversationId}`, { authToken: account.token })
    ]);
    if (!current()) return;
    const profile = await api(`/conversations/groups/profile?conversation_id=${conversationId}`, { authToken: account.token });
    if (current()) renderGroupManager(profile, members.items || [], exactUsernameUsers(result.items, keyword));
  } catch (error) { if (current()) alert(error.message); }
}
async function addGroupMember(userId) {
  try { await api('/conversations/members', { method: 'POST', body: JSON.stringify({ conversation_id: state.active.id, user_id: userId }) }); await openGroupManager(); } catch (error) { alert(error.message); }
}
async function updateGroupRole(userId, role) {
  try { await api('/conversations/members/role', { method: 'POST', body: JSON.stringify({ conversation_id: state.active.id, user_id: userId, role }) }); await openGroupManager(); } catch (error) { alert(error.message); }
}
async function updateGroupMute(userId, minutes) {
  try { await api('/conversations/members/mute', { method: 'POST', body: JSON.stringify({ conversation_id: state.active.id, user_id: userId, minutes }) }); await openGroupManager(); } catch (error) { alert(error.message); }
}
async function removeGroupMember(userId) {
  if (!window.confirm('确定要将这名成员移出群组吗？')) return;
  try { await api('/conversations/members/remove', { method: 'POST', body: JSON.stringify({ conversation_id: state.active.id, user_id: userId }) }); await openGroupManager(); } catch (error) { alert(error.message); }
}
async function updateGroupProfile(event) {
  event.preventDefault();
  const feedback = $('group-profile-feedback');
  try {
    let avatarUrl = undefined;
    const file = $('group-avatar-file')?.files?.[0];
    if (file) { feedback.textContent = '头像上传中，请稍候…'; avatarUrl = (await uploadMedia('image', file)).url; }
    const payload = { conversation_id: state.active.id, name: $('group-name').value.trim(), description: $('group-description').value.trim(), announcement: $('group-announcement').value.trim() };
    if ($('group-allow-member-add-friend')) payload.allow_member_add_friend = !$('group-allow-member-add-friend').checked;
    if (avatarUrl !== undefined) payload.avatar_url = avatarUrl;
    await api('/conversations/groups/profile', { method: 'POST', body: JSON.stringify(payload) });
    await loadConversations();
    await openGroupManager();
  } catch (error) { feedback.textContent = error.message; }
}
async function updateGroupFriendPermission() {
  try {
    await api('/conversations/groups/profile', { method: 'POST', body: JSON.stringify({ conversation_id: state.active.id, allow_member_add_friend: !$('group-allow-member-add-friend').checked }) });
    await openGroupManager();
  } catch (error) { alert(error.message); }
}
async function transferGroupOwnership(userId) {
  if (!window.confirm('确定要把群主转让给这名成员吗？转让后你将成为普通成员。')) return;
  try { await api('/conversations/groups/transfer', { method: 'POST', body: JSON.stringify({ conversation_id: state.active.id, user_id: userId }) }); await loadConversations(); await openGroupManager(); } catch (error) { alert(error.message); }
}
async function dissolveGroup() {
  if (!window.confirm('解散后群成员和聊天记录都会被删除，确定继续吗？')) return;
  try { await api('/conversations/groups/dissolve', { method: 'POST', body: JSON.stringify({ conversation_id: state.active.id }) }); closeGroupManager(); closeChatPanels(); state.active = null; $('group-manage').hidden = true; $('messages').innerHTML = '<p class="empty">请选择一个会话开始聊天</p>'; await loadConversations(); } catch (error) { alert(error.message); }
}
async function updateGroupSetting(key, value) {
  try { await api('/conversations/groups/settings', { method: 'POST', body: JSON.stringify({ conversation_id: state.active.id, [key]: value }) }); await loadConversations(); } catch (error) { alert(error.message); await openGroupManager(); }
}
async function copyGroupInviteCode() {
  const code = document.querySelector('.group-title p')?.textContent.match(/群号\s+(.+)$/)?.[1];
  if (!code || code === '暂无') return;
  try { await navigator.clipboard.writeText(code); alert('群号已复制'); } catch { window.prompt('请复制群号', code); }
}

async function boot() { try { if (!(await enforceClientUpdate())) return; state.user = await api('/auth/me'); renderShell(); await loadConversations(); void contactNames.refresh({ force: true }).catch(() => {}); lockApplicationAtStartup(); } catch { state.token = ''; localStorage.removeItem('pulse_token'); renderLogin(); } }

function cancelConversationRecovery() {
  clearTimeout(state.recoveryRetryTimer); state.recoveryRetryTimer = null;
  state.initialHistory = null;
  state.recovery = null; state.recoverySubscribedSocket = null; state.recoverySubscribedId = 0;
  state.olderHistoryQueued = null; state.olderHistoryFailed = false; state.historyEpoch = (state.historyEpoch || 0) + 1; state.historyReadyEpoch = null; state.historyLoadedFloor = 0; state.historyLoading = false; state.recoveryNeeded = false;
}
function sameRecovery(context) {
  return state.recovery === context && state.token === context.token && Number(state.user?.id) === context.userId && Number(state.active?.id) === context.conversationId
    && state.historyEpoch === context.epoch && state.historyRevision === context.revision && state.historyLocation === context.location
    && state.socket === context.socket && context.socket?.readyState === WebSocket.OPEN;
}

function messageVersionCache() {
  if (state.messageVersionToken !== state.token) { state.messageVersionToken = state.token; state.messageVersions = new Map(); }
  return state.messageVersions;
}
function acceptMessageVersion(type, message, source = 'event') {
  const id = Number(message?.id); if (!Number.isSafeInteger(id) || id <= 0) return false;
  const cache = messageVersionCache(), previous = cache.get(id);
  const removed = type === 'message.recalled' || type === 'message.deleted' || Boolean(message.recalled_at) || ['recalled', 'deleted'].includes(message.status);
  const edited = String(message.edited_at || '');
  if (!removed && previous) {
    if (previous.removed || (previous.edited && edited < previous.edited)) return false;
    // A late send ACK has no mutation version. It must never resurrect or
    // replace any already observed instance, particularly a WS edit/recall.
    if (source === 'ack' && (!edited || (previous.edited && edited <= previous.edited))) return false;
  }
  cache.set(id, { edited, removed, source, message }); return true;
}
function initialSnapshotMessages(messages, pending = null) {
  const cache = messageVersionCache();
  const result = messages.flatMap(message => {
    if (message.recalled_at || ['recalled', 'deleted'].includes(message.status)) {
      acceptMessageVersion('message.recalled', message, 'snapshot'); return [];
    }
    const previous = cache.get(Number(message.id));
    // Quote visibility changes independently of the reply's own edited_at.
    // A fresh unavailable snapshot must redact an equal-version cached event.
    if (previous?.message && message.body?.reply_to?.unavailable && previous.message.body?.reply_to_id === message.body.reply_to_id) {
      previous.message = { ...previous.message, body: { ...previous.message.body, reply_to: message.body.reply_to } };
    }
    if (previous?.removed) return [];
    if (previous?.source === 'event' && previous.edited >= String(message.edited_at || '')) return [previous.message];
    return acceptMessageVersion('message.updated', message, 'snapshot') ? [message] : previous ? [previous.message] : [];
  });
  if (!pending) return result;
  const merged = new Map(result.map(message => [Number(message.id), message]));
  for (const [id, event] of pending.events) {
    if (['message.recalled', 'message.deleted'].includes(event.type) || event.message.recalled_at || ['recalled', 'deleted'].includes(event.message.status)) merged.delete(id);
    else merged.set(id, event.message);
  }
  return [...merged.values()].filter(message => Number(message.id) > Number(state.active?.cleared_before_message_id || 0)).sort((a, b) => Number(a.id) - Number(b.id));
}

function rememberRecoveryMessage(type, message, source = 'event') {
  if (!acceptMessageVersion(type, message, source)) return false;
  const initial = state.initialHistory;
  if (initial && state.token === initial.token && state.historyEpoch === initial.epoch && Number(message?.conversation_id) === initial.conversationId) initial.events.set(Number(message.id), { type, message });
  const context = state.recovery;
  if (!context || !sameRecovery(context) || Number(message?.conversation_id) !== context.conversationId) return true;
  context.events.set(Number(message.id), { type, message }); return true;
}
function recoveryScrollAnchor(container) {
  const box = container.getBoundingClientRect();
  return { bottom: container.scrollHeight - container.scrollTop - container.clientHeight < 40, top: container.scrollTop,
    anchors: [...container.querySelectorAll('[data-message-id]')].map(node => ({ id: Number(node.dataset.messageId), offset: node.getBoundingClientRect().top - box.top })).filter(row => row.offset >= -100 && row.offset <= container.clientHeight) };
}
function restoreRecoveryScroll(container, position) {
  if (position.bottom) { container.scrollTop = container.scrollHeight; return; }
  const box = container.getBoundingClientRect();
  for (const anchor of position.anchors) {
    const node = container.querySelector(`[data-message-id="${anchor.id}"]`);
    if (node) { container.scrollTop += node.getBoundingClientRect().top - box.top - anchor.offset; return; }
  }
  container.scrollTop = Math.min(position.top, Math.max(0, container.scrollHeight - container.clientHeight));
}
async function fetchInitialHistory(context) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (state.initialHistory !== context || state.token !== context.token || state.historyEpoch !== context.epoch || Number(state.active?.id) !== context.conversationId) return null;
    try { return await api(`/messages/history?conversation_id=${context.conversationId}&size=50`, { authToken: context.token, signal: AbortSignal.timeout(15000) }); }
    catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}
async function fetchRecoverySnapshot(context) {
  const messages = new Map(); let after = 0; let snapshot = context.location?.maxId ?? null; let cleared = 0;
  while (sameRecovery(context)) {
    const query = new URLSearchParams({ conversation_id: context.conversationId, floor_id: context.floor, after_id: after, limit: 100 });
    if (snapshot !== null) query.set('snapshot_max_id', snapshot);
    const page = await api(`/messages/sync?${query}`, { authToken: context.token });
    if (!sameRecovery(context)) return null;
    const maximum = Number(page.snapshot_max_id); const next = Number(page.next_after_id);
    if (!Array.isArray(page.items) || !Number.isSafeInteger(maximum) || maximum < 0 || (snapshot !== null && snapshot !== maximum)
      || !Number.isSafeInteger(next) || next < after || typeof page.has_more !== 'boolean' || (page.has_more && next <= after)) throw new Error('消息同步返回无效游标。');
    snapshot = maximum; cleared = Math.max(cleared, Number(page.cleared_before_message_id) || 0);
    for (const message of page.items) {
      const id = Number(message.id);
      if (!Number.isSafeInteger(id) || id <= after || id < context.floor || id > snapshot || Number(message.conversation_id) !== context.conversationId) throw new Error('消息同步返回无效范围。');
      messages.set(id, message);
    }
    if (!page.has_more) {
      for (const [id, event] of context.events) {
        if (['message.recalled', 'message.deleted'].includes(event.type) || event.message.recalled_at || ['recalled', 'deleted'].includes(event.message.status)) messages.delete(id);
        else if (id >= context.floor && (!context.location || id <= context.location.maxId)) messages.set(id, event.message);
      }
      for (const id of messages.keys()) if (id <= cleared) messages.delete(id);
      return { messages: [...messages.values()].sort((a, b) => Number(a.id) - Number(b.id)), cleared };
    }
    after = next;
  }
  return null;
}
async function recoverConversation(conversationId) {
  if (!state.recoveryNeeded || !state.user || Number(state.active?.id) !== Number(conversationId) || state.historyReadyEpoch !== state.historyEpoch
    || state.historyLoading || state.recoverySubscribedSocket !== state.socket || state.recoverySubscribedId !== Number(conversationId)) return;
  if (state.recovery && sameRecovery(state.recovery)) return;
  const container = $('messages'); if (!container) return;
  const ids = [...container.querySelectorAll('[data-message-id]')].map(node => Number(node.dataset.messageId)).filter(id => Number.isSafeInteger(id) && id > 0);
  const context = { token: state.token, userId: Number(state.user.id), conversationId: Number(conversationId), socket: state.socket,
    epoch: state.historyEpoch, revision: state.historyRevision, location: state.historyLocation,
    floor: ids.length ? Math.min(...ids) : state.historyLoadedFloor || Number(state.active.cleared_before_message_id || 0) + 1, events: new Map() };
  clearTimeout(state.recoveryRetryTimer); state.recoveryRetryTimer = null; state.recovery = context;
  try {
    const result = await fetchRecoverySnapshot(context);
    if (!result || !sameRecovery(context)) {
      if (state.recovery === context) {
        state.recovery = null;
        if (state.token === context.token && Number(state.active?.id) === context.conversationId && state.socket === context.socket) setTimeout(() => recoverConversation(context.conversationId), 0);
      }
      return;
    }
    const position = recoveryScrollAnchor(container);
    if (context.location) position.bottom = false;
    state.active.cleared_before_message_id = Math.max(Number(state.active.cleared_before_message_id || 0), result.cleared);
    const authoritativeIds = new Set(result.messages.map(message => Number(message.id)));
    for (const node of container.querySelectorAll('[data-message-id]')) {
      const id = Number(node.dataset.messageId);
      if (!authoritativeIds.has(id)) acceptMessageVersion('message.recalled', { id, conversation_id: context.conversationId }, 'snapshot');
    }
    const authoritative = result.messages.filter(message => Number(message.id) > state.active.cleared_before_message_id && acceptMessageVersion('message.updated', message, 'snapshot'));
    renderConversationMessages(authoritative, container);
    state.historyLoadedFloor = Math.max(context.floor, result.cleared + 1);
    bindMessageActions(); restoreRecoveryScroll(container, position);
    state.recovery = null; state.recoveryFailures = 0; state.recoveryNeeded = false; state.initialHistoryFailed = false;
    loadConversations().catch(() => {});
  } catch (error) {
    if (!sameRecovery(context)) return;
    state.recovery = null; state.recoveryFailures = Math.min(4, (state.recoveryFailures || 0) + 1);
    console.warn('同步聊天记录失败，将重试：', error.message);
    state.recoveryRetryTimer = setTimeout(() => { state.recoveryRetryTimer = null; if (state.token === context.token && state.historyEpoch === context.epoch) recoverConversation(context.conversationId); }, Math.min(15000, 1000 * 2 ** state.recoveryFailures));
  } finally { resumeQueuedOlderHistory(); renderOlderHistoryControl(); }
}

async function refreshConversationAfterEvent(conversationId) {
  if (!state.user || Number(state.active?.id) !== Number(conversationId)) return;
  state.recoveryNeeded = true;
  await recoverConversation(conversationId);
}
function stopSocketRetries() { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; clearInterval(state.heartbeatTimer); }
function requireClientUpgrade(message = '请更新客户端后继续使用。') {
  contactActionRevision++;
  closeContactProfile();
  state.updateRequired = true; stopSocketRetries(); state.socket?.close();
  disposeAuthView?.(); disposeAuthView = null;
  enforceClientUpdate().then(allowed => {
    if (!allowed) return;
    disposeConversationSidebarResize?.();
    document.body.innerHTML = `<main class="login-shell"><section class="login-card"><h1>需要更新客户端</h1><p>${escapeHtml(message)}</p><button id="required-update-retry" type="button">刷新并重新检查</button></section></main>`;
    $('required-update-retry').onclick = () => location.reload();
  }).catch(error => {
    disposeConversationSidebarResize?.();
    document.body.innerHTML = `<main class="login-shell"><section class="login-card"><h1>需要更新客户端</h1><p>${escapeHtml(error.message)}</p><button id="required-update-retry" type="button">重新检查</button></section></main>`;
    $('required-update-retry').onclick = () => location.reload();
  });
}
function desktopNotificationState() {
  if (!state.desktopNotifications || state.desktopNotifications.token !== state.token || state.desktopNotifications.userId !== Number(state.user?.id)) state.desktopNotifications = { token: state.token, userId: Number(state.user?.id), pending: new Map(), notified: new Set() };
  return state.desktopNotifications;
}
function notifyDesktopMessage(message, conversation) {
  if (!desktop.isDesktop || typeof desktop.notify !== 'function' || !document.hidden || !state.token || !state.user || !conversation || conversation.notifications_muted) return;
  const id = Number(message?.id), sender = Number(message?.sender_id);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(sender) || sender <= 0 || sender === Number(state.user.id)) return;
  const context = desktopNotificationState(); if (context.notified.has(id)) return;
  context.notified.add(id);
  if (context.notified.size > 1000) context.notified.delete(context.notified.values().next().value);
  try { desktop.notify('小猿答疑', '你收到一条新消息'); } catch { /* A system notification failure must not interrupt message delivery. */ }
}
function queueDesktopInboxNotification(packet) {
  const conversationId = Number(packet.data?.conversation_id), messageId = Number(packet.data?.message_id);
  const context = state.desktopNotifications;
  if (packet.data?.event_type === 'message.recalled') { if (context?.pending.get(conversationId)?.messageId === messageId) context.pending.delete(conversationId); return; }
  if (packet.data?.event_type !== 'message.new' || !desktop.isDesktop || typeof desktop.notify !== 'function' || !document.hidden || !state.token || !state.user) return;
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0 || !Number.isSafeInteger(messageId) || messageId <= 0) return;
  const current = desktopNotificationState(); if (current.notified.has(messageId)) return;
  if ((current.pending.get(conversationId)?.messageId || 0) < messageId) current.pending.set(conversationId, { messageId });
  if (current.pending.size > 200) current.pending.delete(current.pending.keys().next().value);
}
function flushDesktopInboxNotifications() {
  const context = state.desktopNotifications;
  if (!context || context.token !== state.token || context.userId !== Number(state.user?.id)) return;
  if (!document.hidden) { context.pending.clear(); return; }
  for (const [id, hint] of context.pending) {
    const conversation = state.conversations.find(item => Number(item.id) === id), message = conversation?.last_message;
    if (!message || Number(message.id) < hint.messageId) continue;
    context.pending.delete(id);
    notifyDesktopMessage(message, conversation);
  }
}
function handleSocketPacket(packet) {
  if (packet.type === 'notification.updated') {
    friendChats.changed(); refreshFriendRequestBadge();
    void contactNames.refresh({ force: true }).catch(() => {});
    state.contactCache = {};
    void loadConversations().catch(() => {});
    return;
  }
  if (packet.type === 'message.new' && !rememberRecoveryMessage(packet.type, packet.data)) return;
  if (packet.type === 'subscribe.ok' && Number(packet.conversation_id) === Number(state.active?.id)) { state.recoverySubscribedSocket = state.socket; state.recoverySubscribedId = Number(packet.conversation_id); state.recoveryNeeded = true; void recoverConversation(packet.conversation_id); return; }
  if (packet.type === 'auth.revoked') {
    state.token = ''; state.user = null; state.active = null; stopSocketRetries(); state.recorder?.stop?.(); state.socket?.close(); localStorage.removeItem('pulse_token'); renderLogin();
    if ($('login-error')) $('login-error').textContent = packet.message || '登录已失效，请重新登录。'; return;
  }
  if (packet.type === 'client.update_required') { requireClientUpgrade(packet.message); return; }
  if (packet.type === 'auth.ok') {
    void contactNames.refresh({ force: true }).catch(() => {});
    if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'inbox.subscribe' }));
    if (state.active) subscribeConversation(state.active.id);
    loadConversations().catch(() => {}); return;
  }
  if (packet.type === 'inbox.subscribe.ok' || packet.type === 'conversation.updated') {
    if (packet.type === 'conversation.updated' && packet.data?.event_type === 'message.recalled') {
      updateInternalMessage({ id: Number(packet.data.message_id), conversation_id: Number(packet.data.conversation_id), status: 'recalled', body: {} }, 'event');
    }
    if (packet.type === 'inbox.subscribe.ok') void contactNames.refresh({ force: true }).catch(() => {});
    if (packet.type === 'inbox.subscribe.ok') friendChats.changed();
    if (packet.type === 'conversation.updated') queueDesktopInboxNotification(packet);
    if (packet.type === 'inbox.subscribe.ok' && state.initialHistoryFailed && state.active) void openConversation(Number(state.active.id), { focusInput: false });
    if (packet.type === 'conversation.updated' && Number(packet.data?.conversation_id) === Number(state.active?.id)) void refreshConversationAfterEvent(packet.data.conversation_id);
    if (packet.type === 'inbox.subscribe.ok') loadConversations().catch(() => {}); else refreshChangedConversations(packet.data?.conversation_id); return;
  }
  if (packet.type === 'message.updated' || packet.type === 'message.recalled') {
    updateInternalMessage(packet.type === 'message.recalled' ? { ...packet.data, status: 'recalled' } : packet.data, 'event');
    if (Number(packet.data?.conversation_id) === Number(state.active?.id)) void refreshConversationAfterEvent(packet.data.conversation_id);
    refreshChangedConversations(packet.data?.conversation_id); return;
  }
  if (packet.type === 'message.new') {
    notifyDesktopMessage(packet.data, state.conversations.find(item => Number(item.id) === Number(packet.data?.conversation_id)));
    if (state.initialHistoryFailed && Number(packet.data?.conversation_id) === Number(state.active?.id)) { void openConversation(Number(state.active.id), { focusInput: false }); refreshChangedConversations(packet.data?.conversation_id); return; }
    if (Number(packet.data?.conversation_id) === Number(state.active?.id)) appendMessage(packet.data, 'event');
    refreshChangedConversations(packet.data?.conversation_id);
  }
}
function connectSocket() {
  if (state.updateRequired || !window.WebSocket || !state.token || state.socket) return;
  const token = state.token; const socket = new WebSocket(WS); state.socket = socket;
  const started = Date.now(); let received = started, authenticated = false;
  state.socketLastReceivedAt = started;
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = setInterval(() => {
    if (state.socket !== socket || state.token !== token) return;
    if ((!authenticated && Date.now() - started >= 15000) || Date.now() - received >= 45000) { restartSocketConnection(); return; }
    if (socket.readyState === WebSocket.OPEN) { try { socket.send(JSON.stringify({ type: 'ping' })); } catch { restartSocketConnection(); } }
  }, 15000);
  socket.onopen = () => {
    if (state.socket !== socket || state.token !== token || state.updateRequired) { socket.close(); return; }
    socket.send(JSON.stringify({ type: 'auth', token, client_platform: desktop.isDesktop ? 'pc' : 'web', client_version: CLIENT_VERSION }));
  };
  socket.onmessage = event => {
    if (state.socket !== socket || state.token !== token) return;
    let packet; try { packet = JSON.parse(event.data); } catch { return; }
    if (!packet || typeof packet !== 'object' || typeof packet.type !== 'string') return;
    received = Date.now(); state.socketLastReceivedAt = received;
    if (packet.type === 'auth.ok') { authenticated = true; state.reconnectDelay = 1000; }
    handleSocketPacket(packet);
  };
  socket.onclose = () => {
    if (state.socket !== socket) return;
    state.socket = null; clearInterval(state.heartbeatTimer);
    if (state.token === token && !state.updateRequired && !state.reconnectTimer) {
      state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connectSocket(); }, state.reconnectDelay);
      state.reconnectDelay = Math.min(15000, state.reconnectDelay * 2);
    }
  };
}

function restartSocketConnection() {
  stopSocketRetries();
  const previous = state.socket; state.socket = null;
  state.recovery = null; state.recoverySubscribedSocket = null; state.recoverySubscribedId = 0;
  try { previous?.close(); } catch {}
  connectSocket();
}
function resumeRealtime() {
  composerPermissions.check(true);
  void friendChats.refresh();
  if (!state.token || !state.user || state.updateRequired || document.hidden) return;
  state.desktopNotifications?.pending.clear();
  const now = Date.now(); if (now - (state.lastRealtimeResume || 0) < 1000) return; state.lastRealtimeResume = now;
  if (!state.socket || state.socket.readyState > WebSocket.OPEN || now - (state.socketLastReceivedAt || 0) > 30000) restartSocketConnection();
  else if (state.socket.readyState === WebSocket.OPEN && state.active) subscribeConversation(state.active.id);
  if (state.initialHistoryFailed && state.active) void openConversation(Number(state.active.id), { focusInput: false });
  loadConversations().catch(() => {});
}

function subscribeConversation(id) {
  const socket = state.socket; if (socket?.readyState !== WebSocket.OPEN) return;
  const conversationId = Number(id); if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return;
  if (state.messageSubscriptionSocket === socket && state.messageSubscriptionId && state.messageSubscriptionId !== conversationId) socket.send(JSON.stringify({ type: 'unsubscribe', conversation_id: state.messageSubscriptionId }));
  socket.send(JSON.stringify({ type: 'subscribe', conversation_id: conversationId }));
  state.messageSubscriptionSocket = socket; state.messageSubscriptionId = conversationId;
}
function renderLogin() {
  contactNames.clear(); state.contactCache = {}; state.conversations = []; state.active = null;
  composerDrafts.clear();
  contactActionRevision++;
  disposeConversationSidebarResize?.();
  // The web page loads shared client helpers before app.js, but a cached
  // response or a slow script can briefly expose app.js first. Wait for the
  // auth view instead of throwing and leaving the login shell half-mounted.
  if (typeof window.PulseAuthView?.mount !== 'function') {
    if (!renderLogin.retryTimer) {
      renderLogin.retryTimer = setTimeout(() => {
        renderLogin.retryTimer = null;
        if (!state.token) renderLogin();
      }, 0);
    }
    return;
  }
  disposeAuthView?.();
  disposeAuthView = window.PulseAuthView.mount({
    isDesktop: false,
    clientLabel: '网页版',
    request: (path, options = {}) => api(path, { ...options, authToken: '' }),
    clientReady: enforceClientUpdate,
    onAuthenticated: async result => {
      state.token = result.access_token;
      localStorage.setItem('pulse_token', state.token);
      await boot();
      if (state.token) connectSocket();
    },
  });
}
setInterval(() => { if (PC_LAYOUT && state.page === 'friends' && !document.querySelector('[data-feature-modal]')) renderFriendsPage().catch(() => {}); }, 30000);
window.addEventListener('online', resumeRealtime);
window.addEventListener('focus', resumeRealtime);
document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeRealtime(); });
if (state.token) boot().then(connectSocket); else renderLogin();

// Message mutation controls mirror ownership; the server enforces permissions.
const pulseOriginalMessageHtml = messageHtml;
const pulseMessageCache = new Map();
let pulseMessageCacheAccount = '';
const pendingMessageMutations = new Map();
function syncPulseMessageCache() {
  const account = state.token && state.user ? JSON.stringify([state.token, Number(state.user.id)]) : '';
  if (account !== pulseMessageCacheAccount) { pulseMessageCache.clear(); pulseMessageCacheAccount = account; }
  return pulseMessageCache;
}
function messageForMutation(messageId) {
  const message = syncPulseMessageCache().get(Number(messageId));
  if (!message || state.updateRequired || Number(message.conversation_id) !== Number(state.active?.id)
      || Number(message.id) <= Number(state.active?.cleared_before_message_id || 0)
      || message.recalled_at || message.status === 'recalled' || messageVersionCache().get(Number(message.id))?.removed) return null;
  const node = document.querySelector(`#messages [data-message-id="${Number(message.id)}"]`);
  return node?.isConnected && !node.classList.contains('recalled') ? message : null;
}
function messageMutationContext(message) {
  return { account: { token: state.token, userId: Number(state.user?.id) }, messageId: Number(message.id), conversationId: Number(message.conversation_id),
    historyEpoch: state.historyEpoch, page: state.page, sidebarMode: state.sidebarMode, navigationRevision: messageForwardNavigationRevision };
}
function currentMessageMutation(context) {
  return sameSendAccount(context.account) && !state.updateRequired && Number(state.active?.id) === context.conversationId
    && state.historyEpoch === context.historyEpoch && state.page === context.page && state.sidebarMode === context.sidebarMode
    && messageForwardNavigationRevision === context.navigationRevision;
}
function messageMutationKey(context, action) { return JSON.stringify([context.account.token, context.account.userId, context.conversationId, context.messageId, action]); }
function canEditMessage(message) {
  if (!message || message.type !== 'text') return false;
  if (state.user?.internal_staff) return true;
  const conversation = state.active;
  return Number(message.sender_id) === Number(state.user?.id) && Boolean(conversation)
    && !conversation.frozen_at && conversation.status !== 'frozen' && conversation.can_publish !== false && conversation.can_publish !== 0
    && (conversation.type !== 'channel' || ['owner', 'admin'].includes(conversation.my_role));
}
messageHtml = function(message) {
  textOutbox.confirm(textOutboxAccount(), message);
  syncPulseMessageCache().set(Number(message.id), message);
  let html = pulseOriginalMessageHtml(message);
  if (['red_packet', 'system'].includes(message.type) || message.status === 'recalled' || message.recalled_at) return html;
  const mine = Number(message.sender_id) === Number(state.user?.id), staff = Boolean(state.user?.internal_staff);
  const actions = `${canEditMessage(message) ? `<button class="edit-button" type="button" data-internal-edit="${Number(message.id)}">编辑</button>` : ''}${staff && !mine ? `<button class="recall-button" type="button" data-internal-recall="${Number(message.id)}">撤回</button>` : ''}`;
  if (actions) html = html.replace(/(<small class="classic-message-meta">[\s\S]*?)(<\/small>)/, (_, opening, closing) => opening + actions + closing);
  return html;
};
const pulseOriginalBindMessageActions = bindMessageActions;
bindMessageActions = function() {
  pulseOriginalBindMessageActions();
  renderTextOutbox(); textOutbox.resume();
  document.querySelectorAll('[data-internal-recall]').forEach((button) => { button.onclick = () => recallMessage(Number(button.dataset.internalRecall)); });
  document.querySelectorAll('[data-internal-edit]').forEach((button) => { button.onclick = () => editMessage(Number(button.dataset.internalEdit)); });
};
function updateInternalMessage(message, source = 'ack') {
  if (!state.token || !state.user) return;
  if (!rememberRecoveryMessage(message.recalled_at || message.status === 'recalled' ? 'message.recalled' : 'message.updated', message, source)) return;
  syncPulseMessageCache().set(Number(message.id), message);
  if (Number(message.conversation_id) !== Number(state.active?.id)) return;
  const node = document.querySelector(`[data-message-id="${Number(message.id)}"]`);
  if (!node) return;
  if (message.status === 'recalled' || message.recalled_at) { node.remove(); return; }
  const position = recoveryScrollAnchor($('messages'));
  renderConversationMessages(visibleConversationMessages()); bindMessageActions(); restoreRecoveryScroll($('messages'), position);
}
async function recallMessage(messageId) {
  const message = messageForMutation(messageId);
  if (!message || !state.user?.internal_staff) return;
  const context = messageMutationContext(message), key = messageMutationKey(context, 'recall');
  if (pendingMessageMutations.has(key)) return;
  pendingMessageMutations.set(key, context);
  try {
    await api('/messages/recall', { method: 'POST', authToken: context.account.token, signal: AbortSignal.timeout(15000), body: JSON.stringify({ message_id: context.messageId }) });
    // A successful recall belongs to the account even if navigation changed.
    // Keep its tombstone immediately so a retained view cannot restore it.
    if (!sameSendAccount(context.account)) return;
    const current = syncPulseMessageCache().get(context.messageId) || message;
    updateInternalMessage({ ...current, id: context.messageId, conversation_id: context.conversationId, status: 'recalled', recalled_at: current.recalled_at || new Date().toISOString() });
    refreshChangedConversations(context.conversationId);
  } catch (error) { if (currentMessageMutation(context)) composerFeedback(error.message || '撤回失败，请重试。'); }
  finally { if (pendingMessageMutations.get(key) === context) pendingMessageMutations.delete(key); }
}
function editMessage(messageId) {
  const message = messageForMutation(messageId);
  if (!canEditMessage(message)) return;
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal data-message-edit><section class="feature-card classic-folder-dialog" role="dialog" aria-modal="true" aria-labelledby="message-edit-title"><header><h2 id="message-edit-title">编辑消息</h2><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header><form id="message-edit-form" class="classic-folder-form"><label>消息内容<textarea id="message-edit-text" rows="5" maxlength="5000" required>${escapeHtml(message.body?.text || '')}</textarea></label><p id="message-edit-feedback" class="form-feedback" role="status"></p><footer><button type="button" class="secondary-button" data-close-modal>取消</button><button type="submit" id="message-edit-submit" class="primary">保存</button></footer></form></section></div>`);
  bindFeatureModal();
  const modal = document.querySelector('[data-message-edit]'), context = messageMutationContext(message);
  const input = modal.querySelector('#message-edit-text'), feedback = modal.querySelector('#message-edit-feedback'), button = modal.querySelector('#message-edit-submit');
  const current = () => currentMessageMutation(context) && modal.isConnected && document.querySelector('[data-feature-modal]') === modal;
  modal.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFeatureModal(); } });
  modal.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    if (!current() || context.pending) return;
    if (!canEditMessage(messageForMutation(context.messageId))) { feedback.textContent = '原消息已不可编辑，请关闭后重试。'; return; }
    const text = input.value.trim();
    if (!text) { feedback.textContent = '请输入消息内容。'; return; }
    const key = messageMutationKey(context, 'edit');
    if (pendingMessageMutations.has(key)) { feedback.textContent = '这条消息正在保存，请稍后重试。'; return; }
    context.pending = true; pendingMessageMutations.set(key, context); button.disabled = true; feedback.textContent = '正在保存…';
    try {
      const updated = await api('/messages/edit', { method: 'POST', authToken: context.account.token, signal: AbortSignal.timeout(15000), body: JSON.stringify({ message_id: context.messageId, text }) });
      if (!current()) return;
      if (Number(updated?.id) !== context.messageId || Number(updated?.conversation_id) !== context.conversationId) throw new Error('消息保存结果无效，请刷新后重试。');
      updateInternalMessage(updated);
      closeFeatureModal();
      void loadConversations().catch(() => {});
    } catch (error) { if (current()) feedback.textContent = error.message || '编辑失败，请重试。'; }
    finally { context.pending = false; if (pendingMessageMutations.get(key) === context) pendingMessageMutations.delete(key); if (modal.isConnected) button.disabled = false; }
  };
  input.focus(); input.select();
}
function contactActionsAllowed(account) {
  return Boolean(account?.token && account.userId > 0 && sameSendAccount(account) && !state.updateRequired && !readPasscodeSettings().locked && !$('passcode-lock-screen'));
}

async function forceAddInternal(userId, button) {
  userId = Number(userId);
  const account = { token: state.token, userId: Number(state.user?.id) };
  const row = button?.closest('.contact-search-user, .search-result-card, .contact-row');
  if (!contactActionsAllowed(account) || !state.user?.internal_staff || !Number.isSafeInteger(userId) || userId <= 0
    || userId === account.userId || !(button instanceof HTMLButtonElement) || !row || !button.isConnected) return;
  const key = JSON.stringify([account.userId, account.token, userId]);
  if (pendingInternalContactAdds.has(key)) return;
  const modal = button.closest('[data-feature-modal]');
  const query = modal?.querySelector('#contact-search-input') || $('directory-contact-keyword');
  const operation = { revision: ++contactActionRevision, account, row, button, modal, query, keyword: query?.value,
    historyEpoch: state.historyEpoch, page: state.page, sidebarMode: state.sidebarMode,
    activeId: Number(state.active?.id) || 0, navigationRevision: messageForwardNavigationRevision };
  const current = () => contactActionsAllowed(account) && state.user?.internal_staff
    && contactActionRevision === operation.revision && messageForwardNavigationRevision === operation.navigationRevision
    && state.historyEpoch === operation.historyEpoch && state.page === operation.page && state.sidebarMode === operation.sidebarMode
    && (Number(state.active?.id) || 0) === operation.activeId && button.isConnected && row.isConnected && row.contains(button)
    && Number(button.dataset.addContact) === userId && document.querySelector('[data-feature-modal]') === modal
    && (!modal || modal.isConnected) && (!query || (query.isConnected && query.value === operation.keyword));
  if (!current()) return;
  if (button.dataset.forceAddState === 'added') { await openContactProfile(userId); return; }
  pendingInternalContactAdds.set(key, operation);
  const originalLabel = button.textContent;
  button.dataset.forceAddOperation = String(operation.revision);
  button.disabled = true; button.textContent = '正在添加…';
  setContactRequestFeedback(button, '正在添加好友…');
  try {
    const result = await api('/contacts/force-add', { authToken: account.token, signal: AbortSignal.timeout(15000),
      method: 'POST', body: JSON.stringify({ user_id: userId }) });
    if (!current()) return;
    if (result?.status !== 'accepted' || result.forced !== true || !Number.isSafeInteger(Number(result.user_id))
      || Number(result.user_id) !== userId) throw new Error('添加结果与目标用户不匹配，请重试。');
    button.dataset.forceAddState = 'added'; button.textContent = '查看资料';
    setContactRequestFeedback(button, '已添加好友');
    await openContactProfile(userId);
  } catch (error) {
    if (current()) setContactRequestFeedback(button, '添加失败：' + (error.message || '请稍后重试。'), 'error');
  } finally {
    if (pendingInternalContactAdds.get(key) === operation) pendingInternalContactAdds.delete(key);
    if (button.isConnected && row.contains(button) && button.dataset.forceAddOperation === String(operation.revision)) {
      button.disabled = false; button.textContent = button.dataset.forceAddState === 'added' ? '查看资料' : originalLabel;
      delete button.dataset.forceAddOperation;
    }
  }
}

// Replacing a query invalidates an old force-add even if the user types the old text again.
for (const type of ['input', 'submit']) document.addEventListener(type, event => {
  if (event.target.matches?.('#contact-search-input, #directory-contact-keyword, #contact-search-form, #directory-contact-search')) contactActionRevision++;
}, true);
async function openInternalProfile(userId) { try { const profile = await api(`/contacts/internal-profile?user_id=${Number(userId)}`); const history = (profile.login_history || []).map((item) => `<div><dt>\u767b\u5f55\u8bb0\u5f55</dt><dd>${escapeHtml(item.created_at || '')} · ${escapeHtml(item.ip || '\u6682\u65e0')} · ${escapeHtml(item.location || '\u672a\u77e5\u5730\u533a')}</dd></div>`).join(''); document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal><section class="profile-card" role="dialog" aria-modal="true"><header><h2>\u5185\u90e8\u4eba\u5458\u8d44\u6599</h2><button type="button" data-close-modal>×</button></header><div class="profile-body"><h2>${escapeHtml(profile.nickname || '\u7528\u6237')}</h2><dl class="profile-details"><div><dt>\u7528\u6237 ID</dt><dd>${escapeHtml(publicUserId(profile) || '暂不可用')}</dd></div><div><dt>\u6ce8\u518c IP</dt><dd>${escapeHtml(profile.register_ip || '\u6682\u65e0')}</dd></div><div><dt>\u6ce8\u518c\u5730</dt><dd>${escapeHtml(profile.register_ip_location || '\u672a\u77e5\u5730\u533a')}</dd></div><div><dt>\u6700\u8fd1\u767b\u5f55 IP</dt><dd>${escapeHtml(profile.last_login_ip || '\u6682\u65e0')}</dd></div><div><dt>\u6700\u8fd1\u767b\u5f55\u5730</dt><dd>${escapeHtml(profile.last_login_location || '\u672a\u77e5\u5730\u533a')}</dd></div><div><dt>\u6700\u8fd1\u767b\u5f55\u8bbe\u5907</dt><dd>${escapeHtml(deviceName(profile.last_login_device))}</dd></div>${history}</dl></div></section></div>`); bindFeatureModal(); } catch (error) { alert(error.message); } }
document.addEventListener('click', (event) => { const add = event.target.closest('[data-add-contact]'); if (add && state.user?.internal_staff) { event.preventDefault(); event.stopImmediatePropagation(); forceAddInternal(Number(add.dataset.addContact), add); return; } const profile = event.target.closest('[data-profile-user]'); if (profile && state.user?.internal_staff && !event.target.closest('button')) { event.preventDefault(); event.stopImmediatePropagation(); openInternalProfile(Number(profile.dataset.profileUser)); } }, true);

setInterval(() => { if (state.token && !state.updateRequired) enforceClientUpdate().catch(error => console.warn(error.message)); }, 300000);
