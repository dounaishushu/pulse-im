// Browser capabilities for the shared PC interface. This does not change device identity.
(() => {
  let capture = null;
  function cancelScreenshot() {
    if (!capture) return;
    capture.cancelled = true;
    capture.stream?.getTracks().forEach(track => track.stop());
  }
  async function captureScreenshot() {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('当前浏览器不支持屏幕截图，可使用图片按钮上传图片。');
    cancelScreenshot();
    const session = { cancelled: false, stream: null };
    capture = session;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    try {
      session.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (session.cancelled) return null;
      video.srcObject = session.stream;
      await video.play();
      if (session.cancelled) return null;
      if (!video.videoWidth || !video.videoHeight) throw new Error('截图画面未就绪，请重新选择窗口。');
      const scale = Math.min(1, 4096 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return { dataUrl: canvas.toDataURL('image/png') };
    } catch (error) {
      if (session.cancelled || error.name === 'NotAllowedError' || error.name === 'AbortError') return null;
      throw error;
    } finally {
      session.stream?.getTracks().forEach(track => track.stop());
      video.pause();
      video.srcObject = null;
      if (capture === session) capture = null;
    }
  }
  async function generateQrCode(value) {
    if (!window.PulseQrCode) throw new Error('二维码组件未加载，请刷新页面重试。');
    return window.PulseQrCode.toDataURL(String(value), { width: 280, margin: 2, errorCorrectionLevel: 'M' });
  }
  window.PulseBrowser = Object.freeze({ captureScreenshot, cancelScreenshot, generateQrCode });

  const nativeSettings = new Set(['tray_icon', 'taskbar_icon', 'auto_launch', 'send_to_menu', 'auto_update', 'download_ask']);
  function syncUi() {
    if (window.pulseDesktop?.isDesktop) return;
    const head = document.querySelector('#chat-head');
    if (head && !document.getElementById('web-back-to-list')) {
      const button = document.createElement('button');
      button.id = 'web-back-to-list';
      button.type = 'button';
      button.setAttribute('aria-label', '返回会话列表');
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m14 5-7 7 7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      button.onclick = () => {
        cancelScreenshot();
        if (typeof closeChatPanels === 'function') closeChatPanels();
        if (typeof resetComposerForNavigation === 'function') resetComposerForNavigation();
        document.body.classList.remove('web-conversation-open');
        document.querySelector('.conversation.active')?.focus();
      };
      head.prepend(button);
    }
    const search = document.querySelector('#chat-search-panel');
    document.body.classList.toggle('web-search-open', Boolean(search && !search.hidden));
    const toolbar = document.querySelector('.session-toolbar');
    if (toolbar && !document.getElementById('web-back-to-chat')) {
      const button = document.createElement('button');
      button.id = 'web-back-to-chat';
      button.type = 'button';
      button.setAttribute('aria-label', '返回聊天');
      button.textContent = '返回';
      button.onclick = () => { if (typeof closeChatSearch === 'function') closeChatSearch(); };
      toolbar.prepend(button);
    }
    for (const input of document.querySelectorAll('input[data-setting-toggle]')) {
      if (!nativeSettings.has(input.dataset.settingToggle) || input.dataset.browserAdapted) continue;
      input.dataset.browserAdapted = 'true';
      input.disabled = true;
      const note = input.dataset.settingToggle === 'download_ask' ? '由浏览器下载设置管理' : '适用于电脑安装版';
      input.title = note;
      const row = input.closest('label');
      row?.classList.add('web-native-setting');
      const text = row?.querySelector('span');
      if (text) { const hint = document.createElement('small'); hint.className = 'web-browser-note'; hint.textContent = note; text.append(hint); }
    }
    const spelling = localStorage.getItem('pulse_setting_spellcheck') !== '0';
    for (const input of document.querySelectorAll('textarea, input:not([type]), input[type="text"]')) {
      if (input.id !== 'captcha-code') input.spellcheck = spelling;
    }
    const directory = document.getElementById('download-directory-value');
    if (directory && directory.textContent !== '浏览器默认下载位置') directory.textContent = '浏览器默认下载位置';
  }
  document.addEventListener('click', async event => {
    if (window.pulseDesktop?.isDesktop || !(event.target instanceof Element)) return;
    const actionNode = event.target.closest('[data-advanced-action],#media-open-system-sound');
    if (!actionNode) return;
    const action = actionNode.dataset.advancedAction || 'system-sound';
    if (!['download-directory', 'proxy', 'check-update', 'system-sound'].includes(action)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (action === 'check-update') {
      actionNode.disabled = true;
      try {
        if (await enforceClientUpdate()) alert('网页版本检查完成。刷新页面可加载已发布的最新页面。');
      } catch (error) { alert(error.message || '版本检查失败，请稍后重试。'); }
      finally { if (actionNode.isConnected) actionNode.disabled = false; }
    } else {
      alert(action === 'proxy' ? '网页使用浏览器或系统的网络设置，请在对应设置中配置代理。'
        : action === 'system-sound' ? '请在设备的系统设置或浏览器网站权限中调整声音。'
        : '下载位置由浏览器的下载设置管理。');
    }
  }, true);
  document.addEventListener('change', event => {
    if (event.target instanceof Element && event.target.matches('[data-setting-toggle="spellcheck"]')) {
      queueMicrotask(syncUi);
    }
  });
  let pending = false;
  const observer = new MutationObserver(records => {
    if (pending || !records.some(record => record.type === 'childList' || record.target.id === 'chat-search-panel')) return;
    pending = true;
    queueMicrotask(() => { pending = false; syncUi(); });
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('pagehide', cancelScreenshot);
  syncUi();
})();
