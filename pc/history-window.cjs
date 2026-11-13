const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const mediaSources = require('./web/media-source.js');

// A history window has a read-only, account-bound bridge. The login token stays
// in the main process; neither the URL nor the history renderer receives it.
function createHistoryWindows({ electron, directory, runtimeConfig, appVersion, appName, icon, createBrowserWindow, ownerCurrent, fetchHistory, mapMedia, mapMessageMedia, purgeMessageMedia, openImage, closeImage, selectDirectory, downloadFile, mediaDiskCache, getChatTypography = () => ({}) }) {
  const { BrowserWindow, ipcMain, screen, clipboard } = electron;
  // An opaque data origin cannot read the main app's file:// localStorage.
  // Keep the account's network Session/proxy while exposing only hashed, local
  // scripts and styles and a narrowly scoped, read-only IPC surface.
  const script = ['chat-typography.js', 'media-source.js', 'media-lifecycle.js', 'history-window.js'].map(name => fs.readFileSync(path.join(directory, 'web', name), 'utf8').replace(/\r\n?/g, '\n')).join('\n;\n');
  const style = fs.readFileSync(path.join(directory, 'web/history-window.css'), 'utf8').replace(/\r\n?/g, '\n');
  const hash = value => createHash('sha256').update(value).digest('base64');
  const html = fs.readFileSync(path.join(directory, 'web/history-window.html'), 'utf8')
    .replace("script-src 'self'; style-src 'self'", `script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'`)
    .replace('<link rel="stylesheet" href="./history-window.css">', () => `<style>${style}</style>`)
    .replace('<script src="./history-window.js"></script>', () => `<script>${script}</script>`);
  const entry = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  const byKey = new Map(), byContents = new Map(), channels = [];
  const integer = value => Number.isSafeInteger(value) && value > 0;
  function current(record) {
    return !record.window.isDestroyed() && ownerCurrent(record.owner) && record.owner.profile.accountId === record.accountId;
  }
  function close(record) {
    record.controller?.abort();
    record.token = '';
    if (!record.window.isDestroyed()) record.window.destroy();
  }
  function requireHistory(event) {
    const record = byContents.get(event.sender?.id);
    if (!record || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== entry || !current(record)) throw Error('聊天记录窗口已失效，请重新打开。');
    return record;
  }
  function handle(channel, action) {
    ipcMain.handle(channel, (event, ...args) => action(requireHistory(event), ...args));
    channels.push(channel);
  }
  function mediaUrl(value, owner) {
    if (!value || typeof value !== 'string') return '';
    try {
      const url = new URL(mapMedia ? mapMedia(owner, value) : value, runtimeConfig.apiBaseUrl);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  function message(value, conversationId, owner) {
    if (!value || !integer(Number(value.id)) || Number(value.conversation_id) !== conversationId) throw Error('聊天记录返回了无效的消息。');
    const body = value.body && typeof value.body === 'object' ? value.body : {};
    const originalUrl = mediaUrl(body.url, owner);
    const displayUrl = originalUrl && ['image', 'video', 'voice'].includes(value.type) && mapMessageMedia
      ? mapMessageMedia(owner, originalUrl, conversationId, Number(value.id)) : originalUrl;
    return { id: Number(value.id), conversation_id: conversationId, sender_id: Number(value.sender_id) || 0,
      sender_name: String(value.sender_name || value.sender_nickname || `用户 #${value.sender_id}`).slice(0, 120),
      sender_avatar_url: mediaUrl(value.sender_avatar_url, owner), type: String(value.type || ''),
      created_at: String(value.created_at || '').slice(0, 40), recalled_at: Boolean(value.recalled_at), status: String(value.status || ''),
      body: { text: String(body.text || ''), url: displayUrl, name: String(body.name || '').slice(0, 255), mime: String(body.mime || '').slice(0, 100),
        width: Math.min(10000, Math.max(0, Number(body.width) || 0)), height: Math.min(10000, Math.max(0, Number(body.height) || 0)),
        nickname: String(body.nickname || '').slice(0, 120), username: String(body.username || '').slice(0, 120),
        avatar_url: mediaUrl(body.avatar_url, owner), user_id: Number(body.user_id) || 0 } };
  }
  handle('pulse:history-window:context', record => ({ conversationId: record.conversationId, accountId: record.accountId,
    title: record.title, type: record.type, theme: record.theme, chatTypography: getChatTypography() }));
  handle('pulse:history-window:page', async (record, beforeId = 0) => {
    if (!Number.isSafeInteger(beforeId) || beforeId < 0 || (beforeId && !record.knownIds.has(beforeId))) throw Error('历史消息位置无效，请刷新后重试。');
    if (record.controller) throw Error('正在加载聊天记录，请稍候。');
    if (beforeId === 1) return { items: [], hasMore: false };
    const controller = new AbortController(); record.controller = controller;
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const url = new URL(String(runtimeConfig.apiBaseUrl).replace(/\/$/, '') + '/messages/history');
      url.search = new URLSearchParams({ conversation_id: String(record.conversationId), page: '1', size: '50', max_id: String(beforeId ? beforeId - 1 : 0) }).toString();
      const options = { method: 'GET', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Authorization: 'Bearer ' + record.token, 'X-Client-Platform': 'pc', 'X-Client-Version': appVersion, Accept: 'application/json' } };
      let response;
      if (record.go) {
        record.go.session(record.token);
        const data=await record.go.request('/messages/history?'+new URLSearchParams({conversation_id:String(record.conversationId),size:'50',max_id:String(beforeId)}),{signal:controller.signal});
        response=new Response(JSON.stringify({ok:true,data}),{headers:{'Content-Type':'application/json'}});
      } else response = await (fetchHistory ? fetchHistory(record.owner, url.href, options) : record.owner.profile.session.fetch(url.href, options));
      if (!current(record)) throw Error('当前账号已切换。');
      if ([401, 403, 426].includes(response.status)) { close(record); throw Error('当前账号无权查看此会话，请重新登录或更新客户端。'); }
      const text = await response.text();
      if (!current(record)) throw Error('当前账号已切换。');
      if (text.length > 10 * 1024 * 1024) throw Error('聊天记录数据过大，请稍后重试。');
      let result;
      try { result = JSON.parse(text); } catch { throw Error('聊天记录暂时无法读取，请稍后重试。'); }
      if (!response.ok || result.ok === false) throw Error(String(result.error?.message || '聊天记录加载失败，请重试。'));
      if (!Array.isArray(result.data?.items) || result.data.items.length > 50) throw Error('聊天记录数据格式异常，请重试。');
      const rows = result.data.items.map(item => message(item, record.conversationId, record.owner));
      if (rows.some(item => beforeId && item.id >= beforeId)) throw Error('历史消息顺序异常，请刷新后重试。');
      const removed = rows.filter(item => item.recalled_at || ['deleted', 'recalled'].includes(item.status)).map(item => item.id);
      if (removed.length) Promise.resolve(purgeMessageMedia?.(record.owner, record.conversationId, removed)).catch(() => {});
      for (const id of removed) {
        record.messages.delete(id);
        if (record.imageId === `history-${record.conversationId}-${id}`) { closeImage(record.owner, record.imageId); record.imageId = ''; }
      }
      if (!beforeId) record.messages.clear();
      for (const item of rows) { record.knownIds.add(item.id); if (item.recalled_at || ['deleted', 'recalled'].includes(item.status)) record.removedIds.add(item.id); }
      const items = rows.filter(item => !record.removedIds.has(item.id));
      for (const item of items) record.messages.set(item.id, item);
      const total = Number(result.data.total);
      return { items, oldestId: rows.length ? Math.min(...rows.map(item => item.id)) : 0, hasMore: rows.length > 0 && (Number.isFinite(total) ? total > rows.length : rows.length === 50) };
    } catch (error) {
      if([401,403,426].includes(error.status))close(record);
      if (controller.signal.aborted && current(record)) throw Error('聊天记录加载超时，请重试。');
      throw error;
    } finally { clearTimeout(timer); if (record.controller === controller) record.controller = null; }
  });
  function selected(record, id) {
    const item = record.messages.get(Number(id));
    if (!item) throw Error('消息已失效，请刷新聊天记录。');
    return item;
  }
  handle('pulse:history-window:copy-text', (record, id) => {
    const item = selected(record, id);
    if (!item.body.text) throw Error('这条消息没有可复制的文字。');
    clipboard.writeText(item.body.text); return true;
  });
  handle('pulse:history-window:copy-image', (record, value = {}) => {
    const item = selected(record, value.id), { x, y } = value;
    if (item.type !== 'image' || !item.body.url || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw Error('图片位置无效。');
    const zoom = record.window.webContents.getZoomFactor(), bounds = record.window.getContentBounds();
    const px = Math.round(x * zoom), py = Math.round(y * zoom);
    if (px >= bounds.width || py >= bounds.height) throw Error('图片已不在可见区域。');
    record.window.webContents.copyImageAt(px, py); return true;
  });
  handle('pulse:history-window:image', (record, id) => {
    const item = selected(record, id);
    if (item.type !== 'image' || !item.body.url) throw Error('这条消息没有可预览的图片。');
    record.imageId = `history-${record.conversationId}-${item.id}`;
    return openImage(record.owner, { id: record.imageId, url: item.body.url, name: item.body.name || '聊天图片', accountId: record.accountId,
      conversationId: record.conversationId, messageId: item.id });
  });
  handle('pulse:history-window:download', async (record, id) => {
    const item = selected(record, id);
    if (item.type !== 'file' || !item.body.url || !downloadFile || !selectDirectory) throw Error('这条消息没有可下载的文件。');
    const serviceRecord = { ...record.owner, window: record.window };
    const directory = await selectDirectory(serviceRecord);
    if (!current(record)) throw Error('当前账号已切换。');
    if (!directory) return { canceled: true };
    const saved = await downloadFile(serviceRecord, { url: item.body.url, fileName: item.body.name || '聊天文件', directory });
    return { saved: Boolean(saved) };
  });
  handle('pulse:history-window:close', record => { close(record); return true; });
  handle('pulse:history-window:media-consumers', (record, urls) => {
    if (!Array.isArray(urls) || urls.length > 2048) return false;
    if (urls.some(url => {
      const value = typeof url === 'string' && mediaSources.parseDisplay(url);
      const message = value && record.messages.get(value.message);
      return !value || value.account !== record.accountId || value.conversation !== record.conversationId || !message
        || mediaSources.identity(value.source) !== mediaSources.identity(message.body.url);
    })) return false;
    mediaDiskCache?.updateConsumers?.(String(record.window.webContents.id), record.owner.profile, urls); return true;
  });
  function open(owner, value = {}) {
    if (!ownerCurrent(owner) || value.accountId !== owner.profile.accountId) throw Error('请先登录当前账号。');
    if (!integer(value.conversationId) || typeof value.token !== 'string' || !value.token || value.token.length > 8192) throw Error('请选择有效会话后查看聊天记录。');
    const goMode=new URL(runtimeConfig.apiBaseUrl).pathname.replace(/\/$/,'')==='/api/v2';
    if(goMode && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.conversationWireId||''))throw Error('会话标识无效，请重新打开聊天。');
    if (owner.kind === 'conversation' && owner.conversationId !== value.conversationId) throw Error('此窗口只能打开当前会话的聊天记录。');
    const key = owner.webContents.id + ':' + value.conversationId;
    let record = byKey.get(key);
    if (record && !current(record)) { close(record); record = null; }
    if (record) {
      record.token = value.token;
      if (record.window.isMinimized()) record.window.restore();
      record.window.show(); record.window.focus();
      return { opened: true, conversationId: record.conversationId };
    }
    const area = screen?.getDisplayMatching?.(owner.window.getBounds())?.workArea || { x: 0, y: 0, width: 1280, height: 900 };
    const width = Math.min(660, Math.max(480, area.width - 40)), height = Math.min(800, Math.max(360, area.height - 80));
    const title = String(value.title || '当前会话').slice(0, 120), theme = value.theme === 'night' ? 'night' : 'day';
    const options = { width, height, minWidth: 480, minHeight: 360, x: area.x + area.width - width - 16,
      y: area.y + Math.max(0, Math.round((area.height - height) / 2)), title: `${title} · 聊天记录 - ${appName}`, icon,
      backgroundColor: theme === 'night' ? '#172126' : '#f3f5f7', autoHideMenuBar: true, show: false, modal: false, skipTaskbar: false,
      webPreferences: { session: owner.profile.session, preload: path.join(directory, 'history-window-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } };
    const window = createBrowserWindow ? createBrowserWindow(options) : new BrowserWindow(options);
    record = { window, owner, key, accountId: owner.profile.accountId, conversationId: value.conversationId, title,
      type: value.type === 'group' ? 'group' : 'private', theme, token: value.token, messages: new Map(), knownIds: new Set(), removedIds: new Set(), controller: null };
    if(goMode){
      const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
      record.go=require('./web/go-v2.js').create({base:runtimeConfig.apiBaseUrl,storage,platform:'pc',fetch:(url,options)=>fetchHistory?fetchHistory(owner,url,options):owner.profile.session.fetch(url,options)});
      if(record.go.local('conversation',value.conversationWireId)!==value.conversationId){window.destroy();throw Error('会话标识不一致，请重新打开聊天。');}
    }
    byKey.set(key, record); byContents.set(window.webContents.id, record);
    const contentsId = window.webContents.id;
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) mediaDiskCache?.releaseConsumer?.(String(contentsId)); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('did-finish-load', () => { if (current(record)) { window.show(); window.focus(); } else close(record); });
    window.on('closed', () => {
      mediaDiskCache?.releaseConsumer?.(String(contentsId));
      record.controller?.abort(); record.token = ''; record.messages.clear();
      if (record.imageId) closeImage(record.owner, record.imageId);
      if (byKey.get(key) === record) byKey.delete(key);
      byContents.delete(contentsId);
    });
    window.loadURL(entry).catch(() => close(record));
    return { opened: true, conversationId: record.conversationId };
  }
  return { open,
    recall(profile, value) {
      for (const record of byKey.values()) {
        if (record.owner.profile !== profile || !current(record) || record.accountId !== value.accountId || record.conversationId !== value.conversationId) continue;
        record.removedIds.add(value.messageId); record.messages.delete(value.messageId);
        if (record.imageId === `history-${record.conversationId}-${value.messageId}`) { closeImage(record.owner, record.imageId); record.imageId = ''; }
        record.window.webContents.send('pulse:history-window:message-recalled', value);
      }
    },
    updateChatTypography(value) { for (const record of byKey.values()) if (current(record)) record.window.webContents.send('pulse:history-window:chat-typography', value); },
    closeOwner(owner) { for (const record of [...byKey.values()]) if (record.owner === owner) close(record); },
    closeProfile(profileId) { for (const record of [...byKey.values()]) if (record.owner.profileId === profileId) close(record); },
    destroy() { for (const record of [...byKey.values()]) close(record); for (const channel of channels) ipcMain.removeHandler(channel); },
  };
}
module.exports = { createHistoryWindows };
