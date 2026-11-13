/* Shared image controls for the web overlay and the sandboxed desktop image window. */
(() => {
  'use strict';
  function create({ context, copyImage, canCopyImage = () => false, openWindow, closeWindow, onWindowClosed, listen = true, onClose }) {
    let current = null, detached = null;
    const scope = () => { try { const value = context(); return value?.allowed ? String(value.key) : ''; } catch { return ''; } };
    function close(restoreFocus = true) {
      if (detached) { const view = detached; detached = null; view.observer.disconnect(); Promise.resolve(closeWindow?.({ id: view.id })).catch(() => {}); }
      const view = current; if (!view) return;
      current = null; clearTimeout(view.copyTimer); view.observer.disconnect(); view.image.onload = view.image.onerror = null;
      view.image.removeAttribute('src'); view.modal.remove();
      if (restoreFocus && scope() === view.scope && view.origin.isConnected) view.origin.focus({ preventScroll: true });
    }
    function valid(view) {
      if (current !== view) return false;
      if (scope() !== view.scope || !view.origin.isConnected) { close(false); return false; }
      return true;
    }
    function safeUrl(raw) {
      try {
        const url = new URL(raw, document.baseURI);
        if (url.protocol === 'pulse-media:') {
          const cached = window.PulseMediaSources?.parseDisplay(url.href);
          return cached && cached.account === Number(context()?.accountId) ? url.href : '';
        }
        if (['https:', 'http:', 'blob:'].includes(url.protocol) || /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(url.href)) return url.href;
      } catch { /* Invalid media never falls through to external navigation. */ }
      return '';
    }
    function fitScale(view) { return Math.min(1, Math.max(1, view.stage.clientWidth - 32) / view.image.naturalWidth, Math.max(1, view.stage.clientHeight - 32) / view.image.naturalHeight); }
    function paint(view) {
      if (!valid(view) || !view.ready) return;
      const width = view.image.naturalWidth * view.scale, height = view.image.naturalHeight * view.scale;
      const limitX = Math.max(0, (width - view.stage.clientWidth) / 2), limitY = Math.max(0, (height - view.stage.clientHeight) / 2);
      view.x = Math.max(-limitX, Math.min(limitX, view.x)); view.y = Math.max(-limitY, Math.min(limitY, view.y));
      view.image.style.width = width + 'px'; view.image.style.height = height + 'px';
      view.image.style.transform = `translate(-50%, -50%) translate(${view.x}px, ${view.y}px)`;
      view.percent.textContent = (view.scale * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '%';
      view.stage.classList.toggle('is-pannable', limitX > 0 || limitY > 0);
      view.minus.disabled = view.scale <= Math.min(.05, fitScale(view)) + .00001; view.plus.disabled = view.scale >= 8;
      view.fit.setAttribute('aria-pressed', String(view.fitting));
    }
    function fit(view) { if (!valid(view) || !view.ready) return; view.fitting = true; view.scale = fitScale(view); view.x = view.y = 0; paint(view); }
    function zoom(view, value, point = null) {
      if (!valid(view) || !view.ready) return;
      const scale = Math.max(Math.min(.05, fitScale(view)), Math.min(8, value));
      if (point) { view.x = point.x - (point.x - view.x) * scale / view.scale; view.y = point.y - (point.y - view.y) * scale / view.scale; }
      view.fitting = false; view.scale = scale; paint(view);
    }
    function load(view) {
      if (!valid(view)) return;
      view.ready = false; view.image.hidden = true; view.status.hidden = false; view.status.textContent = '正在加载图片…'; view.retry.hidden = true;
      for (const button of view.tools) button.disabled = true;
      view.image.onload = () => {
        if (!valid(view)) return;
        if (!view.image.naturalWidth || !view.image.naturalHeight) { view.image.onerror(); return; }
        view.ready = true; view.image.hidden = false; view.status.hidden = true;
        view.dimensions.textContent = view.image.naturalWidth + ' × ' + view.image.naturalHeight;
        for (const button of view.tools) button.disabled = false;
        fit(view);
      };
      view.image.onerror = () => { if (!valid(view)) return; view.ready = false; view.image.hidden = true; view.status.hidden = false; view.status.textContent = '图片加载失败，请重试'; view.retry.hidden = false; };
      view.image.src = view.url;
    }
    async function copy(view) {
      if (!valid(view) || !view.ready || view.copying || !canCopyImage()) return;
      clearTimeout(view.copyTimer); view.copying = true; view.copy.disabled = true; view.copy.textContent = '正在复制…';
      try {
        const copied = await copyImage(view.image, () => valid(view));
        if (valid(view)) view.copy.textContent = copied ? '已复制' : '复制图片';
      } catch (error) { if (valid(view)) { view.copy.textContent = '复制失败'; view.copy.title = error.message || '请重试'; } }
      finally {
        if (valid(view)) {
          view.copying = false; view.copy.disabled = !view.ready;
          view.copyTimer = setTimeout(() => { if (valid(view)) { view.copy.textContent = '复制图片'; view.copy.title = '复制图片（Ctrl+C）'; } }, 1800);
        }
      }
    }
    function open(origin, image) {
      const key = scope(); if (!key) return;
      const url = safeUrl(image.currentSrc || image.getAttribute('src') || origin.getAttribute('href')); if (!url) return;
      const cached = window.PulseMediaSources?.parseDisplay(url);
      if (cached) {
        const row = origin.closest('[data-message-id]'), owner = context();
        const conversationId = Number(row?.dataset.conversationId || owner?.conversationId);
        const messageId = Number(row?.dataset.messageId || owner?.messageId);
        if (conversationId !== cached.conversation || messageId !== cached.message) return;
      }
      if (typeof openWindow === 'function') {
        detached?.observer.disconnect();
        const view = { id: 'image-' + crypto.randomUUID(), origin, scope: key };
        view.observer = new MutationObserver(() => { if (detached === view && (scope() !== view.scope || !origin.isConnected)) close(false); });
        detached = view; view.observer.observe(document.body, { childList: true, subtree: true });
        (async () => {
          let source = url;
          if (url.startsWith('blob:')) {
            const blob = await (await fetch(url)).blob();
            if (!blob.type.startsWith('image/') || blob.size > 64 * 1024 * 1024) throw Error('图片无法读取或超过预览大小限制');
            source = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
          }
          if (detached !== view || scope() !== key || !origin.isConnected) return;
          await openWindow({ id: view.id, url: source, name: image.alt || '图片预览', accountId: context()?.accountId,
            ...(cached ? { conversationId: cached.conversation, messageId: cached.message } : {}) });
          if (detached !== view || scope() !== key) await closeWindow?.({ id: view.id });
        })().catch(error => { if (detached === view) { close(false); console.warn('图片窗口打开失败：', error.message); } });
        return;
      }
      close(false);
      const modal = document.createElement('section'); modal.className = 'pc-image-viewer';
      modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', '图片预览');
      modal.innerHTML = '<header class="pc-image-viewer-header"><div><strong data-viewer-name></strong><small data-viewer-dimensions></small></div><button type="button" data-viewer-close aria-label="关闭图片预览" title="关闭（Esc）">×</button></header><div class="pc-image-viewer-stage"><img class="pc-image-viewer-image" alt="" draggable="false" hidden><div class="pc-image-viewer-feedback"><p role="status" aria-live="polite">正在加载图片…</p><button type="button" data-viewer-retry hidden>重新加载</button></div></div><footer class="pc-image-viewer-toolbar" aria-label="图片缩放"><button type="button" data-viewer-minus aria-label="缩小图片" title="缩小">−</button><output data-viewer-percent>100%</output><button type="button" data-viewer-plus aria-label="放大图片" title="放大">＋</button><span aria-hidden="true"></span><button type="button" data-viewer-actual>原始大小</button><button type="button" data-viewer-fit aria-pressed="true">适应窗口</button></footer>';
      const toolbar = modal.querySelector('footer');
      toolbar.insertAdjacentHTML('beforeend', '<button type="button" data-viewer-copy title="复制图片（Ctrl+C）">复制图片</button>');
      const get = name => modal.querySelector('[data-viewer-' + name + ']');
      const view = { modal, origin, url, scope: key, image: modal.querySelector('img'), stage: modal.querySelector('.pc-image-viewer-stage'), status: modal.querySelector('[role="status"]'), retry: get('retry'), dimensions: get('dimensions'), percent: get('percent'), minus: get('minus'), plus: get('plus'), fit: get('fit'), tools: [...modal.querySelectorAll('footer button')], ready: false, fitting: true, scale: 1, x: 0, y: 0, drag: null };
      current = view; get('name').textContent = image.alt || '图片预览'; view.image.alt = image.alt || '图片';
      view.copy = get('copy'); view.copy.hidden = !canCopyImage(); view.copy.onclick = () => { void copy(view); };
      view.observer = new MutationObserver(() => { valid(view); });
      document.body.append(modal); view.observer.observe(document.body, { childList: true, subtree: true });
      get('close').onclick = () => { close(); onClose?.(); }; view.retry.onclick = () => load(view);
      view.minus.onclick = () => zoom(view, view.scale / 1.25); view.plus.onclick = () => zoom(view, view.scale * 1.25);
      get('actual').onclick = () => { view.x = view.y = 0; zoom(view, 1); }; view.fit.onclick = () => fit(view);
      view.stage.addEventListener('wheel', event => { event.preventDefault(); if (!view.ready) return; const rect = view.stage.getBoundingClientRect(); zoom(view, view.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }); }, { passive: false });
      view.image.ondblclick = () => { if (view.fitting && view.scale !== 1) zoom(view, 1); else fit(view); };
      view.stage.onpointerdown = event => {
        if (event.button !== 0 || !view.ready || !view.stage.classList.contains('is-pannable') || event.target.closest('button')) return;
        event.preventDefault(); view.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: view.x, startY: view.y };
        view.stage.setPointerCapture(event.pointerId); view.stage.classList.add('is-dragging');
      };
      view.stage.onpointermove = event => { if (!view.drag || event.pointerId !== view.drag.id) return; view.x = view.drag.startX + event.clientX - view.drag.x; view.y = view.drag.startY + event.clientY - view.drag.y; paint(view); };
      const endDrag = () => { view.drag = null; view.stage.classList.remove('is-dragging'); };
      view.stage.onpointerup = view.stage.onpointercancel = view.stage.onlostpointercapture = endDrag;
      load(view); get('close').focus({ preventScroll: true });
    }
    if (listen) document.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const candidate = target?.closest('.classic-image-media, img.message-image');
      const origin = candidate?.closest('.classic-image-media') || candidate;
      if (!origin || origin.closest('.pc-image-viewer') || event.defaultPrevented) return;
      event.preventDefault(); const image = origin.matches('img') ? origin : origin.querySelector('img.message-image');
      if (image) open(origin, image);
    });
    if (listen) document.addEventListener('auxclick', event => { if (event.target?.closest?.('.classic-image-media, img.message-image')) event.preventDefault(); });
    window.addEventListener('keydown', event => {
      const view = current; if (!view || !valid(view) || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); onClose?.(); return; }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c' && canCopyImage()) { event.preventDefault(); event.stopImmediatePropagation(); void copy(view); return; }
      if (event.key === 'Tab') {
        const buttons = [...view.modal.querySelectorAll('button:not(:disabled):not([hidden])')], index = buttons.indexOf(document.activeElement);
        if ((event.shiftKey && index <= 0) || (!event.shiftKey && (index < 0 || index === buttons.length - 1))) { event.preventDefault(); event.stopImmediatePropagation(); buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus(); }
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && ['+', '=', '-', '0'].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); if (event.key === '0') fit(view); else zoom(view, view.scale * (event.key === '-' ? 1 / 1.25 : 1.25)); }
    }, true);
    document.addEventListener('focusin', event => { const view = current; if (view && valid(view) && !view.modal.contains(event.target)) view.modal.querySelector('[data-viewer-close]').focus({ preventScroll: true }); });
    window.addEventListener('resize', () => { const view = current; if (view?.ready) { if (view.fitting) fit(view); else paint(view); } });
    onWindowClosed?.(value => { if (detached?.id === value?.id) { detached.observer.disconnect(); detached = null; } });
    return Object.freeze({ close, open });
  }
  window.PulseImageViewer = Object.freeze({ create });
})();
