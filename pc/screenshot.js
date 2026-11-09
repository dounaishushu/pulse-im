const path = require('node:path');

function cropScreenshot(image, selection) {
  const { x, y, width, height } = selection || {};
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) throw Error('截图范围无效，请重新选择。');
  const size = image.getSize();
  const left = Math.floor(x * size.width), top = Math.floor(y * size.height);
  const right = Math.min(size.width, Math.ceil((x + width) * size.width));
  const bottom = Math.min(size.height, Math.ceil((y + height) * size.height));
  if (right - left < 2 || bottom - top < 2) throw Error('截图范围太小，请重新选择。');
  const cropped = image.crop({ x: left, y: top, width: right - left, height: bottom - top });
  if (cropped.toPNG().length > 10 * 1024 * 1024) throw Error('截图超过10MB，请缩小截图范围。');
  return { dataUrl: cropped.toDataURL(), width: right - left, height: bottom - top };
}

function registerScreenshot(electron, getMainWindow) {
  const { BrowserWindow, desktopCapturer, screen, ipcMain } = electron;
  let job = null;
  const trustedMain = event => {
    const target = getMainWindow(event), owner = target?.window || target, contents = target?.webContents || owner?.webContents;
    return owner && !owner.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame;
  };
  const trustedOverlay = event => job?.overlay && event.sender === job.overlay.webContents && event.senderFrame === job.overlay.webContents.mainFrame;
  function finish(current, result = null) {
    if (job !== current) return;
    job = null;
    clearTimeout(current.timeout);
    current.owner.removeListener('closed', current.onOwnerClosed);
    if (current.overlay && !current.overlay.isDestroyed()) current.overlay.destroy();
    if (current.wasVisible && !current.owner.isDestroyed()) { current.owner.show(); current.owner.focus(); }
    current.resolve(result);
  }
  ipcMain.handle('pulse:screenshot-image', event => {
    if (!trustedOverlay(event) || !job.image) throw Error('截图会话已关闭。');
    return { dataUrl: job.image.toDataURL() };
  });
  ipcMain.handle('pulse:screenshot-selection', (event, selection) => {
    if (!trustedOverlay(event)) return { error: '截图会话已关闭。' };
    try { const result = cropScreenshot(job.image, selection), current = job; setImmediate(() => finish(current, result)); return { ok: true }; }
    catch (error) { return { error: error.message }; }
  });
  ipcMain.on('pulse:screenshot-cancel', event => { if (job && (event.sender === job.contents && trustedMain(event) || trustedOverlay(event))) finish(job); });
  ipcMain.handle('pulse:screenshot', async event => {
    if (!trustedMain(event)) return { error: '不允许从此页面截图。' };
    if (job) return { error: '正在截图，请先完成或取消。' };
    const target = getMainWindow(event), owner = target?.window || target;
    const result = new Promise(resolve => {
      const current = { owner, contents: event.sender, wasVisible: owner.isVisible(), overlay: null, image: null, resolve };
      job = current;
      current.onOwnerClosed = () => finish(current);
      owner.once('closed', current.onOwnerClosed);
      current.timeout = setTimeout(() => finish(current), 300000);
    });
    const current = job;
    try {
      const display = screen.getDisplayMatching(owner.getBounds());
      if (current.wasVisible) owner.hide();
      // 等待系统完成隐藏动画，避免把本程序拍进待截图内容。
      await new Promise(resolve => setTimeout(resolve, 180));
      if (job !== current) return result;
      const pixelWidth = Math.round(display.bounds.width * display.scaleFactor), pixelHeight = Math.round(display.bounds.height * display.scaleFactor);
      if (pixelWidth <= 0 || pixelHeight <= 0 || pixelWidth * pixelHeight > 80000000) throw Error('屏幕分辨率过大，无法截图。');
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: pixelWidth, height: pixelHeight }, fetchWindowIcons: false });
      if (job !== current) return result;
      const source = sources.find(item => item.display_id === String(display.id)) || (sources.length === 1 ? sources[0] : null);
      if (!source || source.thumbnail.isEmpty()) throw Error('无法读取屏幕，请检查系统的屏幕录制权限。');
      current.image = source.thumbnail;
      const overlay = new BrowserWindow({ ...display.bounds, frame: false, show: false, alwaysOnTop: true, skipTaskbar: true,
        resizable: false, movable: false, enableLargerThanScreen: true, backgroundColor: '#111111',
        webPreferences: { preload: path.join(__dirname, 'screenshot-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      current.overlay = overlay;
      overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      overlay.webContents.on('will-navigate', navigation => navigation.preventDefault());
      overlay.on('closed', () => finish(current));
      await overlay.loadFile(path.join(__dirname, 'web', 'screenshot.html'));
      if (job === current) { overlay.setBounds(display.bounds); overlay.show(); overlay.focus(); }
    } catch (error) { finish(current, { error: /[\u4e00-\u9fff]/.test(error.message || '') ? error.message : '截图失败，请检查系统屏幕录制权限后重试。' }); }
    return result;
  });
  return { cancel: owners => { if (job && (!owners || owners.includes(job.owner) || owners.includes(job.contents))) finish(job); } };
}

module.exports = { cropScreenshot, registerScreenshot };
