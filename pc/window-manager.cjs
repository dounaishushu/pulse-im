const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const chatTypography = require('./web/chat-typography.js');
const mediaSources = require('./web/media-source.js');

// Each independent window owns its account list and remembered-login vault.
// Accounts switch views inside their owning window and keep separate Sessions.
function createWindowManager({ electron, directory, runtimeConfig, appVersion, appName = '小猿口算', icon, createBrowserWindow, configureSession, services = {}, storageDirectory = electron.app?.getPath('userData') }) {
  const { BaseWindow, BrowserWindow, WebContentsView, ipcMain, session } = electron;
  const records = new Map(), profiles = new Map(), groups = new Map(), disposers = [], configured = new WeakMap(), windowTitles = new WeakMap(), imageUploads = new Map();
  const appProtocols = new WeakSet();
  const notificationOwnerCurrent = (record, accountId) => records.get(record.webContents.id) === record && !record.window.isDestroyed()
    && !record.webContents.isDestroyed() && record.profile.accountId === accountId && accountId > 0 && !record.profile.locked;
  function openNotification(record, value) {
    if (!notificationOwnerCurrent(record, value.accountId)) return;
    const main = record.profile.main; if (!main) return;
    activate(main); show(main.window);
    main.webContents.send('pulse:notification-open', value);
  }
  const notificationWindows = require('./notification-window.cjs').createNotificationWindows({ electron, directory,
    ownerCurrent: notificationOwnerCurrent, onOpen: openNotification });
  const routeBridge = require('./route-bridge.cjs').createRouteBridge({ runtimeConfig,
    fetchForProfile: (profile, url, options) => {
      const owner = [...records.values()].find(record => record.profile === profile && record.active && record.kind === 'main');
      if (!owner) throw Error('账号窗口已关闭');
      return services.fetchHistory ? services.fetchHistory(owner, url, options) : profile.session.fetch(url, options);
    },
    onChange: (profile, value) => { for (const record of records.values()) if (record.profile === profile && !record.webContents.isDestroyed()) record.webContents.send('pulse:verified-route-changed', value); },
  });
  const ownerCurrent = record => records.get(record.webContents.id) === record && !record.window.isDestroyed() && !record.webContents.isDestroyed()
    && record.profile.accountId > 0 && !record.profile.locked && (record.kind !== 'main' || record.active);
  const imageWindows = require('./image-window.cjs').createImageWindows({ electron, directory, appName, icon, createBrowserWindow, ownerCurrent, mediaDiskCache: services.mediaDiskCache });
  const historyWindows = require('./history-window.cjs').createHistoryWindows({ electron, directory, runtimeConfig, appVersion, appName, icon, createBrowserWindow, ownerCurrent, mediaDiskCache: services.mediaDiskCache,
    getChatTypography: () => ({ ...typography }),
    fetchHistory: (owner, url, options) => routeBridge.request(owner.profile, url.slice(String(runtimeConfig.apiBaseUrl).replace(/\/$/, '').length), options),
    mapMedia: (owner, value) => routeBridge.mediaURL(owner.profile, value),
    mapMessageMedia: (owner, value, cid, mid, kind) => routeBridge.messageMediaURL(owner.profile, value, cid, mid, services.mediaDiskCache?.available(owner.profile) === true, kind),
    purgeMessageMedia: (owner, cid, ids) => services.mediaDiskCache?.purge(owner.profile, cid, ids),
    downloadFile: (owner, payload) => services.downloadFile?.(owner, { ...payload, url: routeBridge.mediaURL(owner.profile, payload.url) }), selectDirectory: services.selectDirectory,
    openImage: (owner, value) => imageWindows.open(owner, value), closeImage: (owner, id) => imageWindows.closeOwner(owner, id) });
  const entry = runtimeConfig.webUrl || 'pulse-app://client/index.html';
  const profileFile = storageDirectory && path.join(storageDirectory, 'account-profiles.json');
  const settingsFile = storageDirectory && path.join(storageDirectory, 'application-settings.json');
  const typographyFile = storageDirectory && path.join(storageDirectory, 'chat-typography.json');
  let typography = chatTypography.normalize(read(typographyFile, {}));
  const sharedMethods = { tray_icon: 'tray', auto_launch: 'autoLaunch', auto_update: 'autoUpdate', send_to_menu: 'sendToMenu' };
  let settings = {}, settingsInitialized = false, settingsQueue = Promise.resolve(), destroying = false, activeProfileId = 'default';
  let profileSaveTimer = null, changedTimer = null, changedAllGroups = false;
  const changedGroups = new Set();
  function read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
  function write(file, value) {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  const savedSettings = read(settingsFile, {});
  if (savedSettings && typeof savedSettings === 'object' && !Array.isArray(savedSettings)) for (const [key, value] of Object.entries(savedSettings)) if (Object.hasOwn(sharedMethods, key) && typeof value === 'boolean') settings[key] = value;
  const changed = (groupId, notifyRenderers = true) => {
    if (destroying) return;
    if (notifyRenderers) { if (groupId) changedGroups.add(groupId); else changedAllGroups = true; }
    if (changedTimer !== null) return;
    changedTimer = setTimeout(() => {
      changedTimer = null;
      if (destroying) return;
      const all = changedAllGroups, selected = new Set(changedGroups);
      changedAllGroups = false; changedGroups.clear();
      services.onProfilesChanged?.();
      for (const record of records.values()) if (record.kind === 'main' && record.active
        && (all || selected.has(record.groupId)) && !record.webContents.isDestroyed()) record.webContents.send('pulse:account-windows-changed');
    }, 0);
  };
  function accountSummary(value) {
    if (!value || !Number.isSafeInteger(value.id) || value.id <= 0) return null;
    let avatarUrl = '';
    try { const url = new URL(String(value.avatarUrl || '')); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) avatarUrl = url.href.slice(0, 2048); } catch {}
    return { id: value.id, displayName: String(value.displayName || '').slice(0, 60), avatarUrl };
  }
  const validId = id => id === 'default' || (typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id));
  function saveProfiles() { clearTimeout(profileSaveTimer); profileSaveTimer = null; write(profileFile, { version: 2, activeProfileId, defaultAccount: profiles.get('default')?.account || null, defaultTrayHidden: profiles.get('default')?.trayHidden === true,
    groups: [...groups.values()].map(g => ({ id: g.id, createdAt: g.createdAt, activeProfileId: g.activeProfileId })),
    profiles: [...profiles.values()].filter(p => p.id !== 'default').map(p => ({ id: p.id, groupId: p.groupId, createdAt: p.createdAt, account: p.account, trayHidden: p.trayHidden })) }); }
  function saveDisplayPreferencesSoon() {
    clearTimeout(profileSaveTimer);
    profileSaveTimer = setTimeout(() => { profileSaveTimer = null; try { saveProfiles(); } catch { /* Optional display preferences never block account switching. */ } }, 200);
    profileSaveTimer.unref?.();
  }
  function flushDisplayPreferences() { if (profileSaveTimer !== null) { try { saveProfiles(); } catch { /* Keep the last successfully saved registry. */ } } }
  electron.app?.on('before-quit', flushDisplayPreferences);
  disposers.push(() => electron.app?.removeListener('before-quit', flushDisplayPreferences));
  function addGroup(id, createdAt = new Date().toISOString()) {
    if (!validId(id)) throw Error('账号窗口不存在。');
    const group = { id, createdAt, activeProfileId: null, window: null };
    groups.set(id, group); return group;
  }
  function addProfile(id, createdAt = new Date().toISOString(), account = null, groupId = 'default', trayHidden = false) {
    if (!validId(id) || !groups.has(groupId)) throw Error('账号窗口不存在。');
    const profile = { id, groupId, group: groups.get(groupId), createdAt, session: id === 'default' ? session.defaultSession : session.fromPartition('persist:pulse-account-' + id), main: null, accountId: 0, locked: false, displayName: '', account: accountSummary(account), trayHidden: trayHidden === true, notified: new Set() };
    if (!profile.group.activeProfileId) profile.group.activeProfileId = id;
    services.avatarDiskCache?.register(profile, source => routeBridge.avatarSource(profile, source));
    services.mediaDiskCache?.register(profile, source => routeBridge.mediaSource(profile, source));
    profiles.set(id, profile); return profile;
  }
  const registry = read(profileFile, {});
  addGroup('default');
  const savedGroups = registry?.version === 2 && Array.isArray(registry.groups) ? registry.groups : [];
  for (const item of savedGroups) if (item && validId(item.id) && !groups.has(item.id)) addGroup(item.id, typeof item.createdAt === 'string' ? item.createdAt : undefined);
  addProfile('default', undefined, registry?.defaultAccount, 'default', registry?.defaultTrayHidden);
  const savedProfiles = registry && typeof registry === 'object' && !Array.isArray(registry) ? registry.profiles : null;
  // Old registries had one shared account list. Keep that entire list in the original window.
  for (const item of (Array.isArray(savedProfiles) ? savedProfiles : [])) if (item && typeof item.id === 'string' && !profiles.has(item.id)) { try { addProfile(item.id, typeof item.createdAt === 'string' ? item.createdAt : undefined, item.account, registry.version === 2 && groups.has(item.groupId) ? item.groupId : 'default', item.trayHidden); } catch { /* Invalid registry entries never become paths. */ } }
  for (const item of savedGroups) if (groups.has(item?.id) && profiles.get(item.activeProfileId)?.groupId === item.id) groups.get(item.id).activeProfileId = item.activeProfileId;
  if (profiles.has(registry?.activeProfileId)) activeProfileId = registry.activeProfileId;
  function approved(url) { try { const a = new URL(url), b = new URL(entry); return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search; } catch { return false; } }
  function resolveSender(event) {
    const record = records.get(event.sender?.id);
    if (!record || record.window.isDestroyed() || record.webContents.isDestroyed() || event.senderFrame !== event.sender.mainFrame || !approved(event.senderFrame.url)) return null;
    return record;
  }
  function requireSender(event, { primary = false, allowLocked = false } = {}) {
    const record = resolveSender(event);
    if (!record || (primary && (record.kind !== 'main' || !record.active)) || (!allowLocked && record.profile.locked)) throw Error('当前窗口无权执行此操作。');
    return record;
  }
  function closeChildren(profile) { notificationWindows.closeProfile(profile.id); historyWindows.closeProfile(profile.id); imageWindows.closeProfile(profile.id); for (const record of [...records.values()]) if (record.profile === profile && record.kind === 'conversation' && !record.window.isDestroyed()) record.window.destroy(); }
  function broadcast(profile, value, except) { for (const record of records.values()) if (record.profile === profile && record !== except && !record.webContents.isDestroyed()) record.webContents.send('pulse:session-changed', value); }
  function broadcastSettings(value) { for (const record of records.values()) if (!record.webContents.isDestroyed()) record.webContents.send('pulse:application-settings-changed', value); }
  function registerSession(value) {
    if (configured.has(value) && services.isSessionReady?.(value) !== false) return configured.get(value);
    configured.delete(value);
    if (!runtimeConfig.webUrl && !appProtocols.has(value)) {
      appProtocols.add(value);
      value.protocol.handle('pulse-app', async request => {
        const url = new URL(request.url);
        if (url.hostname !== 'client' || request.method !== 'GET') return new Response('Forbidden', {status: 403});
        let file;
        try { file = path.resolve(directory, 'web', '.' + decodeURIComponent(url.pathname)); } catch { return new Response('Invalid path', {status: 400}); }
        const relative = path.relative(path.join(directory, 'web'), file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', {status: 403});
        const response = await electron.net.fetch(pathToFileURL(file).href);
        const headers = new Headers(response.headers);
        headers.set('Cache-Control', 'no-store');
        const api = new URL(runtimeConfig.apiBaseUrl).origin, ws = new URL(runtimeConfig.websocketUrl).origin;
        headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http: pulse-avatar: pulse-media:; media-src 'self' blob: https: http: pulse-media:; connect-src 'self' ${api} ${ws}; object-src 'none'; base-uri 'self'; form-action 'none'`);
        return new Response(response.body, {status: response.status, headers});
      });
    }
    value.setPermissionRequestHandler((contents, permission, callback, details = {}) => {
      const record = records.get(contents?.id), profile = record?.profile;
      // Chromium's video controls use this permission for their fullscreen button.
      callback(Boolean(record && profile.accountId && !profile.locked && (record.kind !== 'main' || record.active) && !record.window.isDestroyed() && approved(contents.getURL()) && ['media', 'clipboard-sanitized-write', 'fullscreen'].includes(permission) && details.isMainFrame !== false));
    });
    const ready = Promise.resolve().then(() => configureSession?.(value)).catch(error => { configured.delete(value); throw error; });
    configured.set(value, ready); return ready;
  }
  function show(window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return window; }
  function mainRecord(window) { return [...records.values()].find(record => record.kind === 'main' && record.window === window && record.active); }
  function layoutMain(window) {
    const record = mainRecord(window);
    if (window.isDestroyed() || !record?.view) return;
    const { width, height } = window.getContentBounds();
    if (record.layoutWidth === width && record.layoutHeight === height) return;
    record.view.setBounds({ x: 0, y: 0, width, height });
    record.layoutWidth = width; record.layoutHeight = height;
  }
  function rememberActive(record) {
    if (!record?.active || record.webContents.isDestroyed() || record.window.isDestroyed()) return;
    const previous = activeProfileId;
    activeProfileId = record.profileId;
    record.profile.group.activeProfileId = record.profileId;
    if (previous !== activeProfileId || !record.appearanceActivated) {
      record.appearanceActivated = true; services.onActiveProfileChanged?.(record);
    }
    if (previous !== activeProfileId) {
      saveDisplayPreferencesSoon();
      // Native-window focus changes the tray selection, not any account list.
      changed(record.groupId, false);
    }
  }
  function updateTitle(record) {
    if (!record.active) return;
    const name = record.profile.displayName || record.profile.account?.displayName;
    const title = name ? `${name} - ${appName}` : appName;
    if (windowTitles.get(record.window) !== title) { record.window.setTitle?.(title); windowTitles.set(record.window, title); }
  }
  function releaseRecord(record) {
    if (records.get(record.webContents.id) !== record) return;
    const discardEmpty = record.kind === 'main' && record.readyToLogin && !record.profile.accountId && !record.profile.account;
    services.cancelRecordRequests?.(record);
    cancelImageUploads(item => item.record === record);
    services.mediaDiskCache?.releaseConsumer?.(String(record.webContents.id));
    if (record.profile.main === record) services.cancelCaptures?.(record.profileId);
    records.delete(record.webContents.id);
    if (record.attached && record.view && !record.window.isDestroyed()) {
      try { record.window.contentView.removeChildView(record.view); } catch { /* The native host may already be closing. */ }
      record.attached = false;
    }
    historyWindows.closeOwner(record);
    imageWindows.closeOwner(record);
    const profile = record.profile;
    if (profile.main === record) {
      notificationWindows.closeProfile(profile.id);
      services.avatarDiskCache?.invalidate(profile);
      services.mediaDiskCache?.invalidate(profile);
      profile.main = null; profile.accountId = 0; profile.locked = false; profile.displayName = '';
      closeChildren(profile);
    }
    record.active = false;
    if (discardEmpty) releaseEmptyProfile(profile);
    changed(record.groupId);
  }
  function releaseEmptyProfile(profile, { unsaved = false } = {}) {
    if (destroying || profile.id === 'default' || profile.main || profile.account || profile.accountId
      || [...records.values()].some(record => record.profile === profile) || (!unsaved && services.canReleaseProfile?.(profile) === false)) return false;
    services.mediaDiskCache?.unregister?.(profile); services.avatarDiskCache?.unregister?.(profile);
    routeBridge.release(profile); configured.delete(profile.session);
    try { profile.session.setPermissionRequestHandler(null); } catch {}
    services.releaseProfile?.(profile); profiles.delete(profile.id);
    const group = profile.group, remaining = [...profiles.values()].filter(p => p.groupId === group.id);
    if (group.activeProfileId === profile.id) group.activeProfileId = remaining[0]?.id || null;
    if (!remaining.length && group.id !== 'default') { groups.delete(group.id); services.releaseGroup?.(group.id); }
    if (activeProfileId === profile.id) activeProfileId = remaining[0]?.id || 'default';
    try { saveProfiles(); } catch { /* The next registry save will retry; no saved account was removed. */ }
    return true;
  }
  function nativeMain(group) {
    const options = { width: 1440, height: 920, minWidth: 480, minHeight: 360, title: appName, icon, backgroundColor: '#f4f7f8', autoHideMenuBar: false };
    const window = createBrowserWindow ? createBrowserWindow(options) : new BaseWindow(options);
    group.window = window;
    window.setMenuBarVisibility(false);
    window.on('resize', () => layoutMain(window));
    window.on('focus', () => rememberActive(mainRecord(window)));
    window.on('close', event => { const record = mainRecord(window); if (record) services.onMainClose?.(record, event); });
    window.on('closed', () => {
      if (group.window === window) group.window = null;
      for (const record of [...records.values()]) if (record.kind === 'main' && record.window === window) {
        releaseRecord(record);
        if (!record.webContents.isDestroyed()) record.webContents.close({ waitForBeforeUnload: false });
      }
    });
    return window;
  }
  function activate(record) {
    if (record.active && record.attached) {
      layoutMain(record.window); rememberActive(record); updateTitle(record); record.webContents.focus(); return record.window;
    }
    for (const previous of records.values()) if (previous !== record && previous.kind === 'main' && previous.groupId === record.groupId && previous.active) {
      services.cancelCaptures?.(previous.profileId);
      historyWindows.closeOwner(previous); imageWindows.closeOwner(previous);
      previous.active = false;
      // Retain the mounted view and its decoded content for the next switch.
      previous.view.setVisible(false);
      if (!previous.webContents.isDestroyed()) previous.webContents.send('pulse:account-visibility', { active: false });
    }
    record.active = true;
    if (!record.attached) { record.window.contentView.addChildView(record.view); record.attached = true; }
    record.view.setVisible(true);
    layoutMain(record.window);
    if (!record.webContents.isDestroyed()) { record.webContents.send('pulse:account-visibility', { active: true }); record.webContents.focus(); }
    rememberActive(record);
    updateTitle(record);
    return record.window;
  }
  function create(profile, kind, conversationId = 0) {
    const options = {
      width: kind === 'main' ? 1440 : 1000, height: kind === 'main' ? 920 : 780,
      minWidth: 480, minHeight: 360,
      title: appName, icon, backgroundColor: '#f4f7f8', autoHideMenuBar: false,
      webPreferences: { session: profile.session, preload: path.join(directory, 'preload.js'),
        additionalArguments: [`--pulse-runtime=${encodeURIComponent(JSON.stringify({ ...runtimeConfig, appVersion, windowKind: kind, conversationId, profileId: profile.id, persistentAvatars: services.avatarDiskCache?.available(profile) === true, persistentMessages: services.localChat === true, persistentMedia: services.mediaDiskCache?.available(profile) === true, nativeImageUploads: typeof services.uploadImage === 'function' }))}`],
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    };
    const window = kind === 'main' ? (profile.group.window || nativeMain(profile.group)) : (createBrowserWindow ? createBrowserWindow(options) : new BrowserWindow(options));
    const view = kind === 'main' ? new WebContentsView({ webPreferences: options.webPreferences }) : null;
    const contents = view ? view.webContents : window.webContents;
    const record = { window, webContents: contents, view, attached: false, active: kind !== 'main', kind, conversationId, groupId: profile.groupId, profileId: profile.id, profile };
    const contentsId = contents.id;
    records.set(contentsId, record);
    services.diagnostics?.attach(contents, { kind, windowId: window.id, profileId: profile.id });
    if (kind === 'main') profile.main = record;
    else { window.setMenuBarVisibility(false); window.on('closed', () => releaseRecord(record)); }
    contents.on('destroyed', () => releaseRecord(record));
    contents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) { services.cancelRecordRequests?.(record); cancelImageUploads(item => item.record === record); services.mediaDiskCache?.releaseConsumer?.(String(contentsId)); historyWindows.closeOwner(record); imageWindows.closeOwner(record); } });
    contents.on('did-finish-load', () => {
      if (kind !== 'main' || !approved(contents.getURL())) return;
      // Chromium can replace the initial native widget during navigation. Remount
      // the active view so it becomes visible and resumes account refreshes.
      if (record.active && !record.window.isDestroyed()) {
        if (record.attached) record.window.contentView.removeChildView(record.view);
        record.attached = false;
        activate(record);
      }
      contents.send('pulse:account-visibility', { active: record.active });
    });
    contents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) services.openExternal?.(record, url); return { action: 'deny' }; });
    contents.on('will-navigate', (event, url) => { if (!approved(url)) event.preventDefault(); });
    contents.on('will-redirect', (event, url) => { if (!approved(url)) event.preventDefault(); });
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.control && input.shift && !input.alt && !input.isAutoRepeat && input.key.toLowerCase() === 'l') {
        event.preventDefault(); void services.openLogs?.(); return;
      }
      if (kind === 'main' && input.control && input.shift && !input.alt && !input.isAutoRepeat && input.key.toLowerCase() === 'n' && !profile.locked) {
        event.preventDefault(); createIndependentWindow(); return;
      }
      if (input.control && input.key.toLowerCase() === 'k') void contents.executeJavaScript(kind === 'conversation' ? "document.querySelector('#chat-search-button')?.click();" : "document.querySelector('#message-search')?.focus();");
      if (input.key === 'F12' && process.env.PULSE_DEVTOOLS === '1') contents.toggleDevTools();
    });
    record.ready = registerSession(profile.session).then(() => {
      if (contents.isDestroyed()) return;
      return contents.loadURL(entry);
    }).catch(error => {
      services.diagnostics?.log('account-page-load-failed', { webContentsId: contents.id, kind, error }, 'error');
      // A failed Session setup has no loaded document in which to run script.
      // Show a local error document; sender validation grants it no app IPC.
      if (!contents.isDestroyed()) return contents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<meta charset="utf-8"><title>账号暂时不可用</title><p>小猿口算暂时离线，请检查网络或代理设置后重新打开程序。</p>')).catch(() => {});
    });
    if (process.env.PULSE_DEVTOOLS === '1') contents.openDevTools();
    changed(profile.groupId); return record;
  }
  function createMainWindow(profileId = activeProfileId) {
    const profile = profiles.get(profileId);
    if (!profile) throw Error('账号窗口不存在。');
    return activate(profile.main || create(profile, 'main'));
  }
  function showProfileWindow(profileId, windowId) {
    const record = profiles.get(profileId)?.main;
    if (!record || record.window.isDestroyed() || record.window.id !== windowId || record.webContents.isDestroyed()) return false;
    show(activate(record)); return true;
  }
  function logoutAccount(profileId, accountId) {
    const profile = profiles.get(profileId), record = profile?.main;
    if (!record || record.window.isDestroyed() || record.webContents.isDestroyed() || !Number.isSafeInteger(accountId)
      || accountId <= 0 || profile.accountId !== accountId || record.logoutRequestedAccountId === accountId) return false;
    record.logoutRequestedAccountId = accountId;
    services.cancelAccountRequests?.(profile, accountId);
    show(activate(record));
    // Use the existing renderer logout path so its token, lock and pending work
    // are cleared exactly as when choosing Exit login in account settings.
    record.webContents.send('pulse:logout-request', { accountId }); return true;
  }
  function removeAccount(profileId, accountId) {
    const profile = profiles.get(profileId), record = profile?.main;
    if (!record || record.window.isDestroyed() || record.webContents.isDestroyed() || !Number.isSafeInteger(accountId)
      || accountId < 0 || profile.accountId !== accountId) return false;
    const previous = profile.trayHidden;
    profile.trayHidden = true;
    // Save before requesting logout: after a crash/restart the startup policy
    // discards any old token before it can restore this removed account.
    try { saveProfiles(); } catch (error) { profile.trayHidden = previous; throw error; }
    record.removingAccountId = accountId;
    changed(profile.groupId);
    if (accountId) logoutAccount(profileId, accountId);
    else record.webContents.send('pulse:logout-request', { accountId: 0, removed: true });
    return true;
  }
  function exitProfileWindow(profileId, windowId) {
    const record = profiles.get(profileId)?.main;
    if (!record || record.window.isDestroyed() || record.window.id !== windowId) return false;
    // All account views in this native window close together, keeping their
    // saved sessions. Other independent windows keep running. destroy() skips
    // the ordinary Close handler that deliberately hides a window to the tray.
    record.window.destroy(); return true;
  }
  function createAccountWindow({ sourceProfileId = activeProfileId, reuseEmpty = true } = {}) {
    const previous = profiles.get(sourceProfileId);
    if (!previous) throw Error('账号窗口不存在。');
    const returnProfileId = previous?.accountId || previous?.account ? previous.id : previous?.main?.returnProfileId;
    const empty = reuseEmpty && [...profiles.values()].find(p => p.groupId === previous.groupId && p.main?.readyToLogin && !p.accountId && !p.account && !p.main.webContents.isDestroyed());
    if (empty) { empty.main.returnProfileId = returnProfileId; return show(activate(empty.main)); }
    const reusable = [...profiles.values()].find(p => p.groupId === previous.groupId && !p.main && !p.account);
    const profile = reusable || addProfile(randomUUID(), undefined, null, previous.groupId);
    try { saveProfiles(); } catch (error) { if (!reusable) { try { releaseEmptyProfile(profile, { unsaved: true }); } catch {} } throw error; }
    const record = create(profile, 'main');
    record.readyToLogin = true;
    record.returnProfileId = returnProfileId;
    return show(activate(record));
  }
  function createIndependentWindow() {
    // Every explicit multi-open begins empty, even if another saved window is closed.
    const id = randomUUID();
    addGroup(id);
    const profile = addProfile(id, undefined, null, id);
    try { saveProfiles(); } catch (error) { try { releaseEmptyProfile(profile, { unsaved: true }); } catch {} throw error; }
    const record = create(profile, 'main'); record.readyToLogin = true;
    return show(activate(record));
  }
  function on(channel, callback, options) {
    const handler = (event, ...args) => { let record; try { record = requireSender(event, options); } catch { return; } Promise.resolve(callback(record, ...args)).catch(() => {}); };
    ipcMain.on(channel, handler); disposers.push(() => ipcMain.removeListener(channel, handler));
  }
  function handle(channel, callback, options) {
    ipcMain.handle(channel, (event, ...args) => callback(requireSender(event, options), ...args));
    disposers.push(() => ipcMain.removeHandler(channel));
  }
  function queueSettings(action) { const result = settingsQueue.then(action); settingsQueue = result.catch(() => {}); return result; }
  function cancelImageUploads(matches) {
    for (const item of imageUploads.values()) if (matches(item)) item.controller.abort();
  }
  on('pulse:diagnostic', (record, value) => services.diagnostics?.rendererEvent(record.webContents, value), { allowLocked: true });
  handle('pulse:open-logs', () => services.openLogs?.() || false, { allowLocked: true });
  handle('pulse:upload-image', async (record, value) => {
    const fail = (code, message) => ({ ok: false, error: { code, message } });
    const accountId = record.profile.accountId, transferId = value?.transferId;
    if (!services.uploadImage || !['main', 'conversation'].includes(record.kind) || !ownerCurrent(record) || accountId !== value?.accountId
      || typeof transferId !== 'string' || !/^[a-f0-9-]{36}$/.test(transferId)) return fail('UPLOAD_SESSION_CHANGED', '当前账号不能上传图片。');
    const bytes = value?.bytes instanceof ArrayBuffer ? new Uint8Array(value.bytes) : value?.bytes;
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 10 * 1024 * 1024) return fail('UPLOAD_INVALID', '图片大小无效，请重新选择。');
    const key = `${record.webContents.id}:${transferId}`;
    if (imageUploads.has(key) || [...imageUploads.values()].filter(item => item.record === record).length >= 2) return fail('UPLOAD_BUSY', '已有图片正在上传，请稍后重试。');
    const controller = new AbortController(); imageUploads.set(key, { record, controller });
    try {
      const route = routeBridge.current(record.profile);
      const response = await services.uploadImage({ session: record.profile.session, url: String(route.api_url).replace(/\/$/, '') + '/uploads',
        token: value.token, mime: value.mime, bytes, signal: controller.signal,
        allowed: () => !destroying && ownerCurrent(record) && record.profile.accountId === accountId,
        progress: progress => { if (ownerCurrent(record) && record.profile.accountId === accountId) record.webContents.send('pulse:image-upload-progress', { transferId, ...progress }); },
      });
      return { ok: true, response };
    } catch (error) {
      return fail(/^UPLOAD_[A-Z_]+$/.test(error.code) ? error.code : 'UPLOAD_NETWORK', /^UPLOAD_[A-Z_]+$/.test(error.code) ? error.message : '图片上传失败，请稍后重试。（UPLOAD_NETWORK）');
    } finally { imageUploads.delete(key); }
  });
  on('pulse:cancel-image-upload', (record, transferId) => {
    if (typeof transferId === 'string') imageUploads.get(`${record.webContents.id}:${transferId}`)?.controller.abort();
  }, { allowLocked: true });
  on('pulse:media-consumers', (record, urls) => {
    if (!Array.isArray(urls) || urls.length > 2048) return;
    const key = String(record.webContents.id);
    // A hidden or just-locked view may still release its previous references.
    if (!urls.length) { services.mediaDiskCache?.releaseConsumer?.(key); return; }
    if (!ownerCurrent(record) || urls.some(url => {
      const value = typeof url === 'string' && mediaSources.parseDisplay(url);
      return !value || value.account !== record.profile.accountId || (record.kind === 'conversation' && value.conversation !== record.conversationId);
    })) return;
    services.mediaDiskCache?.updateConsumers?.(key, record.profile, urls);
  }, { allowLocked: true });
  handle('pulse:avatar-cache', async (record, action, value) => {
    try {
      if (action === 'put') return await services.avatarDiskCache?.seed(record.profile, value) ?? false;
      if (action === 'drop') return await services.avatarDiskCache?.drop(record.profile, value) ?? false;
    } catch { /* Optional cache writes never interrupt an avatar already decoded. */ }
    return false;
  });
  handle('pulse:local-media', async (record, action, cid, ids) => {
    if (!Number.isSafeInteger(cid) || cid <= 0 || !Array.isArray(ids) || ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return false;
    if (record.kind === 'conversation' && record.conversationId !== cid) return false;
    if (action === 'allow') return services.mediaDiskCache?.allow(record.profile, cid) ?? false;
    if (action === 'purge') { await services.mediaDiskCache?.purge(record.profile, cid, ids); return true; }
    return false;
  });
  handle('pulse:publish-verified-route', (record, value) => routeBridge.accept(record.profile, value), { primary: true, allowLocked: true });
  handle('pulse:remembered-logins', (record, action, value) => {
    if (!['list', 'get', 'save', 'remove'].includes(action)) throw Error('账号操作无效');
    if (record.profile.locked && action !== 'save') throw Error('请先解锁客户端');
    if (action === 'get' && record.profile.accountId) throw Error('请在登录页面选择已保存账号');
    if (action === 'save' && Number(value?.userId) !== record.profile.accountId) throw Error('只能记住已成功登录的当前账号');
    return services.rememberedLogins?.(record, action, value);
  }, { primary: true, allowLocked: true });
  function changeSetting(record, key, enabled) {
    if (!Object.hasOwn(sharedMethods, key) || typeof enabled !== 'boolean') throw Error('应用设置无效。');
    return queueSettings(async () => {
      const previous = settings[key];
      await services[sharedMethods[key]]?.(record, enabled);
      settings[key] = enabled;
      try { write(settingsFile, settings); } catch (error) { settings[key] = previous; if (typeof previous === 'boolean') await services[sharedMethods[key]]?.(record, previous); throw error; }
      broadcastSettings({ settings: { ...settings } }); return { ...settings };
    });
  }
  handle('pulse:open-account-window', record => { const window = createAccountWindow({ sourceProfileId: record.profileId }); return { opened: true, profileId: mainRecord(window).profileId }; }, { primary: true });
  handle('pulse:account-startup', record => ({ removed: record.kind === 'main' && record.profile.trayHidden }), { allowLocked: true });
  handle('pulse:list-account-windows', record => [...profiles.values()].filter(profile => profile.groupId === record.groupId).map((profile, index) => {
    const displayName = profile.displayName || profile.account?.displayName || '';
    return { id: profile.id, label: displayName || (profile.main?.readyToLogin ? '未登录账号' : `账号 ${index + 1}`), displayName, avatarUrl: profile.account?.avatarUrl || '', signedIn: Boolean(profile.accountId || profile.account), current: record.profile === profile, returnTarget: record.returnProfileId === profile.id, opened: Boolean(profile.main) };
  }), { primary: true });
  handle('pulse:show-account-window', (record, profileId) => { if (typeof profileId !== 'string' || profiles.get(profileId)?.groupId !== record.groupId) throw Error('账号窗口不存在。'); show(createMainWindow(profileId)); return { opened: true }; }, { primary: true });
  handle('pulse:get-application-settings', () => ({ ...settings }), { allowLocked: true });
  handle('pulse:get-chat-typography', () => ({ ...typography }), { allowLocked: true });
  handle('pulse:set-chat-typography', (_record, value) => {
    const next = chatTypography.normalize(value);
    write(typographyFile, next);
    typography = next;
    for (const record of records.values()) if (!record.webContents.isDestroyed()) record.webContents.send('pulse:chat-typography-changed', { ...typography });
    historyWindows.updateChatTypography(typography);
    return { ...typography };
  }, { primary: true });
  handle('pulse:initialize-application-settings', (record, initial = {}) => queueSettings(async () => {
    if (record.kind !== 'main' || !record.active || settingsInitialized) return { ...settings };
    for (const key of Object.keys(sharedMethods)) {
      if (typeof settings[key] !== 'boolean' && typeof initial?.[key] !== 'boolean') continue;
      const value = typeof settings[key] === 'boolean' ? settings[key] : Boolean(initial[key]);
      await services[sharedMethods[key]]?.(record, value); settings[key] = value;
    }
    write(settingsFile, settings); settingsInitialized = true;
    broadcastSettings({ settings: { ...settings } }); return { ...settings };
  }), { allowLocked: true });
  handle('pulse:set-application-setting', (record, key, enabled) => changeSetting(record, key, enabled), { primary: true });
  handle('pulse:open-conversation-window', (record, value) => {
    const id = Number(value), profile = record.profile;
    if (!profile.accountId || !Number.isSafeInteger(id) || id <= 0) throw Error('请先登录并选择有效会话。');
    const existing = [...records.values()].find(item => item.profile === profile && item.kind === 'conversation' && item.conversationId === id);
    show(existing?.window || create(profile, 'conversation', id).window); return { opened: true, conversationId: id };
  });
  handle('pulse:copy-image', (record, value = {}) => {
    if (!record.profile.accountId || value.accountId !== record.profile.accountId || (record.kind === 'main' && !record.active)) throw Error('当前账号无法复制此图片。');
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.y < 0) throw Error('图片位置无效。');
    const zoom = record.webContents.getZoomFactor(), bounds = record.kind === 'main' ? record.view.getBounds() : record.window.getContentBounds();
    const x = Math.round(value.x * zoom), y = Math.round(value.y * zoom);
    if (x >= bounds.width || y >= bounds.height) throw Error('图片已不在可见区域。');
    record.webContents.copyImageAt(x, y);
    return { copied: true };
  });
  handle('pulse:open-image-window', (record, value) => imageWindows.open(record, value));
  handle('pulse:open-history-window', (record, value) => historyWindows.open(record, value));
  on('pulse:message-recalled', (record, value = {}) => {
    // Only the authenticated app's main frame can relay a recall. Carry IDs,
    // never message bodies or arbitrary packets, and stay within this profile.
    if (!notificationOwnerCurrent(record, value.accountId)
      || !Number.isSafeInteger(value.messageId) || value.messageId <= 0
      || !Number.isSafeInteger(value.conversationId) || value.conversationId <= 0
      || (record.kind === 'conversation' && record.conversationId !== value.conversationId)) return;
    const recall = { accountId: value.accountId, conversationId: value.conversationId, messageId: value.messageId };
    // Block the local protocol immediately, including a download or preview already in progress.
    void Promise.resolve(services.mediaDiskCache?.purge(record.profile, recall.conversationId, [recall.messageId])).catch(() => {});
    historyWindows.recall(record.profile, recall);
    for (const peer of records.values()) if (peer !== record && peer.profile === record.profile && notificationOwnerCurrent(peer, value.accountId)) {
      peer.webContents.send('pulse:message-recalled', recall);
    }
  });
  handle('pulse:close-image-window', (record, value = {}) => { imageWindows.closeOwner(record, String(value.id || '')); return true; }, { allowLocked: true });
  on('pulse:session-state', (record, value = {}) => {
    const profile = record.profile, id = Number(value.accountId) || 0;
    const previousId = profile.accountId, previousLocked = profile.locked;
    if (previousId !== id || Boolean(value.locked) !== previousLocked) services.avatarDiskCache?.invalidate(profile);
    if (previousId !== id || Boolean(value.locked) !== previousLocked) services.mediaDiskCache?.invalidate(profile);
    const previousAccount = JSON.stringify(profile.account);
    const previouslyHidden = profile.trayHidden;
    if (!id || (record.removingAccountId > 0 && record.removingAccountId !== id)) record.removingAccountId = undefined;
    if (id && record.kind === 'main' && profile.trayHidden && record.removingAccountId === undefined) profile.trayHidden = false;
    if (record.kind === 'main' && record.logoutRequestedAccountId !== id) record.logoutRequestedAccountId = 0;
    record.readyToLogin = !id;
    if (record.kind === 'conversation' && id && id !== profile.accountId) { record.window.destroy(); return; }
    if (!id || (record.kind === 'main' && profile.accountId && id !== profile.accountId)) {
      services.cancelAccountRequests?.(profile, previousId);
      cancelImageUploads(item => item.record.profile === profile);
      for (const peer of records.values()) if (peer.profile === profile) services.mediaDiskCache?.releaseConsumer?.(String(peer.webContents.id));
      services.cancelCaptures?.(profile.id); profile.accountId = 0; profile.locked = false; profile.displayName = ''; profile.account = null; profile.notified.clear(); closeChildren(profile);
      // The initiating view does not receive loggedOut, and cancelled transfers
      // finish after their former account can no longer receive progress.
      for (const peer of records.values()) if (peer.profile === profile && !peer.webContents.isDestroyed()) peer.webContents.send('pulse:downloads-changed', []);
      if (!id) broadcast(profile, { loggedOut: true }, record);
    }
    if (id && record.kind === 'main') {
      profile.accountId = id;
      profile.displayName = typeof value.displayName === 'string' ? value.displayName.slice(0, 60) : profile.displayName;
      profile.account = accountSummary({ id, displayName: profile.displayName, avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : profile.account?.avatarUrl });
    }
    if (record.kind === 'main') updateTitle(record);
    if (previousAccount !== JSON.stringify(profile.account) || previouslyHidden !== profile.trayHidden) { try { saveProfiles(); } catch { /* Display metadata is optional; keep the live account session usable. */ } }
    if (id && id === profile.accountId && typeof value.locked === 'boolean' && profile.locked !== value.locked) {
      profile.locked = value.locked; if (profile.locked) { services.cancelAccountRequests?.(profile, profile.accountId); cancelImageUploads(item => item.record.profile === profile); for (const peer of records.values()) if (peer.profile === profile) services.mediaDiskCache?.releaseConsumer?.(String(peer.webContents.id)); services.cancelCaptures?.(profile.id); notificationWindows.closeProfile(profile.id); historyWindows.closeProfile(profile.id); imageWindows.closeProfile(profile.id); } broadcast(profile, { locked: profile.locked });
    }
    if (previousAccount !== JSON.stringify(profile.account) || previousId !== profile.accountId || previousLocked !== profile.locked || previouslyHidden !== profile.trayHidden) changed(record.groupId);
  }, { allowLocked: true });
  on('pulse:window', (record, action) => {
    if (record.kind === 'main' && !record.active) return;
    const window = record.window;
    if (action === 'minimize') window.minimize();
    if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    if (action === 'close') record.kind === 'conversation' ? window.close() : (services.closeMain ? services.closeMain(record) : window.close());
  }, { allowLocked: true });
  on('pulse:zoom', (record, value) => { const factor = Number(value); if (Number.isFinite(factor) && factor >= .5 && factor <= 3) record.webContents.setZoomFactor(factor); }, { allowLocked: true });
  on('pulse:skip-taskbar', (record, value) => { if (record.kind !== 'main' || record.active) record.window.setSkipTaskbar(Boolean(value)); });
  on('pulse:spellcheck', (record, value) => record.profile.session.setSpellCheckerEnabled(Boolean(value)));
  on('pulse:notification', (record, payload = {}) => {
    const profile = record.profile;
    if (record.kind !== 'main' || !profile.accountId) return;
    const conversationId = Number(payload.conversationId), messageId = Number(payload.messageId);
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0 || !Number.isSafeInteger(messageId) || messageId <= 0) return;
    const key = `${profile.accountId}:${conversationId}:${messageId}`;
    if (profile.notified.has(key)) return;
    profile.notified.add(key); if (profile.notified.size > 2000) profile.notified.delete(profile.notified.values().next().value);
    if ([...records.values()].some(item => item.profile === profile && item.kind === 'conversation' && item.conversationId === conversationId && item.window.isFocused())) return;
    const value = { ...payload, accountId: profile.accountId, conversationId, messageId };
    if (payload.native === true && services.notify?.(record, value, () => openNotification(record, { accountId: value.accountId, conversationId, reply: false }))) return;
    notificationWindows.show(record, value);
  });
  on('pulse:notification-dismiss', (record, value) => {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id >= 0) notificationWindows.closeProfile(record.profileId, id);
  });
  const handlers = { 'qr-code': 'qrCode', 'select-directory': 'selectDirectory', 'download-file': 'downloadFile', 'download-list': 'listDownloads', 'download-cancel': 'cancelDownload', 'cancel-proxy-test': 'cancelProxyTest', 'get-proxy-settings': 'getProxySettings', 'set-proxy': 'setProxy', 'test-proxy': 'testProxy', 'clear-cache': 'clearCache', 'check-update': 'checkUpdate', 'open-update': 'openUpdate', 'open-system-sound-settings': 'openSystemSoundSettings' };
  for (const [channel, method] of Object.entries(handlers)) handle(`pulse:${channel}`, (record, ...args) => services[method]?.(record, ...args), { primary: channel === 'set-proxy', allowLocked: channel === 'cancel-proxy-test' });
  for (const [channel, key] of [['auto-update', 'auto_update'], ['send-to-menu', 'send_to_menu']]) handle(`pulse:${channel}`, (record, value) => changeSetting(record, key, Boolean(value)), { primary: true });
  for (const [channel, key] of [['tray', 'tray_icon'], ['auto-launch', 'auto_launch']]) on(`pulse:${channel}`, (record, value) => changeSetting(record, key, Boolean(value)), { primary: true });
  return { createMainWindow, createAccountWindow, createIndependentWindow, showProfileWindow, logoutAccount, removeAccount, exitProfileWindow, activeMain: () => profiles.get(activeProfileId)?.main || null, windows: () => [...records.values()], profiles: () => [...profiles.values()].map(p => ({ id: p.id, groupId: p.groupId, main: p.main?.window || null, accountId: p.accountId, locked: p.locked, trayHidden: p.trayHidden, displayName: p.displayName || p.account?.displayName || '', active: p.id === activeProfileId })), resolveSender,
    publishDownloads(owner, tasks) { for (const record of records.values()) if (record.profileId === owner.profileId && record.profile.accountId === owner.accountId && !record.profile.locked && !record.webContents.isDestroyed()) record.webContents.send('pulse:downloads-changed', tasks); },
    broadcastApplicationSettings: broadcastSettings,
    resolveScreenshotSender: event => { const record = resolveSender(event); return record?.profile.accountId && !record.profile.locked && (record.kind !== 'main' || record.active) ? record : null; },
    destroyAll() { if (destroying) return; flushDisplayPreferences(); destroying = true; for (const item of imageUploads.values()) item.controller.abort(); clearTimeout(profileSaveTimer); clearTimeout(changedTimer); notificationWindows.destroy(); historyWindows.destroy(); imageWindows.destroy(); for (const window of new Set([...records.values()].map(record => record.window))) if (!window.isDestroyed()) window.destroy(); for (const dispose of disposers) dispose(); },
    state: (profileId = 'default') => { const profile = profiles.get(profileId); return profile ? { accountId: profile.accountId, locked: profile.locked } : null; } };
}
module.exports = { createWindowManager };
