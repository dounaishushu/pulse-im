const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pulseTray', Object.freeze({
  onContent(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pulse:tray-content', listener);
    ipcRenderer.send('pulse:tray-ready');
    return () => ipcRenderer.removeListener('pulse:tray-content', listener);
  },
  act(action, key = '') {
    if (['open', 'logout', 'remove-account', 'close-window', 'new', 'logs', 'quit', 'dismiss'].includes(action))
      ipcRenderer.send('pulse:tray-action', { action, key: String(key) });
  },
}));
