const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

// A native submenu consumes the entire row. This split menu gives the account
// name its own Open action and reserves the arrow for account/window actions.
function createTrayMenu({ electron, directory, profiles, open, logout, remove, closeWindow, newWindow, openLogs, quit }) {
  const { BrowserWindow, ipcMain, screen, session } = electron;
  const entry = pathToFileURL(path.join(directory, 'web/tray-menu.html')).href;
  let view = null, destroyed = false;
  const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);
  function snapshot() {
    return profiles().filter(p => !p.trayHidden && p.main && !p.main.isDestroyed()).map(p => ({
      key: randomUUID(), profileId: p.id, windowId: p.main.id, accountId: p.accountId,
      name: clean(p.displayName) || (p.accountId ? `账号 ${p.accountId}` : '未登录'),
      locked: p.locked, active: p.active,
    }));
  }
  function close() {
    const previous = view; view = null;
    if (previous && !previous.window.isDestroyed()) previous.window.destroy();
  }
  function current(row) {
    return profiles().some(p => !p.trayHidden && p.id === row.profileId && p.main && !p.main.isDestroyed()
      && p.main.id === row.windowId && p.accountId === row.accountId);
  }
  function position(item) {
    const area = screen.getDisplayNearestPoint(item.anchor).workArea;
    const rootWidth = Math.min(250, Math.floor(area.width * .6)), sideWidth = Math.min(150, area.width - rootWidth - 16);
    const height = Math.min(area.height - 16, Math.max(1, item.rows.length) * 32 + 136);
    const width = rootWidth + sideWidth + 16;
    const toLeft = item.anchor.x + width > area.x + area.width - 8;
    const rootX = toLeft ? sideWidth + 8 : 8;
    const x = Math.max(area.x, Math.min(area.x + area.width - width, toLeft ? item.anchor.x - width + 8 : item.anchor.x - 8));
    const y = Math.max(area.y, Math.min(area.y + area.height - height, item.anchor.y - height + 8));
    item.layout = { rootX, rootWidth, sideWidth, side: toLeft ? 'left' : 'right', height };
    item.window.setBounds({ x, y, width, height });
  }
  function send(item) {
    if (item !== view || item.window.isDestroyed() || !item.ready) return;
    item.window.webContents.send('pulse:tray-content', { ...item.layout,
      rows: item.rows.map(({ key, name, locked, active, accountId }) => ({ key, name, locked, active, signedIn: accountId > 0 })) });
  }
  function update() {
    if (!view) return;
    // Retain keys only while the owning renderer/account is still the same.
    const old = view.rows;
    view.rows = snapshot().map(row => ({ ...row, key: old.find(p => p.profileId === row.profileId
      && p.windowId === row.windowId && p.accountId === row.accountId)?.key || row.key }));
    position(view); send(view);
  }
  function resolve(event) {
    if (!view || view.window.isDestroyed() || event.sender !== view.window.webContents
      || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== entry) return null;
    return view;
  }
  function show(point = screen.getCursorScreenPoint()) {
    if (destroyed) return;
    close();
    const window = new BrowserWindow({ width: 416, height: 300, show: false, frame: false, transparent: true,
      backgroundColor: '#00000000', alwaysOnTop: true, skipTaskbar: true, resizable: false,
      movable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
      title: '账号窗口', webPreferences: { session: session.fromPartition('pulse-tray-menu'),
        preload: path.join(directory, 'tray-menu-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const item = { window, rows: snapshot(), ready: false, anchor: point };
    view = item; position(item);
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-redirect', event => event.preventDefault());
    window.on('blur', () => { if (view === item) close(); });
    window.on('closed', () => { if (view === item) view = null; });
    window.loadFile(path.join(directory, 'web/tray-menu.html')).catch(() => { if (view === item) close(); });
  }
  const ready = event => {
    const item = resolve(event); if (!item) return;
    item.ready = true; send(item); item.window.show(); item.window.focus();
  };
  const action = (event, value = {}) => {
    const item = resolve(event); if (!item || !item.ready) return;
    const name = value.action;
    if (name === 'dismiss') { close(); return; }
    if (name === 'new') { close(); newWindow(); return; }
    if (name === 'logs') { close(); openLogs?.(); return; }
    if (name === 'quit') { close(); quit(); return; }
    if (!['open', 'logout', 'close-window', 'remove-account'].includes(name)) return;
    const row = item.rows.find(p => p.key === value.key);
    if (!row || !current(row) || (name === 'logout' && !row.accountId)) { update(); return; }
    close();
    if (name === 'open') open(row.profileId, row.windowId);
    if (name === 'logout') logout(row.profileId, row.accountId);
    if (name === 'remove-account') remove(row.profileId, row.accountId);
    if (name === 'close-window') closeWindow(row.profileId, row.windowId);
  };
  ipcMain.on('pulse:tray-ready', ready); ipcMain.on('pulse:tray-action', action);
  const displayChanged = () => { if (view) { position(view); send(view); } };
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, displayChanged);
  return { show, update, close, destroy() {
    destroyed = true; close();
    ipcMain.removeListener('pulse:tray-ready', ready); ipcMain.removeListener('pulse:tray-action', action);
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, displayChanged);
  } };
}
module.exports = { createTrayMenu };
