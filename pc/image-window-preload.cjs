const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pulseImageWindow', Object.freeze({
  content() { return ipcRenderer.invoke('pulse:image-window:content'); },
  close() { return ipcRenderer.invoke('pulse:image-window:close'); },
  mediaConsumers(urls) { return ipcRenderer.invoke('pulse:image-window:media-consumers', urls); },
  copy(value) { return ipcRenderer.invoke('pulse:image-window:copy', { id: String(value?.id || ''), x: Number(value?.x), y: Number(value?.y) }); },
  onImage(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pulse:image-window:show', listener);
    return () => ipcRenderer.removeListener('pulse:image-window:show', listener);
  },
}));
