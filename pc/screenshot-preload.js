const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pulseScreenshot', Object.freeze({
  image: () => ipcRenderer.invoke('pulse:screenshot-image'),
  complete: selection => ipcRenderer.invoke('pulse:screenshot-selection', selection),
  cancel: () => ipcRenderer.send('pulse:screenshot-cancel'),
}));
