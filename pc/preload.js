const { contextBridge, ipcRenderer } = require('electron');

const runtimeArgument = process.argv.find(value => value.startsWith('--pulse-runtime='));
const runtimeConfig = runtimeArgument ? JSON.parse(decodeURIComponent(runtimeArgument.slice('--pulse-runtime='.length))) : { apiBaseUrl: process.env.PULSE_API_URL || 'http://127.0.0.1:8099/index.php', websocketUrl: process.env.PULSE_WS_URL || 'ws://127.0.0.1:8282', appVersion: '2.4.11', production: false };

contextBridge.exposeInMainWorld('pulseDesktop', Object.freeze({
  isDesktop: true,
  persistentAvatars: runtimeConfig.persistentAvatars === true,
  persistentMessages: runtimeConfig.persistentMessages === true,
  persistentMedia: runtimeConfig.persistentMedia === true,
  nativeImageUploads: runtimeConfig.nativeImageUploads === true,
  async uploadImage(value, onProgress) {
    const transferId = value?.transferId;
    const listener = (_event, progress) => { if (progress?.transferId === transferId && typeof onProgress === 'function') onProgress(progress); };
    ipcRenderer.on('pulse:image-upload-progress', listener);
    try { return await ipcRenderer.invoke('pulse:upload-image', value); }
    finally { ipcRenderer.removeListener('pulse:image-upload-progress', listener); }
  },
  cancelImageUpload(transferId) { ipcRenderer.send('pulse:cancel-image-upload', String(transferId)); },
  localMedia(action, conversationId, ids = []) { return ipcRenderer.invoke('pulse:local-media', String(action), Number(conversationId), ids.map(Number)); },
  mediaConsumers(urls) { ipcRenderer.send('pulse:media-consumers', urls); },
  cacheAvatar(value) { return ipcRenderer.invoke('pulse:avatar-cache', 'put', value); },
  dropAvatar(value) { return ipcRenderer.invoke('pulse:avatar-cache', 'drop', value); },
  windowKind: runtimeConfig.windowKind || 'main',
  profileId: runtimeConfig.profileId || 'default',
  conversationId: Number(runtimeConfig.conversationId) || 0,
  rememberedLogins(action, value) { return ipcRenderer.invoke('pulse:remembered-logins', String(action), value); },
  openAccountWindow() { return ipcRenderer.invoke('pulse:open-account-window'); },
  listAccountWindows() { return ipcRenderer.invoke('pulse:list-account-windows'); },
  accountStartup() { return ipcRenderer.invoke('pulse:account-startup'); },
  openLogs() { return ipcRenderer.invoke('pulse:open-logs'); },
  reportDiagnostic(value) {
    if (!value || !['renderer-error', 'unhandled-rejection', 'resource-load-failed', 'renderer-startup-stalled', 'avatar-load-failed', 'avatar-load-recovered'].includes(value.kind)) return;
    if (value.kind.startsWith('avatar-')) {
      ipcRenderer.send('pulse:diagnostic', { kind: value.kind, code: String(value.code || '').slice(0, 48), source: String(value.source || '').slice(0, 4096),
        area: String(value.area || '').slice(0, 48), status: Number(value.status) || 0, attempt: Number(value.attempt) || 0,
        elapsedMs: Number(value.elapsedMs) || 0, online: value.online === true });
      return;
    }
    ipcRenderer.send('pulse:diagnostic', { kind: value.kind, name: String(value.name || '').slice(0, 80), message: String(value.message || '').slice(0, 2048),
      stack: String(value.stack || '').slice(0, 4096), source: String(value.source || '').slice(0, 4096), line: Number(value.line) || 0, column: Number(value.column) || 0 });
  },
  showAccountWindow(profileId) { return ipcRenderer.invoke('pulse:show-account-window', String(profileId)); },
  onAccountVisibilityChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback({ active: value?.active === true });
    ipcRenderer.on('pulse:account-visibility', listener);
    return () => ipcRenderer.removeListener('pulse:account-visibility', listener);
  },
  onAccountWindowsChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('pulse:account-windows-changed', listener);
    return () => ipcRenderer.removeListener('pulse:account-windows-changed', listener);
  },
  getApplicationSettings() { return ipcRenderer.invoke('pulse:get-application-settings'); },
  getChatTypography() { return ipcRenderer.invoke('pulse:get-chat-typography'); },
  setChatTypography(value) { return ipcRenderer.invoke('pulse:set-chat-typography', { size: value?.size, family: value?.family, bold: value?.bold }); },
  onChatTypographyChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pulse:chat-typography-changed', listener);
    return () => ipcRenderer.removeListener('pulse:chat-typography-changed', listener);
  },
  initializeApplicationSettings(settings) { return ipcRenderer.invoke('pulse:initialize-application-settings', settings); },
  setApplicationSetting(key, enabled) { return ipcRenderer.invoke('pulse:set-application-setting', String(key), Boolean(enabled)); },
  onApplicationSettingsChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pulse:application-settings-changed', listener);
    return () => ipcRenderer.removeListener('pulse:application-settings-changed', listener);
  },
  openConversationWindow(id) { return ipcRenderer.invoke('pulse:open-conversation-window', Number(id)); },
  publishVerifiedRoute(value) { return ipcRenderer.invoke('pulse:publish-verified-route', value); },
  onVerifiedRouteChanged(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pulse:verified-route-changed', listener);
    return () => ipcRenderer.removeListener('pulse:verified-route-changed', listener);
  },
  openHistoryWindow(value) { return ipcRenderer.invoke('pulse:open-history-window', { conversationId: Number(value?.conversationId), accountId: Number(value?.accountId), token: String(value?.token || ''), title: String(value?.title || '').slice(0, 120), type: String(value?.type || ''), theme: String(value?.theme || '') }); },
  publishMessageRecall(value) { ipcRenderer.send('pulse:message-recalled', { accountId: Number(value?.accountId), conversationId: Number(value?.conversationId), messageId: Number(value?.messageId) }); },
  onMessageRecalled(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pulse:message-recalled', listener);
    return () => ipcRenderer.removeListener('pulse:message-recalled', listener);
  },
  syncSessionState(value) { ipcRenderer.send('pulse:session-state', { accountId: Number(value?.accountId) || 0, locked: Boolean(value?.locked), displayName: String(value?.displayName || '').slice(0, 60), avatarUrl: String(value?.avatarUrl || '').slice(0, 2048) }); },
  onSessionChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pulse:session-changed', listener);
    return () => ipcRenderer.removeListener('pulse:session-changed', listener);
  },
  onLogoutRequested(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback({ accountId: Number(value?.accountId), removed: value?.removed === true });
    ipcRenderer.on('pulse:logout-request', listener);
    return () => ipcRenderer.removeListener('pulse:logout-request', listener);
  },
  platform: process.platform,
  version: process.versions.electron,
  appName: '小猿口算',
  appVersion: runtimeConfig.appVersion,
  production: runtimeConfig.production,
  localPreview: runtimeConfig.localPreview === true,
  apiBaseUrl: runtimeConfig.apiBaseUrl,
  websocketUrl: runtimeConfig.websocketUrl,
  routePublicKeys: runtimeConfig.routePublicKeys,
  routeClusterId: runtimeConfig.routeClusterId,
  routeDiscoveryUrls: runtimeConfig.routeDiscoveryUrls,
  routeSeeds: runtimeConfig.routeSeeds,
  notify(title, body, metadata = {}) { ipcRenderer.send('pulse:notification', { title, body, conversationId: Number(metadata.conversationId), messageId: Number(metadata.messageId), avatarUrl: String(metadata.avatarUrl || ''), kind: String(metadata.kind || ''), silent: metadata.silent === true, native: metadata.native === true }); },
  dismissNotifications(conversationId = 0) { ipcRenderer.send('pulse:notification-dismiss', Number(conversationId)); },
  onNotificationOpen(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback({ accountId: Number(value?.accountId), conversationId: Number(value?.conversationId), reply: value?.reply === true });
    ipcRenderer.on('pulse:notification-open', listener);
    return () => ipcRenderer.removeListener('pulse:notification-open', listener);
  },
  generateQrCode(value) { return ipcRenderer.invoke('pulse:qr-code', value); },
  setZoomFactor(factor) { ipcRenderer.send('pulse:zoom', Number(factor)); },
  setNightMode(enabled) { ipcRenderer.send('pulse:night-mode', Boolean(enabled)); },
  selectDownloadDirectory() { return ipcRenderer.invoke('pulse:select-directory'); },
  downloadFile(url, fileName, directory) { return ipcRenderer.invoke('pulse:download-file', { url: String(url || ''), fileName: String(fileName || ''), directory: String(directory || '') }); },
  listDownloads() { return ipcRenderer.invoke('pulse:download-list'); },
  cancelDownload(id) { return ipcRenderer.invoke('pulse:download-cancel', String(id || '')); },
  onDownloadsChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pulse:downloads-changed', listener);
    return () => ipcRenderer.removeListener('pulse:downloads-changed', listener);
  },
  copyImage(value) { return ipcRenderer.invoke('pulse:copy-image', { x: Number(value?.x), y: Number(value?.y), accountId: Number(value?.accountId) }); },
  openImageWindow(value) { return ipcRenderer.invoke('pulse:open-image-window', { id: String(value?.id || ''), url: String(value?.url || ''), name: String(value?.name || ''), accountId: Number(value?.accountId), conversationId: Number(value?.conversationId), messageId: Number(value?.messageId) }); },
  closeImageWindow(value) { return ipcRenderer.invoke('pulse:close-image-window', { id: String(value?.id || '') }); },
  onImageWindowClosed(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pulse:image-window-closed', listener);
    return () => ipcRenderer.removeListener('pulse:image-window-closed', listener);
  },
  captureScreenshot() { return ipcRenderer.invoke('pulse:screenshot'); },
  cancelScreenshot() { ipcRenderer.send('pulse:screenshot-cancel'); },
  getProxySettings() { return ipcRenderer.invoke('pulse:get-proxy-settings'); },
  setProxy(settings) { return ipcRenderer.invoke('pulse:set-proxy', settings); },
  testProxy() { return ipcRenderer.invoke('pulse:test-proxy'); },
  cancelProxyTest() { return ipcRenderer.invoke('pulse:cancel-proxy-test'); },
  clearCache() { return ipcRenderer.invoke('pulse:clear-cache'); },
  checkForUpdate() { return ipcRenderer.invoke('pulse:check-update'); },
  setAutoUpdate(enabled) { return ipcRenderer.invoke('pulse:auto-update', Boolean(enabled)); },
  onUpdateAvailable(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('pulse:update-available', listener);
    return () => ipcRenderer.removeListener('pulse:update-available', listener);
  },
  openUpdate(url) { return ipcRenderer.invoke('pulse:open-update', String(url || '')); },
  setTrayVisible(visible) { ipcRenderer.send('pulse:tray', Boolean(visible)); },
  setSkipTaskbar(skip) { ipcRenderer.send('pulse:skip-taskbar', Boolean(skip)); },
  setAutoLaunch(enabled) { ipcRenderer.send('pulse:auto-launch', Boolean(enabled)); },
  setSpellcheck(enabled) { ipcRenderer.send('pulse:spellcheck', Boolean(enabled)); },
  setSendToMenu(enabled) { return ipcRenderer.invoke('pulse:send-to-menu', Boolean(enabled)); },
  openSystemSoundSettings() { return ipcRenderer.invoke('pulse:open-system-sound-settings'); },
  minimize() { ipcRenderer.send('pulse:window', 'minimize'); },
  maximize() { ipcRenderer.send('pulse:window', 'maximize'); },
  close() { ipcRenderer.send('pulse:window', 'close'); },
}));
