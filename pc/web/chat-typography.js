(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PulseChatTypography = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const defaults = Object.freeze({ size: 14, family: 'yahei', bold: false });
  const fonts = Object.freeze([
    Object.freeze({ id: 'yahei', label: '微软雅黑', css: '"Microsoft YaHei", "Microsoft YaHei UI", "Segoe UI", sans-serif' }),
    Object.freeze({ id: 'song', label: '宋体', css: 'SimSun, "Songti SC", serif' }),
    Object.freeze({ id: 'hei', label: '黑体', css: 'SimHei, "Heiti SC", sans-serif' }),
    Object.freeze({ id: 'kai', label: '楷体', css: 'KaiTi, STKaiti, serif' }),
    Object.freeze({ id: 'system', label: '系统默认', css: 'system-ui, "Segoe UI", "Microsoft YaHei UI", sans-serif' }),
  ]);
  function normalize(value) {
    const source = value && typeof value === 'object' ? value : {};
    const size = typeof source.size === 'number' ? source.size : Number.NaN;
    return { size: Number.isFinite(size) ? Math.min(28, Math.max(12, Math.round(size))) : defaults.size,
      family: fonts.some(font => font.id === source.family) ? source.family : defaults.family,
      bold: source.bold === true };
  }
  function apply(value, element) {
    const next = normalize(value), font = fonts.find(item => item.id === next.family);
    element?.style.setProperty('--pc-chat-font-size', next.size + 'px');
    element?.style.setProperty('--pc-chat-line-height', Math.round(next.size * 22 / 14) + 'px');
    element?.style.setProperty('--pc-chat-font-family', font.css);
    element?.style.setProperty('--pc-chat-font-weight', next.bold ? '700' : '400');
    return next;
  }
  function controlsHtml() {
    return `<section class="classic-detail-section chat-font-settings" aria-label="聊天字体">
      <h3>聊天字体</h3>
      <div class="chat-font-row"><label for="chat-font-size">字号</label><div class="chat-font-size-value"><input id="chat-font-size" type="number" min="12" max="28" step="1" value="14" aria-label="聊天字号"><span>px</span></div></div>
      <input id="chat-font-size-range" class="chat-font-size-range" type="range" min="12" max="28" step="1" value="14" aria-label="调整聊天字号">
      <div class="chat-font-limits" aria-hidden="true"><span>12</span><span>28</span></div>
      <div class="chat-font-row"><label for="chat-font-family">字体</label><select id="chat-font-family">${fonts.map(font => `<option value="${font.id}">${font.label}</option>`).join('')}</select></div>
      <label class="chat-font-row chat-font-bold" for="chat-font-bold"><span>加粗</span><input id="chat-font-bold" type="checkbox" role="switch"><span class="chat-font-switch" aria-hidden="true"></span></label>
      <div class="chat-font-preview" aria-label="字体效果预览"><span>效果预览</span><p>你好，消息已经收到。<br>Hello，字体效果 123。</p></div>
      <div class="chat-font-footer"><span class="chat-font-status" role="status" aria-live="polite"></span><button id="chat-font-reset" type="button">恢复默认</button></div>
      <p class="chat-font-hint">自动保存到本机，聊天正文、输入框和聊天记录同步调整。</p>
    </section>`;
  }
  function createController({ desktop = {}, element = document.documentElement } = {}) {
    let value = apply(defaults, element), revision = 0, pending = 0, initialized = false, status = '正在读取…';
    const listeners = new Set();
    const native = typeof desktop.getChatTypography === 'function' && typeof desktop.setChatTypography === 'function';
    const readLocal = () => { try { return JSON.parse(localStorage.getItem('pulse_chat_typography') || 'null'); } catch { return null; } };
    function notify() { for (const listener of [...listeners]) listener(); }
    function show(next) {
      value = apply(next, element);
      element.ownerDocument?.defaultView?.dispatchEvent(new Event('pulse-chat-typography-changed'));
      notify();
    }
    desktop.onChatTypographyChanged?.(next => { if (!pending) { status = '已保存'; show(next); } });
    const ready = Promise.resolve().then(() => native ? desktop.getChatTypography() : readLocal()).then(next => {
      if (!revision) show(next);
      status = '';
    }).catch(() => { status = '读取失败，请重新打开客户端'; }).finally(() => { initialized = true; notify(); });
    let queue = ready;
    function set(patch) {
      const next = normalize({ ...value, ...patch }), edit = ++revision;
      pending++; status = '正在保存…'; show(next);
      queue = queue.then(async () => {
        try {
          let saved;
          if (native) saved = await desktop.setChatTypography(next);
          else { localStorage.setItem('pulse_chat_typography', JSON.stringify(next)); saved = next; }
          if (edit === revision) { status = '已保存'; show(saved); }
        } catch {
          if (edit === revision) {
            status = '保存失败，请重新调整';
            try { show(native ? await desktop.getChatTypography() : readLocal()); } catch { notify(); }
          }
        } finally { pending--; notify(); }
        return { ...value };
      });
      return queue;
    }
    function bind(panel) {
      notify();
      const scope = panel.querySelector('.chat-font-settings');
      if (!scope) return;
      const find = id => scope.querySelector('#chat-font-' + id);
      const size = find('size'), range = find('size-range'), family = find('family'), bold = find('bold'), reset = find('reset');
      const update = () => {
        if (!scope.isConnected) { listeners.delete(update); return; }
        size.value = range.value = String(value.size); family.value = value.family; bold.checked = value.bold;
        for (const control of [size, range, family, bold, reset]) control.disabled = !initialized;
        scope.querySelector('.chat-font-status').textContent = status;
      };
      size.onchange = () => { void set({ size: size.value === '' ? value.size : Number(size.value) }); };
      range.oninput = () => { void set({ size: Number(range.value) }); };
      family.onchange = () => { void set({ family: family.value }); };
      bold.onchange = () => { void set({ bold: bold.checked }); };
      reset.onclick = () => { void set(defaults); };
      listeners.add(update); update();
    }
    return { ready, bind, set, get: () => ({ ...value }), whenSaved: () => queue };
  }
  return Object.freeze({ defaults, fonts, normalize, apply, controlsHtml, createController });
});
