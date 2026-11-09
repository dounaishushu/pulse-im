// 将网页主题同步到 Windows 标题栏和系统原生表单控件，不改变用户媒体内容。
function registerAppearance({ ipcMain, nativeTheme }, getWindow) {
  const listener = (event, enabled) => {
    const target = getWindow(event), window = target?.window || target, contents = target?.webContents || window?.webContents;
    if (!window || window.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame || typeof enabled !== 'boolean') return;
    if (target?.window) { target.nightMode = enabled; if (!target.active) return; }
    nativeTheme.themeSource = enabled ? 'dark' : 'light';
    window.setBackgroundColor(enabled ? '#172126' : '#f4f7f8');
  };
  ipcMain.on('pulse:night-mode', listener);
  return () => ipcMain.removeListener('pulse:night-mode', listener);
}

module.exports = { registerAppearance };
