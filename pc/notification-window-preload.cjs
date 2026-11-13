const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pulseNotification', Object.freeze({
  onContent(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pulse:notification-content', listener);
    ipcRenderer.send('pulse:notification-ready');
    return () => ipcRenderer.removeListener('pulse:notification-content', listener);
  },
  act(action) { if (['open', 'reply', 'close', 'hover', 'leave'].includes(action)) ipcRenderer.send('pulse:notification-action', action); },
}));
