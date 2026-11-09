const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pulseHistoryWindow', Object.freeze({
  context: () => ipcRenderer.invoke('pulse:history-window:context'),
  mediaConsumers: urls => ipcRenderer.invoke('pulse:history-window:media-consumers', urls),
  onMessageRecalled(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pulse:history-window:message-recalled', listener);
    return () => ipcRenderer.removeListener('pulse:history-window:message-recalled', listener);
  },
  onChatTypographyChanged(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pulse:history-window:chat-typography', listener);
    return () => ipcRenderer.removeListener('pulse:history-window:chat-typography', listener);
  },
  page: beforeId => ipcRenderer.invoke('pulse:history-window:page', beforeId),
  copyText: id => ipcRenderer.invoke('pulse:history-window:copy-text', id),
  copyImage: value => ipcRenderer.invoke('pulse:history-window:copy-image', { id: value?.id, x: value?.x, y: value?.y }),
  openImage: id => ipcRenderer.invoke('pulse:history-window:image', id),
  download: id => ipcRenderer.invoke('pulse:history-window:download', id),
  close: () => ipcRenderer.invoke('pulse:history-window:close'),
}));
