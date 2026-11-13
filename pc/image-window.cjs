const path = require('node:path');
const { pathToFileURL } = require('node:url');
const mediaSources = require('./web/media-source.js');

// Preview windows have a limited bridge and share only the owning account's Session.
function createImageWindows({ electron, directory, appName, icon, createBrowserWindow, ownerCurrent, mediaDiskCache }) {
  const { BrowserWindow, ipcMain, screen } = electron;
  const byOwner = new Map(), byContents = new Map();
  const entry = pathToFileURL(path.join(directory, 'web/image-window.html')).href;
  const channels = [];
  function current(record) {
    return !record.window.isDestroyed() && !record.owner.webContents.isDestroyed()
      && ownerCurrent(record.owner) && record.owner.profile.accountId === record.accountId;
  }
  function close(record) { if (record && !record.window.isDestroyed()) record.window.destroy(); }
  function requirePreview(event) {
    const record = byContents.get(event.sender?.id);
    if (!record || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== entry || !current(record)) throw Error('图片窗口已失效，请重新打开。');
    return record;
  }
  function handle(channel, callback) { ipcMain.handle(channel, (event, ...args) => callback(requirePreview(event), ...args)); channels.push(channel); }
  handle('pulse:image-window:content', record => ({ ...record.content, accountId: record.accountId }));
  handle('pulse:image-window:close', record => { close(record); return true; });
  handle('pulse:image-window:media-consumers', (record, urls) => {
    if (!Array.isArray(urls) || urls.length > 2048) return false;
    if (urls.some(url => {
      const value = typeof url === 'string' && mediaSources.parseDisplay(url);
      return !value || value.account !== record.accountId || value.conversation !== record.content.conversationId || value.message !== record.content.messageId
        || mediaSources.identity(value.source) !== mediaSources.identity(record.content.url);
    })) return false;
    mediaDiskCache?.updateConsumers?.(String(record.window.webContents.id), record.owner.profile, urls); return true;
  });
  handle('pulse:image-window:copy', (record, value = {}) => {
    if (value.id !== record.content.id || !Number.isFinite(value.x) || !Number.isFinite(value.y)) throw Error('图片已切换，请重新复制。');
    const zoom = record.window.webContents.getZoomFactor(), bounds = record.window.getContentBounds();
    const x = Math.round(value.x * zoom), y = Math.round(value.y * zoom);
    if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) throw Error('图片不在可见区域。');
    record.window.webContents.copyImageAt(x, y); return { copied: true };
  });
  function content(value, accountId) {
    if (!value || value.accountId !== accountId || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value.id)
      || typeof value.url !== 'string' || value.url.length > 90 * 1024 * 1024) throw Error('图片信息无效。');
    const url = new URL(value.url);
    const cached = url.protocol === 'pulse-media:' ? mediaSources.parseDisplay(value.url) : null;
    if (url.protocol === 'pulse-media:') {
      if (!cached || cached.account !== accountId || cached.conversation !== value.conversationId || cached.message !== value.messageId) throw Error('图片所属会话已失效。');
    } else if (!['https:', 'http:'].includes(url.protocol) && !(url.protocol === 'data:' && /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(value.url))) throw Error('不支持此图片地址。');
    if (url.username || url.password) throw Error('图片地址无效。');
    return { id: value.id, url: url.href, name: String(value.name || '图片预览').slice(0, 180),
      ...(cached ? { conversationId: cached.conversation, messageId: cached.message } : {}) };
  }
  function open(owner, value) {
    if (!ownerCurrent(owner) || !owner.profile.accountId) throw Error('请先登录后查看图片。');
    const next = content(value, owner.profile.accountId);
    if (next.conversationId && owner.kind === 'conversation' && next.conversationId !== owner.conversationId) throw Error('此窗口只能查看当前会话的图片。');
    let record = byOwner.get(owner.webContents.id);
    if (record && !current(record)) { close(record); record = null; }
    if (!record) {
      const area = screen?.getDisplayMatching?.(owner.window.getBounds())?.workArea || { x: 0, y: 0, width: 1280, height: 900 };
      const width = Math.min(1000, Math.max(480, Math.round(area.width * .55))), height = Math.min(800, Math.max(360, area.height - 80));
      const options = { width, height, minWidth: 480, minHeight: 360, x: area.x + area.width - width, y: area.y + Math.round((area.height - height) / 2),
        title: '图片预览 - ' + appName, icon, backgroundColor: '#16191e', autoHideMenuBar: true, show: false, modal: false, skipTaskbar: false,
        webPreferences: { session: owner.profile.session, preload: path.join(directory, 'image-window-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } };
      const window = createBrowserWindow ? createBrowserWindow(options) : new BrowserWindow(options);
      record = { window, owner, accountId: owner.profile.accountId, content: next, loaded: false };
      byOwner.set(owner.webContents.id, record); byContents.set(window.webContents.id, record);
      const contentsId = window.webContents.id;
      window.setMenuBarVisibility(false);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) mediaDiskCache?.releaseConsumer?.(String(contentsId)); });
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      window.on('closed', () => { mediaDiskCache?.releaseConsumer?.(String(contentsId)); if (byOwner.get(owner.webContents.id) === record) byOwner.delete(owner.webContents.id); byContents.delete(contentsId); if (!owner.webContents.isDestroyed()) owner.webContents.send('pulse:image-window-closed', { id: record.content.id }); });
      window.webContents.on('did-finish-load', () => {
        if (!current(record)) { close(record); return; }
        record.loaded = true; window.webContents.send('pulse:image-window:show', { ...record.content, accountId: record.accountId });
        window.show(); window.focus();
      });
      window.loadFile(path.join(directory, 'web/image-window.html')).catch(() => close(record));
    } else {
      if (record.content.url !== next.url) mediaDiskCache?.releaseConsumer?.(String(record.window.webContents.id));
      record.content = next;
      if (record.loaded) record.window.webContents.send('pulse:image-window:show', { ...next, accountId: record.accountId });
      if (record.window.isMinimized()) record.window.restore(); record.window.show(); record.window.focus();
    }
    return { opened: true, id: next.id };
  }
  return { open,
    closeOwner(owner, id) { const record = byOwner.get(owner.webContents.id); if (record && (!id || record.content.id === id)) close(record); },
    closeProfile(profileId) { for (const record of [...byOwner.values()]) if (record.owner.profileId === profileId) close(record); },
    destroy() { for (const record of [...byOwner.values()]) close(record); for (const channel of channels) ipcMain.removeHandler(channel); },
  };
}
module.exports = { createImageWindows };
