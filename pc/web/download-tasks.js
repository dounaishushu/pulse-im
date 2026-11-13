(function () {
  const bridge = window.pulseDesktop;
  if (!bridge?.listDownloads || !bridge?.cancelDownload) return;
  let rows = [], panel = null, visible = true, locked = false, stopped = false, revision = 0;
  const size = value => value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : Math.ceil(value / 1024) + ' KB';
  function render() {
    if (stopped) return;
    if (!rows.length || !visible || locked) { panel?.remove(); panel = null; return; }
    if (!panel?.isConnected) {
      panel = document.createElement('details'); panel.id = 'pulse-download-tasks'; panel.open = true;
      panel.setAttribute('aria-label', '文件下载任务'); document.body.append(panel);
    }
    const open = panel.open; panel.replaceChildren(); panel.open = open;
    const title = document.createElement('summary'); title.textContent = `文件下载（${rows.length}）`; panel.append(title);
    const list = document.createElement('ul'); panel.append(list);
    for (const item of rows) {
      const row = document.createElement('li'), copy = document.createElement('span'), name = document.createElement('strong'), status = document.createElement('small'), button = document.createElement('button');
      name.textContent = item.name; name.title = item.name;
      status.textContent = item.status === 'queued' ? '等待下载' : item.status === 'cancelling' ? '正在取消…' : `下载中 ${size(item.received)}${item.total ? ' / ' + size(item.total) : ''}`;
      button.type = 'button'; button.textContent = '取消'; button.disabled = item.status === 'cancelling'; button.setAttribute('aria-label', '取消下载 ' + item.name);
      button.onclick = async () => { button.disabled = true; try { await bridge.cancelDownload(item.id); } catch {} finally { void refresh(); } };
      copy.append(name, status); row.append(copy, button); list.append(row);
    }
  }
  async function refresh() { const ticket = ++revision; try { const value = await bridge.listDownloads(); if (!stopped && ticket === revision) { rows = Array.isArray(value) ? value : []; render(); } } catch { if (ticket === revision) { rows = []; render(); } } }
  const disposers = [bridge.onDownloadsChanged?.(value => { revision++; rows = Array.isArray(value) ? value : []; render(); }),
    bridge.onAccountVisibilityChanged?.(value => { visible = value.active !== false; render(); if (visible) void refresh(); }),
    bridge.onSessionChanged?.(value => { if (value?.loggedOut) { revision++; rows = []; } if (typeof value?.locked === 'boolean') locked = value.locked; render(); if (!locked && !value?.loggedOut) void refresh(); })];
  const observer = new MutationObserver(() => { if (rows.length && visible && !locked && !panel?.isConnected) render(); });
  observer.observe(document.body, { childList: true });
  window.addEventListener('pagehide', () => { stopped = true; revision++; observer.disconnect(); disposers.forEach(dispose => dispose?.()); panel?.remove(); rows = []; }, { once: true });
  window.PulseDownloads = { refresh }; void refresh();
})();
