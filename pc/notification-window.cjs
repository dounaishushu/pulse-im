const path = require('node:path');
const { pathToFileURL } = require('node:url');

function createNotificationWindows({ electron, directory, ownerCurrent, onOpen, duration = 8000 }) {
  const { BrowserWindow, ipcMain, screen, shell } = electron;
  const entry = pathToFileURL(path.join(directory, 'web/notification-window.html')).href;
  const views = new Map();
  let sweepTimer = null, lastSoundAt = 0, destroyed = false;
  const text = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
  function avatar(raw) {
    try { const url = new URL(String(raw || '')); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 8192) return url.href; } catch { /* Use the name avatar. */ }
    return '';
  }
  function valid(view) { return !destroyed && !view.window.isDestroyed() && ownerCurrent(view.owner, view.accountId); }
  function position() {
    const perDisplay = new Map();
    for (const view of [...views.values()].reverse()) {
      if (!valid(view)) continue;
      const display = screen.getDisplayMatching(view.owner.window.getBounds()), area = display.workArea;
      const index = perDisplay.get(display.id) || 0, width = Math.min(360, Math.max(240, area.width - 24));
      view.window.setBounds({ x: area.x + area.width - width - 12, y: Math.max(area.y + 12, area.y + area.height - 108 - index * 104), width, height: 96 });
      perDisplay.set(display.id, index + 1);
    }
  }
  function close(view) {
    if (!view || views.get(view.key) !== view) return;
    views.delete(view.key);
    if (!view.window.isDestroyed()) view.window.destroy();
    if (!views.size) { clearInterval(sweepTimer); sweepTimer = null; }
    position();
  }
  function closeProfile(profileId, conversationId = 0) {
    for (const view of [...views.values()]) if (view.owner.profileId === profileId && (!conversationId || view.conversationId === conversationId)) close(view);
  }
  function send(view) { if (valid(view) && view.ready) view.window.webContents.send('pulse:notification-content', view.content); }
  function show(owner, payload) {
    if (destroyed || !ownerCurrent(owner, owner.profile.accountId)) return;
    const accountId = owner.profile.accountId, conversationId = Number(payload.conversationId);
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return;
    const key = `${owner.profileId}:${accountId}:${conversationId}`;
    const content = { title: text(payload.title, 80) || '小猿口算', body: text(payload.body, 300) || '你收到一条新消息', avatarUrl: avatar(payload.avatarUrl), group: payload.kind === 'group' || payload.kind === 'channel' };
    let view = views.get(key);
    if (view && !valid(view)) { close(view); view = null; }
    if (view) {
      view.content = content; view.deadline = Date.now() + duration;
      views.delete(key); views.set(key, view); send(view); position();
    } else {
      if (views.size >= 3) close(views.values().next().value);
      const window = new BrowserWindow({ width: 360, height: 96, show: false, frame: false, focusable: false, skipTaskbar: true,
        alwaysOnTop: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        backgroundColor: '#ffffff', autoHideMenuBar: true, title: '新消息',
        webPreferences: { session: owner.profile.session, preload: path.join(directory, 'notification-window-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      view = { key, owner, accountId, conversationId, window, content, ready: false, hovered: false, deadline: Date.now() + duration };
      views.set(key, view); position();
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('will-redirect', event => event.preventDefault());
      window.on('closed', () => close(view));
      window.loadFile(path.join(directory, 'web/notification-window.html')).catch(() => close(view));
      if (!sweepTimer) sweepTimer = setInterval(() => {
        for (const item of [...views.values()]) if (!valid(item) || (!item.hovered && Date.now() >= item.deadline)) close(item);
      }, 250);
    }
    if (!payload.silent && Date.now() - lastSoundAt > 1500) { lastSoundAt = Date.now(); try { shell.beep(); } catch { /* Visual notifications remain available. */ } }
  }
  function resolve(event) {
    const view = [...views.values()].find(item => item.window.webContents === event.sender);
    if (!view || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== entry) return null;
    if (!valid(view)) { close(view); return null; }
    return view;
  }
  const ready = event => {
    const view = resolve(event); if (!view) return;
    view.ready = true; view.deadline = Date.now() + duration; send(view); position(); view.window.showInactive();
  };
  const action = (event, value) => {
    const view = resolve(event); if (!view) return;
    if (value === 'hover') { view.hovered = true; return; }
    if (value === 'leave') { view.hovered = false; view.deadline = Date.now() + duration; return; }
    if (!['open', 'reply', 'close'].includes(value)) return;
    const { owner, accountId, conversationId } = view; close(view);
    if (value !== 'close' && ownerCurrent(owner, accountId)) onOpen(owner, { accountId, conversationId, reply: value === 'reply' });
  };
  ipcMain.on('pulse:notification-ready', ready); ipcMain.on('pulse:notification-action', action);
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, position);
  return { show, closeProfile, destroy() {
    for (const view of [...views.values()]) close(view);
    destroyed = true; clearInterval(sweepTimer);
    ipcMain.removeListener('pulse:notification-ready', ready); ipcMain.removeListener('pulse:notification-action', action);
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, position);
  } };
}
module.exports = { createNotificationWindows };
