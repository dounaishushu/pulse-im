const desktop = window.pulseDesktop || {};
const chatTypographySettings = window.PulseChatTypography.createController({ desktop });
const localDev = location.port === '8098';
const routeBase = desktop.apiBaseUrl || window.PULSE_API_BASE || `${location.origin}/api/v2`;
const routeManager = new PulseGoRoutes.Manager({base:routeBase,storage:localStorage,allowLocal:desktop.production!==true});
const GO = PulseGoV2.create({ base: routeBase, resolveBase:()=>routeManager.current.api_url, fetch:(url,options)=>routeManager.fetch(url,options),storage: localStorage, platform: desktop.isDesktop ? 'pc' : 'web', onInvalidate: (id, reason) => window.PulseGoUI?.invalidate(id, reason) });
const API = GO.base;
const WS = GO.websocketURL;
function openRoutePicker() { if (routeManager) return window.PulseRoutePicker.open(routeManager); }
function syncNativeRoute() { return desktop.windowKind !== 'conversation' && desktop.publishVerifiedRoute && routeManager ? desktop.publishVerifiedRoute({ goRoute: routeManager.current.id }) : Promise.resolve(); }
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
if (desktop.setZoomFactor) desktop.setZoomFactor(getInterfaceScale());
else if (getInterfaceScale() !== 1) document.documentElement.style.zoom = String(getInterfaceScale());
const state = { token: localStorage.getItem(GO.tokenKey) || '', user: null, conversations: [], conversationFolders: [], contactCache: {}, active: null, favoriteMode: false, sidebarMode: 'messages', archiveView: false, archiveFeedback: '', ungroupedCollapsed: localStorage.getItem('pulse_ungrouped_collapsed') !== '0', socket: null, recorder: null, recordingStartedAt: 0, recordingChunks: [], reconnectTimer: null, heartbeatTimer: null, reconnectDelay: 1000, historyPage: 1, historyLoading: false, historyHasMore: true };
const $ = (id) => document.getElementById(id);
const localChat = window.PulseLocalChat({ enabled: !GO && desktop.persistentMessages === true,
  failed: code => { try { desktop.reportDiagnostic?.({ kind: 'renderer-error', name: 'LocalChatCache', message: code, source: 'local-chat-controller.js' }); } catch {} },
  denied: cid => { purgeLocalMedia(cid); conversationViews.clear(); if (Number(state.active?.id) === cid && $("messages")) $("messages").innerHTML = '<p class="empty">当前会话不可访问</p>'; },
  owner: () => state.user?.id && state.token && !readPasscodeSettings().locked ? `${API}|${Number(state.user.id)}|${state.token}` : '',
  request: (route, options, identity) => {
    if (identity !== `${API}|${Number(state.user?.id)}|${state.token}`) return Promise.reject(new Error('LOCAL_CHAT_CANCELLED'));
    return api(route, { ...options, authToken: state.token });
  }
});
const contactNames = PulseContactNames.create({
  context: () => ({ base: API, token: state.token, userId: Number(state.user?.id), nickname: state.user?.nickname,
    allowed: Boolean(desktop.isDesktop && state.token && state.user && !state.updateRequired && !readPasscodeSettings().locked) }),
  request: (path, options) => api(path, options), changed: () => refreshContactNameLabels(),
});
function contactDisplayName(userId, fallback = '会话成员') { return contactNames.resolve(userId, fallback); }
function refreshContactNameLabels() {
  document.querySelectorAll('[data-contact-name-user]').forEach(node => {
    const text = (node.dataset.contactNamePrefix || '') + contactDisplayName(node.dataset.contactNameUser, node.dataset.contactNameFallback || '会话成员');
    if (node.textContent !== text) node.textContent = text;
  });
  window.PulseMessageActions?.refreshContactNames();
  if (desktop.isDesktop && !state.chatSearch) filterConversationList($('message-search')?.value || '');
}
const composerDrafts = PulseConversationDrafts.create();
const conversationOrder = PulseConversationOrder.create();
function conversationOrderAccount() { return { base: API, userId: Number(state.user?.id) }; }
addEventListener('storage', event => {
  if (desktop.isDesktop && !isDetachedConversation && state.token && state.user && event.key === conversationOrder.key(conversationOrderAccount())) {
    renderConversationList(); void loadConversations().catch(() => {});
  }
});
const imageClipboard = PulseImageClipboard.create({
  context: () => ({ key: JSON.stringify([API, state.token, Number(state.user?.id), Number(state.active?.id), state.historyEpoch, Boolean(state.favoriteMode)]),
    accountId: Number(state.user?.id), allowed: Boolean(desktop.isDesktop && state.token && Number(state.user?.id) > 0 && state.desktopAccountVisible !== false && !state.updateRequired && !readPasscodeSettings().locked) }),
  write: typeof desktop.copyImage === 'function' ? value => desktop.copyImage(value) : null,
});
const imageViewer = PulseImageViewer.create({ context: () => ({
  key: JSON.stringify([API, state.token, Number(state.user?.id), Number(state.active?.id), Boolean(state.favoriteMode)]),
  accountId: Number(state.user?.id),
  allowed: Boolean(state.token && Number(state.user?.id) > 0 && state.desktopAccountVisible !== false && !state.updateRequired && !readPasscodeSettings().locked)
}), copyImage: (image, valid) => imageClipboard.copy(image, valid), canCopyImage: () => imageClipboard.available(),
  openWindow: desktop.isDesktop && typeof desktop.openImageWindow === 'function' ? value => desktop.openImageWindow(value) : null,
  closeWindow: value => desktop.closeImageWindow?.(value), onWindowClosed: callback => desktop.onImageWindowClosed?.(callback) });
const conversationReads = PulseConversationRead.create({
  context: () => ({ account: JSON.stringify([API, state.token, Number(state.user?.id)]), token: state.token, userId: Number(state.user?.id), conversationId: Number(state.active?.id),
    available: Boolean(state.user && state.token && !state.updateRequired && !document.hidden && state.desktopAccountVisible !== false && !readPasscodeSettings().locked
      && state.page === 'messages' && !state.favoriteMode && !$('messages')?.hidden && !state.initialHistory && !state.initialHistoryFailed && state.historyReadyEpoch === state.historyEpoch) }),
  request: (path, options) => api(path, options),
  confirmed: result => {
    for (const row of [...state.conversations, state.active].filter(Boolean)) if (Number(row.id) === Number(result.conversation_id)) {
      const covered = Number(row.last_message?.id || 0) <= Number(result.through_message_id);
      if (covered) row.unread_count = result.unread_count;
      if (Number.isSafeInteger(result.unread_mention_count) && (covered || (result.unread_mention_count === 0 && Number(row.last_mention_message_id || 0) <= Number(result.through_message_id)))) {
        row.unread_mention_count = result.unread_mention_count; row.last_mention_message_id = result.last_mention_message_id || 0;
      }
    }
    renderConversationList();
    refreshChangedConversations(result.conversation_id);
  },
  failed: error => console.warn('会话已读同步暂时失败，将在前台重试：', error.message),
});
const messageReceipts = PulseMessageReceipts.create({
  context: () => ({ account: JSON.stringify([API, state.token, Number(state.user?.id)]), token: state.token, userId: Number(state.user?.id),
    conversationId: Number(state.active?.id), type: state.favoriteMode ? 'favorites' : state.active?.type, revision: state.historyEpoch,
    available: Boolean(state.user && !state.updateRequired && !document.hidden && state.desktopAccountVisible !== false && !readPasscodeSettings().locked && !$('passcode-lock-screen') && state.page === 'messages' && !$('messages')?.hidden) }),
  request: (path, options) => api(path, options), container: () => $('messages'),
});
let disposeAuthView = null;
let disposeClassicMenuAccounts = null;
let classicMenuAccountsExpanded = false;
let classicMenuAccountsCache = null;
let disposeConversationSidebarResize = null;
let updateConversationSidebarWidth = null;
let contactActionRevision = 0;
let settingsLoadRevision = 0;
const pendingInternalContactAdds = new Map();
const detachedConversationId = desktop.windowKind === 'conversation' ? Number(desktop.conversationId) : 0;
const isDetachedConversation = Boolean(detachedConversationId);
function leaveAccount({ removeToken = true, reload = false } = {}) {
  cancelForegroundReads();
  cancelConversationRecovery();
  clearImageSendBatches();
  void textOutbox.release(textOutboxAccount());
  friendChats.reset(); conversationRefresh.reset();
  conversationViews.clear();
  localChat.stop();
  chatHeaderAvatars.clear(); avatarLoader.clear();
  groupSidebar.clearAvatars();
  groupCreator.clearCache();
  conversationReads.reset();
  contactNames.clear(); state.contactCache = {};
  state.archiveView = false; state.archiveFeedback = '';
  broadcastAssistant.close();
  activityCenter.reset();
  closeFeatureModal();
  contactActionRevision++;
  state.token = ''; state.user = null; state.active = null; state.startupLockApplied = false; stopSocketRetries(); state.recorder?.stop?.(); state.socket?.close();
  if (removeToken) { localStorage.removeItem(GO.tokenKey); localStorage.removeItem(passcodeStorageKey); }
  desktop.syncSessionState?.({ accountId: 0, locked: false });
  if (isDetachedConversation) { desktop.close?.(); return; }
  if (reload) location.reload(); else renderLogin();
}


function syncDesktopSession() { desktop.syncSessionState?.({ accountId: Number(state.user?.id) || 0, locked: readPasscodeSettings().locked, displayName: state.user?.nickname || '', avatarUrl: state.user?.avatar_url ? mediaUrl(state.user.avatar_url) : '' }); }

const CLIENT_VERSION = desktop.appVersion || document.querySelector('meta[name="pulse-client-version"]')?.content || '2.4.10';
function captureSendContext(targetConversation = state.active) {
  const conversationId = Number(targetConversation?.id);
  if (!state.token || !state.user || !Number.isSafeInteger(conversationId) || conversationId <= 0) throw new Error('请先登录并选择会话');
  return { token: state.token, userId: Number(state.user.id), conversationId, ...(conversationId !== Number(state.active?.id) || typeof PulseMessageActions === 'undefined' ? {} : PulseMessageActions.capture()) };
}
function messageBodyWithReply(body, context) {
  if (desktop.isDesktop && typeof body.text === 'string' && Number(context.conversationId) === Number(state.active?.id)) body = {...body, ...globalThis.PulseGroupMentions?.body(body.text)};
  return typeof PulseMessageActions === 'undefined' ? body : PulseMessageActions.body(body, context);
}
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
  send: (item, signal) => api('/messages', { method: 'POST', authToken: item.account.token, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), body: JSON.stringify(item.payload) }),
  allowed: account => sameSendAccount(account) && !state.updateRequired,
  changed: () => renderTextOutbox(),
  accepted: (item, message) => {
    if (!sameSendAccount(item.account)) return;
    if (Number(state.active?.id) === Number(item.payload.conversation_id)) appendMessage(message);
    scheduleTextConversationRefresh();
  }
});
function renderTextOutbox() {
  renderImageOutbox();
  const container = $('messages'); if (!container || !state.active) return;
  const pending = textOutbox.pending(textOutboxAccount(), state.active?.id);
  const ids = new Set(pending.map(item => item.id));
  container.querySelectorAll('[data-outbox-id]').forEach(node => { if (!ids.has(node.dataset.outboxId)) node.remove(); });
  if (!pending.length) return;
  const follow = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
  container.querySelector('.empty')?.remove();
  for (const item of pending) {
    let node = container.querySelector('[data-outbox-id="' + item.id + '"]');
    if (!node) { node = document.createElement('article'); node.className = 'bubble mine text-message text-outbox-message'; node.dataset.outboxId = item.id; container.append(node); }
    const pendingMessage = { type: 'text', conversation_id: item.payload.conversation_id };
    const direct = isDirectChatMessage(pendingMessage);
    node.classList.toggle('direct-message', direct);
    const failed = item.status === 'failed';
    const status = failed ? '发送未确认，点击重试' : item.status === 'sending' ? '发送中…' : '等待发送…';
    const html = (direct ? chatMessageAvatarHtml(pendingMessage, true, direct) : '') + '<span class="message-text-content">' + escapeHtml(item.payload.body.text) + '</span><small class="classic-message-meta">' + (failed ? '<button type="button" class="text-outbox-retry" title="' + escapeHtml(item.error) + '">重试发送</button> <button type="button" class="text-outbox-remove" aria-label="移除待发送消息">移除</button>' : '<span>' + status + '</span>') + '</small>';
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

const imageSendBatches = new Set();
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
    const config = GO ? await GO.raw(`/client/update?platform=${desktop.isDesktop ? 'pc' : 'web'}&version=${encodeURIComponent(CLIENT_VERSION)}`, { signal: AbortSignal.timeout(10000), authToken: '' }) : await api('/client/config', { authToken: '', signal: AbortSignal.timeout(10000) });
    if (GO ? !config.required : !config.force_update || compareClientVersions(CLIENT_VERSION, config.latest_version) >= 0) return true;
    state.updateRequired = true; state.socket?.close();
    const rawUrl = desktop.isDesktop ? (GO ? config.url : config.pc_download_url) || '' : '';
    let download = ''; try { const url = new URL(rawUrl); if (url.protocol === 'https:') download = url.href; } catch {}
    disposeConversationSidebarResize?.();
    document.body.innerHTML = `<main class="login-shell"><section class="login-card"><h1>需要更新客户端</h1><p>当前版本 ${escapeHtml(CLIENT_VERSION)}，服务要求 ${escapeHtml(config.minimum_version || config.latest_version)}。</p><p>${escapeHtml((GO ? config.notes : config.update_description) || '请更新后继续使用。')}</p>${desktop.isDesktop ? (download ? '<button id="required-update-download" class="primary" type="button">下载新版电脑端</button>' : '<p>尚未配置新版电脑端下载地址，请联系管理员。</p>') : '<button id="required-update-refresh" class="primary" type="button">刷新并加载新版</button>'}<button id="required-update-retry" type="button">重新检查</button></section></main>`;
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

async function readApiResponse(response) {
  const invalidResponse = () => {
    const html = /\btext\/html\b/i.test(response.headers?.get('content-type') || '');
    const error = new Error(`${html ? '服务器返回了网页，未返回接口数据' : '服务器返回的接口数据格式不正确'}（HTTP ${response.status}），请稍后重试或检查接口服务。`);
    error.status = response.status;
    error.code = 'INVALID_API_RESPONSE';
    return error;
  };
  let data;
  try { data = await response.json(); }
  catch (error) { if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error; throw invalidResponse(); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.ok !== 'boolean' || (data.ok && !Object.hasOwn(data, 'data'))) throw invalidResponse();
  return data;
}

async function api(path, options = {}) {
  if (GO) {
    GO.session(state.token);
    const permissionTicket = composerPermissions.ticket();
    const data = await GO.request(path, options);
    composerPermissions.receive(path, data, permissionTicket, options.authToken ?? state.token);
    return data;
  }
  const { authToken = state.token, ...requestOptions } = options;
  const permissionTicket = composerPermissions.ticket();
  if (path === '/messages' && requestOptions.method === 'POST') {
    if (authToken !== state.token) throw new Error('账号已改变，本次发送已取消');
    assertConversationCanSend(JSON.parse(requestOptions.body || '{}').conversation_id);
  }
  if (state.updateRequired && requestOptions.method && requestOptions.method !== 'GET' && path !== '/auth/logout') throw new Error('请先更新客户端');
  const headers = { 'Content-Type': 'application/json', 'X-Client-Platform': desktop.isDesktop ? 'pc' : 'web', 'X-Client-Version': CLIENT_VERSION, ...(requestOptions.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  // API data must never reuse a cached HTML error page from an older deployment.
  let replay = !requestOptions.method || requestOptions.method === 'GET' || requestOptions.method === 'HEAD';
  if (requestOptions.method === 'POST' && path === '/messages') { try { replay = Boolean(JSON.parse(requestOptions.body || '{}').request_id); } catch {} }
  const response = typeof routeManager !== 'undefined' && routeManager
    ? await routeManager.request(path, { ...requestOptions, headers }, replay)
    : await fetch(API + path, { ...requestOptions, cache: 'no-store', headers });
  const data = await readApiResponse(response);
  if (response.status === 426 || data.error?.code === 'UPGRADE_REQUIRED') requireClientUpgrade(data.error?.message);
  if (!response.ok || data.ok === false) { const requestId = String(data.error?.request_id || response.headers.get('X-Pulse-Request-ID') || ''); let message = data.error?.message || '请求失败，请检查网络和服务状态'; if (/^[a-f0-9]{24}$/.test(requestId) && !message.includes(requestId)) message += '（请求编号：' + requestId + '）'; const error = new Error(message); error.requestId = requestId; error.status = response.status; error.code = data.error?.code; throw error; }
  composerPermissions.receive(path, data.data, permissionTicket, authToken);
  return data.data;
}

function waitImageUploadPreparation(work, signal, stage) {
  // Native transfer deadlines start only after these local/IPC steps finish.
  // Settle here on stop/timeout; a late result must never dispatch an upload.
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value);
    };
    const abort = () => finish(reject, Object.assign(new Error('图片发送已停止'), { code: 'UPLOAD_CANCELLED' }));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(() => finish(reject, Object.assign(new Error(stage === 'route' ? '连接上传服务超时，请重试' : '读取图片超时，请重新选择图片后重试'), {
      code: stage === 'route' ? 'UPLOAD_ROUTE_TIMEOUT' : 'UPLOAD_READ_TIMEOUT'
    })), 15000);
    Promise.resolve().then(() => { if (!settled) return work(); }).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
async function uploadMedia(kind, file, authToken = state.token, signal, onProgress, original = false) {
  if (GO) { GO.session(state.token); return GO.uploadMedia(kind, file, { authToken, signal, onProgress, original }); }
  let response;
  if (kind === 'image' && desktop.nativeImageUploads && desktop.uploadImage) {
    if (signal?.aborted) throw new Error('图片发送已停止');
    const accountId = Number(state.user?.id), transferId = crypto.randomUUID();
    const account = { token: authToken, userId: accountId };
    assertSendAccount(account);
    onProgress?.({ stage: 'route' });
    await waitImageUploadPreparation(syncNativeRoute, signal, 'route');
    assertSendAccount(account);
    const route = routeManager?.current;
    const failover = () => { if (route && routeManager?.current === route) void routeManager.failover(route).catch(() => {}); };
    onProgress?.({ stage: 'read' });
    const bytes = await waitImageUploadPreparation(() => file.arrayBuffer(), signal, 'read');
    if (signal?.aborted) throw new Error('图片发送已停止');
    assertSendAccount(account);
    const abort = () => desktop.cancelImageUpload(transferId);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const extension = file.name.split('.').pop().toLowerCase();
      const mime = file.type || ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' })[extension];
      const result = await desktop.uploadImage({ transferId, accountId, token: authToken, mime, bytes }, onProgress);
      if (signal?.aborted) throw new Error('图片发送已停止');
      if (!result?.ok) {
        if (['UPLOAD_NETWORK', 'UPLOAD_STALLED', 'UPLOAD_RESPONSE_TIMEOUT', 'UPLOAD_TIMEOUT'].includes(result?.error?.code)) failover();
        throw Object.assign(new Error(result?.error?.message || '图片上传失败，请重试'), { code: result?.error?.code });
      }
      const upload = result.response;
      response = new Response([204, 205].includes(upload.status) ? null : upload.body, { status: upload.status, headers: upload.headers });
      if ([502, 503, 504].includes(response.status)) failover();
    } finally { signal?.removeEventListener('abort', abort); }
  } else {
    const form = new FormData(); form.append('kind', kind); form.append('file', file);
    const uploadOptions = { method: 'POST', signal, headers: { Authorization: `Bearer ${authToken}`, 'X-Client-Platform': desktop.isDesktop ? 'pc' : 'web', 'X-Client-Version': CLIENT_VERSION }, body: form };
    response = typeof routeManager !== 'undefined' && routeManager ? await routeManager.request('/uploads', uploadOptions, false) : await fetch(API + '/uploads', uploadOptions);
  }
  const data = await readApiResponse(response);
  if (!response.ok || data.ok === false) throw new Error(data.error?.message || '文件上传失败');
  return data.data;
}

const groupCreator = PulseGroupCreator.create({
  getAccount: () => ({ token: state.token, userId: Number(state.user?.id), base: API, scope: `${state.page}:${state.sidebarMode}:${messageForwardNavigationRevision}`,
    blocked: Boolean(state.updateRequired || readPasscodeSettings().locked || state.desktopAccountVisible === false) }),
  request: (route, options) => api(route, options),
  upload: (file, token, signal) => uploadMedia('image', file, token, signal),
  mediaUrl: value => avatarUrl(value),
  onInvited: async (group, account) => {
    if (!sameSendAccount(account)) return;
    const row=state.conversations.find(item=>Number(item.id)===Number(group.id));if(row)row.member_count=group.member_count;
    if(Number(state.active?.id)===Number(group.id))state.active.member_count=group.member_count;
    renderConversationList();updateDesktopChat();refreshChangedConversations([Number(group.id)]);
    if (sameSendAccount(account) && Number(state.chatInfo?.id) === Number(group.id)) void groupSidebar.reload();
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



const broadcastAssistant = PulseBroadcastAssistant.create({
  getAccount: () => ({ token: state.token, userId: Number(state.user?.id), internalStaff: Boolean(state.user?.internal_staff), blocked: Boolean(state.updateRequired || readPasscodeSettings().locked) }),
  request: (path, options) => api(path, options),
  upload: (kind, file, token, signal) => uploadMedia(kind, file, token, signal),
  mediaUrl: value => mediaUrl(value),
  onPermissionRevoked: () => { if (state.user) state.user.internal_staff = false; document.querySelectorAll('[data-classic-menu-action="broadcast"]').forEach(node => node.remove()); },
  onSent: () => { void loadConversations().catch(() => {}); },
});


const activityCenter = PulseActivityCenter.create({
  getAccount: () => ({ base: API, token: state.token, userId: Number(state.user?.id), visible: state.desktopAccountVisible !== false, blocked: Boolean(state.updateRequired || readPasscodeSettings().locked) }),
  request: (path, options) => api(path, options),
  mediaUrl: value => avatarUrl(value),
  onContactsChanged: () => loadConversations().catch(() => {}),
  onFriendAccepted: (result, account) => { friendChats.changed(); void friendChats.offer(result.friend_chat, account); },
  onOpenGroup: async (id, account) => {
    await loadConversations();
    if (state.token !== account.token || Number(state.user?.id) !== account.userId) return;
    if (!state.conversations.some(item => Number(item.id) === Number(id))) throw new Error('你已不在该群聊中');
    closeFeatureModal(); await openConversation(Number(id));
  },
});

const friendChats = PulseFriendChats.create({
  context: () => ({ base: API, token: state.token, userId: Number(state.user?.id),
    syncAllowed: Boolean(state.token && state.user && !document.hidden && state.desktopAccountVisible !== false && !state.updateRequired
      && !readPasscodeSettings().locked && !$('passcode-lock-screen') && !isDetachedConversation),
    allowed: Boolean(state.token && state.user && !document.hidden && state.desktopAccountVisible !== false && !state.updateRequired
      && !readPasscodeSettings().locked && !$('passcode-lock-screen') && $('messages') && !state.imageDraft && ![...imageSendBatches].some(batch => batch.queue.running)
      && state.recorder?.state !== 'recording' && !isDetachedConversation) }),
  storage: localStorage,
  request: (path, options) => api(path, { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) }),
  synchronize: async (event, account, current, { signal } = {}) => {
    // A response captured before acceptance must not consume this invalidation.
    cancelConversationListRead();
    const complete = await loadConversations({ signal });
    return current() && complete === true && state.conversations.some(item => Number(item.id) === Number(event.conversation_id));
  },
  open: async (event, account, current) => {
    // Consume the accepted-friend event once its chat is in the list.
    // Keep the current request window, scroll position and active chat intact.
    return current() && state.conversations.some(item => Number(item.id) === Number(event.conversation_id)
      && item.type === 'direct' && Number(item.peer_user_id) === Number(event.peer_user_id));
  },
});
let friendChatsPollTimer = null;
function resumeAccountWork() {
  if (!foregroundReadsAllowed()) return;
  friendChats.resume(); conversationRefresh.resume(); activityCenter.resume(); textOutbox.resume(textOutboxAccount());
  if (friendChatsPollTimer === null) friendChatsPollTimer = setInterval(() => { void friendChats.refresh(); }, 5000);
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function publicUserId(user) {
  const value = user?.public_id;
  return typeof value === 'string' && (/^[A-F0-9]{32}$/.test(value) || (value.length === 16 && /^[A-Za-z0-9]{16}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value))) ? value : '';
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
  const avatar = item.avatar_url ? `<img src="${escapeHtml(avatarUrl(item.avatar_url))}" alt="">` : escapeHtml(initial);
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
function mediaUrl(value) { if (String(value || '').startsWith('pulse-media:')) return value; if (typeof routeManager !== 'undefined' && routeManager) return routeManager.mediaURL(value); try { return new URL(String(value || ''), API).href; } catch { return String(value || ''); } }
function cachedMediaUrl(message) { return window.PulseMediaSources?.display(mediaUrl(message.body?.url), Number(state.user?.id), Number(message.conversation_id), Number(message.id), desktop.persistentMedia === true) || mediaUrl(message.body?.url); }
function purgeLocalMedia(cid, ids = []) { void desktop.localMedia?.('purge', Number(cid), ids).catch(() => {}); }
function avatarUrl(value) { return window.PulseAvatarSources.display(mediaUrl(value), Number(state.user?.id), desktop.persistentAvatars === true); }

const conversationViews = PulseMessageView.createCache();
const chatHeaderAvatars = PulseMessageView.createAvatarCache();
const avatarLoader = window.PulseAvatarLoader.create({
  context: () => ({ base: API, token: state.token, userId: Number(state.user?.id) }),
  mediaPath(source) {
    try {
      const url = new URL(window.PulseAvatarSources.original(source), API), routes = routeManager ? [...routeManager.seeds, ...routeManager.routes] : [];
      const origins = new Set([new URL(API).origin, ...routes.flatMap(item => [new URL(item.api_url).origin, new URL(item.media_url).origin])]);
      const path = origins.has(url.origin) && window.PulseRoutes?.mediaPath(url);
      return path ? '/media?path=' + encodeURIComponent(path) + '&media_preview=640' : '';
    } catch { return ''; }
  },
  request(path, account, signal) {
    const options = { signal, headers: { Authorization: `Bearer ${account.token}`, 'X-Client-Platform': 'pc', 'X-Client-Version': CLIENT_VERSION } };
    return routeManager ? routeManager.request(path, options, true)
      : fetch(API + path, { ...options, redirect: 'error', credentials: 'omit', cache: 'no-store' });
  },
  persist: desktop.persistentAvatars === true ? (source, bytes, type, account) => desktop.cacheAvatar?.({ source: window.PulseAvatarSources.original(source), bytes, type, accountId: account.userId }) : undefined,
  drop: desktop.persistentAvatars === true ? (source, account) => desktop.dropAvatar?.({ source: window.PulseAvatarSources.original(source), accountId: account.userId }) : undefined,
  report: value => desktop.reportDiagnostic?.(value),
});
addEventListener('pagehide', () => avatarLoader.dispose(), { once: true });
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
    archive: '<path d="M4 8h16v12H4zM3 4h18v4H3zM12 10v7m-3-3 3 3 3-3"/>',
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
    ? `<img src="${escapeHtml(avatarUrl(user.avatar_url))}" alt="">`
    : escapeHtml(nickname.slice(0, 1));
  return `<div class="classic-drawer-avatar">${avatar}</div><div class="classic-drawer-user"><strong title="${escapeHtml(nickname)}">${escapeHtml(nickname)}</strong><small title="${escapeHtml(account)}">${escapeHtml(account)}</small></div>`;
}

function classicMenuAccountHtml(profile) {
  const name = (profile.current ? state.user?.nickname : '') || profile.displayName || profile.label || '待登录账号';
  const rawAvatar = profile.current ? state.user?.avatar_url : profile.avatarUrl;
  let avatar = '';
  try { const url = new URL(rawAvatar || '', API); if (rawAvatar && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) avatar = url.href; } catch {}
  return `<button type="button" class="classic-drawer-account ${profile.current ? 'is-current' : ''}" data-account-window="${escapeHtml(profile.id)}" ${profile.current ? 'aria-current="true"' : ''}><span class="classic-drawer-account-avatar">${avatar ? `<img src="${escapeHtml(avatar)}" alt="">` : escapeHtml(String(name).slice(0, 1))}</span><span class="classic-drawer-account-name">${escapeHtml(name)}</span>${profile.current ? '<span class="classic-drawer-account-check" aria-label="当前账号">✓</span>' : ''}</button>`;
}

function bindClassicMenuAccounts(backdrop) {
  const toggle = backdrop.querySelector('#classic-drawer-accounts-toggle');
  if (!toggle) return null;
  const section = backdrop.querySelector('#classic-drawer-accounts');
  const list = section.querySelector('[data-account-list]');
  const feedback = section.querySelector('[data-account-feedback]');
  const add = section.querySelector('[data-classic-menu-action="account"]');
  const account = { token: state.token, userId: Number(state.user?.id) };
  let disposed = false, revision = 0, busy = false, loading = null, refreshAgain = false, renderedHtml = null;
  const current = () => !disposed && backdrop.isConnected && sameSendAccount(account);
  const report = message => { feedback.textContent = message || ''; feedback.hidden = !message; };
  const setBusy = value => { busy = value; section.querySelectorAll('button').forEach(button => { button.disabled = value; }); };
  const render = profiles => {
    const html = profiles.map(classicMenuAccountHtml).join('');
    if (html === renderedHtml) return;
    const focused = document.activeElement?.closest('[data-account-window]')?.dataset.accountWindow;
    PulseMessageView.render(list, html, JSON.stringify([account.token, account.userId, 'account-list']));
    renderedHtml = html;
    list.querySelectorAll('.classic-drawer-account-avatar img').forEach(image => { image.onerror = () => {
      if (!image.isConnected) return;
      const initial = image.closest('button').querySelector('.classic-drawer-account-name').textContent.slice(0, 1);
      image.parentElement.textContent = initial;
    }; });
    list.querySelectorAll('[data-account-window]').forEach(button => { button.disabled = busy; });
    if (focused && !section.hidden) {
      const button = [...list.querySelectorAll('[data-account-window]')].find(button => button.dataset.accountWindow === focused) || toggle;
      if (document.activeElement !== button) button.focus();
    }
  };
  list.onclick = async event => {
    const button = event.target.closest('[data-account-window]');
    if (!button || !list.contains(button) || busy || !current() || button.getAttribute('aria-current') === 'true') return;
    setBusy(true); report('');
    try { await desktop.showAccountWindow(button.dataset.accountWindow); if (current()) closeSessionMenu(); }
    catch (error) { if (current()) report(error.message || '暂时无法切换账号，请重试。'); }
    finally { if (current()) setBusy(false); }
  };
  const refresh = () => {
    if (!current()) return;
    if (loading) { refreshAgain = true; return loading; }
    const request = ++revision;
    loading = Promise.resolve().then(async () => {
      try {
        const profiles = await desktop.listAccountWindows();
        if (current() && revision === request) {
          classicMenuAccountsCache = { ...account, profiles };
          render(profiles); report('');
        }
      } catch (error) { if (current() && revision === request) report(error.message || '账号列表暂时无法加载，请重新展开。'); }
      finally {
        loading = null;
        if (refreshAgain) { refreshAgain = false; if (current() && !section.hidden) refresh(); }
      }
    });
    return loading;
  };
  const updateExpanded = () => {
    section.hidden = !classicMenuAccountsExpanded;
    toggle.setAttribute('aria-expanded', String(classicMenuAccountsExpanded));
    toggle.setAttribute('aria-label', classicMenuAccountsExpanded ? '收起账号列表' : '展开账号列表');
  };
  toggle.onclick = () => {
    classicMenuAccountsExpanded = !classicMenuAccountsExpanded;
    updateExpanded();
    if (classicMenuAccountsExpanded) refresh();
  };
  add.onclick = async () => {
    if (busy || !current()) return;
    setBusy(true); report('');
    try { await desktop.openAccountWindow(); if (current()) closeSessionMenu(); }
    catch (error) { if (current()) report(error.message || '暂时无法添加账号，请重试。'); }
    finally { if (current()) setBusy(false); }
  };
  const cached = classicMenuAccountsCache;
  render(cached && cached.token === account.token && cached.userId === account.userId
    ? cached.profiles : [{ id: desktop.profileId || 'default', current: true }]);
  updateExpanded();
  if (classicMenuAccountsExpanded) refresh();
  const unsubscribe = desktop.onAccountWindowsChanged?.(() => { if (current() && !section.hidden) refresh(); });
  return () => { disposed = true; revision++; unsubscribe?.(); };
}

function openClassicMenu() {
  closeSessionMenu();
  const nightMode = document.body.classList.contains('desktop-night-mode');
  const accountsAvailable = !isDetachedConversation && desktop.openAccountWindow && desktop.listAccountWindows && desktop.showAccountWindow;
  document.body.insertAdjacentHTML('beforeend', `<div class="classic-menu-backdrop" id="classic-menu-backdrop"><aside class="classic-profile-drawer" role="dialog" aria-modal="true" aria-label="个人菜单"><div class="classic-drawer-scroll"><header class="classic-drawer-profile"><div class="classic-drawer-profile-main">${classicMenuUserHtml()}</div><div class="classic-drawer-profile-actions"><button type="button" data-classic-menu-action="qr" aria-label="我的二维码">${navIcon('qr')}</button><button type="button" data-classic-menu-action="star" aria-label="我的收藏">${navIcon('star')}</button></div>${accountsAvailable ? '<button type="button" id="classic-drawer-accounts-toggle" class="classic-drawer-accounts-toggle" aria-label="展开账号列表" aria-expanded="false" aria-controls="classic-drawer-accounts"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>' : ''}</header>${accountsAvailable ? `<section id="classic-drawer-accounts" class="classic-drawer-accounts" aria-label="账号列表" hidden><div data-account-list></div><button type="button" class="classic-drawer-account classic-drawer-account-add" data-classic-menu-action="account"><span class="classic-drawer-account-plus" aria-hidden="true">+</span><span>添加账号</span></button><p class="classic-drawer-account-feedback" data-account-feedback role="alert" hidden></p></section>` : ''}<nav class="classic-drawer-nav"><button type="button" data-classic-menu-action="group"><span class="classic-drawer-icon">${navIcon('group')}</span><span>新建群组</span></button><button type="button" data-classic-menu-action="channel"><span class="classic-drawer-icon">${navIcon('channel')}</span><span>新建频道</span></button><button type="button" data-classic-menu-action="contacts"><span class="classic-drawer-icon">${navIcon('friends')}</span><span>联系人</span></button><button type="button" data-classic-menu-action="calls"><span class="classic-drawer-icon">${navIcon('calls')}</span><span>通话记录</span></button><button type="button" data-classic-menu-action="settings"><span class="classic-drawer-icon">${navIcon('settings')}</span><span>设置</span></button><button type="button" class="classic-drawer-switch-row" data-classic-menu-action="night"><span class="classic-drawer-icon">${navIcon('moon')}</span><span>夜间模式</span><span class="classic-drawer-switch ${nightMode ? 'on' : ''}"><i></i></span></button><button type="button" class="classic-drawer-switch-row" data-classic-menu-action="translate"><span class="classic-drawer-icon">${navIcon('translate')}</span><span>自动翻译</span><span class="classic-drawer-switch is-disabled"><i></i></span></button></nav></div><footer class="classic-drawer-footer"><span>小猿口算<br>版本 ${escapeHtml(desktop.appVersion || CLIENT_VERSION)} – 关于</span></footer></aside></div>`);
  const backdrop = $('classic-menu-backdrop');
  if (desktop.isDesktop && !isDetachedConversation) {
    backdrop.querySelector('[data-classic-menu-action="translate"]')?.insertAdjacentHTML('afterend', `<button id="classic-drawer-archive" type="button" data-classic-menu-action="archive"><span class="classic-drawer-icon">${navIcon('archive')}</span><span>归档</span><span class="conversation-archive-badge" aria-hidden="true" hidden></span></button>`);
    syncConversationArchiveMenu();
  }
  if (desktop.isDesktop && state.user?.internal_staff) backdrop.querySelector('.classic-drawer-nav')?.insertAdjacentHTML('beforeend', `<button type="button" data-classic-menu-action="broadcast"><span class="classic-drawer-icon">${navIcon('messages')}</span><span>群发助手</span></button>`);
  syncNightModeControls();
  const avatarImage = backdrop.querySelector('.classic-drawer-avatar img');
  avatarImage?.addEventListener('error', () => {
    avatarImage.remove();
    backdrop.querySelector('.classic-drawer-avatar').textContent = (state.user?.nickname || '猿').slice(0, 1);
  });
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeSessionMenu(); });
  backdrop.querySelectorAll('.classic-drawer-profile-actions [data-classic-menu-action], .classic-drawer-nav [data-classic-menu-action]').forEach((button) => { button.onclick = () => handleClassicMenuAction(button.dataset.classicMenuAction); });
  disposeClassicMenuAccounts = bindClassicMenuAccounts(backdrop);
  backdrop.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSessionMenu(); $('classic-menu-button')?.focus(); } };
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
  if (action === 'account') { try { return await desktop.openAccountWindow?.(); } catch (error) { alert(error.message || '暂时无法添加账号'); } return; }
  if (action === 'translate') return toggleAutoTranslate();
  if (action === 'qr') return openQrCode();
  if (action === 'star') return openFavorites();
  if (action === 'archive') return openConversationArchive();
  if (action === 'broadcast' && desktop.isDesktop && state.user?.internal_staff) return broadcastAssistant.open();
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
  const generateQrCode = typeof desktop.generateQrCode === 'function' ? desktop.generateQrCode.bind(desktop) : null;
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
  // Applying grid widths inside this observer resizes its descendants again.
  // Coalesce the layout write into the next frame to avoid observer loops.
  let resizeFrame = 0;
  const observer = new ResizeObserver(() => {
    if (!resizeFrame) resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (!controller.signal.aborted && shell.isConnected) apply();
    });
  });
  observer.observe(shell); observer.observe(sidebar);
  if (info) observer.observe(info);
  updateConversationSidebarWidth = apply;
  disposeConversationSidebarResize = () => {
    finish(false); controller.abort(); observer.disconnect(); cancelAnimationFrame(resizeFrame); handle.remove();
    if (updateConversationSidebarWidth === apply) updateConversationSidebarWidth = null;
    disposeConversationSidebarResize = null;
  };
  apply();
}

function renderShell() {
  if (state.token && state.user) void textOutbox.restore(textOutboxAccount()).then(() => renderTextOutbox());
  imageViewer.close(false);
  state.archiveView = false; state.archiveFeedback = '';
  closeSessionMenu();
  contactActionRevision++;
  disposeConversationSidebarResize?.();
  disposeAuthView?.(); disposeAuthView = null;
  resetChatHistoryLocation();
  resetComposerForNavigation();
  closeImageSendPreview();
  if (state.groupInfoDialog) closeFeatureModal();
  clearTimeout(state.chatSearch?.timer);
  state.chatSearch = null;
  groupSidebar.close();
  state.chatInfo = null;
  document.body.classList.toggle('desktop-mode', Boolean(desktop.isDesktop));
  document.body.classList.toggle('conversation-window', isDetachedConversation);
  state.page = 'messages';
  const nav = desktop.isDesktop ? '<nav class="desktop-nav" aria-hidden="true"></nav>' : '';
  document.body.innerHTML = `<main class="chat-shell${desktop.isDesktop ? ' desktop-app-shell' : ''}">${nav}<aside class="sidebar"><div class="side-head"><div class="side-title"><div><h1>小猿口算</h1><p>即时通讯工作台</p></div><button id="new-group" class="icon-button" type="button" title="创建群组">+</button></div><div class="side-actions"><button id="contacts-button" type="button">联系人</button></div><input id="message-search" class="search" placeholder="搜索消息"></div><div id="conversation-list" class="conversation-list"></div><div class="profile"><button id="profile-settings" class="profile-name" type="button"><span id="profile-name"></span><small>账户设置</small></button><button id="logout">退出登录</button></div></aside><section class="main"><header id="chat-head" class="chat-head"><div class="chat-peer"><span id="chat-avatar" class="avatar">聊</span><div><h2 id="chat-title">请选择会话</h2><small id="chat-subtitle">消息会实时同步</small></div></div><div class="chat-head-tools"><span id="chat-user-meta" aria-hidden="true"></span><button type="button" title="搜索聊天记录">⌕</button><button type="button" title="查看资料">▣</button><button type="button" title="更多操作">•••</button><button id="group-manage" class="secondary-button" type="button" hidden>群组管理</button></div></header><div id="messages" class="messages"><p class="empty">请选择一个会话开始聊天</p></div><form id="composer" class="composer"><input id="image-picker" type="file" accept="image/*" hidden><input id="file-picker" type="file" hidden><button id="file-button" type="button" title="发送文件" aria-label="发送文件">${navIcon('folder')}</button><button id="image-button" type="button" title="发送图片" aria-label="发送图片">${navIcon('scissors')}</button><button type="button" class="visual-tool" title="表情" aria-label="表情">${navIcon('smile')}</button><button id="record-button" type="button" title="录音" aria-label="录音">${navIcon('microphone')}</button><button type="button" class="visual-tool" title="语音通话" aria-label="语音通话">${navIcon('calls')}</button><button type="button" class="visual-tool" title="视频通话" aria-label="视频通话">${navIcon('camera')}</button>${desktop.isDesktop ? "<textarea id=\"message-input\" rows=\"3\" placeholder=\"输入消息\" aria-label=\"输入消息\" autocomplete=\"off\"></textarea>" : "<input id=\"message-input\" placeholder=\"输入消息\" autocomplete=\"off\">"}<button class="primary">发送</button></form><section id="directory-panel" class="directory-panel" hidden></section></section></main>`;
  const composer = $('composer');
  composer.querySelectorAll('#file-picker, #file-button, #record-button, [title="语音通话"], [title="视频通话"]').forEach((node) => node.remove());
  $('image-button').innerHTML = navIcon('image');
  $('image-button').title = '图片'; $('image-button').setAttribute('aria-label', '发送图片');
  composer.insertAdjacentHTML('afterbegin', '<input id="video-picker" type="file" accept="video/*" hidden>');
  const emojiButton = composer.querySelector('[title="表情"]');
  emojiButton.id = 'emoji-button';
  emojiButton.insertAdjacentHTML('afterend', `<button id="video-button" type="button" title="视频" aria-label="发送视频">${navIcon('video')}</button><button id="contact-card-button" type="button" title="发送名片" aria-label="发送站内名片">${navIcon('contactCard')}</button><button id="shake-button" type="button" title="窗口抖动" aria-label="发送窗口抖动">${navIcon('shake')}</button>`);
  $('logout').onclick = () => leaveAccount({ reload: true });
  applyChatTheme(getChatTheme(), false);
  $('profile-settings').onclick = openSettings;
  $('new-group').onclick = createGroup;
  $('contacts-button').onclick = () => desktop.isDesktop ? switchPage('friends') : openContacts();
  if (desktop.isDesktop) {
    document.querySelector('.desktop-app-shell').insertAdjacentHTML('beforeend', '<aside id="chat-info-panel" class="classic-info-panel" aria-label="会话资料" hidden></aside><button id="chat-info-collapse" class="classic-info-collapse" type="button" aria-controls="chat-info-panel" title="收起资料" hidden><span aria-hidden="true">›</span></button>');
    $('chat-info-collapse').onclick = dismissChatInfo;
    $('conversation-list').insertAdjacentHTML('beforebegin', '<section id="chat-search-panel" class="classic-search-panel" aria-label="搜索消息" hidden></section>');
    document.querySelector('.side-head').innerHTML = `<div class="session-toolbar"><button id="classic-menu-button" class="classic-menu-button" type="button" aria-label="打开菜单">${navIcon('hamburger')}</button><label class="session-search" for="message-search"><span class="classic-search-icon" aria-hidden="true">${navIcon('search')}</span><input id="message-search" class="search" placeholder="搜索" aria-label="搜索会话" autocomplete="off" spellcheck="false"></label><button id="session-add" class="session-add" type="button" aria-label="添加好友" title="添加好友与消息通知">${navIcon('contactAdd')}<span id="friend-request-badge" class="activity-toolbar-badge" aria-hidden="true" hidden></span></button></div><div class="classic-tabs"><button class="classic-tab active" type="button" data-page="messages" aria-current="page"><span class="classic-tab-icon">${classicTabIcon('messages')}</span><span>聊天</span></button><button class="classic-tab" type="button" data-page="friends"><span class="classic-tab-icon">${classicTabIcon('friends')}</span><span>好友</span></button><button class="classic-tab" type="button" data-page="groups"><span class="classic-tab-icon">${classicTabIcon('groups')}</span><span>群聊</span></button></div>`;
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
  $('chat-info-button').onclick = () => openChatConversationInfo({ toggle: true });
  $('chat-more-button').onclick = toggleChatMoreMenu;
  if (desktop.isDesktop) {
    const avatar = document.createElement('button');
    avatar.id = 'chat-avatar'; avatar.className = 'avatar chat-peer-avatar'; avatar.type = 'button';
    avatar.disabled = true; avatar.setAttribute('aria-label', '查看会话资料');
    $('chat-avatar').replaceWith(avatar);
  }
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
  $('image-picker').onchange = (event) => desktop.isDesktop ? openImageSendPreview([...event.target.files]) : sendMediaFile('image', event.target.files[0]);
  $('video-picker').onchange = (event) => sendMediaFile('video', event.target.files[0]);
  if (desktop.isDesktop) {
    $('image-picker').accept = 'image/jpeg,image/png,image/gif,image/webp';
    $('image-picker').multiple = true;
    $('composer').addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.files || [])].filter(item => item.type.startsWith('image/'));
      if (files.length && state.active) { event.preventDefault(); openImageSendPreview(files); }
    });
  }
  $('message-search').onkeydown = (event) => { if (event.key === 'Enter') searchMessages(event.target.value); };
  if (desktop.isDesktop) {
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
  if (desktop.isDesktop) globalThis.PulseDesktopChat?.bind({ state, detached: isDetachedConversation, navigate: openConversation, leave: closeConversationView, search: openChatHistorySearch, closeEmoji: closeComposerEmoji, canSendFiles: desktopMediaSendAllowed, sendFiles: sendDroppedMedia, imageDropTarget: () => currentImageSendDraft(state.imageDraft) && desktopMediaSendAllowed() ? state.imageDraft.modal : null, feedback: imageSendFeedback });
  if (desktop.isDesktop) globalThis.PulseChatBottom?.bind({
    context:()=>({token:state.token,userId:Number(state.user?.id),id:Number(state.active?.id),navigation:state.historyEpoch,located:Boolean(state.historyLocation),
      allowed:Boolean(state.token&&state.user&&state.active&&state.page==='messages'&&!state.favoriteMode&&!state.updateRequired&&state.desktopAccountVisible!==false&&!readPasscodeSettings().locked&&!document.hidden)}),
    jump:returnChatToBottom,feedback:composerFeedback
  });
  if(desktop.isDesktop) globalThis.PulseGroupMentions?.bind({
    context:()=>({token:state.token,userId:Number(state.user?.id),id:Number(state.active?.id),navigation:state.historyEpoch,role:state.active?.my_role,staff:state.user?.internal_staff===true,
      allowed:Boolean(state.token&&state.user&&state.active?.type==='group'&&state.page==='messages'&&!state.favoriteMode&&!state.updateRequired&&state.desktopAccountVisible!==false&&!readPasscodeSettings().locked&&!document.hidden&&!$('message-input')?.disabled&&!$('message-input')?.readOnly)}),
    request:(id,q,page,token,signal)=>api(`/conversations/groups/mention-members?conversation_id=${id}&q=${encodeURIComponent(q)}&page=${page}`,{authToken:token,signal}),
    avatar:avatarUrl,feedback:composerFeedback,closeEmoji:closeComposerEmoji
  });
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
      actions = [['info', '查看群组信息'], ['mute', profile.notifications_muted ? '开启消息通知' : '关闭消息通知'], ['invite', '邀请新成员'], ['clear', '清空历史记录']];
      if (!canInviteGroup(profile)) actions = actions.filter(([action]) => action !== 'invite');
      if (profile.can_manage) actions.splice(1, 0, ['manage', '管理群组']);
    } catch (error) {
      if (menu.isConnected) { closeChatMoreMenu(); alert(error.message); }
      return;
    }
  }
  if (!menu.isConnected) return;
  if (desktop.isDesktop && desktop.openHistoryWindow) actions.splice(conversation.type === 'group' ? 1 : 2, 0, ['history', '聊天记录']);
  menu.innerHTML = actions.map(([action, label]) => `<button type="button" role="menuitem" data-chat-menu="${action}">${label}</button>`).join('');
  menu.querySelectorAll('[data-chat-menu]').forEach((button) => {
    button.onclick = () => {
      closeChatMoreMenu();
      const handlers = { search: openChatHistorySearch, history: openDetachedChatHistory, info: openChatMenuConversationInfo, manage: openGroupManager,
        mute: toggleGroupNotifications, invite: openGroupInvite, clear: clearActiveChatHistory };
      return handlers[button.dataset.chatMenu]?.();
    };
  });
}

async function openDetachedChatHistory() {
  const conversation = state.active, account = { token: state.token, userId: Number(state.user?.id) };
  if (!conversation || !sameSendAccount(account) || readPasscodeSettings().locked || state.desktopAccountVisible === false || !desktop.openHistoryWindow) return;
  try {
    await syncNativeRoute();
    await desktop.openHistoryWindow({ conversationId: Number(conversation.id), conversationWireId: GO.wire('conversation',conversation.id), accountId: account.userId, token: account.token,
      title: conversation.name || '当前会话', type: conversation.type, theme: document.body.dataset.theme || getChatTheme() });
  } catch (error) { if (sameSendAccount(account)) composerFeedback(error.message || '聊天记录窗口打开失败，请重试。'); }
}

function openChatMenuConversationInfo() {
  if (desktop.isDesktop && state.active?.type === 'group') return openGroupInfoDialog();
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
  const actions = [['invite', '邀请新成员'], ['clear', '清空历史记录']];
  if (!canInviteGroup(info.conversation)) actions.splice(0, 1);
  if (info.conversation.can_manage) actions.unshift(['manage', '管理群组']);
  info.modal.querySelector('.classic-group-info-dialog').insertAdjacentHTML('beforeend', `<div id="group-info-menu" class="classic-group-info-menu" role="menu" aria-label="群组操作">${actions.map(([action, label]) => `<button type="button" role="menuitem" data-group-info-action="${action}">${label}</button>`).join('')}</div>`);
  $('group-info-menu').querySelectorAll('[data-group-info-action]').forEach(button => {
    button.onclick = () => {
      if (state.groupInfoDialog !== info || Number(state.active?.id) !== info.id) return;
      const action = button.dataset.groupInfoAction;
      closeFeatureModal();
      const handlers = { invite: openGroupInvite, clear: clearActiveChatHistory, manage: openGroupManager };
      return handlers[action]?.();
    };
  });
}

function renderGroupInfoDialog(info) {
  if (state.groupInfoDialog !== info || !info.modal.isConnected || Number(state.active?.id) !== info.id || !sameSendAccount(info.account)) return;
  const conversation = info.conversation;
  const focusedId = info.modal.contains(document.activeElement) ? document.activeElement.id : '';
  const muted = info.saving ? info.pendingMuted : conversation.notifications_muted;
  renderStableConversationContent(info.modal.querySelector('.classic-group-info-dialog'), `<header class="classic-group-info-header"><h2 id="group-info-title">群组信息</h2><button id="group-info-more" type="button" aria-label="群组更多操作" aria-haspopup="menu" aria-expanded="${info.menuOpen ? 'true' : 'false'}" ${!info.loaded ? 'disabled' : ''}>${navIcon('more')}</button><button id="group-info-close" type="button" aria-label="关闭群组信息"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="classic-group-info-peer"><span class="classic-group-info-avatar">${panelAvatarHtml(conversation)}</span><strong title="${escapeHtml(conversation.name || '未命名群组')}">${escapeHtml(conversation.name || '未命名群组')}</strong></div><div class="classic-group-info-divider"></div><label class="classic-group-info-notification">${navIcon('bell')}<span>通知</span><input id="group-info-notifications" type="checkbox" role="switch" aria-label="群消息通知" ${!muted ? 'checked' : ''} ${!info.loaded || info.saving ? 'disabled' : ''}><span class="classic-group-info-switch" aria-hidden="true"></span></label><p id="group-info-feedback" class="classic-group-info-feedback" role="status">${escapeHtml(info.error || (!info.loaded ? '正在读取群组信息…' : ''))}</p>${info.error && !info.loaded ? '<button id="group-info-retry" class="classic-group-info-retry" type="button">重新加载</button>' : ''}<div class="classic-group-info-divider classic-group-info-bottom"></div>`, info.id);
  $('group-info-close').onclick = closeGroupInfoDialog;
  $('group-info-more').onclick = () => { info.menuOpen = !info.menuOpen; renderGroupInfoMenu(info); };
  $('group-info-notifications').onchange = event => saveGroupInfoNotification(info, !event.target.checked);
  $('group-info-notifications').checked = !muted;
  if ($('group-info-retry')) $('group-info-retry').onclick = () => loadGroupInfoDialogProfile(info);
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
  if (state.groupInfoDialog !== info || !info.loaded || info.saving || !sameSendAccount(info.account)) return;
  info.saving = true;
  info.pendingMuted = muted;
  info.error = '';
  renderGroupInfoDialog(info);
  try {
    const profile = await api('/conversations/groups/settings', { method: 'POST', authToken: info.account.token, body: JSON.stringify({ conversation_id: info.id, notifications_muted: muted }) });
    if (state.groupInfoDialog !== info || !sameSendAccount(info.account) || Number(state.active?.id) !== info.id) return;
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
  if (state.groupInfoDialog !== info || info.loading || !sameSendAccount(info.account)) return;
  info.loading = true;
  info.error = '';
  renderGroupInfoDialog(info);
  try {
    const profile = await api(`/conversations/groups/profile?conversation_id=${info.id}`, { authToken: info.account.token });
    if (state.groupInfoDialog !== info || !info.modal.isConnected || Number(state.active?.id) !== info.id || !sameSendAccount(info.account)) return;
    Object.assign(info.conversation, profile);
    info.loaded = true;
  } catch (error) { info.error = error.message || '群组信息加载失败，请重试'; }
  finally { info.loading = false; renderGroupInfoDialog(info); }
}

async function openGroupInfoDialog() {
  const conversation = state.active;
  if (conversation?.type !== 'group') return;
  closeChatMoreMenu();
  closeGroupManager();
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', '<div class="modal-backdrop feature-modal classic-group-info-backdrop" data-feature-modal><section class="classic-group-info-dialog" role="dialog" aria-modal="true" aria-labelledby="group-info-title" tabindex="-1"></section></div>');
  const info = { id: Number(conversation.id), account: { token: state.token, userId: Number(state.user?.id) }, conversation, loaded: false, loading: false, saving: false, error: '', menuOpen: false, modal: document.querySelector('[data-feature-modal]'), opener: $('chat-more-button') };
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
    const result = await api('/messages/clear-history', { method: 'POST', body: JSON.stringify({ conversation_id: conversation.id, through_message_id: conversation.message_seq }) });
    conversation.cleared_before_message_id = result.cleared_before_message_id;
    void localChat.clearConversation(Number(conversation.id), Number(result.cleared_before_message_id)); purgeLocalMedia(conversation.id);
    if (Number(state.active?.id) === Number(conversation.id)) {
      resetChatHistoryLocation();
      state.historyPage = 1; state.historyHasMore = false;
      $('messages').innerHTML = '<p class="empty">历史记录已清空，新消息将显示在这里</p>';
      if (state.chatSearch) runChatSearch();
    }
    await loadConversations();
  });
}

const groupPollCache = new Map();
let groupPollRefreshBusy = false;

function groupPollHtml() { return '<small>历史投票记录（只读）</small>'; }

function bindGroupPollActions() {}
function refreshGroupPollCards() {}

document.addEventListener('pointerdown', (event) => {
  if (event.target instanceof Element && !event.target.closest('#chat-more-button,#chat-more-menu')) closeChatMoreMenu();
});

// A group stays expanded until its close control is used. Navigation only
// disposes the current view; the choice belongs to this account and group.
const groupChatInfoVisibility = new Map();
function groupChatInfoPreferenceKey(conversation = state.active) {
  return desktop.isDesktop && state.user?.id && conversation?.type === 'group'
    ? 'pulse_group_info_expanded:' + JSON.stringify([API, Number(state.user.id), Number(conversation.id)]) : '';
}
function groupChatInfoExpanded(conversation) {
  const key = groupChatInfoPreferenceKey(conversation);
  if (!key) return false;
  if (!groupChatInfoVisibility.has(key)) {
    let expanded = true;
    try { expanded = localStorage.getItem(key) !== '0'; } catch { /* Keep the default when storage is unavailable. */ }
    groupChatInfoVisibility.set(key, expanded);
  }
  return groupChatInfoVisibility.get(key);
}
function rememberGroupChatInfo(expanded, conversation = state.active) {
  const key = groupChatInfoPreferenceKey(conversation);
  if (!key) return;
  groupChatInfoVisibility.set(key, expanded);
  try { if (expanded) localStorage.removeItem(key); else localStorage.setItem(key, '0'); }
  catch { /* The choice still lasts for this window. */ }
}
function chatInfoScope() { return messageForwardNavigationRevision + ':' + state.page + ':' + state.sidebarMode; }
function syncDefaultGroupChatInfo() {
  if (!desktop.isDesktop || !$('chat-info-panel')) return;
  const conversation = state.active;
  const allowed = state.token && state.user && state.page === 'messages' && !state.favoriteMode
    && !state.updateRequired && !readPasscodeSettings().locked && state.desktopAccountVisible !== false;
  if (!allowed || !groupChatInfoExpanded(conversation)) {
    if (state.chatInfo?.type === 'group') closeChatInfo();
    return;
  }
  const info = state.chatInfo;
  if (info?.id === Number(conversation.id) && info.scope === chatInfoScope() && sameSendAccount(info.account)) return;
  void openDesktopChatInfo(conversation, { automatic: true });
}
function dismissChatInfo() {
  if (state.chatInfo?.id === Number(state.active?.id)) rememberGroupChatInfo(false);
  closeChatInfo();
  $('chat-info-button')?.focus();
}

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
  groupSidebar.close();
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
  return conversation.avatar_url ? `<img src="${escapeHtml(avatarUrl(conversation.avatar_url))}" alt="">` : escapeHtml((conversation.name || '群').slice(0, 1));
}

const groupSidebar = PulseGroupSidebar.create({
  context: () => ({token:state.token,userId:Number(state.user?.id),id:Number(state.active?.id),conversation:state.active,base:API,
    scope:chatInfoScope(),
    blocked:Boolean(state.updateRequired || readPasscodeSettings().locked || state.desktopAccountVisible===false)}),
  active:info=>state.chatInfo===info, request:(route,options)=>api(route,options), icon:navIcon, escape:escapeHtml,
  mediaUrl:value=>avatarUrl(value), publicId:publicUserId, presence:contactLastSeenText,
  changed:(profile,account)=>{
    if(!sameSendAccount(account))return;
    const row=state.conversations.find(item=>Number(item.id)===Number(profile.id));if(row)Object.assign(row,profile);
    if(Number(state.active?.id)===Number(profile.id)){Object.assign(state.active,profile);updateDesktopChat();renderConversationList();}
  },
  manage:()=>openGroupManager(), invite:()=>openGroupInvite(), profile:(id, groupId)=>openContactProfile(id, groupId),
  memberMenu:options=>globalThis.PulseMessageActions?.memberMenu(options),
  closePanel:dismissChatInfo
});

function renderChatInfoPanel(info) {
  if (state.chatInfo !== info || Number(state.active?.id) !== info.id) return;
  if (state.active?.type === 'group') { groupSidebar.sync(state.active); return; }
  const conversation = state.active;
  const title = conversation.type === 'group' ? '群组信息' : '会话信息';
  $('chat-info-panel').innerHTML = `<header class="classic-info-head"><h2>${title}</h2><button id="chat-info-close" type="button" aria-label="关闭会话资料">×</button></header><div class="classic-info-peer"><span class="classic-panel-avatar">${panelAvatarHtml(conversation)}</span><strong>${escapeHtml(conversation.name || '未命名会话')}</strong></div><div class="classic-panel-divider"></div>${conversation.type === 'group' ? `<label class="classic-info-notification">${navIcon('bell')}<span>通知</span><input id="chat-info-notifications" type="checkbox" role="switch" aria-label="群消息通知" ${!conversation.notifications_muted ? 'checked' : ''} ${!info.loaded || info.saving ? 'disabled' : ''}><span class="classic-panel-switch" aria-hidden="true"></span></label><div class="classic-panel-divider"></div>` : ''}<p id="chat-info-feedback" class="classic-panel-feedback" role="status">${escapeHtml(info.error || (!info.loaded ? '正在读取群组信息…' : ''))}</p>${info.error && !info.loaded ? '<button id="chat-info-retry" class="classic-panel-retry" type="button">重新加载</button>' : ''}`;
  $('chat-info-close').onclick = dismissChatInfo;
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
  groupSidebar.sync(state.active);
  const dialog = state.groupInfoDialog;
  if (dialog?.loaded && !dialog.saving && Number(state.active?.id) === dialog.id) renderGroupInfoDialog(dialog);
  const info = state.chatInfo;
  if (!info || info.saving || !info.loaded || Number(state.active?.id) !== info.id) return;
  const input = $('chat-info-notifications');
  if (input) input.checked = !state.active.notifications_muted;
}

async function loadChatInfoProfile(info) {
  if (state.active?.type === 'group') return groupSidebar.reload();
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

async function openDesktopChatInfo(conversation, { automatic = false } = {}) {
  if (state.chatInfo?.id === Number(conversation.id) && state.chatInfo.scope === chatInfoScope() && sameSendAccount(state.chatInfo.account)) return;
  closeChatInfo();
  if (!automatic) { rememberGroupChatInfo(true, conversation); closeFeatureModal(); }
  const info = { id: Number(conversation.id), type: conversation.type, scope: chatInfoScope(), account: { token: state.token, userId: Number(state.user?.id) }, loaded: conversation.type !== 'group', saving: false, error: '' };
  state.chatInfo = info;
  document.querySelector('.desktop-app-shell').classList.add('has-chat-info');
  $('chat-info-panel').hidden = false;
  updateConversationSidebarWidth?.();
  syncChatInfoToggle();
  if (conversation.type === 'group') await groupSidebar.open(info, $('chat-info-panel'));
  else renderChatInfoPanel(info);
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
  $('chat-search-panel').innerHTML = `<div class="classic-search-heading">搜索消息</div><div class="classic-search-scope"><span class="classic-panel-avatar">${panelAvatarHtml(conversation)}</span><span class="classic-search-scope-name">${navIcon(conversation.type === 'group' ? 'groups' : 'friends')}<strong>${escapeHtml(conversation.name || '当前会话')}</strong></span><button id="chat-search-close" type="button" title="关闭搜索" aria-label="关闭消息搜索">×</button></div>${filters ? `<div class="classic-search-active-filters">${filters}</div>` : ''}<div class="classic-search-heading classic-search-summary">${search.page ? `搜索消息 · ${search.total} 条` : '搜索消息'}</div><div class="classic-sidebar-search-results" aria-live="polite">${search.items.map(message => `<article class="classic-sidebar-search-result"><header><strong data-contact-name-user="${Number(message.sender_id) || 0}" data-contact-name-fallback="${escapeHtml(message.sender_name || message.sender_nickname || '群成员')}">${escapeHtml(contactDisplayName(message.sender_id, message.sender_name || message.sender_nickname || '群成员'))}</strong><time>${escapeHtml(message.created_at || '')}</time></header><p>${highlightChatSearchText(message.body?.text || message.body?.name || `[${messageType(message.type)}消息]`, search.keyword)}</p></article>`).join('')}<p class="classic-search-status" role="status">${escapeHtml(search.status || (search.loading ? '正在搜索…' : search.page && !search.items.length ? '没有找到相关消息' : ''))}</p>${search.page && search.items.length < search.total ? `<button id="chat-search-more" class="classic-search-more" type="button" ${search.loading ? 'disabled' : ''}>${search.loading ? '正在加载…' : '加载更多'}</button>` : ''}</div>`;
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
  else if (!document.querySelector('.modal-backdrop')) { if (state.chatInfo && state.active?.type !== 'group') closeChatInfo(); else if (state.chatSearch) closeChatSearch(); }
});

function openChatHistorySearch() {
  closeChatMoreMenu();
  const conversation = state.active;
  if (!conversation) return;
  if (desktop.isDesktop && !isDetachedConversation) return openDesktopChatSearch(conversation);
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

function openChatConversationInfo({ toggle = false } = {}) {
  closeChatMoreMenu();
  const conversation = state.active;
  if (!conversation) return;
  if (conversation.type === 'direct') {
    const peerId = Number(conversation.peer_user_id);
    if (!Number.isSafeInteger(peerId) || peerId <= 0) return composerFeedback('未取得联系人资料，请重新打开会话后重试。');
    closeChatInfo();
    return openContactProfile(peerId);
  }
  if (desktop.isDesktop) {
    if (toggle && state.chatInfo?.id === Number(conversation.id)) return dismissChatInfo();
    return openDesktopChatInfo(conversation);
  }
  if (conversation.type === 'group') return openGroupManager(false);
  closeFeatureModal();
  const name = conversation.name || '未命名会话';
  const avatar = conversation.avatar_url ? `<img src="${escapeHtml(avatarUrl(conversation.avatar_url))}" alt="">` : escapeHtml(name.slice(0, 1));
  const type = conversation.type === 'favorites' ? '我的收藏' : conversation.type === 'channel' ? '频道' : '单聊';
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal><section class="feature-card classic-conversation-info" role="dialog" aria-modal="true" aria-label="会话资料"><header><h2>会话资料</h2><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header><div class="classic-conversation-info-body"><span class="avatar">${avatar}</span><h3>${escapeHtml(name)}</h3><p>${type}</p><small>创建时间：${escapeHtml(conversation.created_at || '暂无记录')}</small></div></section></div>`);
  bindFeatureModal();
}

async function refreshFriendRequestBadge() { await activityCenter.refresh(); }

function renderDesktopChatHeader(conversation) {
  if (!desktop.isDesktop || !conversation) return;
  syncChatInfoToggle();
  const title = conversation.name || (conversation.type === 'direct' ? '单聊' : '会话');
  const isMemberConversation = ['group', 'channel'].includes(conversation.type);
  const internalProfile = conversation.type === 'direct' && state.user?.internal_staff ? conversation.internal_profile : null;
  const titleNode = $('chat-title');
  titleNode.textContent = title;
  const peerId = Number(conversation.peer_user_id);
  const avatarNode = $('chat-avatar');
  const account = { token: state.token, userId: Number(state.user?.id) };
  const conversationId = Number(conversation.id), conversationType = conversation.type;
  avatarNode.disabled = !isMemberConversation && !(conversation.type === 'direct' && Number.isSafeInteger(peerId) && peerId > 0 && peerId !== account.userId);
  avatarNode.setAttribute('aria-label', `查看${title}的${conversation.type === 'direct' ? '个人' : '会话'}资料`);
  avatarNode.title = conversation.type === 'direct' ? '查看个人资料' : '查看会话资料';
  avatarNode.onclick = () => {
    if (avatarNode.disabled || !avatarNode.isConnected || state.page !== 'messages' || state.favoriteMode || state.desktopAccountVisible === false
      || !contactActionsAllowed(account) || Number(state.active?.id) !== conversationId || state.active?.type !== conversationType
      || (conversationType === 'direct' && Number(state.active?.peer_user_id) !== peerId)) return;
    return openChatConversationInfo();
  };
  $('chat-subtitle').textContent = isMemberConversation
    ? (conversation.member_count != null && Number.isSafeInteger(Number(conversation.member_count)) && Number(conversation.member_count) >= 0 ? `${Number(conversation.member_count)} 位成员` : '成员数加载中…')
    : (conversation.type === 'favorites' ? '' : conversation.type === 'direct' ? internalProfile ? internalChatHeaderText(internalProfile, conversation) : chatPresenceText(conversation) : '最近上线时间和资料信息');
  // 顶部只保留头像、名称和副标题，避免重复显示“用户信息／群组：xxx”。
  $('chat-user-meta').textContent = '';
  chatHeaderAvatars.render(avatarNode, conversation.avatar_url ? avatarUrl(conversation.avatar_url) : '',
    conversationViewAccount(), Array.from(title)[0] || '?');
  $('group-manage').hidden = conversation.type !== 'group';
}

function formatPresenceTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const date = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return raw;
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function chatPresenceText(conversation) {
  // Presence comes from the current conversation snapshot, never login history.
  if (conversation.peer_online === true) return '在线';
  if (conversation.peer_online !== false || !conversation.peer_last_seen_at) return '在线状态未知';
  return `离线 · 最近在线：${formatPresenceTime(conversation.peer_last_seen_at)}`;
}

function internalChatHeaderText(profile, conversation) {
  return [chatPresenceText(conversation), profile.last_login_ip, profile.last_login_location]
    .filter(value => String(value || '').trim())
    .join(' · ');
}

async function refreshChatHeaderProfile(conversationId) {
  const conversation = state.active;
  const account = { token: state.token, userId: Number(state.user?.id) };
  if (!conversation || Number(conversation.id) !== Number(conversationId)) return;
  if (conversation.type === 'direct') {
    if (!state.user?.internal_staff || !conversation.peer_user_id) return;
    try {
      const profile = await api(`/contacts/internal-profile?user_id=${Number(conversation.peer_user_id)}`);
      if (!sameSendAccount(account) || Number(state.active?.id) !== Number(conversationId) || Number(state.active?.peer_user_id) !== Number(conversation.peer_user_id)) return;
      state.active.internal_profile = profile;
      renderDesktopChatHeader(state.active);
    } catch {
      // 内部资料接口失败时保留普通聊天头部，不影响消息收发。
    }
    return;
  }
  if (conversation.type !== 'group') return;
  try {
    const profile = await api(`/conversations/groups/profile?conversation_id=${Number(conversationId)}`);
    if (!sameSendAccount(account) || Number(state.active?.id) !== Number(conversationId)) return;
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
  if (desktop.isDesktop && state.desktopAccountVisible === false) { state.conversationViewDirty = true; return; }
  composerDrafts.refresh();
  renderTextOutbox(); textOutbox.resume();
  updateComposerConversationTools();
  globalThis.PulseDesktopChat?.refresh();
  globalThis.PulseChatBottom?.refresh();
  globalThis.PulseGroupMentions?.refresh();
  syncDefaultGroupChatInfo();
  if (!desktop.isDesktop || state.page !== 'messages') return;
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
  if (!state.active) $('messages').innerHTML = '<div class="desktop-chat-idle" role="status"><span>请选择一个对话开始聊天</span></div>';
}

async function openFavorites() {
  if (!foregroundReadsAllowed()) return;
  cancelDirectoryRequests(); cancelConversationRecovery();
  const request = { token: state.token, userId: Number(state.user.id), controller: new AbortController() }; state.favoriteLoad = request;
  const current = () => state.favoriteLoad === request && !request.controller.signal.aborted && foregroundReadsAllowed()
    && state.token === request.token && Number(state.user?.id) === request.userId;
  state.archiveView = false; state.archiveFeedback = '';
  closeContactProfile();
  resetChatHistoryLocation();
  resetComposerForNavigation();
  if (!desktop.isDesktop) return openSimpleDrawerFeature('我的收藏', '请使用电脑端查看收藏内容。');
  closeSessionMenu();
  closeChatMoreMenu();
  closeFeatureModal();
  closeChatPanels();
  try {
    const favorite = await api('/conversations/favorites', { authToken: request.token, signal: request.controller.signal, method: 'POST', body: JSON.stringify({}) });
    if (!current()) return;
    state.page = 'messages';
    state.sidebarMode = 'messages';
    state.favoriteMode = true;
    state.active = favorite;
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
    const result = await api(`/messages/history?conversation_id=${favorite.id}&size=50`, { authToken: request.token, signal: request.controller.signal });
    if (!current()) return;
    const messages = (result.items || []).reverse();
    $('messages').innerHTML = messages.map(messageHtml).join('') || '<p class="empty">暂无收藏内容</p>';
    bindMessageActions();
    $('messages').scrollTop = $('messages').scrollHeight;
    await markMessagesRead(messages);
    if (!current()) return;
    await loadConversations();
    if (!current()) return;
    updateDesktopChat();
  } catch (error) {
    if (current()) alert(error.message || '打开我的收藏失败');
  } finally { if (state.favoriteLoad === request) state.favoriteLoad = null; }
}

function toggleSessionMenu() { if ($('classic-menu-backdrop')) closeSessionMenu(); else openClassicMenu(); }
function closeSessionMenu() { disposeClassicMenuAccounts?.(); disposeClassicMenuAccounts = null; $('classic-menu-backdrop')?.remove(); }
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
  if (!desktop.isDesktop && page !== 'messages') return openContacts();
  if (page === 'profile') { await openSettings(); return; }
  const allowed = ['messages', 'center', 'friends', 'groups', 'blacklist'];
  if (!allowed.includes(page)) page = 'messages';
  const nextPage = desktop.isDesktop && ['messages', 'friends', 'groups'].includes(page) ? 'messages' : page;
  if (nextPage !== state.page || state.sidebarMode !== page) cancelDirectoryRequests();
  if (nextPage !== 'messages') pauseConversationReads();
  if (desktop.isDesktop && ['messages', 'friends', 'groups'].includes(page)) {
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
    resumeForegroundReads();
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
function foregroundReadsAllowed() {
  return Boolean(state.token && state.user && !state.updateRequired && !document.hidden && state.desktopAccountVisible !== false
    && !readPasscodeSettings().locked && !$('passcode-lock-screen'));
}
function cancelDirectoryRequests() {
  state.directoryView?.controller.abort();
  state.directoryView?.searchController?.abort();
  state.directoryView = null;
}
function currentDirectoryRequest(context) {
  return Boolean(context && state.directoryView === context && !context.controller.signal.aborted && foregroundReadsAllowed()
    && state.token === context.token && Number(state.user?.id) === context.userId && state.page === context.page && state.sidebarMode === context.sidebarMode);
}
function loadDirectoryPage(page, title, failure, render) {
  if (!foregroundReadsAllowed() || state.page !== page) return Promise.resolve();
  const previous = state.directoryView;
  if (previous?.pending && currentDirectoryRequest(previous)) return previous.promise;
  cancelDirectoryRequests();
  const context = { token: state.token, userId: Number(state.user.id), page, sidebarMode: state.sidebarMode, controller: new AbortController(), pending: true };
  state.directoryView = context;
  const request = path => api(path, { authToken: context.token, signal: context.controller.signal });
  context.promise = Promise.resolve().then(() => {
    if (currentDirectoryRequest(context)) return render(context, request);
  }).catch(error => {
    if (currentDirectoryRequest(context)) directoryLayout(title, failure, `<p class="directory-empty">${escapeHtml(error.message)}</p>`);
    context.controller.abort();
  }).finally(() => { context.pending = false; });
  return context.promise;
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
  return loadDirectoryPage('friends', '我的好友', '联系人加载失败', async (context, request) => {
    const [contacts, requests] = await Promise.all([request('/contacts?size=100'), request('/contact-requests?direction=received&size=50')]);
    if (!currentDirectoryRequest(context)) return;
    state.contactCache = Object.fromEntries((contacts.items || []).map((item) => [Number(item.user_id), item]));
    const pending = (requests.items || []).filter((item) => item.status === 'pending');
    const contactHtml = friendDirectoryHtml(contacts.items || []);
    directoryLayout('我的好友', '点击好友名片查看资料，再从资料卡发起聊天', `<form id="directory-contact-search" class="directory-search"><input id="directory-contact-keyword" placeholder="输入完整用户名"><button class="primary" type="submit">搜索</button></form><div id="directory-contact-results" class="directory-list"></div><section class="directory-section"><h2>我的好友</h2><div class="friend-card-list">${contactHtml}</div></section>`);
    $('directory-contact-search').onsubmit = event => searchDirectoryContacts(context, event);
    bindDirectoryActions();
  });
}
async function searchDirectoryContacts(context, event) {
  event.preventDefault();
  const keyword = $('directory-contact-keyword')?.value.trim();
  if (!keyword || !currentDirectoryRequest(context)) return;
  context.searchController?.abort();
  const controller = new AbortController(); context.searchController = controller;
  const current = () => currentDirectoryRequest(context) && context.searchController === controller && !controller.signal.aborted
    && $('directory-contact-keyword')?.value.trim() === keyword;
  try {
    const result = await api(`/contacts/search?q=${encodeURIComponent(keyword)}&size=20`, { authToken: context.token, signal: controller.signal });
    if (!current()) return;
    const users = exactUsernameUsers(result.items, keyword).filter(item => Number(item.id) !== context.userId);
    users.forEach(item => { state.contactCache[Number(item.id)] = item; });
    $('directory-contact-results').innerHTML = users.map(item => `<article class="friend-card search-result-card" data-profile-user="${item.id}" tabindex="0"><span class="friend-card-avatar">${item.avatar_url ? `<img src="${escapeHtml(avatarUrl(item.avatar_url))}" alt="">` : escapeHtml((item.nickname || '?').slice(0, 1))}</span><span class="contact-info"><strong>${escapeHtml(item.nickname)}</strong><small>${escapeHtml(publicUserId(item) ? 'ID：' + publicUserId(item) : item.username || '点击查看资料')}</small></span><button type="button" data-add-contact="${item.id}">加好友</button></article>`).join('') || '<p class="directory-empty">用户不存在</p>';
    bindDirectoryActions();
  } catch (error) { if (current()) alert(error.message); }
  finally { if (context.searchController === controller) context.searchController = null; }
}
async function renderMessageCenter() {
  return loadDirectoryPage('center', '消息中心', '消息加载失败', async (context, request) => {
    const result = await request('/contact-requests?direction=received&size=100');
    if (!currentDirectoryRequest(context)) return;
    const requests = (result.items || []).filter((item) => item.status === 'pending');
    const rows = requests.map((item) => `<article class="verification-card"><span class="friend-card-avatar">${item.avatar_url ? `<img src="${escapeHtml(avatarUrl(item.avatar_url))}" alt="">` : escapeHtml((item.nickname || '?').slice(0, 1))}</span><span class="contact-info"><strong>${escapeHtml(item.nickname)}</strong><small>${escapeHtml(item.message || '请求添加你为好友')} · ${escapeHtml(item.created_at || '')}</small></span><span class="request-actions"><button type="button" data-request-action="accept" data-request-id="${item.id}">同意</button><button type="button" data-request-action="reject" data-request-id="${item.id}">拒绝</button></span></article>`).join('') || desktopEmpty('暂无验证消息', '有人添加你为好友时，会在这里显示好友验证');
    directoryLayout('消息中心', '这里仅显示别人添加你的好友验证', `<div class="verification-list">${rows}</div>`);
    bindDirectoryActions();
  });
}
async function openNewFriendsModal() { return openContacts(); }
async function renderGroupsPage() {
  return loadDirectoryPage('groups', '我的群组', '群组加载失败', async (context, request) => {
    const result = await request('/conversations');
    if (!currentDirectoryRequest(context)) return;
    state.conversations = result.items || [];
    const groups = (result.items || []).filter((item) => item.type === 'group');
    const rows = groups.map((item) => `<div class="directory-row group-directory-row"><span class="group-avatar">${escapeHtml((item.name || '群').slice(0, 1))}</span><span class="contact-info"><strong>${escapeHtml(item.name || '未命名群组')}</strong><small>${item.unread_count ? `${item.unread_count} 条未读消息` : escapeHtml(item.last_message?.body?.text || '暂无消息')}</small></span><button type="button" data-group-chat="${item.id}">打开群聊</button></div>`).join('') || '<div class="directory-empty-state"><div class="directory-illustration">♧</div><strong>暂无群聊</strong><p>创建群组后会显示在这里</p></div>';
    directoryLayout('我的群组', '查看和进入你加入的群聊', rows, '<button id="directory-new-group" class="primary" type="button">创建群组</button>');
    $('directory-new-group').onclick = createGroup;
    bindDirectoryActions();
  });
}
async function renderBlacklistPage() {
  return loadDirectoryPage('blacklist', '黑名单', '黑名单加载失败', async (context, request) => {
    const result = await request('/blocks?page=1&size=100');
    if (!currentDirectoryRequest(context)) return;
    const rows = (result.items || []).map((item) => `<div class="directory-row"><span class="contact-avatar muted-avatar">⊘</span><span class="contact-info"><strong>${escapeHtml(item.nickname || '未知用户')}</strong><small>${escapeHtml(item.phone || item.reason || '已加入黑名单')}</small></span><button type="button" data-unblock-directory="${item.blocked_id}">移出黑名单</button></div>`).join('') || '<div class="directory-empty-state"><div class="directory-illustration">⊘</div><strong>黑名单为空</strong><p>被屏蔽的联系人会显示在这里</p></div>';
    directoryLayout('黑名单', '管理已屏蔽的联系人', rows);
    bindDirectoryActions();
  });
}
async function unblockDirectoryUser(userId) { try { await api('/blocks/unblock', { method: 'POST', body: JSON.stringify({ user_id: userId }) }); await renderBlacklistPage(); } catch (error) { alert(error.message); } }
async function blockDirectoryUser(userId) { const reason = window.prompt('请输入屏蔽原因（可选）', '不想再接收对方消息'); if (reason === null) return; try { await api('/blocks', { method: 'POST', body: JSON.stringify({ user_id: userId, reason: reason.trim() }) }); await renderFriendsPage(); } catch (error) { alert(error.message); } }

function classicSettingsModalHtml(sessionRows, blockRows) {
  const user = state.user || {};
  const nickname = user.nickname || '我的账号';
  const avatar = user.avatar_url ? `<img src="${escapeHtml(avatarUrl(user.avatar_url))}" alt="">` : escapeHtml(nickname.slice(0, 1));
  const row = (icon, label, action, suffix = '') => `<button type="button" class="classic-settings-row" data-setting-action="${action}">${navIcon(icon)}<span>${label}</span>${suffix ? `<em>${suffix}</em>` : ''}</button>`;
  return `<div class="modal-backdrop" id="settings-modal"><section class="classic-settings-modal" role="dialog" aria-modal="true" aria-label="设置"><div class="classic-settings-scroll"><header class="classic-settings-head"><h2>设置</h2><button id="close-settings" type="button" aria-label="关闭">×</button><button id="classic-settings-more" class="classic-settings-more" type="button" aria-label="更多">⋮</button><div id="classic-account-menu" class="classic-account-menu" hidden><button id="classic-account-edit" type="button">编辑资料</button><button id="classic-account-logout" type="button">注销</button></div><div class="classic-settings-account-wrap"><span class="classic-settings-avatar">${avatar}</span><div class="classic-settings-account"><strong>${escapeHtml(nickname)}</strong><small>在线</small></div></div></header><section class="classic-settings-list">${row('edit', '编辑资料', 'profile')}${row('bell', '通知', 'notifications')}${row('lock', '隐私和安全', 'privacy')}${row('messages', '对话设置', 'chat')}${row('calls', '通话设置', 'media')}${row('sliders', '高级', 'advanced')}${row('globe', '语言', 'language', '简体中文')}</section><section class="classic-settings-scale"><div class="classic-settings-scale-title"><span>${navIcon('eye')}默认界面缩放</span><span class="classic-settings-switch on"><i></i></span></div><div class="classic-settings-slider"></div><div class="classic-settings-scale-labels"><span>100%</span><span>125%</span><span>150%</span><span>200%</span><span>250%</span><span>300%</span></div></section><section class="classic-settings-list classic-settings-help">${row('help', '常见问题', 'faq')}${row('help', '我有疑问', 'question')}</section><section class="settings-section"><h3>登录设备</h3><div id="session-list">${sessionRows}</div></section><section class="settings-section"><h3>已屏蔽联系人</h3><div id="block-list">${blockRows}</div></section></div></section></div>`;
}

function classicSettingsCheck(label, checked = true, notificationKey = '') {
  if (notificationKey) checked = localSetting(notificationKey, checked);
  return `<label class="classic-detail-check"><input type="checkbox" ${notificationKey ? `data-notification-setting="${notificationKey}"` : ''} ${checked ? 'checked' : ''}><span class="classic-check-box">✓</span><span>${label}</span></label>`;
}

function classicSettingsSwitch(label, checked = true) {
  return `<label class="classic-detail-switch-row"><span>${label}</span><input type="checkbox" ${checked ? 'checked' : ''}><i class="classic-detail-switch"><b></b></i></label>`;
}

const appProductName = desktop.appName || '小猿口算';
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
  syncDesktopSession();
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
  return `<div class="classic-passcode-lock-screen" id="passcode-lock-screen"><section class="classic-passcode-lock-card" role="dialog" aria-modal="true" aria-labelledby="passcode-lock-title"><div class="classic-passcode-lock-logo"><img src="./app-icon.png" alt="小猿口算"></div><h2 id="passcode-lock-title">${escapeHtml(appProductName)} 已锁定</h2><p>请输入锁定码以继续使用</p><form id="passcode-unlock-form"><input id="passcode-unlock-value" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12" placeholder="锁定码" aria-label="锁定码"><button type="submit">解锁</button></form><p id="passcode-unlock-feedback" class="classic-passcode-unlock-feedback" role="alert"></p><button type="button" id="passcode-lock-logout">退出登录</button></section></div>`;
}
function openPasscodeLockScreen() {
  textOutbox.pause(textOutboxAccount());
  imageViewer.close(false);
  cancelForegroundReads();
  if (!passcodeIsEnabled() || $('passcode-lock-screen')) return;
  contactActionRevision++;
  closeContactProfile();
  document.body.insertAdjacentHTML('beforeend', passcodeLockScreenHtml());
  messageReceipts.refresh();
  const screen = $('passcode-lock-screen');
  $('passcode-unlock-value').focus();
  $('passcode-unlock-form').onsubmit = async (event) => {
    event.preventDefault();
    const feedback = $('passcode-unlock-feedback');
    try {
      if ((await hashPasscode($('passcode-unlock-value').value)) !== readPasscodeSettings().hash) throw new Error('锁定码不正确。');
      writePasscodeSettings({ locked: false });
      screen.remove();
      messageReceipts.refresh();
      resumeRealtime();
    } catch (error) { feedback.textContent = error.message || '锁定码不正确。'; $('passcode-unlock-value').select(); }
  };
  $('passcode-lock-logout').onclick = () => leaveAccount({ reload: true });
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
  if (isDetachedConversation) { if (settings.locked) openPasscodeLockScreen(); return; }
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
  return storeProxySettings(remote);
}
async function applyClientProxySettings(settings) {
  const result = desktop.setProxy ? await desktop.setProxy(settings) : settings;
  const applied = storeProxySettings(result || settings);
  if (state.socket) state.socket.close();
  return applied;
}
loadProxySettings().catch(() => {});
const sharedApplicationSettingKeys = ['tray_icon', 'auto_launch', 'auto_update', 'send_to_menu'];
function receiveApplicationSettings(value) {
  if (value?.settings) for (const key of sharedApplicationSettingKeys) if (typeof value.settings[key] === 'boolean') {
    setLocalSetting(key, value.settings[key]);
    document.querySelectorAll(`[data-setting-toggle="${key}"]`).forEach(node => { node.checked = value.settings[key]; });
  }
  if (value?.proxy) { storeProxySettings(value.proxy); state.socket?.close(); }
}
desktop.onApplicationSettingsChanged?.(receiveApplicationSettings);
const applicationSettingsReady = (async () => {
  if (desktop.initializeApplicationSettings && !isDetachedConversation) {
    const initial = { tray_icon: localSetting('tray_icon', true), auto_launch: localSetting('auto_launch', false), auto_update: localSetting('auto_update', true) };
    if (localStorage.getItem('pulse_setting_send_to_menu') !== null) initial.send_to_menu = localSetting('send_to_menu');
    receiveApplicationSettings({ settings: await desktop.initializeApplicationSettings(initial) });
  } else if (desktop.getApplicationSettings) receiveApplicationSettings({ settings: await desktop.getApplicationSettings() });
})().catch(() => {});
if (!desktop.initializeApplicationSettings && !isDetachedConversation && desktop.setTrayVisible) desktop.setTrayVisible(localSetting('tray_icon', true));
if (desktop.setSkipTaskbar) desktop.setSkipTaskbar(!localSetting('taskbar_icon', true));
if (!desktop.initializeApplicationSettings && !isDetachedConversation && desktop.setAutoLaunch) desktop.setAutoLaunch(localSetting('auto_launch', false));
if (desktop.setSpellcheck) desktop.setSpellcheck(localSetting('spellcheck', true));
if (!desktop.initializeApplicationSettings && !isDetachedConversation && desktop.setAutoUpdate) desktop.setAutoUpdate(localSetting('auto_update', true));
document.body.classList.toggle('disable-motion', !localSetting('animations', true));
if (!isDetachedConversation) desktop.onUpdateAvailable?.((result) => {
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
  if (sharedApplicationSettingKeys.includes(key)) description = '对所有账号窗口生效';
  const disabled = isDetachedConversation && sharedApplicationSettingKeys.includes(key) ? ' disabled' : '';
  return `<label class="classic-real-switch-row"><span><strong>${label}</strong>${description ? `<small>${description}</small>` : ''}</span><input type="checkbox" data-setting-toggle="${key}" ${localSetting(key, checked) ? 'checked' : ''}${disabled}><i></i></label>`;
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
  return `<section class="classic-detail-section"><h3>网络与代理</h3><button type="button" class="classic-setting-action-row classic-setting-action-button" data-advanced-action="routes"><span>服务器线路</span><em data-route-current>${escapeHtml(routeManager?.current.name || '主线路')}</em></button><div class="classic-setting-action-row"><span>连接类型</span><em id="proxy-summary">${escapeHtml(proxySummary())}</em></div><button type="button" class="classic-setting-button" data-advanced-action="proxy">配置代理 <small>${proxyLabel()}</small></button></section><section class="classic-detail-section"><h3>数据与存储</h3>${settingsToggleRow('download_ask', '下载前询问保存目录', true)}<button type="button" class="classic-setting-action-row classic-setting-action-button" data-advanced-action="download-directory"><span>下载目录</span><em id="download-directory-value">${escapeHtml(localStorage.getItem('pulse_download_directory') || '默认目录')}</em></button><button type="button" class="classic-setting-button" data-advanced-action="clear-cache">管理本地缓存</button><button type="button" class="classic-setting-button" data-advanced-action="export-data">导出 ${escapeHtml(appProductName)} 数据</button></section><section class="classic-detail-section"><h3>自动下载媒体文件</h3>${mediaDownloadScopeRow('private')}${mediaDownloadScopeRow('group')}${mediaDownloadScopeRow('channel')}</section><section class="classic-detail-section"><h3>系统集成</h3><button type="button" class="classic-setting-action-row classic-setting-action-button" data-advanced-action="media"><span>通话设置</span><em>扬声器、耳机和麦克风</em></button>${settingsToggleRow('tray_icon', '显示托盘图标', true)}${settingsToggleRow('taskbar_icon', '显示任务栏图标', true)}${settingsToggleRow('auto_launch', `开机自动启动 ${escapeHtml(appProductName)}`, false)}${settingsToggleRow('send_to_menu', `在“发送到”菜单中显示 ${escapeHtml(appProductName)}`, false)}</section><section class="classic-detail-section"><h3>性能</h3>${settingsToggleRow('animations', '动画切换效果', true)}${settingsToggleRow('animated_gif', '自动播放 GIF', true)}</section><section class="classic-detail-section"><h3>拼写检查器</h3>${settingsToggleRow('spellcheck', '使用系统拼写检查器', true)}</section><section class="classic-detail-section"><h3>版本和更新</h3>${settingsToggleRow('auto_update', '自动更新', true)}<div class="classic-setting-action-row"><span>当前版本</span><em>${escapeHtml(appProductVersion)}</em></div><button type="button" class="classic-setting-action-row classic-setting-action-button" data-advanced-action="check-update"><span>检查更新</span><em>立即检查</em></button></section>`;
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
    fields: [{ key: 'phone_visibility', title: '谁可以看到您的手机号', choices: privacyChoices, description: '已将您的手机号保存至联系人中的用户可以在小猿口算上看到该号码。' }, { key: 'phone_search_visibility', title: '谁可以通过您的手机号找到我？', choices: privacySearchChoices, description: '' }],
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
  const avatar = item.avatar_url ? `<img src="${escapeHtml(avatarUrl(item.avatar_url))}" alt="">` : escapeHtml((item.nickname || '?').slice(0, 1));
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
  const rows = items.map((item) => `<div class="classic-privacy-blocked-row"><span class="classic-privacy-picker-avatar">${item.avatar_url ? `<img src="${escapeHtml(avatarUrl(item.avatar_url))}" alt="">` : escapeHtml((item.nickname || '?').slice(0, 1))}</span><span><strong>${escapeHtml(item.nickname || '未知用户')}</strong><small>${escapeHtml(item.reason || '已屏蔽联系人')}</small></span><button type="button" data-privacy-unblock="${Number(item.blocked_id)}">解除</button></div>`).join('');
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
  try { if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.map((key) => caches.delete(key))); } await localChat.clear(); conversationViews.clear(); await desktop.clearCache?.(); localStorage.removeItem('pulse_conversation_folders'); alert('本地缓存已清理'); } catch (error) { alert(error.message || '清理缓存失败'); }
}
function exportLocalData() {
  const payload = { exported_at: new Date().toISOString(), app: appProductName, settings: Object.fromEntries(Object.keys(localStorage).filter((key) => key.startsWith('pulse_') && !key.startsWith('pulse_go_v2:') && key !== 'pulse_token').map((key) => [key, localStorage.getItem(key)])) };
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
  void Promise.resolve(desktop.cancelProxyTest?.()).catch(() => {});
  document.querySelector('#proxy-manager-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', proxyManagerHtml());
  const modal = $('proxy-manager-modal');
  const feedback = $('proxy-manager-feedback');
  const close = () => { void Promise.resolve(desktop.cancelProxyTest?.()).catch(() => {}); modal?.remove(); };
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
  document.querySelectorAll('[data-setting-toggle]').forEach((node) => { node.onchange = async () => { if (await applySharedSettingToggle(node)) return; const key = node.dataset.settingToggle; setLocalSetting(key, node.checked); if (key === 'tray_icon') desktop.setTrayVisible?.(node.checked); if (key === 'taskbar_icon') desktop.setSkipTaskbar?.(!node.checked); if (key === 'auto_launch') desktop.setAutoLaunch?.(node.checked); if (key === 'spellcheck') desktop.setSpellcheck?.(node.checked); if (key === 'send_to_menu') { try { await desktop.setSendToMenu?.(node.checked); } catch (error) { node.checked = !node.checked; setLocalSetting(key, node.checked); alert(error.message || '发送到菜单设置失败'); } } document.body.classList.toggle('disable-motion', key === 'animations' && !node.checked); }; });
  if (isDetachedConversation) document.querySelectorAll('[data-advanced-action="proxy"]').forEach(node => { node.disabled = true; node.title = '请在账号主窗口修改'; });
  document.querySelectorAll('[data-media-download-scope]').forEach((node) => { node.onclick = () => openSettingsDetail(`media-download-${node.dataset.mediaDownloadScope}`, 'advanced'); });
  document.querySelectorAll('[data-advanced-action]').forEach((node) => { node.onclick = async () => { const action = node.dataset.advancedAction; if (action === 'routes') return openRoutePicker(); if (action === 'clear-cache') return clearLocalCache(); if (action === 'export-data') return exportLocalData(); if (action === 'media') { closeSettingsDetail(); return openSettingsDetail('media', 'advanced'); } if (action === 'check-update') { try { const result = await desktop.checkForUpdate?.(); if (result?.updateAvailable && result.downloadUrl && window.confirm(`${result.message || `发现新版本 ${result.latestVersion}`}\n是否打开下载地址？`)) await desktop.openUpdate?.(result.downloadUrl); else alert(result?.message || `当前已是最新版本（${appProductVersion}）`); } catch (error) { alert(error.message || '检查更新失败'); } return; } if (action === 'proxy') { return openProxyManager(); } if (action === 'download-directory') { const value = await desktop.selectDownloadDirectory?.(); if (value) { localStorage.setItem('pulse_download_directory', value); const label = $('download-directory-value'); if (label) label.textContent = value; } } }; });
}

async function applySharedSettingToggle(node) {
  const key = node.dataset.settingToggle;
  if (!sharedApplicationSettingKeys.includes(key) || !desktop.setApplicationSetting) return false;
  const previous = localSetting(key, key === 'tray_icon' || key === 'auto_update');
  node.disabled = true;
  try { receiveApplicationSettings({ settings: await desktop.setApplicationSetting(key, node.checked) }); }
  catch (error) { node.checked = previous; alert(error.message || '应用设置保存失败'); }
  finally { node.disabled = isDetachedConversation; }
  return true;
}

function bindAdvancedSettingsExtra() {
  document.querySelectorAll('[data-setting-toggle]').forEach((node) => {
    node.onchange = async () => {
      const key = node.dataset.settingToggle;
      if (await applySharedSettingToggle(node)) return;
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
  const avatar = user.avatar_url ? `<img src="${escapeHtml(avatarUrl(user.avatar_url))}" alt="">` : escapeHtml(nickname.slice(0, 1));
  const birthday = user.birthday || '未设置';
  const gender = user.gender || '未设置';
  const signature = user.signature || '未设置';
  const profileRow = (icon, field, value, label, locked = false) => `<div class="classic-info-row${locked ? ' locked' : ''}"${locked ? '' : ` data-profile-field="${field}" tabindex="0"`}><span class="classic-info-icon">${navIcon(icon)}</span><p><strong>${escapeHtml(value)}</strong><small>${label}</small></p>${locked ? '' : `<button class="classic-edit-pencil" type="button" data-profile-edit="${field}" aria-label="编辑${label}">✎</button>`}</div>`;
  const usernameLocked = Boolean(user.username);
  const birthdayLocked = Number(user.birthday_change_count || 0) >= 1;
  const layouts = {
    profile: { title: '个人信息', body: `<section class="classic-profile-detail"><div class="classic-profile-detail-avatar">${avatar}</div><button id="classic-avatar-button" class="classic-avatar-button" type="button">设置头像</button><input id="classic-avatar-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp" hidden><div class="classic-info-list">${profileRow('friends', 'nickname', nickname, '昵称')}${profileRow('messages', 'username', user.username || '未设置', '账号', usernameLocked)}${profileRow('friends', 'public_id', publicUserId(user) || '暂不可用', '用户 ID', true)}${profileRow('calendar', 'birthday', birthday, '生日', birthdayLocked)}${profileRow('gender', 'gender', gender, '性别')}${profileRow('edit', 'signature', signature, '个性签名')}</div></section>` },
    notifications: { title: '通知', body: `<section class="classic-detail-section"><h3>聊天通知</h3>${classicSettingsCheck('启用通知', true, 'notification_enabled')}${classicSettingsCheck('显示发送者昵称', true, 'notification_sender')}${classicSettingsCheck('显示消息预览', true, 'notification_preview')}${classicSettingsCheck('播放提示音', true, 'notification_sound')}</section><section class="classic-detail-section"><h3>未读消息数量提示</h3>${classicSettingsCheck('包含已关闭通知的对话')}${classicSettingsCheck('按消息数统计未读')}</section><section class="classic-detail-section"><h3>原生通知</h3>${classicSettingsCheck('使用 Windows 原生通知', false, 'notification_native')}</section><section class="classic-detail-section classic-notification-position"><h3>在屏幕上的位置</h3><div class="classic-notification-monitor"><div></div><i></i></div><p class="classic-detail-hint-inline">默认在屏幕右下角显示，最多同时显示3条。点击通知或“回复”打开对应会话。</p></section>` },
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
  await applicationSettingsReady;
  closeSettings();
  closeSettingsDetail();
  if (type === 'privacy') await loadPrivacyPageData();
  if (type === 'advanced') await loadProxySettings().catch(() => {});
  document.body.insertAdjacentHTML('beforeend', classicSettingsDetailHtml(type));
  const detailModal = $('settings-detail-modal');
  detailModal?.querySelectorAll('[data-notification-setting]').forEach(node => {
    node.onchange = () => { setLocalSetting(node.dataset.notificationSetting, node.checked); desktop.dismissNotifications?.(); };
  });
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
    detailScroll?.insertAdjacentHTML('afterbegin', window.PulseChatTypography.controlsHtml());
    chatTypographySettings.bind(detailModal);
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
    document.querySelectorAll('.classic-settings-avatar, .classic-profile-detail-avatar').forEach((node) => { node.innerHTML = state.user.avatar_url ? `<img src="${escapeHtml(avatarUrl(state.user.avatar_url))}" alt="">` : escapeHtml((state.user.nickname || '猿').slice(0, 1)); });
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
  if (!state.token || !state.user) return;
  const revision = settingsLoadRevision;
  const context = { token: state.token, userId: Number(state.user.id) };
  try {
    const options = { authToken: context.token, signal: AbortSignal.timeout(15000) };
    const [sessions, blocks, user] = await Promise.all([api('/auth/sessions', options), api('/blocks?page=1&size=50', options), api('/auth/me', options)]);
    if (revision !== settingsLoadRevision || !sameSendAccount(context)) return;
    state.user = user;
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
    $('classic-account-logout').onclick = () => leaveAccount({ reload: true });
    document.querySelectorAll('[data-setting-action]').forEach((button) => { button.onclick = () => { const action = button.dataset.settingAction; if (['profile', 'notifications', 'privacy', 'chat', 'media', 'advanced', 'language'].includes(action)) openSettingsDetail(action); else if (action === 'faq' || action === 'question') alert('帮助内容正在整理中'); }; });

    document.querySelectorAll('[data-revoke-session]').forEach((button) => button.onclick = () => revokeSession(Number(button.dataset.revokeSession)));
    document.querySelectorAll('[data-unblock-user]').forEach((button) => button.onclick = () => unblockUser(Number(button.dataset.unblockUser)));
  } catch (error) { if (revision === settingsLoadRevision && sameSendAccount(context)) alert(error.message); }
}

function closeSettings() {
  settingsLoadRevision++;
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
async function changePassword(event) { event.preventDefault(); try { await api('/auth/password', { method: 'POST', body: JSON.stringify({ current_password: $('current-password').value, new_password: $('new-password').value }) }); alert('密码修改成功，请在本设备重新登录。'); leaveAccount({ reload: true }); } catch (error) { $('password-feedback').textContent = error.message; } }
async function revokeSession(sessionId) { try { await api('/auth/sessions/revoke', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) }); await openSettings(); } catch (error) { alert(error.message); } }
async function unblockUser(userId) { try { await api('/blocks/unblock', { method: 'POST', body: JSON.stringify({ user_id: userId }) }); await openSettings(); } catch (error) { alert(error.message); } }

let conversationDataRevision = 0;
const conversationDeltaRevisions = new Map();
const conversationRefresh = PulseConversationRefresh.create({
  account: () => ({ base: API, token: state.token, userId: Number(state.user?.id) }),
  load: async (ids, account, { signal } = {}) => { const readTicket = conversationReads.capture(); const result = await api('/conversations/updates?ids=' + ids.join(','), { authToken: account.token, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }); return { ...result, readTicket }; },
  full: ({ signal } = {}) => loadConversations({ signal }),
  apply: (result, account) => {
    if (!sameSendAccount(account) || state.updateRequired) return;
    const revision = ++conversationDataRevision, ticket = result.readTicket ?? conversationReads.capture();
    const removed = new Set(result.removed_ids.map(Number));
    const changes = new Map(result.items.map(item => [Number(item.id), conversationReads.merge(item, ticket)]));
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
    else state.conversationViewDirty = true;
  }
});
function refreshChangedConversations(ids) { conversationRefresh.hint(ids); }

function cancelConversationListRead() {
  const current = state.conversationListLoad; state.conversationListLoad = null;
  if (current) { state.conversationListRefreshNeeded = true; current.controller?.abort(); }
}
async function loadConversations({ signal } = {}) {
  if (!state.token || !state.user) return;
  if (!foregroundReadsAllowed()) { state.conversationListRefreshNeeded = true; return false; }
  if (signal?.aborted) return false;
  const token = state.token, userId = Number(state.user.id);
  const current = state.conversationListLoad;
  if (current && current.token === token && current.userId === userId) { current.again = true; return current.promise; }
  const context = { token, userId, revision: conversationDataRevision, readTicket: conversationReads.capture(), again: false, promise: null, controller: new AbortController() };
  const cancel = () => context.controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const requestSignal = () => AbortSignal.any([context.controller.signal, AbortSignal.timeout(15000)]);
  state.conversationListLoad = context;
  context.promise = (async () => {
    try {
      const [conversations, folders] = isDetachedConversation
        ? [{ items: [await api(`/conversations/info?conversation_id=${detachedConversationId}`, { authToken: token, signal: requestSignal() })] }, { items: [] }]
        : await Promise.all([api('/conversations', { authToken: token, signal: requestSignal() }), api('/conversation-folders', { authToken: token, signal: requestSignal() })]);
      if (context.controller.signal.aborted || state.conversationListLoad !== context || state.token !== token || Number(state.user?.id) !== userId) return;
      const rows = [...(conversations.items || [])];
      const pageSize = Math.max(1, Math.min(100, Number(conversations.size) || 30));
      const pageCount = isDetachedConversation ? 1 : Math.ceil(Math.max(rows.length, Number(conversations.total) || 0) / pageSize);
      let complete = true;
      for (let page = 2; page <= pageCount; page++) {
        if (context.controller.signal.aborted || state.conversationListLoad !== context || state.token !== token || Number(state.user?.id) !== userId) return;
        const next = await api(`/conversations?page=${page}&size=${pageSize}`, { authToken: token, signal: requestSignal() });
        if (!(next.items || []).length) { complete = false; break; }
        rows.push(...next.items);
      }
      if (context.controller.signal.aborted || state.conversationListLoad !== context || state.token !== token || Number(state.user?.id) !== userId) return;
      const freshRows = new Map(rows.map(item => [Number(item.id), conversationReads.merge(item, context.readTicket)]));
      for (const item of state.conversations) if ((conversationDeltaRevisions.get(Number(item.id)) || 0) > context.revision) freshRows.set(Number(item.id), item);
      for (const [id, revision] of conversationDeltaRevisions) if (revision > context.revision && !state.conversations.some(item => Number(item.id) === id)) freshRows.delete(id);
      state.conversations = [...freshRows.values()];
      contactNames.conversations(state.conversations);
      if (desktop.isDesktop && !isDetachedConversation && complete && state.conversations.length >= (Number(conversations.total) || 0)) conversationOrder.reconcile(conversationOrderAccount(), state.conversations);
      flushDesktopInboxNotifications();
      if (state.active) {
        const refreshed = state.conversations.find(item => Number(item.id) === Number(state.active.id));
        if (refreshed) Object.assign(state.active, refreshed);
      }
      state.conversationFolders = folders?.items || [];
      if ($('profile-name')) $('profile-name').textContent = state.user.nickname;
      renderConversationList(); updateDesktopChat(); syncChatInfoNotification();
      if (complete) { state.conversationListRefreshed = { token, userId, at: Date.now() }; state.conversationListRefreshNeeded = false; }
      return complete;
    } catch (error) { if (context.controller.signal.aborted) return false; throw error; } finally {
      signal?.removeEventListener('abort', cancel);
      const again = context.again && !context.controller.signal.aborted;
      context.controller.abort(); // Also releases a still-pending Promise.all sibling after failure.
      if (state.conversationListLoad === context) {
        state.conversationListLoad = null;
        if (again && foregroundReadsAllowed() && state.token === token && Number(state.user?.id) === userId) void loadConversations().catch(() => {});
      }
    }
  })();
  return context.promise;
}

function conversationMessagePreview(item) {
  const last = item.last_message?.recalled_at || ['recalled', 'deleted'].includes(item.last_message?.status) ? null : item.last_message;
  return !last ? '暂无消息' : last.body?.text || `[${messageType(last.type)}]`;
}
function conversationPreviewHtml(item) {
  const mention = item.type === 'group' && Number(item.unread_mention_count) > 0 ? '<span class="conversation-mention-label">有人@你 </span>' : '';
  const draft = composerDrafts.text({ token: state.token, userId: Number(state.user?.id) }, item.id).replace(/\s+/gu, ' ').trim();
  if (draft && Number(item.id) !== Number(state.active?.id)) return mention + '<span class="conversation-draft-label">草稿：</span><span class="conversation-draft-text">' + escapeHtml(draft) + '</span>';
  return mention + escapeHtml(conversationMessagePreview(item));
}
function refreshConversationDraftPreviews(ids) {
  const container = $('conversation-list'); if (!container || state.chatSearch) return;
  for (const id of new Set(ids)) {
    const item = state.conversations.find(row => Number(row.id) === Number(id)); if (!item) continue;
    for (const preview of container.querySelectorAll('.conversation[data-id="' + Number(id) + '"] .conversation-copy small')) renderStableConversationContent(preview, conversationPreviewHtml(item), Number(id));
  }
  if (desktop.isDesktop) filterConversationList($('message-search')?.value || '');
}

function conversationRowHtml(item, showFolderAction = false) {
  const fallback = item.peer_nickname || item.name || (item.type === 'direct' ? '单聊' : '会话');
  const name = item.type === 'direct' ? contactDisplayName(item.peer_user_id, fallback) : item.name || '会话';
  const nameBinding = item.type === 'direct' && Number(item.peer_user_id) > 0
    ? ` data-contact-name-user="${Number(item.peer_user_id)}" data-contact-name-fallback="${escapeHtml(fallback)}"` : '';
  const selected = Number(state.active?.id) === Number(item.id);
  const pinned = Boolean(item.is_pinned);
  const pinBadge = pinned ? '<span class="conversation-pin" title="已置顶"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 9V4h1V2H7v2h1v5a4 4 0 0 1-2 3v2h5v7l1 1 1-1v-7h5v-2a4 4 0 0 1-2-3Z"/></svg><span>置顶</span></span>' : '';
  const last = item.last_message?.recalled_at || ['recalled', 'deleted'].includes(item.last_message?.status) ? null : item.last_message;
  const avatarColors = ['#69a9df', '#73b897', '#a58ad5', '#d79c68', '#6ab6bf', '#cf83a2'];
  const avatarColor = avatarColors[Math.abs(Number(item.id) || 0) % avatarColors.length];
  const unread = Math.max(0, Math.floor(Number(item.unread_count) || 0));
  const muteBadge = item.notifications_muted === true || Number(item.notifications_muted) === 1
    ? '<span class="conversation-mute-indicator" role="img" aria-label="消息免打扰" title="消息免打扰"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18M10.6 4.1A6 6 0 0 1 18 10v4l2 3H8m-3.5-.5L6 14v-4a6 6 0 0 1 .8-3M10 20a2 2 0 0 0 4 0"/></svg></span>' : '';
  const folderAction = showFolderAction
    ? `<span class="conversation-folder-action" data-folder-assign="${Number(item.id)}" role="button" tabindex="0" title="设置分组" aria-label="设置分组">•••</span>`
    : '';
  const avatar = `<span class="avatar">${item.avatar_url ? `<img src="${escapeHtml(avatarUrl(item.avatar_url))}" alt="">` : escapeHtml(name.slice(0, 1).toUpperCase())}</span>`;
  const peerId = Number(item.peer_user_id);
  const showPresence = desktop.isDesktop && item.type === 'direct' && Number.isSafeInteger(peerId) && peerId > 0
    && peerId !== Number(state.user?.id) && typeof item.peer_online === 'boolean';
  const presence = showPresence ? `<span class="conversation-presence ${item.peer_online ? 'is-online' : 'is-offline'}" role="img" aria-label="${item.peer_online ? '在线' : '离线'}" title="${item.peer_online ? '在线' : '离线'}"></span>` : '';
  const avatarWithPresence = desktop.isDesktop ? `<span class="conversation-avatar">${avatar}${presence}</span>` : avatar;
  return `<button class="conversation ${selected ? 'active' : ''}${pinned ? ' is-pinned' : ''}" data-id="${Number(item.id)}" aria-current="${selected ? 'true' : 'false'}" style="--conversation-avatar-color:${avatarColor}">${avatarWithPresence}<span class="conversation-copy"><strong${nameBinding}>${escapeHtml(name)}</strong><small>${conversationPreviewHtml(item)}</small></span><span class="conversation-meta"><time>${escapeHtml((last?.created_at || item.updated_at || '').slice(11, 16))}</time><span class="conversation-flags">${muteBadge}${pinBadge}${unread ? `<b class="unread" aria-label="${unread} 条未读消息">${unread > 99 ? '99+' : unread}</b>` : ''}</span></span>${folderAction}</button>`;
}

function conversationRowsHtml(items, showFolderAction = false) {
  return items.map((item) => conversationRowHtml(item, showFolderAction)).join('');
}

async function refreshConversationPresence() {
  if (!desktop.isDesktop || !state.token || !state.user || document.hidden || state.desktopAccountVisible === false
    || state.page !== 'messages' || state.updateRequired || readPasscodeSettings().locked || $('passcode-lock-screen')
    || state.chatSearch || state.conversationListLoad
    || (state.active?.type !== 'direct' && !document.querySelector('#conversation-list .conversation-presence'))) return;
  try { await loadConversations(); } catch { /* Keep the last known state until a normal refresh succeeds. */ }
}
setInterval(() => { void refreshConversationPresence(); }, 30000);

const pendingFolderToggles = new Map();
const pendingArchiveChanges = new Map();
function conversationIsArchived(item) { return item?.is_archived === true || Number(item?.is_archived) === 1; }
function conversationArchiveEntryHtml(items) {
  const unread = items.reduce((sum, item) => sum + Math.max(0, Math.floor(Number(item.unread_count) || 0)), 0);
  const names = items.map(item => item.name || '会话').join('、');
  return `<button id="conversation-archive-entry" class="conversation-archive-entry" type="button" aria-label="已归档对话，${items.length} 个对话，${unread} 条未读消息"><span class="conversation-archive-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 8h16v12H4zM3 4h18v4H3z"/><path d="M12 10v7m-3-3 3 3 3-3"/></svg></span><span class="conversation-archive-copy"><strong>已归档对话</strong><small title="${escapeHtml(names)}">${escapeHtml(names || '暂无归档对话')}</small></span>${unread ? `<span class="conversation-archive-badge" aria-hidden="true">${unread > 99 ? '99+' : unread}</span>` : ''}</button>`;
}
function syncConversationArchiveMenu() {
  const button = $('classic-drawer-archive'); if (!button) return;
  const rows = state.conversations.filter(item => item.type !== 'favorites' && conversationIsArchived(item));
  const unread = rows.reduce((sum, item) => sum + Math.max(0, Math.floor(Number(item.unread_count) || 0)), 0);
  button.setAttribute('aria-label', `归档，${rows.length} 个对话，${unread} 条未读消息`);
  const badge = button.querySelector('.conversation-archive-badge');
  badge.hidden = unread === 0; badge.textContent = unread > 99 ? '99+' : String(unread);
}
async function openConversationArchive() {
  const account = { token: state.token, userId: Number(state.user?.id) };
  if (!desktop.isDesktop || isDetachedConversation || !contactActionsAllowed(account)) return;
  if (state.page !== 'messages' || state.sidebarMode !== 'messages') await switchPage('messages');
  else { closeChatSearch(); closeChatMoreMenu(); }
  if (!sameSendAccount(account)) return;
  setConversationArchiveView(true);
  $('conversation-archive-back')?.focus();
}
function conversationArchiveHeaderHtml(count) {
  return `<header class="conversation-archive-header"><button id="conversation-archive-back" type="button" aria-label="返回聊天列表" title="返回聊天列表"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7M7 12h14"/></svg></button><div><strong>已归档对话</strong><small>${count} 个对话</small></div></header>`;
}
function setConversationArchiveView(open) {
  closeConversationFolderModal(); closeContactProfile(); closeSessionMenu();
  state.archiveView = Boolean(open); state.archiveFeedback = '';
  if ($('message-search')) $('message-search').value = '';
  renderConversationList();
  syncDefaultGroupChatInfo();
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
    cancelConversationListRead();
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
  if (!isDetachedConversation && desktop.openConversationWindow && conversation.type !== 'favorites') actions.unshift(['independent', '独立窗口']);
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
  const context = { token: state.token, userId: Number(state.user?.id) };
  const result = await api('/conversations/settings', { method: 'POST', authToken: context.token, signal: AbortSignal.timeout(15000), body: JSON.stringify({ conversation_id: conversation.id, [key]: value }) });
  if (!sameSendAccount(context)) return;
  if (key === 'is_pinned' && (!result || !Object.hasOwn(result,'is_pinned') || Boolean(result.is_pinned) !== Boolean(value))) throw new Error('置顶状态未能确认，请刷新后重试。');
  Object.assign(conversation, result || {});
  const row = state.conversations.find(item => Number(item.id) === Number(conversation.id));
  if (row && row !== conversation) Object.assign(row, result || {});
  if (Number(state.active?.id) === Number(conversation.id)) Object.assign(state.active, result || {});
  if (desktop.isDesktop && key === 'is_pinned') conversationOrder.setPinned(conversationOrderAccount(), conversation.id, Boolean(result.is_pinned));
  cancelConversationListRead();
  renderConversationList();
  try { await loadConversations(); }
  catch { if (sameSendAccount(context)) composerFeedback('设置已保存，列表刷新失败，请稍后重试。'); }
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
  const account = { token: state.token, userId: Number(state.user?.id) };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const feedback = $('conversation-remark-feedback');
    const remark = $('conversation-remark-input').value.trim();
    button.disabled = true;
    feedback.textContent = '';
    try {
      const result = await api('/contacts/remark', { authToken: account.token, method: 'POST', body: JSON.stringify({ user_id: Number(conversation.peer_user_id), remark }) });
      if (!contactActionsAllowed(account)) return;
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
    const result = await api('/messages/clear-history', { method: 'POST', body: JSON.stringify({ conversation_id: conversation.id, through_message_id: conversation.message_seq }) });
    conversation.cleared_before_message_id = result.cleared_before_message_id;
    void localChat.clearConversation(Number(conversation.id), Number(result.cleared_before_message_id)); purgeLocalMedia(conversation.id);
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
    if (action === 'independent') return await desktop.openConversationWindow(Number(conversation.id));
    if (action === 'folder') return assignConversationFolder(Number(conversation.id));
    if (action === 'hide') return hideConversationFromList(conversation);
    if (action === 'archive') return await setConversationArchived(conversation);
    if (action === 'remark') return renameConversationContact(conversation);
    if (action === 'pin') return await saveConversationSetting(conversation, 'is_pinned', !conversation.is_pinned);
    if (action === 'mute') return await saveConversationSetting(conversation, 'notifications_muted', !conversation.notifications_muted);
    if (action === 'unread') {
      await api('/messages/mark-unread', { method: 'POST', body: JSON.stringify({ conversation_id: conversation.id, through_message_id: conversation.message_seq }) });
      conversationReads.invalidate(conversation.id);
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
  if (desktop.isDesktop && state.desktopAccountVisible === false) { state.conversationViewDirty = true; return; }
  syncConversationArchiveMenu();
  const groupActions = $('group-sidebar-actions');
  if (groupActions) groupActions.hidden = state.sidebarMode !== 'groups' || Boolean(state.chatSearch);
  if (state.chatSearch) return;
  const mode = state.sidebarMode || 'messages';
  const scope = sidebarFolderScope();
  const items = state.conversations.filter(item => item.type !== 'favorites');
  const allItems = desktop.isDesktop ? conversationOrder.sort(conversationOrderAccount(), items) : items;
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
  } else content = (desktop.isDesktop ? '' : conversationArchiveEntryHtml(archivedItems)) + (conversationRowsHtml(allItems.filter(item => !conversationIsArchived(item))) || '<p class="classic-list-empty">暂无会话</p>');
  const favoriteRow = !archiveOpen && state.favoriteMode ? `<button class="conversation favorite-conversation active" data-favorite="true"><span class="avatar favorite-avatar">${navIcon('star')}</span><span class="conversation-copy"><strong>我的收藏</strong><small>收藏的消息和文件</small></span></button>` : '';
  const archiveFeedback = state.archiveFeedback ? `<p class="conversation-archive-feedback" role="alert">${escapeHtml(state.archiveFeedback)}</p>` : '';
  // Flat chats, archive rows and nested folders need separate reconciliation contexts.
  renderStableConversationContent($('conversation-list'), archiveFeedback + favoriteRow + (content || '<p class="classic-list-empty">暂无会话</p>'), `sidebar:${mode}:${archiveOpen}`);
  if ($('conversation-archive-entry')) $('conversation-archive-entry').onclick = () => setConversationArchiveView(true);
  if ($('conversation-archive-back')) $('conversation-archive-back').onclick = () => { setConversationArchiveView(false); if (desktop.isDesktop) $('classic-menu-button')?.focus(); };
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
      openConversation(Number(button.dataset.id), { latest: true });
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
  if (desktop.isDesktop) filterConversationList($('message-search')?.value || '');
}

function filterConversationList(keyword) {
  const list = $('conversation-list');
  if (!list || state.chatSearch) return;
  const searching = Boolean(PulseConversationFilter.normalize(keyword));
  const rows = new Map(state.conversations.map(item => [Number(item.id), item]));
  for (const node of list.querySelectorAll('.conversation')) {
    const item = rows.get(Number(node.dataset.id));
    const peerId = item?.type === 'direct' ? Number(item.peer_user_id) : 0;
    const contact = peerId ? state.contactCache[peerId] : null;
    node.hidden = !PulseConversationFilter.matches(keyword, {
      name: node.querySelector('.conversation-copy strong')?.textContent || item?.name,
      remark: peerId ? contactDisplayName(peerId, '') : '',
      preview: node.querySelector('.conversation-copy small')?.textContent,
      conversationId: node.dataset.id,
      internalStaff: state.user?.internal_staff === true,
      nickname: item?.peer_nickname || contact?.nickname,
      username: item?.peer_username || contact?.username,
      publicId: item?.peer_public_id || publicUserId(contact),
      description: item?.description,
    });
  }
  for (const folder of list.querySelectorAll('.classic-conversation-folder')) {
    folder.classList.toggle('is-searching', searching);
    folder.hidden = searching && !folder.querySelector('.conversation:not([hidden])');
  }
  const other = list.querySelector('.classic-other-conversations');
  if (other) other.hidden = searching && !other.querySelector('.conversation:not([hidden])');
  let empty = list.querySelector('[data-conversation-search-empty]');
  const noMatches = searching && !list.querySelector('.conversation:not([hidden])');
  if (noMatches && !empty) {
    empty = document.createElement('p'); empty.className = 'classic-list-empty'; empty.dataset.conversationSearchEmpty = '';
    empty.setAttribute('role', 'status'); empty.textContent = '没有找到匹配的会话'; list.append(empty);
  }
  if (empty) empty.hidden = !noMatches;
}

function focusConversationInput(id) {
  const input = $('message-input'), composer = $('composer');
  if (!desktop.isDesktop && !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (!state.token || !state.user || state.updateRequired || state.favoriteMode || state.desktopAccountVisible === false
    || Number(state.active?.id) !== Number(id) || state.page !== 'messages' || document.hidden
    || !input?.isConnected || composer?.hidden || input.disabled || input.readOnly || !input.getClientRects().length
    || document.querySelector('.modal-backdrop,.classic-menu-backdrop,.classic-passcode-lock-screen,[aria-modal="true"]')) return;
  input.focus({ preventScroll: true });
}

function closeConversationView() {
  if (!desktop.isDesktop || isDetachedConversation || state.favoriteMode || !state.active || !state.token || !state.user || state.page !== 'messages'
    || state.desktopAccountVisible === false || document.hidden || readPasscodeSettings().locked || state.updateRequired) return;
  const id = Number(state.active.id), socket = state.socket;
  $('messages')?.querySelectorAll('audio,video').forEach(media => media.pause());
  rememberConversationView();
  cancelConversationRecovery();
  resetChatHistoryLocation();
  resetComposerForNavigation();
  closeChatPanels();
  closeChatMoreMenu();
  state.active = null; state.favoriteMode = false; state.initialHistoryFailed = false;
  document.body.classList.remove('favorite-mode');
  if (socket?.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify({type:'unsubscribe', conversation_id:id})); }
    catch { /* The local close still succeeds if the connection has just ended. */ }
  }
  state.messageSubscriptionId = 0; state.messageSubscriptionSocket = null;
  messageReceipts.refresh();
  updateDesktopChat();
  renderConversationList();
  $('message-search')?.focus({preventScroll:true});
}

async function openConversation(id, { focusInput = true, latest = false } = {}) {
  if (!foregroundReadsAllowed()) return;
  closeConversationFolderModal();
  closeContactProfile();
  if (isDetachedConversation && Number(id) !== detachedConversationId) return;
  const selected = state.conversations.find(item => Number(item.id) === Number(id));
  if (!selected) return;
  desktop.dismissNotifications?.(Number(id));
  if (selected.type === 'favorites') return openFavorites();
  const showLatest = latest && desktop.isDesktop;
  const latestId = Number(selected.last_message?.id);
  const latestMissing = showLatest && !state.initialHistory && Number.isSafeInteger(latestId) && latestId > Number(selected.cleared_before_message_id || 0)
    && !$('messages').querySelector(`[data-message-id="${latestId}"]`);
  if (!latestMissing && !state.favoriteMode && !state.historyLocation && Number(state.active?.id) === Number(id) && !state.initialHistoryFailed
    && (state.initialHistory || (state.historyReadyEpoch != null && state.historyReadyEpoch === state.historyEpoch))) {
    if (showLatest) { void returnChatToBottom(); PulseChatBottom.followLatest(); }
    subscribeConversation(id); updateDesktopChat(); void markMessagesRead(visibleConversationMessages(), { force: true }); if (focusInput) focusConversationInput(id); return;
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
  const container = $('messages'); let cached = GO ? null : conversationViews.take(conversationViewAccount(), id, container);
  const initial = { token: historyToken, epoch: historyEpoch, conversationId: Number(id), events: new Map(), controller: new AbortController(), startedAt: Date.now() }; state.initialHistory = initial; state.initialHistoryFailed = false;
  state.historyPage = cached?.page || 1; state.historyHasMore = cached ? cached.hasMore : true;
  state.historyLoadedFloor = cached?.floor || 0;
  if (cached) {
    // Apply already observed recalls/clears before showing a retained view.
    renderConversationMessages(visibleConversationMessages());
    bindMessageActions();
  } else container.innerHTML = '<p class="empty">正在加载消息…</p>';
  container.querySelector('[data-initial-history-error]')?.remove();
  updateDesktopChat();
  // A cache checkpoint may improve persistence, but must never hold network reads.
  const history = (async () => {
    initial.diskTicket = await initialHistoryTicket(initial);
    return fetchInitialHistory(initial);
  })().then(result => ({ result }), error => ({ error }));
  if (!cached && localChat.enabled) {
    void localChat.read(Number(id), { limit: 50 }).then(disk => {
      if (state.initialHistory !== initial || state.token !== historyToken || state.historyEpoch !== historyEpoch || Number(state.active?.id) !== Number(id)) return;
      if (disk?.items.length) {
        const rows = initialSnapshotMessages(disk.items.filter(m => Number(m.id) > Number(state.active.cleared_before_message_id || 0)), initial);
        if (rows.length) {
          renderConversationMessages(rows, container); bindMessageActions();
          cached = { page: 1, hasMore: true, floor: Math.min(...rows.map(m => Number(m.id))), position: { bottom: true } };
          state.historyLoadedFloor = cached.floor;
          restoreRecoveryScroll(container, cached.position);
        }
      }
    }).catch(() => {});
  }
  if (cached) restoreRecoveryScroll(container, showLatest ? { bottom: true } : cached.position);
  if (showLatest) PulseChatBottom.followLatest();
  document.querySelectorAll('.conversation').forEach(node => { const active = Number(node.dataset.id) === Number(id); node.classList.toggle('active', active); node.setAttribute('aria-current', active ? 'true' : 'false'); });
  if (focusInput) focusConversationInput(id);
  subscribeConversation(id);
  // Keep the group sidebar's layout in this frame, then let the retained chat
  // paint before refreshing its history and the remaining profile data.
  // The timer also settles if the account is hidden before its next frame.
  await new Promise(resolve => {
    let frame, work; const done = () => { clearTimeout(fallback); clearTimeout(work); cancelAnimationFrame(frame); resolve(); };
    const fallback = setTimeout(done, 60);
    frame = requestAnimationFrame(() => { work = setTimeout(done, 0); });
  });
  if (state.initialHistory !== initial || state.token !== historyToken || state.historyEpoch !== historyEpoch || Number(state.active?.id) !== Number(id)) return;
  syncDefaultGroupChatInfo();
  // The visible group sidebar already requests the authoritative profile.
  if (state.chatInfo?.type !== 'group' || state.chatInfo.id !== Number(id)) void refreshChatHeaderProfile(id);
  if (selected.type === 'group' && desktop.isDesktop) void contactNames.refresh().catch(() => {});
  let result;
  try { const response = await history; if (response.error) throw response.error; result = response.result; }
  catch (error) {
    if (state.initialHistory !== initial || state.token !== historyToken || state.historyEpoch !== historyEpoch) return;
    state.initialHistory = null; state.initialHistoryFailed = true;
    if ([401, 403].includes(error.status)) {
      container.innerHTML = '<p class="empty">当前会话暂时不可访问，请刷新列表后重试。</p>';
      void localChat.clearConversation(Number(id)); purgeLocalMedia(id); return;
    }
    const code = ['TimeoutError', 'AbortError'].includes(error.name) ? 'PC-MSG-LOAD-TIMEOUT' : error.code === 'PC-MSG-LOAD-INVALID' ? error.code : 'PC-MSG-LOAD-FAILED';
    try { desktop.reportDiagnostic?.({ kind: 'renderer-error', name: 'ChatHistoryLoad', source: 'app.js',
      message: `${code}; elapsed_ms=${Date.now() - initial.startedAt}; status=${Number(error.status) || 0}` }); } catch {}
    const notice = `<p class="empty" data-initial-history-error>消息加载暂时失败，请检查连接后重试。（错误编号：${code}）<button id="retry-initial-history" type="button">重新加载</button></p>`;
    if (cached) {
      state.historyReadyEpoch = historyEpoch; state.recoveryNeeded = true; void recoverConversation(id);
      container.insertAdjacentHTML('afterbegin', notice);
      console.warn('会话补同步暂时失败，保留当前消息并等待重连：', error.message);
    } else {
      container.innerHTML = notice;
    }
    $('retry-initial-history').onclick = () => { void openConversation(id); };
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
  void desktop.localMedia?.("allow", Number(id), []).catch(() => {});
  if (initial.diskTicket) void localChat.savePage(Number(id), { ...result, items: fresh }, { ticket: initial.diskTicket, cleared, conversation: selected }).then(() => localChat.enqueue(Number(id)));
  else localChat.enqueue(Number(id), { latest: true });
  state.historyReadyEpoch = historyEpoch; state.historyLoadedFloor = messages.length ? Math.min(...messages.map(message => Number(message.id))) : 0;
  void recoverConversation(id);
  bindMessageActions(); restoreRecoveryScroll(container, position);
  if (showLatest && position.bottom) PulseChatBottom.followLatest();
  await markMessagesRead(messages, { force: Number(state.active?.unread_count) > 0 });
  if (state.token !== historyToken || state.historyEpoch !== historyEpoch) return;
  const refreshed = state.conversationListRefreshed;
  const loading = state.conversationListLoad;
  if ((refreshed?.token !== historyToken || refreshed.userId !== Number(state.user?.id) || Date.now() - refreshed.at >= 5000)
    && !(loading?.token === historyToken && loading.userId === Number(state.user?.id))) await loadConversations();
  if (state.token !== historyToken || state.historyEpoch !== historyEpoch) return;
  updateDesktopChat();
}

async function returnChatToBottom() {
  const token=state.token,userId=Number(state.user?.id),id=Number(state.active?.id),messages=$('messages');
  if(!token||!id||state.page!=='messages'||state.favoriteMode||state.updateRequired||readPasscodeSettings().locked||state.desktopAccountVisible===false)return;
  if(state.chatSearch)state.chatSearch.locateRequest=(state.chatSearch.locateRequest||0)+1;
  if(state.historyLocation||state.initialHistoryFailed){
    const work=openConversation(id,{focusInput:false}),epoch=state.historyEpoch;
    await work;
    if(state.token!==token||Number(state.user?.id)!==userId||Number(state.active?.id)!==id||state.historyEpoch!==epoch||state.page!=='messages')return;
    if(state.initialHistoryFailed)throw Error('最新消息加载失败，请重新加载');
  }else resetChatHistoryLocation();
  if(state.token===token&&Number(state.user?.id)===userId&&Number(state.active?.id)===id&&messages.isConnected)messages.scrollTop=messages.scrollHeight;
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
  if (!foregroundReadsAllowed() || state.page !== 'messages' || !state.active || state.favoriteMode || state.initialHistory || state.historyLoading || !state.historyHasMore) return;
  // Scrolling while socket recovery is reading must not lose the user's request.
  if (state.recovery) {
    state.olderHistoryQueued = { token: state.token, epoch: state.historyEpoch, id: Number(state.active.id) };
    return;
  }
  state.historyLoading = true; state.olderHistoryFailed = false;
  const messages = $('messages'); const conversationId = Number(state.active.id);
  const epoch = state.historyEpoch, token = state.token, revision = state.historyRevision;
  const request = { controller: new AbortController() }; state.olderHistoryRequest = request;
  const current = () => state.olderHistoryRequest === request && !request.controller.signal.aborted && foregroundReadsAllowed()
    && state.token === token && Number(state.active?.id) === conversationId && state.historyEpoch === epoch && state.historyRevision === revision;
  const ids = [...messages.querySelectorAll('[data-message-id]')].map(node => Number(node.dataset.messageId)).filter(id => Number.isSafeInteger(id) && id > 0);
  const before = ids.length ? Math.min(...ids) - 1 : 0;
  renderOlderHistoryControl();
  try {
    if (before <= 0) { state.historyHasMore = false; return; }
    const diskTicket = await localChat.ticket(conversationId);
    if (!current()) return;
    const disk = await localChat.read(conversationId, { before, limit: 51 });
    if (!current()) return;
    const useLocal = disk?.items.length && (disk.meta.complete || disk.items.length >= 51);
    const result = useLocal ? { items: disk.items.slice(-50).reverse(), has_more: disk.items.length > 50 || !disk.meta.complete, local: true }
      : await api(`/messages/history?conversation_id=${conversationId}&page=1&size=50&max_id=${before}`, { authToken: token, signal: request.controller.signal });
    if (!current()) return;
    if (!Array.isArray(result.items) || result.items.some(message => !Number.isSafeInteger(Number(message.id)) || Number(message.id) <= 0 || Number(message.id) > before || Number(message.conversation_id) !== conversationId)
      || new Set(result.items.map(message => Number(message.id))).size !== result.items.length) throw new Error('历史消息分页无效，请重试');
    const older = initialSnapshotMessages(result.items.filter(message => !messages.querySelector(`[data-message-id="${Number(message.id)}"]`)).reverse());
    if (!result.local) void localChat.savePage(conversationId, result, { ticket: diskTicket || undefined, before, cleared: state.active.cleared_before_message_id });
    // Capture after HTTP: a slow read must not undo scrolling performed while it was pending.
    const currentPosition = recoveryScrollAnchor(messages, { forceAnchor: true }); currentPosition.bottom = false;
    if (older.length) { state.historyPage++; messages.insertAdjacentHTML('afterbegin', older.map(messageHtml).join('')); state.historyLoadedFloor = Math.min(...older.map(message => Number(message.id))); bindMessageActions(); }
    state.historyHasMore = result.items.length > 0 && (typeof result.has_more === 'boolean' ? result.has_more : Number.isFinite(Number(result.total)) ? Number(result.total) > result.items.length : true);
    if (result.items.length && Math.min(...result.items.map(message => Number(message.id))) <= 1) state.historyHasMore = false;
    renderOlderHistoryControl();
    // Keep the control before the newly prepended rows.
    messages.prepend(messages.querySelector('[data-history-older]'));
    restoreRecoveryScroll(messages, currentPosition);
    if (result.local) { state.recoveryNeeded = true; setTimeout(() => { if (state.token === token && state.historyEpoch === epoch) void recoverConversation(conversationId); }, 0); }
  } catch (error) {
    if (current()) { state.olderHistoryFailed = true; console.warn('加载历史消息失败：', error.message); }
  } finally {
    if (state.olderHistoryRequest === request) { state.olderHistoryRequest = null; state.historyLoading = false; renderOlderHistoryControl(); void recoverConversation(conversationId); }
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
  if (link.dataset.downloading === '1') return;
  const url = link.dataset.downloadUrl || link.href;
  const fileName = link.dataset.downloadName || '下载文件';
  if (!desktop.isDesktop) { const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); return; }
  const downloadAccount = textOutboxAccount(); link.dataset.downloading = '1';
  try {
    let directory = localStorage.getItem('pulse_download_directory') || '';
    if (localSetting('download_ask', true) || !directory) directory = await desktop.selectDownloadDirectory?.() || '';
    if (!directory || !sameSendAccount(downloadAccount) || readPasscodeSettings().locked || state.desktopAccountVisible === false) return;
    if (desktop.downloadFile) await desktop.downloadFile(url, fileName, directory);
    else { const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); }
    if (link.isConnected && sameSendAccount(downloadAccount)) link.textContent = '已保存';
  } catch (error) { if (sameSendAccount(downloadAccount) && !/下载已取消/.test(error.message || '')) alert(error.message || '文件下载失败'); }
  finally { delete link.dataset.downloading; }
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
  return `<button type="button" class="classic-image-media classic-gif-media" title="查看 GIF" aria-label="查看 GIF"><img class="message-image" loading="lazy" data-gif-url="${escapeHtml(url)}" data-gif-name="${escapeHtml(name)}" src="${escapeHtml(url)}" alt="${escapeHtml(name)}"${width}${height}></button>`;
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
    const current = node.closest('.classic-image-media') || node;
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
      button.replaceWith(messageImageButton(image, '查看 GIF'));
    };
  });
}

function messageImageButton(image, label = '查看图片') {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'classic-image-media'; button.title = label; button.setAttribute('aria-label', label);
  button.append(image); return button;
}

function isDirectChatMessage(message) {
  return desktop.isDesktop && !state.favoriteMode && state.active?.type === 'direct'
    && Number(message.conversation_id) === Number(state.active.id) && message.type !== 'system';
}

function chatMessageAvatarHtml(message, mine, direct = isDirectChatMessage(message)) {
  if (!desktop.isDesktop || (!mine && !direct)) return '';
  const name = mine ? state.user?.nickname || '我' : state.active.peer_nickname || state.active.name || message.sender_name || '对方';
  // A current, explicitly empty peer avatar must not revive an old message photo.
  const source = mine ? state.user?.avatar_url : state.active.avatar_url !== undefined ? state.active.avatar_url : message.sender_avatar_url;
  const letter = Array.from(String(name))[0] || '?';
  return `<span class="classic-message-avatar" aria-hidden="true">${source ? `<img src="${escapeHtml(avatarUrl(source))}" alt="" data-message-avatar-fallback="${escapeHtml(letter)}">` : escapeHtml(letter)}</span>`;
}

function messageHtml(message) {
  if (message.recalled_at || ['recalled', 'deleted'].includes(message.status) || messageVersionCache().get(Number(message.id))?.removed) return '';
  let content;
  const mine = Number(message.sender_id) === Number(state.user.id);
  const direct = isDirectChatMessage(message);
  const image = message.type === 'image' && Boolean(message.body?.url);
  const caption = image && typeof message.body.text === 'string' && message.body.text.trim() ? message.body.text : '';
  const gif = isGifMessage(message);
  const redPacket = message.type === 'red_packet';
  const contactCard = message.type === 'contact_card' && Number(message.body?.user_id) > 0;
  const shake = message.type === 'shake';
  const video = Boolean(message.body?.url) && (message.type === 'video' || (message.type === 'file' && /^video\//i.test(String(message.body?.mime || ''))));
  const autoDownload = mediaAutoDownloadEnabled(state.active, image ? 'photos' : video ? 'videos' : 'files', message);
  if (Number(message.body?.poll_id) > 0) { const poll = groupPollCache.get(Number(message.body.poll_id)); content = `<section class="classic-poll-card" data-group-poll="${Number(message.body.poll_id)}">${poll ? groupPollHtml(poll) : `<strong>${escapeHtml(message.body.text || '群组投票')}</strong><small>正在加载投票…</small>`}</section>`; }
  else if (message.type === 'voice' && message.body?.url) content = `<audio controls preload="${autoDownload ? 'metadata' : 'none'}" src="${escapeHtml(cachedMediaUrl(message))}"></audio>`;
  else if (image) {
    const url = cachedMediaUrl(message);
    const thumbnail = message.body.thumbnail_url ? mediaUrl(message.body.thumbnail_url) : url;
    const imageHtml = autoDownload
      ? (gif && !localSetting('animated_gif', true) ? gifPlayButtonHtml(url, message.body.name || 'GIF 图片') : gif ? gifImageHtml(url, message.body.name || 'GIF 图片', message.body) : `<button type="button" class="classic-image-media" title="${message.body.original ? '查看原图' : '查看图片'}" aria-label="${message.body.original ? '查看原图' : '查看图片'}"><img class="message-image" loading="lazy" src="${escapeHtml(thumbnail)}" alt="${escapeHtml(message.body.name || '图片消息')}"${Number(message.body.width) > 0 ? ` width="${Math.min(10000, Number(message.body.width))}"` : ''}${Number(message.body.height) > 0 ? ` height="${Math.min(10000, Number(message.body.height))}"` : ''}></button>`)
      : `<button class="classic-media-load" type="button" data-media-load-kind="image" data-media-load-url="${escapeHtml(url)}" data-media-load-name="${escapeHtml(message.body.name || '图片消息')}">点击加载图片</button>`;
    content = imageHtml;
  }
  else if (video) {
    const url = cachedMediaUrl(message);
    content = autoDownload
      ? `<video class="message-video" controls preload="metadata" src="${escapeHtml(url)}"></video>`
      : `<button class="classic-media-load" type="button" data-media-load-kind="video" data-media-load-url="${escapeHtml(url)}" data-media-load-name="${escapeHtml(message.body.name || '视频消息')}">点击加载视频</button>`;
  }
  else if (contactCard) {
    const cardAvatar = message.body?.avatar_url ? `<img src="${escapeHtml(avatarUrl(message.body.avatar_url))}" alt="">` : escapeHtml((message.body?.nickname || '?').slice(0, 1));
    content = `<button type="button" class="contact-card-message" data-contact-card-user="${Number(message.body.user_id)}" data-contact-card-message="${Number(message.id)}" data-contact-card-conversation="${Number(message.conversation_id)}"><span class="contact-card-message-avatar">${cardAvatar}</span><span class="contact-card-message-copy"><strong>${escapeHtml(message.body?.nickname || '未命名用户')}</strong><small>${escapeHtml(message.body?.username ? '@' + message.body.username : '站内名片')}</small>${publicUserId(message.body) ? `<small class="contact-public-id">ID：${escapeHtml(publicUserId(message.body))}</small>` : ''}</span><span class="contact-card-message-label">个人名片 · 点击查看  ›</span></button>`;
  }
  else if (shake) content = '<div class="shake-message">窗口抖动</div>';
  else if (message.type === 'file' && message.body?.url) { const url = mediaUrl(message.body.url); content = autoDownload ? `<a class="file-link" href="${escapeHtml(url)}" data-download-url="${escapeHtml(url)}" data-download-name="${escapeHtml(message.body.name || '下载文件')}" target="_blank" rel="noreferrer">下载文件</a>` : `<button class="classic-media-load" type="button" data-media-load-kind="file" data-media-load-url="${escapeHtml(url)}" data-media-load-name="${escapeHtml(message.body.name || '下载文件')}">点击加载文件</button>`; }
  else if (redPacket) content = '<div class="red-packet-card"><strong>历史红包</strong><span>红包功能已停用</span></div>';
  else {
    const text = escapeHtml(message.body?.text || `[${messageType(message.type)}消息]`);
    content = message.type === 'text' ? `<span class="message-text-content">${text}</span>` : text;
  }
  const recall = !redPacket && mine && state.user?.internal_staff && !message.body?.poll_id ? `<button class="recall-button" data-recall-id="${message.id}" type="button">撤回</button>` : '';
  const avatar = chatMessageAvatarHtml(message, mine, direct);
  const time = desktop.isDesktop ? String(message.created_at || '').match(/(?:T|\s)(\d{2}:\d{2})/)?.[1] || '' : message.created_at;
  const receipt = messageReceipts.html(message);
  const metadata = `<small class="classic-message-meta"><time title="${escapeHtml(message.created_at || '')}">${escapeHtml(caption ? String(message.created_at || '').match(/(?:T|\s)(\d{2}:\d{2})/)?.[1] || '' : time)}</time>${recall}</small>`;
  if (caption) {
    content = `<div class="image-caption-card"><div class="image-caption-media">${content}</div><div class="image-caption-copy"><p class="classic-image-caption">${escapeHtml(caption)}</p>${metadata}</div></div>`;
  }
  return `<article class="bubble ${mine ? 'mine' : ''}${direct ? ' direct-message' : ''}${receipt ? ' has-message-receipt' : ''}${redPacket ? ' red-packet-message' : ''}${contactCard ? ' contact-card-bubble' : ''}${shake ? ' shake-bubble' : ''}${message.type === 'text' ? ' text-message' : ''}${message.type === 'system' ? ' system-message' : ''}${image || video || contactCard ? ' visual-message' : ''}${image ? ' image-message' : ''}${caption ? ' has-image-caption' : ''}" data-message-id="${message.id}" data-conversation-id="${Number(message.conversation_id)}">${avatar}${content}${caption ? '' : metadata}${receipt}</article>`;
}

function bindMessageActions() {
  messageReceipts.refresh();
  document.querySelectorAll('[data-message-avatar-fallback]').forEach(img => { img.onerror = () => { if (!PulseMessageView.retryFreshSource(img)) img.parentElement.textContent = img.dataset.messageAvatarFallback; }; });
  document.querySelectorAll('[data-recall-id]').forEach(button => { button.onclick = () => recallMessage(Number(button.dataset.recallId)); });
  document.querySelectorAll('[data-contact-card-user]').forEach(button => { button.onclick = () => {
    const id = Number(button.closest('[data-message-id]')?.dataset.messageId);
    const message = state.messages.find(item => Number(item.id) === id) || { id, conversation_id: Number(button.dataset.contactCardConversation), type: 'contact_card', body: { user_id: Number(button.dataset.contactCardUser) } };
    openReceivedContactCard(message, button);
  }; });
  document.querySelectorAll('[data-media-load-url]').forEach(button => { button.onclick = () => {
    const url = button.dataset.mediaLoadUrl, name = button.dataset.mediaLoadName || '媒体消息', kind = button.dataset.mediaLoadKind || 'image';
    if (kind === 'video') {
      const video = document.createElement('video'); video.className = 'message-video'; video.controls = true; video.preload = 'metadata'; video.src = url;
      button.replaceWith(video); applyMediaOutputToElement(video); return;
    }
    if (kind === 'file') {
      const link = document.createElement('a'); link.className = 'file-link'; link.href = url; link.target = '_blank'; link.rel = 'noreferrer'; link.dataset.downloadUrl = url; link.dataset.downloadName = name; link.textContent = '下载文件';
      button.replaceWith(link); link.onclick = event => downloadMessageFile(event, link); return;
    }
    const image = document.createElement('img'); image.className = 'message-image'; image.loading = 'lazy'; image.src = url; image.alt = name;
    button.replaceWith(messageImageButton(image));
  }; });
  document.querySelectorAll('[data-download-url]').forEach(link => { link.onclick = event => downloadMessageFile(event, link); });
  bindGifActions(); applyMediaOutputSettings(); bindGroupPollActions(); refreshGroupPollCards();
}
function triggerWindowShake() {
  const main = document.querySelector('.main');
  if (!main) return;
  main.classList.remove('window-shaking');
  void main.offsetWidth;
  main.classList.add('window-shaking');
  clearTimeout(state.shakeTimer);
  state.shakeTimer = setTimeout(() => main.classList.remove('window-shaking'), 460);
}
function appendMessage(message, source = 'ack') { textOutbox.confirm(textOutboxAccount(), message); if (Number(message.id) <= Number(state.active?.cleared_before_message_id || 0)) return; if (!rememberRecoveryMessage(message.recalled_at ? 'message.recalled' : 'message.new', message, source)) return; if (!state.user || Number(message.conversation_id) !== Number(state.active?.id)) return; if (Number(message.id) <= Number(state.active?.cleared_before_message_id || 0) || document.querySelector(`[data-message-id="${message.id}"]`)) return; if (message.type === 'shake') triggerWindowShake(); if (state.historyLocation?.conversationId === Number(state.active?.id) && Number(message.id) > state.historyLocation.maxId) { const notice = $('chat-history-location')?.querySelector('span'); if (notice) notice.textContent = '有新消息'; return; } const scrollPosition = recoveryScrollAnchor($('messages')); const empty = $('messages').querySelector('.empty'); if (empty) empty.remove(); const next = [...$('messages').querySelectorAll('[data-message-id]')].find(node => Number(node.dataset.messageId) > Number(message.id)) || $('messages').querySelector('[data-outbox-id]'); if (next) next.insertAdjacentHTML('beforebegin', messageHtml(message)); else $('messages').insertAdjacentHTML('beforeend', messageHtml(message)); bindMessageActions(); restoreRecoveryScroll($('messages'), scrollPosition); if (Number(message.conversation_id) === Number(state.active?.id)) void markMessagesRead([message]); }
async function markReceipt(messageId, status, refreshList = true) {
  if (status === 'read') { if (canReadActiveMessage(messageId)) return conversationReads.mark(state.active?.id, messageId); return; }
  const token = state.token;
  try {
    await api('/messages/receipt', { method: 'POST', authToken: token, body: JSON.stringify({ conversation_id: state.active?.id, message_id: messageId, status }) });
    if (refreshList && state.token === token && state.user && status === 'read') loadConversations().catch(() => {});
  } catch (error) { console.warn('消息回执失败：', error.message); }
}
async function markMessagesRead(messages, options = {}) {
  const id = Number(state.active?.id);
  const through = Math.max(0, ...messages.filter(message => Number(message.conversation_id) === id && canReadActiveMessage(message.id)).map(message => Number(message.id)));
  if (through > 0) return conversationReads.mark(id, through, options);
}
function canReadActiveMessage(messageId) {
  return Boolean(state.user && state.token && state.page === 'messages' && !state.updateRequired && !document.hidden && state.desktopAccountVisible !== false
    && !readPasscodeSettings().locked && !$('messages')?.hidden && $('messages')?.querySelector('[data-message-id="' + Number(messageId) + '"]'));
}

function forwardMessageBody(message) {
  if (GO) { if (!message.body?._go_wire_id || !canForwardSource(message)) throw GO.fail('forbidden', 403); return {_source_wire_id:message.body._go_wire_id}; }
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
    && conversation.can_send !== false && !conversation.frozen_at && conversation.status !== 'frozen' && conversation.can_publish !== false && conversation.can_publish !== 0
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
  const remark = String(item.remark || '').trim(), nickname = String(item.nickname || '').trim();
  const name = remark || nickname || '未命名用户';
  const avatar = item.avatar_url ? `<img src="${escapeHtml(avatarUrl(item.avatar_url))}" alt="">` : escapeHtml(name.slice(0, 1));
  return `<button type="button" class="contact-card-picker-row" data-send-contact-card="${userId}"><span class="contact-modal-avatar">${avatar}</span><span class="contact-modal-copy"><strong>${escapeHtml(name)}</strong>${remark && nickname && remark !== nickname ? `<small>昵称：${escapeHtml(nickname)}</small>` : ''}<small>${escapeHtml(item.username ? '@' + item.username : item.phone || '站内联系人')}</small>${publicUserId(item) ? `<small class="contact-public-id">ID：${escapeHtml(publicUserId(item))}</small>` : ''}</span><span class="contact-card-picker-arrow">发送</span></button>`;
}
async function openReceivedContactCard(message, sourceButton = null) {
  const userId = Number(message?.body?.user_id), messageId = Number(message?.id), conversationId = Number(message?.conversation_id);
  const account = { token: state.token, userId: Number(state.user?.id) };
  const activeId = Number(state.active?.id) || 0;
  if (!contactActionsAllowed(account) || message?.type !== 'contact_card' || ![userId, messageId, conversationId].every(id => Number.isSafeInteger(id) && id > 0)) return;
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal data-received-contact-card><section class="feature-card received-card-profile" role="dialog" aria-modal="true" aria-label="联系人名片"><header><h2>联系人名片</h2><button class="icon-button" type="button" data-close-modal aria-label="关闭名片">×</button></header><div data-received-card-content><p class="modal-empty">正在加载名片…</p></div><p class="form-feedback" data-received-card-feedback role="status"></p></section></div>`);
  bindFeatureModal();
  const modal = document.querySelector('[data-received-contact-card]'), content = modal.querySelector('[data-received-card-content]'), feedback = modal.querySelector('[data-received-card-feedback]');
  const controller = modal.receivedCardController = new AbortController();
  const epoch = state.historyEpoch, revision = contactActionRevision, navigation = messageForwardNavigationRevision;
  let profile = null, busy = false, requested = false, forced = false;
  const current = () => contactActionsAllowed(account) && modal.isConnected && document.querySelector('[data-feature-modal]') === modal
    && state.historyEpoch === epoch && contactActionRevision === revision && messageForwardNavigationRevision === navigation && (Number(state.active?.id) || 0) === activeId && sourceLive();
  function sourceLive() {
    const item = state.messages.find(item => Number(item.id) === messageId);
    if (item) return Number(item.conversation_id) === conversationId && item.type === 'contact_card' && Number(item.body?.user_id) === userId && !item.recalled_at && !['recalled', 'deleted'].includes(item.status);
    return Boolean(sourceButton?.isConnected && Number(sourceButton.dataset.contactCardMessage) === messageId && Number(sourceButton.dataset.contactCardConversation) === conversationId && Number(sourceButton.dataset.contactCardUser) === userId);
  }
  const refresh = async () => {
    const value = await api(`/contacts/card-profile?user_id=${userId}&conversation_id=${conversationId}&message_id=${messageId}`, { authToken: account.token, signal: controller.signal });
    if (!current()) return null;
    if (Number(value?.id) !== userId || Number(value.source_conversation_id) !== conversationId || Number(value.source_message_id) !== messageId
      || typeof value.is_contact !== 'boolean' || typeof value.can_add_friend !== 'boolean') throw Error('名片资料不匹配，请重试。');
    profile = value; return value;
  };
  const render = () => {
    if (!current() || !profile) return;
    const self = userId === account.userId, contact = profile.is_contact;
    const nickname = profile.nickname || '未命名用户', name = contact && !self ? contactDisplayName(userId, nickname) : nickname;
    const avatar = profile.avatar_url ? `<img src="${escapeHtml(avatarUrl(profile.avatar_url))}" alt="">` : escapeHtml(name.slice(0, 1));
    content.innerHTML = `<div class="received-card-identity"><span class="received-card-avatar">${avatar}</span><div><h3>${escapeHtml(name)}</h3>${name !== nickname ? `<p>昵称：${escapeHtml(nickname)}</p>` : ''}<p>账号：${escapeHtml(profile.username || '未公开')}</p><p>ID：${escapeHtml(publicUserId(profile) || '暂不可用')}</p></div></div>${contact && !self ? `<button class="received-card-remark" type="button" data-card-remark><span>备注名</span><span>${escapeHtml(name === nickname ? '设置备注' : name)} ›</span></button>` : ''}<button class="primary received-card-action" type="button" data-card-action ${busy || self || !contact && (requested || !profile.can_add_friend) ? 'disabled' : ''}>${self ? '这是你自己' : busy ? '处理中…' : contact ? forced ? '聊天' : '发送消息' : requested ? '已申请添加好友' : '添加好友'}</button>${!contact && profile.add_friend_restriction ? `<p class="received-card-restriction">${escapeHtml(profile.add_friend_restriction)}</p>` : ''}`;
    content.querySelector('[data-card-remark]')?.addEventListener('click', () => { if (current() && !busy) openContactProfile(userId); });
    content.querySelector('[data-card-action]').onclick = async () => {
      if (!current() || busy || self || !profile.is_contact && (requested || !profile.can_add_friend)) return;
      busy = true; feedback.textContent = ''; render();
      try {
        const fresh = await refresh(); if (!fresh || !current()) return;
        if (fresh.is_contact) { await openContactChat(userId, null, current); return; }
        if (!fresh.can_add_friend) throw Error(fresh.add_friend_restriction || '当前无法添加该好友。');
        if (state.user?.internal_staff) {
          const result = await api('/contacts/force-add', { authToken: account.token, signal: controller.signal, method: 'POST', body: JSON.stringify({ user_id: userId }) });
          if (!current()) return;
          if (result.status !== 'accepted' || result.forced !== true || Number(result.user_id) !== userId) throw Error('强加好友回执无效，请重试。');
          profile.is_contact = true; forced = true;
        } else {
          const result = await api('/contact-requests', { authToken: account.token, signal: controller.signal, method: 'POST', body: JSON.stringify({ to_user_id: userId,
            message: '你好，想和你成为好友', card_conversation_id: conversationId, card_message_id: messageId }) });
          if (!current()) return;
          if (!['accepted', 'pending'].includes(result.status)) throw Error('好友申请回执无效，请重试。');
          if (result.status === 'accepted') profile.is_contact = true;
          else requested = true;
        }
        void loadConversations().catch(() => {});
      } catch (error) { if (current()) feedback.textContent = error.message || '操作失败，请重试。'; }
      finally {
        busy = false;
        if (!current() && modal.isConnected) { feedback.textContent = '名片已不可用，请关闭后重新查看。'; content.querySelectorAll('button').forEach(button => { button.disabled = true; }); }
        else render();
      }
    };
  };
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing && modal.isConnected && document.querySelector('[data-feature-modal]') === modal) { event.preventDefault(); event.stopPropagation(); closeFeatureModal(); } }, { capture: true, signal: controller.signal });
  modal.querySelector('[data-close-modal]').focus();
  async function load() {
    if (!current()) return;
    try { if (await refresh()) render(); }
    catch (error) {
      if (!current()) return;
      feedback.textContent = error.message || '名片加载失败，请重试。';
      content.innerHTML = '<button type="button" class="secondary-button" data-card-retry>重新加载</button>';
      content.querySelector('[data-card-retry]').onclick = () => { feedback.textContent = ''; void load(); };
    }
  }
  await load();
}
function normalizeContactCardSearch(value) {
  return String(value || '').normalize('NFKC').toLowerCase().trim();
}
function contactCardMatchesSearch(item, terms) {
  const fields = [item.remark, item.nickname, item.username ? '@' + item.username : '', item.phone, publicUserId(item)].map(normalizeContactCardSearch);
  return terms.every(term => fields.some(value => value.includes(term)));
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
  picker.modal.querySelectorAll('[data-send-contact-card],[data-share-target],[data-retry-contact-cards],input').forEach(node => { node.disabled = picker.sending; });
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
    list.innerHTML = targets.map(item => `<button type="button" class="contact-card-picker-row" data-share-target="${Number(item.id)}"><span class="contact-modal-avatar">${item.avatar_url ? `<img src="${escapeHtml(avatarUrl(item.avatar_url))}" alt="">` : escapeHtml((item.name || '会').slice(0, 1))}</span><span class="contact-modal-copy"><strong>${escapeHtml(item.name || '未命名会话')}</strong><small>${item.type === 'group' ? `${Number(item.member_count || 0)} 位成员` : '私聊会话'}</small></span><span class="contact-card-picker-arrow">发送</span></button>`).join('') || '<p class="modal-empty">暂无可发送的其他会话</p>';
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
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal contact-card-picker-backdrop" data-feature-modal><section class="feature-card contact-card-picker" role="dialog" aria-modal="true" aria-labelledby="contact-card-picker-title"><header><h2 id="contact-card-picker-title">发送站内名片</h2><button type="button" class="icon-button" data-close-modal aria-label="关闭">×</button></header><input id="contact-card-picker-search" type="search" placeholder="搜索备注/昵称/账号/ID，空格分隔关键词" aria-label="搜索备注、昵称、账号或ID" aria-describedby="contact-card-picker-status"><p id="contact-card-picker-status" class="contact-card-picker-status" role="status" aria-live="polite"></p><div id="contact-card-picker-list" class="contact-card-picker-list"><p class="modal-empty">正在加载联系人…</p></div><p id="contact-card-picker-feedback" class="form-feedback" role="status"></p></section></div>`);
  bindFeatureModal();
  const modal = document.querySelector('.contact-card-picker-backdrop');
  const list = $('contact-card-picker-list'), search = $('contact-card-picker-search'), status = $('contact-card-picker-status');
  const picker = contactCardPickerState(modal, 'contact-card-picker-feedback', state.active);
  const contacts = new Map();
  let items = [], nextPage = 1, loading = false, loaded = false, loadError = '';
  const render = () => {
    if (!currentContactCardPicker(picker)) return;
    const terms = normalizeContactCardSearch(search.value).split(/\s+/).filter(Boolean);
    const filtered = items.filter(item => contactCardMatchesSearch(item, terms));
    const empty = loading ? '正在搜索，联系人仍在加载…' : loadError ? '已加载的联系人中暂无匹配，请重试加载。' : '没有匹配的联系人';
    const html = filtered.map(contactCardRowHtml).join('') || `<p class="modal-empty">${empty}</p>`;
    if (list.innerHTML !== html) {
      const focusedId = document.activeElement?.dataset.sendContactCard, scrollTop = list.scrollTop;
      list.innerHTML = html;
      if (focusedId) list.querySelector(`[data-send-contact-card="${Number(focusedId)}"]`)?.focus({ preventScroll: true });
      list.scrollTop = scrollTop;
    }
    list.querySelectorAll('[data-send-contact-card]').forEach(button => { button.onclick = () => sendContactCard(Number(button.dataset.sendContactCard), picker); });
    status.textContent = loading ? `已加载 ${items.length} 位，正在加载联系人…` : loadError ? `${loadError} 已加载 ${items.length} 位，列表尚未完整。` : terms.length ? `找到 ${filtered.length} 位联系人` : `共 ${items.length} 位联系人`;
    if (loadError && !loading) {
      const retry = document.createElement('button');
      retry.type = 'button'; retry.dataset.retryContactCards = ''; retry.textContent = '重试加载';
      retry.onclick = loadContacts; status.append(' ', retry);
    }
    setContactCardPickerBusy(picker);
  };
  search.oninput = render;
  async function loadContacts() {
    if (!currentContactCardPicker(picker) || loading || loaded || picker.sending) return;
    loading = true; loadError = ''; render();
    try {
      while (currentContactCardPicker(picker)) {
        const result = await api(`/contacts?size=100${nextPage > 1 ? '&page=' + nextPage : ''}`, { authToken: picker.account.token });
        if (!currentContactCardPicker(picker)) return;
        if (!Array.isArray(result.items)) throw new Error('联系人列表加载失败。');
        const before = contacts.size;
        for (const item of result.items) {
          const userId = Number(item.user_id || item.id);
          if (Number.isSafeInteger(userId) && userId > 0) contacts.set(userId, item);
        }
        items = [...contacts.values()];
        const total = Number(result.total);
        loaded = result.total != null && Number.isSafeInteger(total) && total >= 0 ? contacts.size >= total : result.items.length < 100;
        if (!loaded && contacts.size === before) throw new Error('联系人列表尚未完整加载。');
        nextPage++; render();
        if (loaded) break;
      }
    } catch (error) {
      if (currentContactCardPicker(picker)) loadError = error.message || '联系人加载失败。';
    } finally {
      loading = false; render();
    }
  }
  await loadContacts();
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
  if (desktop.isDesktop && (kind === 'image' || /^image\//i.test(file.type) || /\.(jpe?g|png|gif|webp)$/i.test(file.name))) return openImageSendPreview(file, capturedContext);
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

function desktopMediaSendAllowed() {
  const conversation = state.active;
  if (!state.token || !state.user || state.updateRequired || state.desktopAccountVisible === false || readPasscodeSettings().locked || state.page !== 'messages' || !conversation || $('composer')?.hidden || $('message-input')?.disabled) return false;
  if (!forwardTargetAllowed(conversation) || ['deleted', 'dissolved'].includes(conversation.status)) return false;
  return !composerPermissions.reason(conversation);
}

function sendDroppedMedia(files) {
  if (!desktopMediaSendAllowed() || !files.length) return;
  const images = files.every(file => /\.(jpe?g|png|gif|webp)$/i.test(file.name));
  if (images) return openImageSendPreview(files, captureSendContext());
  if (state.imageDraft) { imageSendFeedback('请继续添加 JPG、PNG、GIF 或 WebP 图片，视频请单独发送。'); return; }
  if (files.length === 1 && (/^video\//i.test(files[0].type) || /\.(mp4|webm|mov|avi|mkv|ogv|mpeg|mpg|3gp|m4v|wmv)$/i.test(files[0].name))) return sendMediaFile('video', files[0], captureSendContext());
  composerFeedback('请拖入 JPG、PNG、GIF、WebP 图片，可一次拖入多张；视频请每次发送一个。');
}

function currentImageSendDraft(draft) {
  return Boolean(draft && state.imageDraft === draft && !draft.sending && draft.modal?.isConnected
    && sameSendAccount(draft.context) && draft.conversationId === Number(state.active?.id));
}

function imageSendFeedback(message) {
  if (currentImageSendDraft(state.imageDraft)) {
    state.imageDraft.feedback = message;
    state.imageDraft.modal.querySelector('#image-send-feedback').textContent = message;
  } else composerFeedback(message);
}

function disposeImageSendItem(item) {
  item.image.onload = item.image.onerror = null;
  item.image.removeAttribute('src');
  URL.revokeObjectURL(item.previewUrl);
}

function refreshImageSendPreview(draft) {
  if (!currentImageSendDraft(draft)) return;
  const count = draft.items.length, modal = draft.modal;
  modal.querySelector('#image-send-title').textContent = `已选择 ${count} 张图片`;
  const preview = modal.querySelector('.classic-image-send-preview');
  preview.classList.toggle('is-multiple', count > 1);
  preview.classList.toggle('is-album', count >= 4);
  for (const [index, item] of draft.items.entries()) {
    item.image.alt = `待发送图片 ${index + 1}：${item.file.name}`;
    item.tile.querySelector('button').setAttribute('aria-label', `移除第 ${index + 1} 张图片：${item.file.name}`);
    item.tile.classList.toggle('has-error', Boolean(item.error));
    item.tile.querySelector('span').hidden = !item.error;
    if (index < 2 && item.decoded && !item.preparedDefault) item.preparedDefault = prepareImageSendFile(item, false).catch(() => null);
  }
  draft.ready = count > 0 && draft.items.every(item => item.decoded && !item.error);
  modal.querySelector('#image-send-submit').disabled = !draft.ready;
  const labels = modal.querySelectorAll('.classic-image-send-options label > span:last-child');
  labels[0].textContent = count > 1 ? `批量发送 ${count} 张图片` : '以图片形式发送';
  labels[1].textContent = count > 1 ? `批量发送 ${count} 张原图` : '以原图形式发送';
  modal.querySelector('.classic-image-send-caption span').textContent = count > 1 ? '添加说明（随第一张图片发送）' : '添加说明';
  modal.querySelector('#image-send-feedback').textContent = draft.items.find(item => item.error)?.error || draft.feedback || '';
  modal.querySelector('#image-send-add').disabled = count >= 20;
}

function appendImageSendFiles(draft, files) {
  if (!currentImageSendDraft(draft) || !desktopMediaSendAllowed()) return;
  draft.feedback = '';
  const preview = draft.modal.querySelector('.classic-image-send-preview');
  const added = files.map(file => {
    const item = { file, previewUrl: URL.createObjectURL(file), decoded: false, uploaded: null, pendingPayload: null, sent: false, width: 0, height: 0, requestId: `pc-image-${crypto.randomUUID()}` };
    const tile = document.createElement('div'); tile.className = 'classic-image-send-item'; tile.setAttribute('role', 'listitem');
    tile.innerHTML = '<img><button type="button" class="classic-image-send-remove" title="移除图片">×</button><span hidden>无法预览</span>';
    item.tile = tile; item.image = tile.querySelector('img');
    tile.querySelector('button').onclick = () => {
      if (!currentImageSendDraft(draft)) return;
      draft.items = draft.items.filter(photo => photo !== item); tile.remove(); disposeImageSendItem(item); draft.feedback = '';
      if (!draft.items.length) { closeImageSendPreview(); return; }
      refreshImageSendPreview(draft);
    };
    const current = () => currentImageSendDraft(draft) && draft.items.includes(item);
    item.image.onload = () => {
      if (!current()) return;
      item.width = item.image.naturalWidth; item.height = item.image.naturalHeight;
      item.decoded = Boolean(item.width && item.height && item.width <= 10000 && item.height <= 10000 && item.width * item.height <= 80000000);
      item.error = item.decoded ? '' : `“${item.file.name}”尺寸过大或无法读取，请移除后重试。`;
      refreshImageSendPreview(draft);
    };
    item.image.onerror = () => {
      if (!current()) return;
      item.decoded = false; item.error = `“${item.file.name}”无法预览，请移除后重试。`; refreshImageSendPreview(draft);
    };
    preview.append(tile); return item;
  });
  draft.items.push(...added); refreshImageSendPreview(draft);
  for (const item of added) item.image.src = item.previewUrl;
}

function openImageSendPreview(fileOrFiles, capturedContext = null) {
  const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  if (!state.active || !files.length || files.some(file => !file)) return;
  if (!desktopMediaSendAllowed()) { imageSendFeedback('当前会话暂时不能发送图片。'); return; }
  if (state.imageDraft?.sending) return;
  const existing = currentImageSendDraft(state.imageDraft) ? state.imageDraft : null;
  if (files.length + (existing?.items.length || 0) > 20) { imageSendFeedback('一次最多发送 20 张图片，请移除部分图片或分批发送。'); return; }
  if (files.some(file => !/\.(jpe?g|png|gif|webp)$/i.test(file.name) || (file.type && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)))) { imageSendFeedback('请选择 JPG、PNG、GIF 或 WebP 图片。'); return; }
  if (files.some(file => !file.size || file.size > 10 * 1024 * 1024)) { imageSendFeedback('每张图片大小必须在 10 MB 以内。'); return; }
  if ([...imageSendBatches].some(batch => batch.queue.running)) { composerFeedback('图片正在发送，可在聊天中查看进度或停止后续发送。'); return; }
  const context = capturedContext || captureSendContext();
  if (!sameSendAccount(context) || context.conversationId !== Number(state.active.id)) return;
  if (existing) { appendImageSendFiles(existing, files); return; }
  closeFeatureModal();
  composerFeedback('');
  const draft = { items: [], conversationId: context.conversationId, context, ready: false, sending: false, feedback: '' };
  state.imageDraft = draft;
  $('image-picker').value = '';
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal classic-image-send-backdrop" data-feature-modal><section class="classic-image-send-dialog" role="dialog" aria-modal="true" aria-labelledby="image-send-title"><form id="image-send-form"><header><h2 id="image-send-title" aria-live="polite"></h2><button id="image-send-close" type="button" aria-label="关闭">×</button></header><div class="classic-image-send-preview" role="list" aria-label="待发送图片"></div><p class="classic-image-send-hint">可继续拖入图片，或点击“添加”</p><fieldset class="classic-image-send-options"><legend class="visually-hidden">图片发送方式</legend><label><input type="radio" name="image-send-mode" value="image" checked><span class="classic-image-send-radio" aria-hidden="true"></span><span>以图片形式发送</span></label><label><input type="radio" name="image-send-mode" value="original"><span class="classic-image-send-radio" aria-hidden="true"></span><span>以原图形式发送</span></label></fieldset><label class="classic-image-send-caption" for="image-send-caption"><span>添加说明</span></label><div class="classic-image-caption-input"><textarea id="image-send-caption" maxlength="1000" rows="1" aria-label="添加说明"></textarea><button id="image-send-emoji" type="button" aria-label="添加表情" aria-expanded="false">${navIcon('smile')}</button></div><div id="image-send-emoji-picker" class="classic-image-emoji-picker" hidden>${['😀', '😊', '😂', '🥰', '😎', '👍', '❤️', '🎉', '🙏', '🌹', '👌', '✨'].map(emoji => `<button type="button" data-image-emoji="${emoji}">${emoji}</button>`).join('')}</div><input id="image-send-picker" type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden><p id="image-send-feedback" class="classic-image-send-feedback" role="status"></p><footer><button id="image-send-add" type="button">添加</button><button id="image-send-cancel" type="button">取消</button><button id="image-send-submit" type="submit" disabled>发送</button></footer></form></section></div>`);
  const modal = document.querySelector('.classic-image-send-backdrop');
  draft.modal = modal;
  appendImageSendFiles(draft, files);
  const cancel = () => { if (!draft.sending && state.imageDraft === draft) closeFeatureModal(); };
  $('image-send-cancel').onclick = cancel;
  $('image-send-close').onclick = cancel;
  const picker = $('image-send-picker');
  $('image-send-add').onclick = () => { if (currentImageSendDraft(draft) && desktopMediaSendAllowed()) { picker.value = ''; picker.click(); } };
  picker.onchange = () => { if (currentImageSendDraft(draft)) openImageSendPreview([...picker.files], draft.context); picker.value = ''; };
  modal.onpaste = event => {
    const images = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
    if (images.length) { event.preventDefault(); if (currentImageSendDraft(draft)) openImageSendPreview(images, draft.context); }
  };
  modal.onclick = (event) => { if (event.target === modal) cancel(); };
  let captionComposing = false;
  $('image-send-caption').addEventListener('compositionstart', () => { captionComposing = true; });
  $('image-send-caption').addEventListener('compositionend', () => { captionComposing = false; });
  $('image-send-caption').title = '回车发送，Shift+回车换行';
  modal.onkeydown = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); cancel(); return; }
    if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
        || event.isComposing || captionComposing || event.keyCode === 229 || event.target.closest('button')) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat && currentImageSendDraft(draft) && draft.ready) $('image-send-form').requestSubmit($('image-send-submit'));
  };
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

async function prepareImageSendFile(item, original) {
  const sourceType = item.file.type || (/\.jpe?g$/i.test(item.file.name) ? 'image/jpeg' : /\.webp$/i.test(item.file.name) ? 'image/webp' : 'image/png');
  // The explicit original option and animated GIFs retain their original bytes.
  if (original || sourceType === 'image/gif' || /\.gif$/i.test(item.file.name)) return { file: item.file, width: item.width, height: item.height };
  const budget = 512 * 1024;
  if (item.file.size <= budget && Math.max(item.width, item.height) <= 1600) return { file: item.file, width: item.width, height: item.height };
  const canvas = document.createElement('canvas'), ratio = Math.min(1, 1600 / Math.max(item.width, item.height));
  canvas.width = Math.max(1, Math.round(item.width * ratio)); canvas.height = Math.max(1, Math.round(item.height * ratio));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前环境无法处理图片，请选择原图发送。');
  context.drawImage(item.image, 0, 0, canvas.width, canvas.height);
  let alpha = false;
  if (sourceType !== 'image/jpeg') {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) { alpha = true; break; }
  }
  const mime = alpha ? 'image/webp' : 'image/jpeg';
  let quality = .82;
  for (;;) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, quality));
    if (!blob) throw new Error('图片处理失败，请选择原图发送。');
    if (blob.size <= budget) {
      const extension = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
      const name = item.file.name.replace(/\.[^.]+$/, '') + '.' + extension;
      return { file: new File([blob], name, { type: blob.type }), width: canvas.width, height: canvas.height };
    }
    if (quality > .7) { quality = .7; continue; }
    if (canvas.width <= 256 && canvas.height <= 256) throw new Error('图片处理后仍过大，请选择原图或更小的图片。');
    canvas.width = Math.max(1, Math.round(canvas.width * .8)); canvas.height = Math.max(1, Math.round(canvas.height * .8));
    context.drawImage(item.image, 0, 0, canvas.width, canvas.height); quality = .82;
  }
}

function disposeImageSendBatch(batch) {
  imageSendBatches.delete(batch);
  for (const item of batch.items) disposeImageSendItem(item);
  renderImageOutbox();
}
function clearImageSendBatches() {
  for (const batch of [...imageSendBatches]) { batch.queue.stop(); disposeImageSendBatch(batch); }
}
function renderImageOutbox() {
  const container = $('messages'); if (!container) return;
  const pending = [...imageSendBatches].filter(batch => sameSendAccount(batch.context) && batch.context.conversationId === Number(state.active?.id));
  const ids = new Set(pending.flatMap(batch => batch.items.filter(item => !item.sent).map(item => item.requestId)));
  container.querySelectorAll('[data-image-outbox]').forEach(node => { if (!ids.has(node.dataset.imageOutbox)) node.remove(); });
  if (!ids.size) return;
  const follow = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
  container.querySelector('.empty')?.remove();
  for (const batch of pending) for (const item of batch.items) {
    if (item.sent) continue;
    const pendingMessage = { type: 'image', conversation_id: batch.context.conversationId };
    const direct = isDirectChatMessage(pendingMessage);
    let node = container.querySelector(`[data-image-outbox="${item.requestId}"]`);
    if (!node) {
      node = document.createElement('article'); node.className = 'bubble mine image-outbox-message'; node.dataset.imageOutbox = item.requestId;
      node.innerHTML = `${direct ? chatMessageAvatarHtml(pendingMessage, true, direct) : ''}<img src="${escapeHtml(item.previewUrl)}" alt="待发送图片" style="display:block;width:auto;height:auto;max-width:min(240px,100%);max-height:200px;object-fit:contain"><small class="classic-message-meta"><span data-image-status></span> <button type="button" class="text-outbox-retry" data-image-retry hidden>重试发送</button> <button type="button" class="text-outbox-remove" data-image-stop>停止后续发送</button></small>`;
      container.append(node);
    }
    node.classList.toggle('direct-message', direct);
    const failed = item.phase === 'failed';
    const progress = item.uploadProgress;
    const uploadLabel = progress?.stage === 'route' ? '正在连接上传服务…' : progress?.stage === 'read' ? '正在读取图片…' : progress?.waiting ? '图片已上传，等待服务器处理…' : progress?.total > 0
      ? `正在上传图片 ${Math.min(99, Math.floor(progress.sent * 100 / progress.total))}%…` : '正在上传图片…';
    const label = failed ? (item.error || '图片发送失败，可重试') : item.phase === 'processing' ? '正在处理图片…' : item.phase === 'uploading' ? uploadLabel : item.phase === 'sending' ? '正在发送…' : '等待发送…';
    node.dataset.sendState = failed ? 'failed' : 'sending';
    node.querySelector('[data-image-status]').textContent = label;
    const retry = node.querySelector('[data-image-retry]'); retry.hidden = !failed || batch.queue.running;
    retry.onclick = () => { void batch.queue.run(); };
    const stop = node.querySelector('[data-image-stop]'); stop.hidden = item !== batch.items.find(photo => !photo.sent);
    stop.onclick = () => { batch.queue.stop(); disposeImageSendBatch(batch); };
  }
  if (follow) container.scrollTop = container.scrollHeight;
}

async function submitImageSend(draft) {
  if (state.imageDraft !== draft || !draft.ready || draft.sending) return;
  if (!sameSendAccount(draft.context) || Number(state.active?.id) !== draft.conversationId) { closeImageSendPreview(); return; }
  if (!desktopMediaSendAllowed()) { $('image-send-feedback').textContent = '当前会话暂时不能发送图片。'; return; }
  const items = [...draft.items];
  const original = draft.modal.querySelector('[name="image-send-mode"]:checked').value === 'original';
  const text = $('image-send-caption').value.trim();
  const batch = { items, context: draft.context, queue: null };
  batch.queue = PulseImageSendQueue.create({
    items,
    allowed: () => sameSendAccount(batch.context) && !state.updateRequired && state.desktopAccountVisible !== false && !readPasscodeSettings().locked
      && !composerPermissions.reason(state.conversations.find(chat => Number(chat.id) === batch.context.conversationId) || { id: batch.context.conversationId })
      && (Number(state.active?.id) !== batch.context.conversationId || desktopMediaSendAllowed()),
    prepare: async item => !original && item.preparedDefault ? (await item.preparedDefault) || prepareImageSendFile(item, false) : prepareImageSendFile(item, original),
    upload: async (item, prepared, signal) => {
      item.uploadProgress = null;
      return { ...(await uploadMedia('image', prepared.file, batch.context.token, signal, progress => {
        if (!signal.aborted && imageSendBatches.has(batch) && sameSendAccount(batch.context)) { item.uploadProgress = progress; renderImageOutbox(); }
      }, original)), width: prepared.width, height: prepared.height };
    },
    send: async (item, upload, index, signal) => {
      item.pendingPayload ||= { conversation_id: batch.context.conversationId, type: 'image', body: index === 0
        ? messageBodyWithReply({ url: mediaUrl(upload.url), mime: upload.mime, size: upload.size, name: item.file.name, width: upload.width, height: upload.height, text, original }, batch.context)
        : { url: mediaUrl(upload.url), mime: upload.mime, size: upload.size, name: item.file.name, width: upload.width, height: upload.height, text: '', original }, request_id: item.requestId };
      const message = await api('/messages', { method: 'POST', authToken: batch.context.token, signal, body: JSON.stringify(item.pendingPayload) });
      if (!(Number(message.id) > 0) || Number(message.conversation_id) !== batch.context.conversationId || Number(message.sender_id) !== batch.context.userId || message.type !== 'image') throw new Error('图片消息回执无效，请重试');
      return message;
    },
    changed: renderImageOutbox,
    accepted: message => {
      completeReplySend(batch.context);
      if (sameSendAccount(batch.context)) {
        if (Number(state.active?.id) === batch.context.conversationId) appendMessage(message);
        scheduleTextConversationRefresh();
      }
    },
    completed: () => disposeImageSendBatch(batch)
  });
  // Transfer ownership of the local previews before closing the dialog.
  // They remain visible in the chat until a real server acknowledgement arrives.
  draft.sending = true; state.imageDraft = null;
  imageSendBatches.add(batch); closeFeatureModal(); renderImageOutbox();
  // Return to typing immediately; later upload acknowledgements must not steal focus.
  $('message-input')?.focus({ preventScroll: true });
  void batch.queue.run();
}

async function toggleRecording() {
  return toggleComposerRecording();
}

async function searchMessages(keyword) { if (!keyword.trim()) return loadConversations(); const result = await api(`/messages/search?q=${encodeURIComponent(keyword)}${state.active ? `&conversation_id=${state.active.id}` : ''}`); $('messages').innerHTML = result.items.map(messageHtml).join('') || '<p class="empty">没有找到相关消息</p>'; bindMessageActions(); }

function closeFeatureModal() { cancelContactSearch(); document.querySelector('[data-received-contact-card]')?.receivedCardController?.abort(); document.querySelector('[data-message-forward]')?.disposeForwardPicker?.(); document.querySelector('[data-contact-profile]')?.contactProfileDraft?.flushRemark?.(); groupManager.close(false); imageViewer.close(false); groupCreator.close(false); activityCenter.close(); contactActionRevision++; disposeContactProfile(); closeChatSearchFilter(); disposeComposerModal(); disposeGroupForm(); if (state.imageDraft) { const draft = state.imageDraft; state.imageDraft = null; for (const item of draft.items) disposeImageSendItem(item); } state.groupInfoDialog = null; document.querySelector('[data-feature-modal]')?.remove(); }
function bindFeatureModal() { const modal = document.querySelector('[data-feature-modal]'); if (modal) { modal.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', closeFeatureModal)); modal.addEventListener('click', (event) => { if (event.target === modal) closeFeatureModal(); }); } }
function contactRow(contact, action = 'chat') { const userId = Number(contact.user_id || contact.id); const button = action === 'chat' ? `<button type="button" data-contact-chat="${userId}">发消息</button>` : `<button type="button" data-add-contact="${userId}">加好友</button>`; return `<div class="contact-row"><span class="contact-avatar">${escapeHtml((contact.nickname || '?').slice(0, 1))}</span><span class="contact-info"><strong>${escapeHtml(contact.nickname || '未命名用户')}</strong><small>${escapeHtml(contact.phone || contact.message || '')}</small></span>${button}</div>`; }

function contactLastSeenText(item) {
  if (item.last_seen_hidden) return '最后上线时间已隐藏';
  if (item.online) return '当前在线';
  const date = String(item.last_seen_at || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return date ? `最后上线于 ${date[3]}.${date[2]}.${date[1].slice(-2)} ${date[4]}:${date[5]}` : '最后上线时间暂无记录';
}

function contactDialogRowHtml(item) {
  return `<button type="button" class="contact-modal-row" data-contact-chat="${Number(item.user_id || item.id)}" data-contact-keyword="${escapeHtml(`${item.nickname || ''} ${item.remark || ''} ${item.username || ''} ${publicUserId(item)}`.toLowerCase())}"><span class="contact-modal-avatar">${item.avatar_url ? `<img src="${escapeHtml(avatarUrl(item.avatar_url))}" alt="" data-contact-avatar-fallback="${escapeHtml((item.nickname || '?').slice(0, 1))}">` : escapeHtml((item.nickname || '?').slice(0, 1))}</span><span class="contact-modal-copy"><strong>${escapeHtml(contactDisplayName(item.user_id || item.id, item.remark || item.nickname || '未命名用户'))}</strong><small>${escapeHtml(contactLastSeenText(item))}</small>${publicUserId(item) ? `<small class="contact-public-id">ID：${escapeHtml(publicUserId(item))}</small>` : ''}</span></button>`;
}

function bindContactDialogRows(modal) {
  modal.querySelectorAll('[data-contact-chat]').forEach(button => { button.onclick = () => openContactChat(Number(button.dataset.contactChat)); });
  modal.querySelectorAll('[data-contact-avatar-fallback]').forEach(img => {
    img.addEventListener('error', () => { img.parentElement.textContent = img.dataset.contactAvatarFallback || '?'; }, { once: true });
  });
}

async function openContacts() {
  if (!state.user || !state.token || state.updateRequired || readPasscodeSettings().locked) return;
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal contact-modal-backdrop" data-feature-modal><section class="feature-card desktop-contact-modal activity-modal" role="dialog" aria-modal="true" aria-labelledby="contact-modal-title"><header><h2 id="contact-modal-title">添加好友</h2></header><form id="contact-search-form" class="contact-modal-search"><input id="contact-search-input" placeholder="输入完整用户名" aria-label="输入完整用户名" autocomplete="off" spellcheck="false"><button class="contact-search-submit" type="submit" aria-label="搜索用户">搜索</button></form><div id="contact-search-results" class="contact-modal-results" aria-live="polite"></div><div class="activity-heading"><h3>消息通知</h3><button type="button" data-notice-refresh>刷新</button></div><div class="activity-list" aria-label="消息通知列表"><p class="activity-empty">正在加载…</p></div><button type="button" class="activity-more" data-notice-more hidden>加载更多通知</button><p class="activity-feedback" role="status"></p><button type="button" class="contact-modal-close" data-close-modal>关闭</button></section></div>`);
  bindFeatureModal();
  const modal = document.querySelector('.contact-modal-backdrop');
  modal.querySelector('#contact-search-form').onsubmit = searchContacts;
  modal.querySelector('#contact-search-input').oninput = () => { cancelContactSearch(); modal.dataset.searchRevision = String(Number(modal.dataset.searchRevision || 0) + 1); modal.querySelector('#contact-search-results').replaceChildren(); };
  modal.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeFeatureModal(); } });
  activityCenter.mount(modal);
  modal.querySelector('#contact-search-input').focus();
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
  const input = modal?.querySelector('#contact-search-input'), results = modal?.querySelector('#contact-search-results');
  const keyword = input?.value.trim(), token = state.token, userId = Number(state.user?.id);
  if (!modal || !keyword || !foregroundReadsAllowed()) return;
  if (state.contactSearchRequest?.modal === modal && state.contactSearchRequest.keyword === keyword && !state.contactSearchRequest.controller.signal.aborted) return;
  cancelContactSearch();
  const request = { modal, keyword, controller: new AbortController() }; state.contactSearchRequest = request;
  const revision = String(Number(modal.dataset.searchRevision || 0) + 1); modal.dataset.searchRevision = revision;
  const current = () => !request.controller.signal.aborted && foregroundReadsAllowed() && modal.isConnected && modal.dataset.searchRevision === revision && state.token === token && Number(state.user?.id) === userId && input.value.trim() === keyword;
  results.textContent = '正在搜索…';
  try {
    const result = await api(`/contacts/search?q=${encodeURIComponent(keyword)}&size=20`, { authToken: token, signal: request.controller.signal });
    if (!current()) return;
    const users = exactUsernameUsers(result.items, keyword).filter(item => Number(item.id) !== userId);
    results.innerHTML = users.map(item => `<div class="contact-modal-row contact-search-user"><span class="contact-modal-avatar">${item.avatar_url ? `<img src="${escapeHtml(avatarUrl(item.avatar_url))}" alt="" data-contact-avatar-fallback="${escapeHtml((item.nickname || '?').slice(0, 1))}">` : escapeHtml((item.nickname || '?').slice(0, 1))}</span><span class="contact-modal-copy"><strong>${escapeHtml(item.nickname || '未命名用户')}</strong><small>${escapeHtml(item.username)}</small></span><button class="contact-search-add" type="button" ${item.is_contact ? 'disabled' : `data-add-contact="${Number(item.id)}"`}>${item.is_contact ? '已添加' : '加好友'}</button></div>`).join('') || '<p class="modal-empty">用户不存在</p>';
    bindContactDialogRows(results);
    results.querySelectorAll('[data-add-contact]').forEach(button => { button.onclick = () => { if (current()) void sendFriendRequest(Number(button.dataset.addContact), button); }; });
  } catch (error) { if (current()) results.textContent = error.message; }
  finally { if (state.contactSearchRequest === request) state.contactSearchRequest = null; }
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
  const token = state.token, accountId = Number(state.user?.id);
  if (!token || !accountId || state.updateRequired || readPasscodeSettings().locked) return;
  const current = () => state.token === token && Number(state.user?.id) === accountId && (!button || button.isConnected);
  if (button?.dataset.requestState === 'sending' || button?.dataset.requestState === 'sent') return;
  if (button) { button.dataset.requestState = 'sending'; button.disabled = true; button.textContent = '发送中…'; }
  try {
    const result = await api('/contact-requests', { method: 'POST', authToken: token, body: JSON.stringify({ to_user_id: userId, message: '你好，想和你成为好友' }) });
    if (result.status === 'accepted') {
      if (!current()) return;
      if (button) { button.dataset.requestState = 'sent'; button.disabled = true; button.textContent = '已添加'; }
      setContactRequestFeedback(button, '你们已经成为好友，可在聊天列表中打开对话。');
      void friendChats.offer(result.friend_chat, { token, userId: accountId }); friendChats.changed();
      void loadConversations().catch(() => {}); return;
    }
    if (!current()) return;
    const alreadyPending = result.status === 'pending' && result.created === false;
    const notice = result.status === 'accepted' ? '好友申请已自动通过，你们已经成为好友。' : alreadyPending ? '好友申请已经发送过了，正在等待对方验证。' : '好友申请已发送，等待对方验证。';
    if (button) { button.dataset.requestState = 'sent'; button.disabled = true; button.textContent = '已发送'; }
    setContactRequestFeedback(button, notice);
  } catch (error) {
    if (!current()) return;
    if (button) { button.dataset.requestState = 'error'; button.disabled = false; button.textContent = '加好友'; }
    setContactRequestFeedback(button, `发送失败：${contactRequestErrorText(error)}`, 'error');
  }
}
const contactRequestsInFlight = new Set();
async function handleContactRequest(requestId, action) {
  requestId = Number(requestId);
  const account = { token: state.token, userId: Number(state.user?.id) };
  if (!contactActionsAllowed(account) || !Number.isSafeInteger(requestId) || requestId <= 0 || !['accept', 'reject'].includes(action)) return;
  const key = JSON.stringify([account.token, account.userId, requestId]);
  if (contactRequestsInFlight.has(key)) return;
  const source = { page: state.page, modal: document.querySelector('[data-feature-modal]'), revision: contactActionRevision };
  const buttons = [...document.querySelectorAll(`[data-request-id="${requestId}"][data-request-action]`)];
  const current = () => contactActionsAllowed(account) && state.page === source.page && contactActionRevision === source.revision
    && document.querySelector('[data-feature-modal]') === source.modal;
  contactRequestsInFlight.add(key);
  const row = buttons.find(button => button.isConnected)?.closest('.verification-card');
  let feedback = row?.querySelector('[data-contact-handle-feedback]');
  if (row && !feedback) { feedback = document.createElement('small'); feedback.dataset.contactHandleFeedback = ''; feedback.setAttribute('role', 'status'); row.appendChild(feedback); }
  if (feedback) feedback.textContent = '';
  buttons.forEach(button => { button.disabled = true; if (button.dataset.requestAction === action) button.textContent = action === 'accept' ? '同意中…' : '拒绝中…'; });
  const signal = AbortSignal.timeout(12000);
  let handled = false;
  try {
    const result = await api('/contact-requests/handle', { method: 'POST', authToken: account.token, signal, body: JSON.stringify({ request_id: requestId, action }) });
    if (!sameSendAccount(account)) return;
    if (!['accepted', 'rejected'].includes(result.status)) throw new Error('好友申请尚未处理成功，请重试。');
    handled = true;
    refreshFriendRequestBadge();
    if (current()) {
      const actions = buttons.find(button => button.isConnected)?.closest('.request-actions');
      if (actions) { actions.textContent = result.status === 'accepted' ? '已同意' : '已拒绝'; actions.setAttribute('role', 'status'); }
    }
    if (result.status === 'accepted') {
      void friendChats.offer(result.friend_chat, account); friendChats.changed();
      void loadConversations().catch(() => {});
    }
  } catch (error) { if (current() && feedback) feedback.textContent = signal.aborted ? '暂未收到处理结果，请刷新确认后重试。' : error.message || '处理失败，请重试。'; }
  finally { contactRequestsInFlight.delete(key); if (!handled) buttons.filter(button => button.isConnected).forEach(button => { button.disabled = false; button.textContent = button.dataset.requestAction === 'accept' ? '同意' : '拒绝'; }); }
}
async function openContactChat(userId, profileDraft = null, sourceAvailable = () => true) {
  userId = Number(userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  const account = profileDraft?.account || { token: state.token, userId: Number(state.user?.id) };
  const source = { modal: document.querySelector('[data-feature-modal]'), historyEpoch: state.historyEpoch, page: state.page,
    sidebarMode: state.sidebarMode, activeId: Number(state.active?.id) || 0, contactRevision: contactActionRevision, navigationRevision: messageForwardNavigationRevision };
  const current = () => contactActionsAllowed(account) && sourceAvailable() && (profileDraft ? currentContactProfile(profileDraft)
    : state.historyEpoch === source.historyEpoch && state.page === source.page && state.sidebarMode === source.sidebarMode
      && (Number(state.active?.id) || 0) === source.activeId && contactActionRevision === source.contactRevision
      && messageForwardNavigationRevision === source.navigationRevision && document.querySelector('[data-feature-modal]') === source.modal
      && (!source.modal || source.modal.isConnected));
  if (!current() || profileDraft?.busy) return;
  profileDraft?.flushRemark?.();
  if (profileDraft) setContactProfileBusy(profileDraft, true);
  try {
    const conversation = await api('/conversations/direct', { authToken: account.token, method: 'POST', body: JSON.stringify({ user_id: userId }) });
    if (!current()) return;
    if (!Number.isSafeInteger(Number(conversation?.id)) || Number(conversation.id) <= 0 || Number(conversation.peer_user_id) !== userId || conversation.type !== 'direct') throw new Error('会话资料无效，请重试。');
    if (isDetachedConversation && Number(conversation.id) !== detachedConversationId) {
      if (!desktop.openConversationWindow) throw new Error('无法打开该联系人的聊天窗口。');
      await desktop.openConversationWindow(Number(conversation.id));
      if (current()) closeContactProfile();
      return;
    }
    const index = state.conversations.findIndex(item => Number(item.id) === Number(conversation.id));
    if (index < 0) state.conversations.unshift(conversation);
    else state.conversations[index] = { ...state.conversations[index], ...conversation };
    if (profileDraft) closeContactProfile(); else closeFeatureModal();
    if (desktop.isDesktop) {
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
  draft.flushRemark?.();
  draft.cancelRemarkTimer?.();
  draft.disposed = true;
  draft.revision += 1;
  draft.controller?.abort();
  draft.dismissController?.abort();
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
    node.disabled = busy || (!draft.isContact && ['profile-remark', 'profile-remove-contact'].includes(node.id)) || (node.id === 'profile-send-message' && (draft.requestSent || draft.canAddFriend === false))
      || (node.id === 'profile-remark' && draft.remarkSaving && !desktop.isDesktop);
  });
}

const contactRemarkWrites = new Map();
function saveProfileContactRemark(account, userId, remark, nickname) {
  const key = JSON.stringify([account.token, account.userId, userId]);
  const previous = contactRemarkWrites.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    if (!contactActionsAllowed(account)) throw new Error('账号状态已改变，请重新打开资料。');
    const result = await api('/contacts/remark', { authToken: account.token, method: 'POST',
      body: JSON.stringify({ user_id: userId, remark }), signal: AbortSignal.timeout(15000) });
    const saved = typeof result?.remark === 'string' ? result.remark : remark;
    if (contactActionsAllowed(account)) {
      if (state.contactCache[userId]) state.contactCache[userId].remark = saved;
      contactNames.remember(userId, saved);
      const apply = item => {
        if (item?.type === 'direct' && Number(item.peer_user_id) === userId) {
          item.remark = saved; item.name = saved || nickname || '未命名用户';
        }
      };
      state.conversations.forEach(apply); apply(state.active);
      // An older list response must not replace the just-confirmed remark.
      cancelConversationListRead();
      renderConversationList();
      if (state.page === 'messages' && !state.favoriteMode && state.active?.type === 'direct' && Number(state.active.peer_user_id) === userId) renderDesktopChatHeader(state.active);
    }
    return saved;
  });
  contactRemarkWrites.set(key, pending);
  void pending.finally(() => { if (contactRemarkWrites.get(key) === pending) contactRemarkWrites.delete(key); }).catch(() => {});
  return pending;
}

async function openContactProfile(userId, groupContextConversationId = null) {
  userId = Number(userId);
  if (groupContextConversationId !== null && (!Number.isSafeInteger(groupContextConversationId) || groupContextConversationId <= 0)) return;
  if (!contactActionsAllowed({ token: state.token, userId: Number(state.user?.id) }) || !Number.isSafeInteger(userId) || userId <= 0 || userId === Number(state.user.id)) return;
  const returnFocus = document.activeElement;
  closeFeatureModal();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal" data-feature-modal data-contact-profile><section class="profile-card" role="dialog" aria-modal="true" aria-label="个人资料"><header class="profile-banner"><button class="profile-close" type="button" data-close-modal aria-label="关闭个人资料">×</button></header><div class="profile-body" data-profile-content aria-live="polite"><p role="status">正在加载个人资料…</p></div></section></div>`);
  const modal = document.querySelector('[data-contact-profile]');
  const draft = { modal, userId, groupContextConversationId, account: { token: state.token, userId: Number(state.user.id) }, historyEpoch: state.historyEpoch,
    page: state.page, sidebarMode: state.sidebarMode, activeId: Number(state.active?.id) || 0, contactRevision: contactActionRevision,
    navigationRevision: messageForwardNavigationRevision, revision: 0, disposed: false, busy: false, controller: null };
  modal.contactProfileDraft = draft;
  bindFeatureModal();
  if (desktop.isDesktop) {
    draft.dismissController = new AbortController();
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing || draft.remarkComposing || document.querySelector('[data-feature-modal]') !== modal) return;
      event.preventDefault(); event.stopPropagation(); closeFeatureModal();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      else focusConversationInput(Number(state.active?.id));
    }, { capture: true, signal: draft.dismissController.signal });
  }
  modal.querySelector('[data-close-modal]').focus();
  async function load() {
    if (!currentContactProfile(draft)) return;
    draft.controller?.abort();
    const revision = ++draft.revision;
    const controller = draft.controller = new AbortController();
    const nameTicket = contactNames.capture();
    const content = modal.querySelector('[data-profile-content]');
    content.innerHTML = '<p role="status">正在加载个人资料…</p>';
    try {
      const profile = await api(`/contacts/profile?user_id=${userId}${groupContextConversationId === null ? '' : '&context_conversation_id=' + groupContextConversationId}`, { authToken: draft.account.token, signal: controller.signal });
      if (!currentContactProfile(draft) || draft.revision !== revision) return;
      if (Number(profile?.user_id) !== userId) throw new Error('个人资料不匹配，请重试。');
      // Cache only this fresh, server-authorized DTO. Older staff-only fields must not survive a permission change.
      state.contactCache[userId] = profile;
      contactNames.observe(nameTicket, userId, profile.is_contact ? String(profile.remark || '') : '');
      draft.isContact = Boolean(profile.is_contact);
      draft.canAddFriend = groupContextConversationId === null || draft.isContact || profile.can_add_friend === true;
      const avatar = profile.avatar_url ? `<img src="${escapeHtml(avatarUrl(profile.avatar_url))}" alt="${escapeHtml(profile.nickname)}">` : escapeHtml((profile.nickname || '?').slice(0, 1));
      const statusMap = { active: '正常', frozen: '已冻结', deleted: '已注销' };
      const onlineText = profile.online ? '在线' : '离线';
      const headerPresence = desktop.isDesktop ? '' : `<p class="profile-status ${profile.online ? 'online-label' : 'offline-label'}">${onlineText}</p>`;
      const addedTimeDetail = desktop.isDesktop ? '' : `<div><dt>添加时间</dt><dd>${escapeHtml(profile.added_at || profile.created_at || '—')}</dd></div>`;
      const accountStateDetails = desktop.isDesktop ? '' : `<div><dt>在线状态</dt><dd class="${profile.online ? 'online-label' : 'offline-label'}">${onlineText}</dd></div><div><dt>账号状态</dt><dd>${escapeHtml(statusMap[profile.status] || '未知')}</dd></div>`;
      const registrationDetails = desktop.isDesktop ? `<div><dt>注册IP地址</dt><dd data-profile-register-ip>${state.user?.internal_staff ? '加载中…' : '未公开'}</dd></div><div><dt>注册IP归属地</dt><dd data-profile-register-location>${state.user?.internal_staff ? '加载中…' : '未公开'}</dd></div>` : '';
      const copyValues = { account: String(profile.username || profile.phone || ''), public_id: publicUserId(profile) };
      const copyLabels = { account: '账号', public_id: '用户 ID' };
      const identityHtml = (key, fallback) => {
        const value = copyValues[key];
        if (!desktop.isDesktop || !value) return escapeHtml(value || fallback);
        return `<span class="profile-identity-value"><button class="profile-copy-button" type="button" data-profile-copy="${key}" title="复制${copyLabels[key]}" aria-label="复制${copyLabels[key]}"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg></button><span>${escapeHtml(value)}</span></span>`;
      };
      content.innerHTML = `<div class="profile-avatar">${avatar}</div><h2>${escapeHtml(profile.nickname || '未命名用户')}</h2>${headerPresence}<dl class="profile-details"><div><dt>备注名</dt><dd><input id="profile-remark" value="${escapeHtml(profile.remark || '')}" placeholder="设置备注名" aria-label="备注名" maxlength="64" ${profile.is_contact ? '' : 'disabled'}></dd></div><div><dt>账号</dt><dd>${identityHtml('account', '未公开')}</dd></div><div><dt>用户 ID</dt><dd>${identityHtml('public_id', '暂不可用')}</dd></div>${addedTimeDetail}<div><dt>最近登录</dt><dd>${escapeHtml(profile.last_login_at || '未公开')}</dd></div><div><dt>登录设备</dt><dd>${profile.last_login_device ? escapeHtml(deviceName(profile.last_login_device)) : '未公开'}</dd></div>${accountStateDetails}<div><dt>IP 地址</dt><dd>${escapeHtml(profile.last_login_ip || '未公开')}</dd></div><div><dt>IP 归属地</dt><dd>${escapeHtml(profile.ip_location || '未公开')}</dd></div>${registrationDetails}</dl><p id="profile-feedback" class="form-feedback" role="status"></p><div class="profile-actions"><button id="profile-send-message" class="primary" type="button">发送消息</button></div><div class="profile-danger-actions"><button id="profile-remove-contact" type="button" ${profile.is_contact ? '' : 'disabled'}>删除好友</button><button id="profile-block-contact" type="button">拉黑好友</button></div>`;
      if (desktop.isDesktop && state.user?.internal_staff) void (async () => {
        const current = () => currentContactProfile(draft) && draft.revision === revision;
        const set = (ip, location) => {
          if (!current()) return;
          content.querySelector('[data-profile-register-ip]').textContent = ip;
          content.querySelector('[data-profile-register-location]').textContent = location;
        };
        try {
          const registration = await api(`/contacts/internal-profile?user_id=${userId}${groupContextConversationId === null ? '' : '&context_conversation_id=' + groupContextConversationId}`, { authToken: draft.account.token,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          if (!current()) return;
          if (!state.user?.internal_staff) { set('未公开', '未公开'); return; }
          if (Number(registration?.user_id) !== userId) throw new Error('注册资料不匹配');
          const ip = typeof registration.register_ip === 'string' ? registration.register_ip.trim() : '';
          const location = typeof registration.register_ip_location === 'string' ? registration.register_ip_location.trim() : '';
          set(ip || '暂无记录', ip ? location || '暂未查到归属地' : '暂无记录');
        } catch (error) {
          if (!current()) return;
          const hidden = !state.user?.internal_staff || error.status === 403 || error.status === 401;
          set(hidden ? '未公开' : '暂不可用', hidden ? '未公开' : '暂不可用');
        }
      })();
      const feedback = content.querySelector('#profile-feedback');
      content.querySelectorAll('[data-profile-copy]').forEach(button => { button.onclick = async () => {
        if (!currentContactProfile(draft) || draft.busy || button.disabled) return;
        const key = button.dataset.profileCopy, value = copyValues[key];
        if (!Object.hasOwn(copyValues, key) || !value) return;
        button.disabled = true;
        try {
          if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('无法复制');
          await navigator.clipboard.writeText(value);
          if (currentContactProfile(draft)) {
            const notice = document.createElement('span'); notice.className = 'profile-copy-success';
            notice.textContent = `${copyLabels[key]}已复制`; feedback.replaceChildren(notice);
          }
        } catch {
          if (currentContactProfile(draft)) feedback.textContent = '复制失败，请重试或选中文字复制。';
        } finally { if (currentContactProfile(draft)) button.disabled = false; }
      }; });
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
      if (desktop.isDesktop) {
        let timer, composing = false, desiredRemark = savedRemark;
        const clearTimer = () => { clearTimeout(timer); timer = null; };
        const save = async () => {
          clearTimer();
          if (!currentContactProfile(draft) || draft.busy || !draft.isContact || composing) return;
          desiredRemark = remarkInput.value.trim();
          if (draft.remarkSaving || desiredRemark === savedRemark) return;
          draft.remarkSaving = true;
          let submitted;
          try {
            while (desiredRemark !== savedRemark && contactActionsAllowed(draft.account)) {
              submitted = desiredRemark;
              if (currentContactProfile(draft)) feedback.textContent = '正在保存备注…';
              savedRemark = await saveProfileContactRemark(draft.account, userId, submitted, profile.nickname);
              const unchanged = desiredRemark === submitted;
              if (unchanged) desiredRemark = savedRemark;
              if (currentContactProfile(draft) && unchanged && remarkInput.value.trim() === submitted) {
                remarkInput.value = savedRemark;
                if (feedback.textContent === '正在保存备注…') feedback.textContent = '备注已保存';
              }
            }
          } catch (error) {
            if (currentContactProfile(draft)) feedback.textContent = `备注保存失败：${error.message || '请按回车重试。'}`;
            else if (contactActionsAllowed(draft.account) && state.page === draft.page && Number(state.active?.id) === draft.activeId && !document.querySelector('[data-feature-modal]')) composerFeedback('备注保存失败，请重新打开资料重试。');
          } finally {
            draft.remarkSaving = false;
            if (desiredRemark !== submitted && desiredRemark !== savedRemark && currentContactProfile(draft)) void save();
          }
        };
        const schedule = () => {
          clearTimer();
          if (composing || !currentContactProfile(draft)) return;
          timer = setTimeout(() => { void save(); }, 250);
        };
        draft.flushRemark = () => { void save(); };
        draft.cancelRemarkTimer = clearTimer;
        remarkInput.onblur = draft.flushRemark;
        remarkInput.oninput = event => { feedback.textContent = ''; if (!event.isComposing) schedule(); };
        remarkInput.onkeydown = event => {
          if (event.key === 'Enter' && !event.isComposing && !composing) { event.preventDefault(); draft.flushRemark(); }
        };
        remarkInput.addEventListener('compositionstart', () => { composing = true; draft.remarkComposing = true; clearTimer(); });
        remarkInput.addEventListener('compositionend', () => { composing = false; draft.remarkComposing = false; schedule(); });
      }
      const sendButton = content.querySelector('#profile-send-message');
      sendButton.textContent = groupContextConversationId === null || profile.is_contact ? '发送消息' : draft.requestSent ? '好友申请已发送' : draft.canAddFriend ? '添加好友' : '暂不可添加好友';
      sendButton.disabled = Boolean(!profile.is_contact && (draft.requestSent || !draft.canAddFriend));
      sendButton.onclick = () => {
        if (!currentContactProfile(draft) || draft.busy || draft.requestSent) return;
        if (groupContextConversationId === null || profile.is_contact) return openContactChat(userId, draft);
        return action(async () => {
          const fresh = await api(`/contacts/profile?user_id=${userId}${groupContextConversationId === null ? '' : '&context_conversation_id=' + groupContextConversationId}`, { authToken: draft.account.token });
          if (!currentContactProfile(draft)) throw Error('资料页面已关闭');
          if (fresh.is_contact) return { status: 'accepted' };
          if (fresh.can_add_friend !== true) throw Error('当前无法从该群添加好友，请重新打开资料');
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
          delete state.contactCache[userId]; contactNames.remember(userId, ''); closeContactProfile();
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
      : /^\d+$/.test(value) ? (GO ? { group_number: value } : { conversation_id: Number(value) }) : { invite_code: value };
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
const groupManager = PulseGroupManager.create({
  openProfile:(id,groupId)=>openContactProfile(id,groupId),
  context: () => ({ token:state.token, userId:Number(state.user?.id), groupId:Number(state.active?.id), base:API,
    scope:messageForwardNavigationRevision+':'+state.page+':'+state.sidebarMode,
    blocked:Boolean(state.updateRequired || readPasscodeSettings().locked || state.desktopAccountVisible===false || state.active?.type!=='group') }),
  request:(route,options)=>api(route,options), upload:(file,token,signal)=>uploadMedia('image',file,token,signal), mediaUrl:value=>avatarUrl(value),
  changed:(profile,account)=>{
    if(!sameSendAccount(account))return;
    const row=state.conversations.find(item=>Number(item.id)===Number(profile.id));
    const pinChanged=typeof profile.is_pinned==='boolean'&&Boolean(row?.is_pinned??state.active?.is_pinned)!==profile.is_pinned;
    if(row)Object.assign(row,profile);
    if(desktop.isDesktop&&pinChanged){conversationOrder.setPinned(conversationOrderAccount(),profile.id,profile.is_pinned);cancelConversationListRead();void loadConversations().catch(()=>{});}
    if(Number(state.active?.id)===Number(profile.id)){Object.assign(state.active,profile);updateDesktopChat();renderConversationList();if(Number(state.chatInfo?.id)===Number(profile.id))void groupSidebar.reload();}
  },
  exited:async(id,account)=>{
    if(!sameSendAccount(account))return;
    if(state.socket?.readyState===WebSocket.OPEN)state.socket.send(JSON.stringify({type:'unsubscribe',conversation_id:id}));
    if(Number(state.active?.id)===id){closeChatPanels();state.active=null;$('group-manage').hidden=true;$('messages').innerHTML='<p class="empty">请选择一个会话开始聊天</p>';updateDesktopChat();}
    await loadConversations();
  }
});
async function openGroupManager(manage = true) {
  const conversation=state.active;if(conversation?.type!=='group')return;
  closeGroupManager();closeFeatureModal();await groupManager.open(conversation,manage!==false);
}
function closeGroupManager(){state.groupManagerRequest=null;groupManager.close(false);document.querySelector('.group-modal')?.closest('.modal-backdrop')?.remove();}
function renderGroupManager(profile,members,searchResults=[],manage=true){void openGroupManager(manage);}
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
  try { await api('/conversations/members', { method: 'POST', body: JSON.stringify({ conversation_id: state.active.id, user_id: userId, allow_history: window.PulseGoUI?.allowHistory() === true }) }); await openGroupManager(); } catch (error) { alert(error.message); }
}
async function updateGroupRole(userId, role) {
  try { await api('/conversations/members/role', { method: 'POST', body: JSON.stringify({ conversation_id: state.active.id, user_id: userId, role }) }); await openGroupManager(); } catch (error) { alert(error.message); }
}
async function updateGroupMute(userId, minutes) {
  try { await api('/conversations/members/mute', { method: 'POST', body: JSON.stringify({ conversation_id: state.active.id, user_id: userId, minutes }) }); await openGroupManager(); } catch (error) { alert(error.message); }
}
async function removeGroupMember(userId) {
  if (!window.confirm('确定要将这名成员移出群组吗？')) return;
  try { await api('/conversations/members/remove', { method: 'POST', body: JSON.stringify({ conversation_id: state.active.id, user_id: userId, allow_history: window.PulseGoUI?.allowHistory() === true }) }); await openGroupManager(); } catch (error) { alert(error.message); }
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
  try { await api('/conversations/groups/transfer', { method: 'POST', body: JSON.stringify({ conversation_id: state.active.id, user_id: userId, allow_history: window.PulseGoUI?.allowHistory() === true }) }); await loadConversations(); await openGroupManager(); } catch (error) { alert(error.message); }
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

async function boot() {
  const token = state.token;
  let authenticationConfirmed = false;
  try {
    if (!(await enforceClientUpdate())) return;
    const user = await api('/auth/me', { authToken: token, signal: AbortSignal.timeout(15000) });
    if (state.token !== token || localStorage.getItem(GO.tokenKey) !== token) return;
    authenticationConfirmed = true; state.user = user;
    if (!isDetachedConversation && !state.startupLockApplied) { state.startupLockApplied = true; if (passcodeIsEnabled()) writePasscodeSettings({ locked: true }); else syncDesktopSession(); } else syncDesktopSession();
    renderShell(); if (readPasscodeSettings().locked) openPasscodeLockScreen();
    resumeAccountWork();
    if (desktop.isDesktop) void contactNames.refresh().catch(() => {});
    await loadConversations();
    if (state.token !== token) return;
    if (isDetachedConversation) { await openConversation(detachedConversationId); document.title = `${state.active?.name || '聊天'} - 小猿口算`; }
  } catch (error) {
    if (state.token !== token) return;
    const legacyAuthRejection = error.status === 400 && error.code === 'BUSINESS_ERROR' && ['请先登录。', '登录状态已过期，请重新登录。', '用户账号不可用。'].includes(error.message);
    if (!authenticationConfirmed && error.code !== 'INVALID_API_RESPONSE' && (error.status === 401 || error.status === 403 || legacyAuthRejection)) { leaveAccount(); return; }
    disposeConversationSidebarResize?.();
    document.body.innerHTML = `<main class="login-shell"><section class="login-card"><h1>暂时无法加载聊天</h1><p>${escapeHtml(error.message || '请检查网络后重试')}</p><button id="chat-boot-retry" type="button">重试</button>${isDetachedConversation ? '<button id="chat-window-close" type="button">关闭窗口</button>' : ''}</section></main>`;
    $('chat-boot-retry').onclick = () => boot().then(connectSocket);
    if ($('chat-window-close')) $('chat-window-close').onclick = () => desktop.close();
    if (readPasscodeSettings().locked) openPasscodeLockScreen();
  }
}

function cancelConversationRecovery() {
  pauseConversationReads();
  clearTimeout(state.recoveryRetryTimer); state.recoveryRetryTimer = null;
  state.initialHistory?.controller?.abort();
  state.initialHistory = null;
  state.recovery = null; state.recoverySubscribedSocket = null; state.recoverySubscribedId = 0;
  state.olderHistoryQueued = null; state.olderHistoryFailed = false; state.historyEpoch = (state.historyEpoch || 0) + 1; state.historyReadyEpoch = null; state.historyLoadedFloor = 0; state.historyLoading = false; state.recoveryNeeded = false;
  state.favoriteLoadInterrupted = false;
}
function pauseConversationReads() {
  clearTimeout(state.recoveryRetryTimer); state.recoveryRetryTimer = null;
  if (state.initialHistory) state.initialHistoryFailed = true;
  state.initialHistory?.controller?.abort(); state.initialHistory = null;
  if (state.favoriteLoad) state.favoriteLoadInterrupted = true;
  state.favoriteLoad?.controller.abort(); state.favoriteLoad = null;
  if (state.recovery) state.recoveryNeeded = true;
  state.recovery?.controller?.abort(); state.recovery = null;
  state.olderHistoryRequest?.controller.abort(); state.olderHistoryRequest = null;
  state.historyLoading = false; state.olderHistoryQueued = null;
}
function cancelContactSearch() {
  state.contactSearchRequest?.controller.abort(); state.contactSearchRequest = null;
}
function cancelForegroundReads() {
  cancelDirectoryRequests(); cancelContactSearch(); pauseConversationReads(); cancelRealtimeResume();
  cancelConversationListRead(); friendChats.pause(); conversationRefresh.pause(); activityCenter.pause();
  clearInterval(friendChatsPollTimer); friendChatsPollTimer = null;
  state.lastRealtimeResumeAccount = null;
  void Promise.resolve(desktop.cancelProxyTest?.()).catch(() => {});
}
function resumeForegroundReads() {
  if (!foregroundReadsAllowed()) return;
  if (['friends', 'groups', 'blacklist', 'center'].includes(state.page) && currentDirectoryRequest(state.directoryView)) return;
  if (state.page === 'friends') void renderFriendsPage();
  else if (state.page === 'groups') void renderGroupsPage();
  else if (state.page === 'blacklist') void renderBlacklistPage();
  else if (state.page === 'center') void renderMessageCenter();
  else if (state.page === 'messages' && state.favoriteLoadInterrupted) void openFavorites();
  else if (state.page === 'messages' && isDetachedConversation && !state.active) void openConversation(detachedConversationId, { focusInput: false });
  else if (state.page === 'messages' && state.active && !state.favoriteMode) {
    if (state.initialHistoryFailed) void openConversation(Number(state.active.id), { focusInput: false });
    else if (state.recoveryNeeded) void recoverConversation(Number(state.active.id));
  }
}
function sameRecovery(context) {
  return !context.controller?.signal.aborted && foregroundReadsAllowed() && state.page === 'messages' && !state.favoriteMode
    && state.recovery === context && state.token === context.token && Number(state.user?.id) === context.userId && Number(state.active?.id) === context.conversationId
    && state.historyEpoch === context.epoch && state.historyRevision === context.revision && state.historyLocation === context.location
    && state.socket === context.socket && context.socket?.readyState === WebSocket.OPEN;
}

function messageVersionCache() {
  if (state.messageVersionToken !== (state.token + ':' + (state.active?.id || ''))) { state.messageVersionToken = state.token + ':' + (state.active?.id || ''); state.messageVersions = new Map(); }
  return state.messageVersions;
}
function acceptMessageVersion(type, message, source = 'event') {
  const id = Number(message?.id); if (!Number.isSafeInteger(id) || id <= 0) return false;
  const cache = messageVersionCache(), previous = cache.get(id);
  const removed = type === 'message.recalled' || type === 'message.deleted' || Boolean(message.recalled_at) || ['recalled', 'deleted'].includes(message.status);
  const edited = GO && message.body?._go_version ? String(message.body._go_version).padStart(20, '0') : String(message.edited_at || '');
  if (!removed && previous) {
    if (previous.removed || (previous.edited && edited < previous.edited)) return false;
    // A late send ACK has no mutation version. It must never resurrect or
    // replace any already observed instance, particularly a WS edit/recall.
    if (source === 'ack' && (!edited || (previous.edited && edited <= previous.edited))) return false;
  }
  if (removed) purgeLocalMedia(message.conversation_id, [id]);
  cache.set(id, { edited, removed, source, message });
  if (source !== 'snapshot') localChat.event(type, message);
  if (type === 'message.recalled' && !previous?.removed && source !== 'peer' && state.token && state.user) {
    desktop.publishMessageRecall?.({ accountId: Number(state.user.id), conversationId: Number(message.conversation_id), messageId: id });
  }
  return true;
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
    if (previous?.source === 'event' && previous.edited >= (GO && message.body?._go_version ? String(message.body._go_version).padStart(20, '0') : String(message.edited_at || ''))) return [previous.message];
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
function recoveryScrollAnchor(container, { forceAnchor = false } = {}) {
  const top = container.scrollTop, bottom = container.scrollHeight - top - container.clientHeight < 40;
  // Most chat switches follow the latest message. Measuring every historical
  // row is unnecessary unless the user is reading earlier messages.
  if (bottom && !forceAnchor) return { bottom: true, top, anchors: [] };
  const box = container.getBoundingClientRect();
  return { bottom, top,
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
function initialHistoryTicket(context) {
  if (!localChat.enabled) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const signal = context.controller.signal;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); resolve(value); };
    const cancel = () => finish(null), timer = setTimeout(cancel, 150);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    Promise.resolve().then(() => localChat.ticket(context.conversationId)).then(finish, cancel);
  });
}

async function fetchInitialHistory(context) {
  // One overall deadline covers readiness, route failover, response bytes and retry.
  const timeout = AbortSignal.timeout(12000);
  const signal = context.controller ? AbortSignal.any([context.controller.signal, timeout]) : timeout;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (state.initialHistory !== context || state.token !== context.token || state.historyEpoch !== context.epoch || Number(state.active?.id) !== context.conversationId) return null;
    try {
      signal.throwIfAborted();
      let cancel;
      const aborted = new Promise((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); });
      let result;
      try { result = await Promise.race([api(`/messages/history?conversation_id=${context.conversationId}&size=50`, { authToken: context.token, signal, requestTimeoutMs: 4000 }), aborted]); }
      finally { signal.removeEventListener('abort', cancel); }
      if (!Array.isArray(result?.items) || result.items.length > 50 || result.items.some(m => !m || !Number.isSafeInteger(Number(m.id)) || Number(m.id) <= 0 || Number(m.conversation_id) !== context.conversationId)
        || new Set(result.items.map(m => Number(m.id))).size !== result.items.length) {
        const error = new Error('消息记录返回格式无效'); error.code = 'PC-MSG-LOAD-INVALID'; throw error;
      }
      return result;
    }
    catch (error) {
      if (signal.aborted || attempt === 1 || error.code === 'PC-MSG-LOAD-INVALID' || (error.status && ![408, 429, 500, 502, 503, 504].includes(error.status))) throw error;
      await new Promise(resolve => { const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, 500); signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish(); });
    }
  }
}
async function fetchRecoverySnapshot(context) {
  const messages = new Map(); let after = 0; let snapshot = context.location?.maxId ?? null; let cleared = 0;
  while (sameRecovery(context)) {
    const query = new URLSearchParams({ conversation_id: context.conversationId, floor_id: context.floor, after_id: after, limit: 100 });
    if (snapshot !== null) query.set('snapshot_max_id', snapshot);
    const page = await api(`/messages/sync?${query}`, { authToken: context.token, signal: context.controller.signal });
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
      return { messages: [...messages.values()].sort((a, b) => Number(a.id) - Number(b.id)), cleared, maximum: snapshot };
    }
    after = next;
  }
  return null;
}
async function recoverConversation(conversationId) {
  if (!foregroundReadsAllowed() || state.page !== 'messages' || state.favoriteMode || !state.recoveryNeeded || !state.user || Number(state.active?.id) !== Number(conversationId) || state.historyReadyEpoch !== state.historyEpoch
    || state.historyLoading || state.recoverySubscribedSocket !== state.socket || state.recoverySubscribedId !== Number(conversationId)) return;
  if (state.recovery && sameRecovery(state.recovery)) return;
  const container = $('messages'); if (!container) return;
  const ids = [...container.querySelectorAll('[data-message-id]')].map(node => Number(node.dataset.messageId)).filter(id => Number.isSafeInteger(id) && id > 0);
  state.recovery?.controller?.abort();
  const context = { token: state.token, userId: Number(state.user.id), conversationId: Number(conversationId), socket: state.socket, controller: new AbortController(),
    epoch: state.historyEpoch, revision: state.historyRevision, location: state.historyLocation,
    floor: ids.length ? Math.min(...ids) : state.historyLoadedFloor || Number(state.active.cleared_before_message_id || 0) + 1, events: new Map() };
  clearTimeout(state.recoveryRetryTimer); state.recoveryRetryTimer = null; state.recovery = context;
  try {
    context.diskTicket = await localChat.ticket(context.conversationId);
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
    void localChat.reconcile(context.conversationId, authoritative, { ticket: context.diskTicket || undefined, cleared: result.cleared, floor: context.floor, maximum: Number.MAX_SAFE_INTEGER });
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
  cancelForegroundReads();
  contactActionRevision++;
  closeContactProfile();
  state.updateRequired = true; stopSocketRetries(); state.socket?.close();
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
function desktopReadingConversation(conversationId) {
  return !document.hidden && document.hasFocus() && state.desktopAccountVisible !== false && state.page === 'messages'
    && !state.favoriteMode && Number(state.active?.id) === Number(conversationId) && !$('messages')?.hidden
    && !document.querySelector('[aria-modal="true"], #passcode-lock-screen');
}
function notifyDesktopMessage(message, conversation) {
  if (isDetachedConversation || !desktop.isDesktop || typeof desktop.notify !== 'function' || !state.token || !state.user || !conversation
      || conversation.notifications_muted || !localSetting('notification_enabled', true) || readPasscodeSettings().locked
      || message?.recalled_at || ['recalled', 'deleted'].includes(message?.status)) return;
  const id = Number(message?.id), sender = Number(message?.sender_id);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(sender) || sender <= 0 || sender === Number(state.user.id)) return;
  const context = desktopNotificationState(); if (context.notified.has(id)) return;
  context.notified.add(id);
  if (context.notified.size > 1000) context.notified.delete(context.notified.values().next().value);
  const conversationId = Number(message.conversation_id || conversation.id);
  if (desktopReadingConversation(conversationId)) return;
  const showSender = localSetting('notification_sender', true), showPreview = localSetting('notification_preview', true);
  const senderName = contactDisplayName(sender, message.sender_name || (conversation.type === 'direct' ? conversation.name : '') || '会话成员');
  const title = showSender ? (conversation.type === 'direct' ? contactDisplayName(conversation.peer_user_id || sender, conversation.name || senderName) : conversation.name || '群聊') : '小猿口算';
  const preview = showPreview ? conversationMessagePreview({ last_message: message }) : '你收到一条新消息';
  const body = showSender && showPreview && conversation.type !== 'direct' ? `${senderName}：${preview}` : preview;
  const avatar = conversation.avatar_url || message.sender_avatar_url;
  try { desktop.notify(title, body, { conversationId, messageId: id, kind: conversation.type,
    avatarUrl: showSender && avatar ? mediaUrl(avatar) : '',
    native: localSetting('notification_native', false), silent: !localSetting('notification_sound', true) }); } catch { /* A notification failure must not interrupt delivery. */ }
}
function queueDesktopInboxNotification(packet) {
  const conversationId = Number(packet.data?.conversation_id), messageId = Number(packet.data?.message_id);
  const context = state.desktopNotifications;
  if (packet.data?.event_type === 'message.recalled') { if (context?.pending.get(conversationId)?.messageId === messageId) context.pending.delete(conversationId); return; }
  if (packet.data?.event_type !== 'message.new' || !desktop.isDesktop || typeof desktop.notify !== 'function' || !state.token || !state.user
      || !localSetting('notification_enabled', true) || readPasscodeSettings().locked) return;
  if (!Number.isSafeInteger(conversationId) || conversationId <= 0 || !Number.isSafeInteger(messageId) || messageId <= 0) return;
  const current = desktopNotificationState(); if (current.notified.has(messageId)) return;
  if ((current.pending.get(conversationId)?.messageId || 0) < messageId) current.pending.set(conversationId, { messageId });
  if (current.pending.size > 200) current.pending.delete(current.pending.keys().next().value);
}
function flushDesktopInboxNotifications() {
  const context = state.desktopNotifications;
  if (!context || context.token !== state.token || context.userId !== Number(state.user?.id)) return;
  for (const [id, hint] of context.pending) {
    const conversation = state.conversations.find(item => Number(item.id) === id), message = conversation?.last_message;
    if (!message || Number(message.id) < hint.messageId) continue;
    context.pending.delete(id);
    notifyDesktopMessage(message, conversation);
  }
}
async function openDesktopNotification(value) {
  if (isDetachedConversation || Number(value.accountId) !== Number(state.user?.id) || !state.token || state.updateRequired || readPasscodeSettings().locked) return;
  const token = state.token, userId = Number(state.user.id), id = Number(value.conversationId);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  try {
    if (!state.conversations.some(item => Number(item.id) === id)) await loadConversations();
    if (state.token !== token || Number(state.user?.id) !== userId || state.updateRequired || readPasscodeSettings().locked) return;
    closeSettings(); closeSettingsDetail(); closeFeatureModal();
    await switchPage('messages');
    if (state.token !== token || Number(state.user?.id) !== userId || state.updateRequired || readPasscodeSettings().locked) return;
    await openConversation(id, { latest: true, focusInput: true });
  } catch (error) { composerFeedback(error.message || '暂时无法打开该会话，请稍后重试。'); }
}
function handleSocketPacket(packet) {
  if (packet.type === 'message.new' && !rememberRecoveryMessage(packet.type, packet.data)) return;
  if (packet.type === 'subscribe.ok' && Number(packet.conversation_id) === Number(state.active?.id)) { state.recoverySubscribedSocket = state.socket; state.recoverySubscribedId = Number(packet.conversation_id); state.recoveryNeeded = true; void recoverConversation(packet.conversation_id); return; }
  if (packet.type === 'auth.revoked') {
    leaveAccount();
    if ($('login-error')) $('login-error').textContent = packet.message || '登录已失效，请重新登录。'; return;
  }
  if (packet.type === 'client.update_required') { requireClientUpgrade(packet.message); return; }
  if (packet.type === 'notification.updated') {
    activityCenter.changed(); friendChats.changed();
    void contactNames.refresh({ force: true }).catch(() => {});
    state.contactCache = {};
    void loadConversations().catch(() => {});
    return;
  }
  if (packet.type === 'auth.ok') {
    void contactNames.refresh({ force: true }).catch(() => {});
    resumeAccountWork();
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
  const token = state.token; const socketRoute = typeof routeManager !== 'undefined' ? routeManager?.current : null; const socket = new WebSocket(socketRoute?.ws_url || WS); state.socket = socket;
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
    if (state.recovery?.socket === socket) {
      state.recovery.controller?.abort(); state.recovery = null; state.recoveryNeeded = true;
      clearTimeout(state.recoveryRetryTimer); state.recoveryRetryTimer = null;
    }
    state.socket = null; clearInterval(state.heartbeatTimer);
    if (socketRoute && state.token === token && !state.updateRequired) void routeManager.failover(socketRoute);
    if (state.token === token && !state.updateRequired && !state.reconnectTimer) {
      state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connectSocket(); }, state.reconnectDelay);
      state.reconnectDelay = Math.min(15000, state.reconnectDelay * 2);
    }
  };
}

function restartSocketConnection() {
  stopSocketRetries();
  const previous = state.socket; state.socket = null;
  state.recovery?.controller?.abort();
  clearTimeout(state.recoveryRetryTimer); state.recoveryRetryTimer = null;
  state.recovery = null; state.recoverySubscribedSocket = null; state.recoverySubscribedId = 0;
  try { previous?.close(); } catch {}
  connectSocket();
}
function canResumeRealtime() {
  return foregroundReadsAllowed();
}
function cancelRealtimeResume() {
  const task = state.realtimeResumeTask; state.realtimeResumeTask = null;
  if (!task) return;
  if (task.frame !== null) cancelAnimationFrame(task.frame);
  if (task.timer !== null) clearTimeout(task.timer);
}
function resumeRealtime(event) {
  composerPermissions.check(true);
  if (!canResumeRealtime()) { cancelRealtimeResume(); return; }
  const token = state.token, userId = Number(state.user.id), force = event?.type === 'online';
  const pending = state.realtimeResumeTask;
  if (pending && pending.token === token && pending.userId === userId) { pending.force ||= force; return; }
  cancelRealtimeResume();
  const task = { token, userId, force, frame: null, timer: null };
  state.realtimeResumeTask = task;
  // Give the retained account view a frame before starting refresh work.
  task.frame = requestAnimationFrame(() => {
    task.frame = null;
    task.timer = setTimeout(() => runRealtimeResume(task), 0);
  });
}
function runRealtimeResume(task) {
  if (state.realtimeResumeTask !== task) return;
  state.realtimeResumeTask = null;
  if (!canResumeRealtime() || state.token !== task.token || Number(state.user.id) !== task.userId) return;
  if (state.conversationViewDirty) { state.conversationViewDirty = false; renderConversationList(); updateDesktopChat(); }
  const now = Date.now(), previous = state.lastRealtimeResumeAccount;
  if (!task.force && previous?.token === task.token && previous.userId === task.userId && now - (state.lastRealtimeResume || 0) < 1000) return;
  state.lastRealtimeResume = now; state.lastRealtimeResumeAccount = { token: task.token, userId: task.userId };
  resumeAccountWork(); resumeForegroundReads();
  messageReceipts.refresh();
  state.desktopNotifications?.pending.clear();
  if (state.active && $('messages')) void markMessagesRead(visibleConversationMessages());
  if (desktop.isDesktop) void contactNames.refresh().catch(() => {});
  const reconnect = task.force || !state.socket || state.socket.readyState > WebSocket.OPEN
    || state.socket.readyState === WebSocket.OPEN && now - (state.socketLastReceivedAt || 0) > 30000;
  if (reconnect) restartSocketConnection();
  else if (state.socket.readyState === WebSocket.OPEN && state.active
    && (state.messageSubscriptionSocket !== state.socket || state.messageSubscriptionId !== Number(state.active.id))) subscribeConversation(state.active.id);
  const refreshed = state.conversationListRefreshed, loading = state.conversationListLoad;
  const fresh = refreshed?.token === task.token && refreshed.userId === task.userId && now - refreshed.at < 5000;
  if ((reconnect || !fresh || state.conversationListRefreshNeeded) && !(loading?.token === task.token && loading.userId === task.userId)) void loadConversations().catch(() => {});
}

function subscribeConversation(id) {
  const socket = state.socket; if (socket?.readyState !== WebSocket.OPEN) return;
  const conversationId = Number(id); if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return;
  if (state.messageSubscriptionSocket === socket && state.messageSubscriptionId && state.messageSubscriptionId !== conversationId) socket.send(JSON.stringify({ type: 'unsubscribe', conversation_id: state.messageSubscriptionId }));
  socket.send(JSON.stringify({ type: 'subscribe', conversation_id: conversationId }));
  state.messageSubscriptionSocket = socket; state.messageSubscriptionId = conversationId;
}
function renderLogin() {
  groupCreator.clearCache();
  chatHeaderAvatars.clear(); avatarLoader.clear(); groupSidebar.clearAvatars(); state.conversationViewDirty = false;
  cancelRealtimeResume();
  imageViewer.close(false);
  messageReceipts.reset();
  composerDrafts.clear();
  closeSessionMenu();
  classicMenuAccountsExpanded = false;
  classicMenuAccountsCache = null;
  contactActionRevision++;
  disposeConversationSidebarResize?.();
  if (!isDetachedConversation) desktop.syncSessionState?.({ accountId: 0, locked: false });
  if (isDetachedConversation) { document.body.innerHTML = '<main class="login-shell"><section class="login-card"><h1>请在主窗口重新登录</h1><button id="chat-window-close" type="button">关闭窗口</button></section></main>'; $('chat-window-close').onclick = () => desktop.close?.(); return; }
  disposeAuthView?.();
  disposeAuthView = window.PulseAuthView.mount({
    isDesktop: Boolean(desktop.isDesktop),
    appVersion: desktop.appVersion || CLIENT_VERSION,
    localPreview: desktop.localPreview === true,
    request: (path, options = {}) => api(path, { ...options, authToken: '' }),
    clientReady: enforceClientUpdate,
    onRoute: openRoutePicker, routeName: routeManager?.current.name || '主线路',
    rememberedLogins: desktop.isDesktop && typeof desktop.rememberedLogins === 'function' ? (action, value) => desktop.rememberedLogins(action, value) : undefined,
    onAuthenticated: async (result, credentials) => {
      state.token = result.access_token;
      localStorage.setItem(GO.tokenKey, state.token);
      await boot();
      if (credentials && state.token === result.access_token && Number(state.user?.id) === Number(result.user_id) && desktop.rememberedLogins) {
        try {
          if (credentials.remember) await desktop.rememberedLogins('save', { ...credentials, userId: Number(state.user.id), nickname: state.user.nickname || '', avatarUrl: state.user.avatar_url ? mediaUrl(state.user.avatar_url) : '' });
          else await desktop.rememberedLogins('remove', { account: credentials.account });
        } catch { alert('已登录，但未能保存记住密码的设置。请检查本机存储后重试。'); }
      }
      if (state.token) connectSocket();
    },
  });
  if (desktop.isDesktop && desktop.openAccountWindow) {
    const navigation = document.createElement('nav');
    navigation.id = 'auth-account-navigation';
    navigation.className = 'pc-auth-account-navigation';
    navigation.setAttribute('aria-label', '返回已登录账号');
    navigation.hidden = true;
    navigation.innerHTML = '<button id="auth-back-account" type="button"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m9 4-6 6 6 6M3 10h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>返回已登录账号</span></button>';
    document.querySelector('.pc-auth-card-top')?.before(navigation);
    const back = $('auth-back-account');
    back.onclick = async () => {
      const profileId = back.dataset.profileId;
      if (!profileId || back.disabled) return;
      back.disabled = true;
      try { await desktop.showAccountWindow(profileId); }
      catch (error) { if (back.isConnected) $('login-error').textContent = error.message || '暂时无法返回账号，请重试'; }
      finally { if (back.isConnected) back.disabled = false; }
    };
    const controls = document.createElement('nav');
    controls.id = 'account-window-options';
    controls.setAttribute('aria-label', '切换账号');
    controls.innerHTML = '<button type="button" data-login-new-account>添加账号</button>';
    document.querySelector('.pc-auth-bottom-note')?.before(controls);
    controls.querySelector('[data-login-new-account]').onclick = async () => {
      try { await desktop.openAccountWindow(); } catch (error) { alert(error.message || '暂时无法添加账号'); }
    };
    refreshLoginAccountOptions();
  }
}
function refreshLoginAccountOptions() {
  const controls = $('account-window-options');
  if (!controls || !desktop.listAccountWindows || state.desktopAccountVisible === false) return;
  desktop.listAccountWindows().then(profiles => {
    if (!controls.isConnected) return;
    const signedIn = profiles.filter(profile => !profile.current && profile.signedIn);
    const target = signedIn.find(profile => profile.returnTarget) || signedIn[0];
    const navigation = $('auth-account-navigation'), back = $('auth-back-account');
    if (navigation && back) {
      navigation.hidden = !target;
      back.dataset.profileId = target?.id || '';
      if (target) back.title = `返回 ${target.displayName || target.label}`;
      else back.removeAttribute('title');
    }
    controls.querySelectorAll('[data-account-window]').forEach(button => button.remove());
    for (const profile of profiles.filter(profile => !profile.current)) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.accountWindow = profile.id; button.textContent = profile.label;
      button.onclick = async () => {
        try { await desktop.showAccountWindow(profile.id); } catch (error) { alert(error.message || '暂时无法切换账号'); }
      };
      controls.append(button);
    }
  }).catch(() => {});
}
setInterval(() => { if (desktop.isDesktop && state.desktopAccountVisible !== false && !document.hidden && state.page === 'friends' && !document.querySelector('[data-feature-modal]')) renderFriendsPage().catch(() => {}); }, 30000);
window.addEventListener('online', resumeRealtime);
window.addEventListener('focus', resumeRealtime);
window.addEventListener('focus', () => { if (state.active && desktopReadingConversation(state.active.id)) desktop.dismissNotifications?.(Number(state.active.id)); });
desktop.onNotificationOpen?.(openDesktopNotification);
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelForegroundReads(); else resumeRealtime(); });
window.addEventListener('pagehide', () => { cancelForegroundReads(); friendChats.dispose(); conversationRefresh.dispose(); activityCenter.dispose(); void textOutbox.dispose(); });
desktop.onAccountWindowsChanged?.(refreshLoginAccountOptions);
desktop.onAccountVisibilityChanged?.(value => {
  state.desktopAccountVisible = value.active;
  closeSessionMenu();
  if (!value.active) {
    textOutbox.pause(textOutboxAccount());
    cancelForegroundReads();
    imageViewer.close(false);
    if (typeof resetComposerForNavigation === 'function') resetComposerForNavigation();
    document.querySelectorAll('audio,video').forEach(media => media.pause());
    return;
  }
  desktop.setNightMode?.(getChatTheme() === 'night');
  desktop.setSkipTaskbar?.(!localSetting('taskbar_icon', true));
  refreshLoginAccountOptions();
  resumeRealtime();
});
desktop.onLogoutRequested?.(value => {
  if ((value.removed && value.accountId === 0) || (Number(state.user?.id) === value.accountId && value.accountId > 0)) leaveAccount({ reload: true });
});
desktop.onMessageRecalled?.(value => {
  if (!state.token || Number(state.user?.id) !== Number(value?.accountId)) return;
  updateInternalMessage({ id: Number(value.messageId), conversation_id: Number(value.conversationId), status: 'recalled', body: {} }, 'peer');
  refreshChangedConversations(value.conversationId);
});
desktop.onSessionChanged?.(value => {
  if (value?.loggedOut) { void textOutbox.release(textOutboxAccount()); friendChats.reset(); conversationRefresh.reset(); cancelForegroundReads(); clearImageSendBatches(); activityCenter.reset(); closeFeatureModal(); state.token = ''; state.user = null; state.active = null; stopSocketRetries(); state.socket?.close(); if (isDetachedConversation) desktop.close?.(); else renderLogin(); return; }
  if (typeof value?.locked === 'boolean') { if (value.locked) openPasscodeLockScreen(); else { $('passcode-lock-screen')?.remove(); messageReceipts.refresh(); resumeRealtime(); } }
});
window.addEventListener('storage', event => {
  if (event.key === GO.tokenKey && event.newValue !== state.token) {
    if (!event.newValue) leaveAccount({ removeToken: false });
    else { void textOutbox.release(textOutboxAccount()); friendChats.reset(); conversationRefresh.reset(); cancelForegroundReads(); clearImageSendBatches(); state.token = ''; state.user = null; state.active = null; stopSocketRetries(); state.socket?.close(); desktop.syncSessionState?.({ accountId: 0, locked: false }); if (isDetachedConversation) desktop.close?.(); else location.reload(); }
  }
  if (event.key === 'pulse_chat_theme') applyChatTheme(getChatTheme(), false);
  if (event.key?.startsWith('pulse_group_info_expanded:')) {
    groupChatInfoVisibility.delete(event.key);
    if (event.key === groupChatInfoPreferenceKey()) syncDefaultGroupChatInfo();
  }
  if (event.key === passcodeStorageKey) { if (readPasscodeSettings().locked) openPasscodeLockScreen(); else { $('passcode-lock-screen')?.remove(); messageReceipts.refresh(); resumeRealtime(); } }
});
if (routeManager) {
  let actualTransport = JSON.stringify([routeManager.current.api_url, routeManager.current.ws_url, routeManager.current.media_url]);
  routeManager.onChange(() => {
    void syncNativeRoute().catch(() => {});
    document.querySelectorAll('[data-route-current]').forEach(node => { node.textContent = routeManager.current.name; });
    const nextTransport = JSON.stringify([routeManager.current.api_url, routeManager.current.ws_url, routeManager.current.media_url]);
    if (nextTransport === actualTransport) return;
    actualTransport = nextTransport;
    for (const node of document.querySelectorAll('img[src],audio[src],video[src],source[src]')) { const next = mediaUrl(node.src); if (next !== node.src) node.src = next; }
    if (state.token && !state.updateRequired) { state.recoveryNeeded = true; restartSocketConnection(); }
  });
  desktop.onVerifiedRouteChanged?.(async value => {
    if(routeManager.isGo){
      if(!value.goRoute||value.goRoute===routeManager.current.id)return;
      try{await routeManager.refresh();const selected=routeManager.routes.find(row=>row.id===value.goRoute);if(selected&&selected.id!==routeManager.current.id){routeManager.current=selected;routeManager.emit();}}catch{}
      return;
    }
    const serial = routeManager.serial;
    try {
      if (!value.envelope) { routeManager.expire(); return; }
      const data = await PulseRoutes.verify(value.envelope, { ...routeManager.options, minRevision: routeManager.revision });
      if (serial !== routeManager.serial) return;
      const selected = data.routes.find(r => r.id === String(value.current)); if (!selected) return;
      // Install the native policy and selected bundle as one visible transition.
      routeManager.current = selected; routeManager.install(data, value.envelope); routeManager.emit();
    } catch { /* Native IPC still needs the same pinned signature proof. */ }
  });
  routeManager.ready.then(async () => { await syncNativeRoute().catch(() => {}); return routeManager.refresh(); }).catch(()=>{});
  setInterval(() => { if (!document.hidden) void routeManager.refresh().catch(()=>{}); }, 300000);
}
async function startAccountView() {
  // A removed tray entry must require a fresh login, including after restart
  // between saving the removal and clearing the previous renderer's token.
  if ((await desktop.accountStartup?.())?.removed) { leaveAccount(); return; }
  if (!GO) { if (state.token) await boot().then(connectSocket); else renderLogin(); }
}
startAccountView().catch(() => renderLogin());

// Message mutation controls mirror ownership; the server enforces permissions.
const pulseOriginalMessageHtml = messageHtml;
const pulseMessageCache = new Map();
let pulseMessageCacheAccount = '';
const pendingMessageMutations = new Map();
function syncPulseMessageCache() {
  const account = state.token && state.user ? JSON.stringify([state.token, Number(state.user.id), Number(state.active?.id)]) : '';
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
    historyEpoch: state.historyEpoch, page: state.page, sidebarMode: state.sidebarMode, navigationRevision: messageForwardNavigationRevision, expectedVersion: message.body?._go_version };
}
function currentMessageMutation(context) {
  return sameSendAccount(context.account) && !state.updateRequired && Number(state.active?.id) === context.conversationId
    && state.historyEpoch === context.historyEpoch && state.page === context.page && state.sidebarMode === context.sidebarMode
    && messageForwardNavigationRevision === context.navigationRevision;
}
function messageMutationKey(context, action) { return JSON.stringify([context.account.token, context.account.userId, context.conversationId, context.messageId, action]); }
function canEditMessage(message) {
  if (!message || message.type !== 'text') return false;
  if (GO && Number(message.sender_id) !== Number(state.user?.id)) return false;
  if (!GO && state.user?.internal_staff) return true;
  const conversation = state.active;
  return Number(message.sender_id) === Number(state.user?.id) && Boolean(conversation)
    && conversation.can_send !== false && !conversation.frozen_at && conversation.status !== 'frozen' && conversation.can_publish !== false && conversation.can_publish !== 0
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
    await api('/messages/recall', { method: 'POST', authToken: context.account.token, signal: AbortSignal.timeout(15000), body: JSON.stringify({ conversation_id: context.conversationId, message_id: context.messageId }) });
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
      const updated = await api('/messages/edit', { method: 'POST', authToken: context.account.token, signal: AbortSignal.timeout(15000), body: JSON.stringify({ conversation_id: context.conversationId, message_id: context.messageId, text, expected_version: context.expectedVersion }) });
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
