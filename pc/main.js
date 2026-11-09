const electron = require('electron');
electron.protocol.registerSchemesAsPrivileged(['pulse-avatar', 'pulse-media'].map(scheme => ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } })));
const { app, BrowserWindow, shell, session, net, Menu, Tray, nativeImage, nativeTheme, Notification, ipcMain, dialog, safeStorage } = electron;
const packageMetadata = require('./package.json');
const diagnostics = require('./diagnostics.cjs').installDiagnostics({ electron, version: packageMetadata.version });
const QRCode = require('qrcode');
const path = require('node:path');
const fs = require('node:fs');
const { registerScreenshot } = require('./screenshot');
const { registerAppearance } = require('./appearance');

const { loadRuntimeConfig } = require('./runtime-config.cjs');
const appName = '小猿口算';
const appIconPath = path.join(__dirname, 'assets', 'app-icon.png');
const runtimeConfig = loadRuntimeConfig({ packaged: app.isPackaged, directory: __dirname, buildProfile: packageMetadata.pulseBuildProfile });
const webUrl = runtimeConfig.webUrl;
const bundledWeb = path.join(__dirname, 'web', 'index.html');
let mainWindow = null;
const { createWindowManager } = require('./window-manager.cjs');
const { createGlobalProxy, defaultProxySettings, normalizeProxySettings } = require('./global-proxy.cjs');
const { createSessionFetch } = require('./session-fetch.cjs');
let windowManager = null;
let tray = null;
let trayMenu = null;
let cachedApplicationIcon = null;
const appVersion = packageMetadata.version || '2.4.11';
const globalProxy = createGlobalProxy({ persist: settings => writeProxySettings(settings) });
let autoUpdateTimer = null;
let updateCheckInFlight = false;
let updateCheckController = null;
const updateCheckIntervalMs = 6 * 60 * 60 * 1000;

function compareVersions(left, right) {
  const parse = value => String(value || '0').trim().replace(/^v/i, '').split(/[.-]/).map(part => {
    const number = Number.parseInt(part, 10);
    return Number.isFinite(number) ? number : 0;
  });
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function updateServiceUrl() {
  return runtimeConfig.updateUrl;
}

function readUpdateManifest() {
  const endpoint = updateServiceUrl();
  if (!endpoint) {
    return Promise.resolve({
      currentVersion: appVersion,
      latestVersion: appVersion,
      updateAvailable: false,
      configured: false,
      message: `未配置更新服务，当前版本为 ${appVersion}`,
    });
  }
  let parsed;
  try { parsed = new URL(endpoint); } catch { return Promise.reject(new Error('更新服务地址格式不正确。')); }
  if (!['http:', 'https:'].includes(parsed.protocol)) return Promise.reject(new Error('更新服务只支持 HTTP 或 HTTPS 地址。'));
  return new Promise((resolve, reject) => {
    const controller = new AbortController(); updateCheckController = controller;
    let request, settled = false;
    let body = '';
    const finish = (callback, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      controller.abort(); try { request?.abort(); } catch {}
      if (updateCheckController === controller) updateCheckController = null;
      body = ''; callback(value);
    };
    const abort = () => finish(reject, new Error('检查更新已取消。'));
    controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => finish(reject, new Error('检查更新超时。')), 10000);
    (async () => {
    await globalProxy.whenIdle({ signal: controller.signal });
    if (settled) return;
    if (!globalProxy.isSessionReady(session.defaultSession)) throw Error('代理配置尚未恢复，请重新应用设置后重试。');
    request = net.request({ url: parsed.toString(), session: session.defaultSession, method: 'GET' });
    request.setHeader('X-Client-Platform', 'pc');
    request.setHeader('X-Client-Version', appVersion);
    request.on('login', (authInfo, callback) => { const auth = globalProxy.credentialsFor(authInfo, session.defaultSession); if (auth) callback(auth.username, auth.password); else callback(); });
    request.on('error', error => finish(reject, new Error(`检查更新失败：${error.message}`)));
    request.on('response', response => {
      response.on('error', error => finish(reject, error));
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
        finish(reject, new Error(`更新服务返回 ${response.statusCode || '未知状态'}。`));
        return;
      }
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (settled) return;
        body += chunk;
        if (body.length > 1024 * 1024) {
          finish(reject, new Error('更新清单超过大小限制。'));
        }
      });
      response.on('end', () => {
        if (settled) return;
        try {
          const manifest = JSON.parse(body);
          const latestVersion = String(manifest.version || manifest.latestVersion || '').trim();
          if (!latestVersion) throw new Error('更新清单缺少版本号。');
          const rawDownloadUrl = String(manifest.downloadUrl || manifest.url || '').trim();
          let downloadUrl = '';
          if (rawDownloadUrl) {
            const download = new URL(rawDownloadUrl);
            if (!['http:', 'https:'].includes(download.protocol)) throw new Error('更新下载地址只支持 HTTP 或 HTTPS。');
            downloadUrl = download.toString();
          }
          const updateAvailable = compareVersions(latestVersion, appVersion) > 0;
          const notes = String(manifest.notes || manifest.changelog || '').trim();
          const message = updateAvailable
            ? `发现新版本 ${latestVersion}${notes ? `\n${notes}` : ''}`
            : `当前已是最新版本（${appVersion}）`;
          finish(resolve, { currentVersion: appVersion, latestVersion, updateAvailable, downloadUrl, notes, configured: true, message });
        } catch (error) { finish(reject, new Error(error.message || '更新清单格式不正确。')); }
      });
    });
    request.end();
    })().catch(error => finish(reject, error));
  });
}

async function checkForUpdate(notify = false) {
  if (updateCheckInFlight) return { currentVersion: appVersion, latestVersion: appVersion, updateAvailable: false, message: '正在检查更新。' };
  updateCheckInFlight = true;
  try {
    const result = await readUpdateManifest();
    if (notify && result.updateAvailable) for (const record of windowManager?.windows() || []) {
      if (record.kind === 'main' && !record.webContents.isDestroyed()) record.webContents.send('pulse:update-available', result);
    }
    return result;
  } finally { updateCheckInFlight = false; }
}

function setAutoUpdate(enabled) {
  clearInterval(autoUpdateTimer);
  autoUpdateTimer = null;
  if (!enabled) return false;
  checkForUpdate(true).catch(() => {});
  autoUpdateTimer = setInterval(() => { checkForUpdate(true).catch(() => {}); }, updateCheckIntervalMs);
  return true;
}

function applicationIcon() { if (!cachedApplicationIcon) cachedApplicationIcon = nativeImage.createFromPath(appIconPath); return cachedApplicationIcon; }
function trayIcon() { return applicationIcon().resize({ width: 32, height: 32, quality: 'best' }); }

function proxySettingsPath() {
  return path.join(app.getPath('userData'), 'proxy-settings.json');
}

function readProxySettings() {
  try {
    return normalizeProxySettings(JSON.parse(fs.readFileSync(proxySettingsPath(), 'utf8')));
  } catch {
    return defaultProxySettings();
  }
}

function writeProxySettings(settings) {
  const normalized = normalizeProxySettings(settings);
  fs.mkdirSync(path.dirname(proxySettingsPath()), { recursive: true });
  const temporary = proxySettingsPath() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(temporary, proxySettingsPath());
  return normalized;
}

async function applyProxySettings(input, persist = true) {
  const settings = await globalProxy.apply(input, { persist });
  windowManager?.broadcastApplicationSettings?.({ proxy: settings });
  return settings;
}

async function testProxyConnection(targetSession, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController(); let request, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      controller.abort(); try { request?.abort(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error('连接测试已取消'));
    const timer = setTimeout(() => finish(new Error('代理连接超时。')), 10000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    (async () => {
      await globalProxy.whenIdle({ signal: controller.signal });
      if (settled) return;
      if (globalProxy.isSessionReady && !globalProxy.isSessionReady(targetSession)) throw Error('代理配置尚未恢复，请重新应用设置后重试。');
      const startedAt = Date.now();
      request = net.request({ url: 'https://www.cloudflare.com/cdn-cgi/trace', session: targetSession, method: 'GET' });
      request.on('login', (authInfo, callback) => { const auth = globalProxy.credentialsFor(authInfo, targetSession); if (auth) callback(auth.username, auth.password); else callback(); });
      request.on('response', response => {
        response.on('error', error => finish(new Error(`代理连接失败：${error.message}`)));
        const statusCode = Number(response.statusCode || 0);
        if (statusCode < 200 || statusCode >= 400) finish(new Error(`代理连接失败，服务器返回 ${statusCode || '未知状态'}。`));
        else finish(null, { ok: true, statusCode, latencyMs: Date.now() - startedAt });
      });
      request.on('error', error => finish(new Error(`代理连接失败：${error.message}`)));
      request.end();
    })().catch(error => finish(error));
  });
}

function setTrayVisible(visible) {
  if (visible) {
    if (!tray) createTray();
    return;
  }
  tray?.destroy();
  tray = null;
  trayMenu?.close();
}

function showNotification(title, body, { silent = false, onClick } = {}) {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({ title: title || appName, body: body || '你有一条新消息', icon: applicationIcon(), silent });
  if (onClick) notification.on('click', onClick);
  notification.show(); return true;
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: appName, submenu: [{ label: `关于${appName}`, click: () => showNotification(appName, '桌面端正在运行') }, { type: 'separator' }, { label: '退出', role: 'quit' }] },
    { label: '窗口', submenu: [{ label: '最小化', role: 'minimize' }, { label: '最大化', role: 'toggleMaximize' }, { label: '关闭窗口', role: 'close' }] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }] },
    { label: '帮助', submenu: [{ label: '打开本地日志', click: openLocalLogs }, { label: '快捷键说明', click: () => showNotification('快捷键说明', 'Ctrl + K 搜索消息；Ctrl + Shift + L 打开本地日志；F12 在开发模式下打开调试工具。') }] },
  ]));
}

function createTray() {
  if (process.platform === 'linux' && !process.env.DISPLAY) return;
  const creating = !tray;
  if (creating) tray = new Tray(trayIcon());
  tray.setToolTip(appName);
  if (process.platform === 'win32') {
    if (!trayMenu) {
      trayMenu = require('./tray-menu.cjs').createTrayMenu({ electron: require('electron'), directory: __dirname,
        profiles: () => windowManager?.profiles() || [],
        open: (profileId, windowId) => windowManager?.showProfileWindow(profileId, windowId),
        logout: (profileId, accountId) => windowManager?.logoutAccount(profileId, accountId),
        remove: (profileId, accountId) => {
          try { windowManager?.removeAccount(profileId, accountId); }
          catch { showNotification('删除此账号未完成', '无法保存本机账号列表，请检查磁盘权限后重试。'); }
        },
        closeWindow: (profileId, windowId) => windowManager?.exitProfileWindow(profileId, windowId),
        newWindow: () => windowManager?.createIndependentWindow(), openLogs: openLocalLogs, quit: () => app.quit() });
      app.on('before-quit', () => trayMenu?.destroy());
    }
    // Do not attach a native context menu: Windows would consume the name click
    // to expand its submenu instead of opening the selected account window.
    if (creating) tray.on('right-click', () => trayMenu.show());
    trayMenu.update();
  } else {
    const accounts = (windowManager?.profiles() || []).filter(p => !p.trayHidden && p.main && !p.main.isDestroyed()).map(profile => ({
      label: `${profile.displayName || (profile.accountId ? `账号 ${profile.accountId}` : '未登录')}${profile.locked ? '（已锁定）' : ''}`,
      submenu: [
        { label: '打开窗口', click: () => windowManager.showProfileWindow(profile.id, profile.main.id) },
        { label: '退出登录', enabled: profile.accountId > 0, click: () => windowManager.logoutAccount(profile.id, profile.accountId) },
        { label: '退出窗口', click: () => windowManager.exitProfileWindow(profile.id, profile.main.id) },
        { label: '删除此账号', click: () => {
          try { windowManager.removeAccount(profile.id, profile.accountId); }
          catch { showNotification('删除此账号未完成', '无法保存本机账号列表，请检查磁盘权限后重试。'); }
        } },
      ],
    }));
    tray.setContextMenu(Menu.buildFromTemplate([...accounts, ...(accounts.length ? [{ type: 'separator' }] : []), { label: '新开窗口', click: () => windowManager?.createIndependentWindow() }, { label: '打开本地日志', click: openLocalLogs }, { type: 'separator' }, { label: '退出', role: 'quit' }]));
  }
  if (creating) tray.on('double-click', () => { const window = windowManager?.createMainWindow(); if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
}

function ownedSendToShortcut(filename) {
  if (!fs.existsSync(filename)) return false;
  try {
    const shortcut = shell.readShortcutLink(filename);
    if (!path.isAbsolute(shortcut.target || '')) return false;
    const resolved = path.resolve(shortcut.target), executable = path.resolve(process.execPath);
    const sameTarget = resolved.toLowerCase() === executable.toLowerCase();
    const legacyTarget = path.dirname(resolved).toLowerCase() === path.dirname(executable).toLowerCase() && path.basename(resolved).toLowerCase() === '脉冲即时通讯.exe';
    const knownDescription = [`发送文件到${appName}`, '发送文件到脉冲即时通讯'].includes(shortcut.description);
    return (sameTarget || legacyTarget) && knownDescription && (!shortcut.appUserModelId || shortcut.appUserModelId === 'com.pulseim.desktop');
  } catch { return false; }
}
function setSendToMenu(enabled) {
  if (process.platform !== 'win32') return false;
  const directory = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo');
  const target = path.join(directory, `${appName}.lnk`), legacy = path.join(directory, '脉冲即时通讯.lnk');
  if (enabled) {
    if (fs.existsSync(target) && !ownedSendToShortcut(target)) throw new Error('发送到菜单中已有同名快捷方式，请先检查冲突。');
    fs.mkdirSync(directory, { recursive: true });
    if (!shell.writeShortcutLink(target, 'create', { target: process.execPath, description: `发送文件到${appName}`, icon: process.execPath, iconIndex: 0, appUserModelId: 'com.pulseim.desktop' })) throw new Error('无法创建发送到菜单快捷方式。');
  } else if (ownedSendToShortcut(target)) fs.unlinkSync(target);
  if (ownedSendToShortcut(legacy)) fs.unlinkSync(legacy);
  return true;
}
function migrateSendToMenu() {
  if (process.platform !== 'win32') return;
  const legacy = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', '脉冲即时通讯.lnk');
  if (ownedSendToShortcut(legacy)) { try { setSendToMenu(true); } catch { /* Preserve the old link when a name conflict prevents migration. */ } }
}


function createWindow(profileId) {
  const window = windowManager.createMainWindow(profileId);
  mainWindow = window;
  return window;
}
function openLocalLogs() {
  return diagnostics.openDirectory().catch(error => { showNotification('本地日志', error.message); return false; });
}

app.on('login', (event, webContents, _request, authInfo, callback) => {
  if (!webContents?.session) return;
  const auth = globalProxy.credentialsFor(authInfo, webContents.session);
  if (!auth) return;
  event.preventDefault();
  callback(auth.username, auth.password);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  diagnostics.startSession();
  let pendingWindows = 0;
  app.on('second-instance', () => {
    if (!windowManager) { pendingWindows++; return; }
    windowManager.createIndependentWindow();
  });
  app.whenReady().then(async () => {
  app.isQuitting = false;
  const windowLogins = require('./remembered-logins.cjs').createWindowRememberedLogins({ directory: app.getPath('userData'), safeStorage });
  const avatarDiskCache = require('./avatar-disk-cache.cjs').createAvatarDiskCache({
    directory: path.join(app.getPath('userData'), 'avatar-thumbnails-v1'),
    fetch: (profile, url, options) => createSessionFetch({ net, proxy: globalProxy, target: profile.session })(url, options),
    report: code => diagnostics.log('avatar-cache-failed', { code: /^AVATAR_[A-Z_0-9]+$/.test(code) ? code : 'AVATAR_CACHE_IO' }, 'warn'),
  });
  const mediaDiskCache = require('./media-disk-cache.cjs').createMediaDiskCache({
    directory: path.join(app.getPath('userData'), 'local-media-v1'),
    fetch: (profile, url, options) => createSessionFetch({ net, proxy: globalProxy, target: profile.session })(url, options),
    report: code => diagnostics.log('media-cache-failed', { code: /^MEDIA_[A-Z_0-9]+$/.test(code) ? code : 'MEDIA_IO' }, 'warn'),
  });
  app.on('before-quit', () => { app.isQuitting = true; });
  let screenshot;
  try { await applyProxySettings(readProxySettings(), false); } catch { await applyProxySettings(defaultProxySettings()); }
  const uploadImage = require('./image-upload.cjs').createImageUploader({ net, proxy: globalProxy, version: appVersion,
    createSession: partition => session.fromPartition(partition, { cache: false }),
    report: (kind, data, level) => diagnostics.log(kind, data, level) });
  const proxyTests = new Map();
  const cancelProxyTests = predicate => { for (const task of proxyTests.values()) if (predicate(task)) task.controller.abort(); };
  const downloads = require('./download-queue.cjs').createDownloadQueue({
    download: (owner, payload, options) => require('./download-file.cjs').createDownloader({ net: { fetch: createSessionFetch({ net, proxy: globalProxy, target: owner.target }) } })(payload.url, payload.fileName, payload.directory, options),
    onChange: (owner, tasks) => windowManager?.publishDownloads(owner, tasks),
  });
  let drainingDownloads = false;
  app.on('before-quit', event => {
    updateCheckController?.abort();
    cancelProxyTests(() => true);
    if (!drainingDownloads && downloads.stats().total) {
      event.preventDefault(); drainingDownloads = true;
      const deadline = setTimeout(() => app.exit(0), 5000);
      void downloads.dispose().finally(() => { clearTimeout(deadline); app.quit(); });
    } else void downloads.dispose();
  });
  windowManager = createWindowManager({ electron: require('electron'), directory: __dirname, runtimeConfig, appVersion, appName, icon: applicationIcon(), configureSession: target => {
    target.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, done) => done({ cancel: !globalProxy.isSessionReady(target) }));
    return globalProxy.registerSession(target);
  },
    services: { localChat: true,
      isSessionReady: target => globalProxy.isSessionReady(target),
      diagnostics,
      uploadImage,
      avatarDiskCache,
      mediaDiskCache,
      canReleaseProfile: profile => !downloads.hasProfile(profile.id) && !windowLogins.hasSavedGroup(profile.groupId),
      releaseProfile: profile => { uploadImage.releaseSession?.(profile.session); globalProxy.unregisterSession(profile.session); },
      releaseGroup: groupId => windowLogins.releaseGroup(groupId),
      cancelRecordRequests: record => cancelProxyTests(task => task.recordId === record.webContents.id),
      cancelAccountRequests: (profile, accountId) => { downloads.cancelProfile(profile.id, accountId); cancelProxyTests(task => task.profileId === profile.id); },
      openLogs: openLocalLogs,
      rememberedLogins: (record, action, value) => {
        const rememberedLogins = windowLogins.forGroup(record.groupId);
        const server = runtimeConfig.apiBaseUrl;
        if (action === 'list') return { available: rememberedLogins.available(), items: rememberedLogins.list(server) };
        if (action === 'get') return rememberedLogins.get(server, value?.id);
        if (action === 'save') return rememberedLogins.save(server, value);
        if (action === 'remove') return rememberedLogins.remove(server, value);
        throw Error('账号操作无效');
      },
      onMainClose: (record, event) => { if (process.platform === 'win32' && tray && !app.isQuitting) { event.preventDefault(); record.window.hide(); } },
      closeMain: record => { if (tray) record.window.hide(); else record.window.close(); },
      openExternal: (_record, url) => shell.openExternal(url),
      notify: (_record, payload, onClick) => showNotification(payload.title, payload.body, { silent: payload.silent === true, onClick }),
      qrCode: (_record, value) => QRCode.toDataURL(String(value || ''), { errorCorrectionLevel: 'M', margin: 1, width: 240 }),
      selectDirectory: async record => { const result = await dialog.showOpenDialog(record.window, { title: '选择下载目录', properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : (result.filePaths[0] || null); },
      fetchHistory: (record, url, options) => createSessionFetch({ net, proxy: globalProxy, target: record.profile.session })(url, options),
      downloadFile: (record, payload = {}) => {
        if (!record.profile.accountId || record.profile.locked) throw Error('请先解锁并登录后下载文件');
        return downloads.start({ profileId: record.profile.id, accountId: record.profile.accountId, target: record.profile.session }, payload);
      },
      listDownloads: record => downloads.list({ profileId: record.profile.id, accountId: record.profile.accountId }),
      cancelDownload: (record, id) => downloads.cancel({ profileId: record.profile.id, accountId: record.profile.accountId }, id),
      getProxySettings: () => globalProxy.settings(), setProxy: (_record, settings) => applyProxySettings(settings),
      cancelProxyTest: record => { cancelProxyTests(task => task.recordId === record.webContents.id); return true; },
      testProxy: record => {
        const key = record.webContents.id, previous = proxyTests.get(key); if (previous) return previous.promise;
        const task = { recordId: key, profileId: record.profile.id, controller: new AbortController() };
        task.promise = testProxyConnection(record.profile.session, { signal: task.controller.signal }).finally(() => { if (proxyTests.get(key) === task) proxyTests.delete(key); });
        proxyTests.set(key, task); return task.promise;
      },
      clearCache: async record => { await mediaDiskCache.clear(); await avatarDiskCache.clear(record.profile); await record.webContents.session.clearCache(); return true; },
      checkUpdate: () => checkForUpdate(false), autoUpdate: (_record, enabled) => setAutoUpdate(Boolean(enabled)),
      openUpdate: async (_record, value) => { const url = new URL(String(value || '')); if (!['http:', 'https:'].includes(url.protocol)) throw Error('更新地址只支持 HTTP 或 HTTPS。'); await shell.openExternal(url.href); return true; },
      tray: (_record, visible) => setTrayVisible(visible), autoLaunch: (_record, enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
      sendToMenu: (_record, enabled) => setSendToMenu(Boolean(enabled)),
      openSystemSoundSettings: async () => { if (process.platform !== 'win32') throw Error('当前系统没有可直接打开的声音设置入口。'); await shell.openExternal('ms-settings:sound'); return true; },
      cancelCaptures: profileId => screenshot?.cancel(windowManager.windows().filter(record => record.profileId === profileId).map(record => record.webContents)),
      onActiveProfileChanged: record => { nativeTheme.themeSource = record.nightMode ? 'dark' : 'light'; record.window.setBackgroundColor(record.nightMode ? '#172126' : '#f4f7f8'); },
      onProfilesChanged: () => { if (tray) createTray(); },
    },
  });
  screenshot = registerScreenshot(require('electron'), event => windowManager.resolveScreenshotSender(event));
  registerAppearance(require('electron'), event => windowManager.resolveSender(event));
  Menu.setApplicationMenu(null);
  migrateSendToMenu();
  createTray();
  createWindow();
  while (pendingWindows > 0) { pendingWindows--; windowManager.createIndependentWindow(); }
  app.on('activate', () => {
    if (!windowManager.windows().some(record => record.kind === 'main' && !record.window.isDestroyed())) createWindow();
  });
  }).catch(error => { diagnostics.log('application-startup-failed', { error }, 'fatal'); console.error('桌面客户端启动失败：', error?.code || 'INITIALIZATION_FAILED'); app.quit(); });
}

app.on('window-all-closed', () => {
  const hasMainWindow = windowManager?.windows().some(record => record.kind === 'main' && !record.window.isDestroyed());
  if (process.platform !== 'darwin' && !tray && !hasMainWindow) app.quit();
});
