// Desktop-only composition and navigation; sends still use the existing client.
(() => {
  let binding;
  window.PulseDesktopChat = {
    refresh() { binding?.refresh(); },
    bind({ state, detached, navigate, leave, search, closeEmoji, canSendFiles, sendFiles, imageDropTarget, feedback }) {
      binding?.dispose();
      const composer = document.getElementById('composer');
      const input = document.getElementById('message-input');
      if (!composer || !(input instanceof HTMLTextAreaElement)) return;
      const account = { token: state.token, id: Number(state.user?.id) };
      const controller = new AbortController(), { signal } = controller;
      const on = (node, name, handler, options = {}) => node.addEventListener(name, handler, { ...options, signal });
      const sameAccount = () => composer.isConnected && state.token === account.token && Number(state.user?.id) === account.id;
      const blocked = () => !sameAccount() || !state.token || !state.user || state.updateRequired || Boolean(document.querySelector('.modal-backdrop, .classic-menu-backdrop, .classic-passcode-lock-screen'));
      const attachments = document.createElement('div');
      attachments.className = 'desktop-attachments';
      attachments.innerHTML = '<button id="desktop-attach-button" type="button" aria-label="添加附件" title="添加附件" aria-haspopup="menu" aria-controls="desktop-attach-menu" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 13 7.8-7.8a3.5 3.5 0 0 1 5 5L10 21a5 5 0 0 1-7-7L13.5 3.5"/><path d="m6.5 15 10-10"/></svg></button><div id="desktop-attach-menu" class="desktop-attach-menu" role="menu" aria-label="添加附件" hidden></div>';
      const toggle = attachments.firstElementChild, menu = attachments.lastElementChild;
      const tools = [];
      for (const [id, label] of [['image-button', '图片'], ['video-button', '视频'], ['contact-card-button', '好友名片'], ['shake-button', '窗口抖动']]) {
        const tool = document.getElementById(id);
        if (!tool) continue;
        tools.push(tool);
        tool.setAttribute('role', 'menuitem');
        const caption = document.createElement('span'); caption.className = 'desktop-attach-label'; caption.textContent = label;
        tool.append(caption); menu.append(tool);
      }
      composer.prepend(attachments);
      composer.classList.add('desktop-chat-composer');
      input.rows = 1;
      input.title = 'Enter 发送，Shift + Enter 换行';
      input.setAttribute('aria-keyshortcuts', 'Enter Shift+Enter');
      const send = composer.querySelector('button.primary');
      send?.setAttribute('title', '发送消息 (Enter)');
      const chat = composer.closest('.main');
      const messages = document.getElementById('messages');
      const drop = document.createElement('div');
      drop.className = 'desktop-media-drop'; drop.hidden = true;
      drop.setAttribute('role', 'status'); drop.setAttribute('aria-live', 'polite');
      drop.innerHTML = '<div class="desktop-media-drop-card"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4H4v16h16V10"/><path d="m4 16 5-5 4 4 3-3 4 4M19 2v6m-3-3h6"/><circle cx="9" cy="8" r="1"/></svg><span>拖拽图片到此处发送</span></div>';
      chat?.append(drop);
      let dragTimer;
      let highlightedPreview;
      const clearDrop = () => { clearTimeout(dragTimer); drop.hidden = true; highlightedPreview?.classList.remove('is-dragging-images'); highlightedPreview = null; };
      const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files') || Array.from(event.dataTransfer?.items || []).some(item => item.kind === 'file');
      const inChat = target => target instanceof Element && chat?.contains(target) && !target.closest('#chat-head, #directory-panel, .classic-composer-emoji');
      const previewTarget = () => {
        const preview = imageDropTarget?.();
        if (!(preview instanceof Element) || !preview.isConnected) return null;
        // Only the current photo preview may accept more files through a modal.
        // A lock screen or any other dialog still blocks the whole drop path.
        const blockers = document.querySelectorAll('.modal-backdrop, .classic-menu-backdrop, .classic-passcode-lock-screen, [aria-modal="true"]');
        return [...blockers].every(node => node === preview || preview.contains(node)) ? preview : null;
      };
      const dropAllowed = preview => sameAccount() && (!blocked() && !document.querySelector('[aria-modal="true"]') || Boolean(preview)) && !composer.hidden && !input.disabled && !document.getElementById('image-button')?.disabled && state.page === 'messages' && Number(state.active?.id) > 0 && Boolean(canSendFiles?.());
      const dropLocation = (target, preview) => preview ? target instanceof Node && preview.contains(target) : inChat(target);
      const positionDrop = () => {
        if (!chat || !messages) return;
        const area = chat.getBoundingClientRect(), content = messages.getBoundingClientRect();
        drop.style.top = Math.max(0, content.top - area.top) + 'px';
        drop.style.right = Math.max(0, area.right - content.right) + 'px';
      };
      const dragOver = event => {
        if (!hasFiles(event)) return;
        // File drops anywhere in the window must never navigate to a local file.
        event.preventDefault();
        const types = Array.from(event.dataTransfer.items || []).filter(item => item.kind === 'file').map(item => item.type);
        const supported = !types.length || types.every(type => !type || /^(image\/(jpeg|png|gif|webp)$|video\/)/i.test(type));
        const preview = previewTarget();
        const allowed = dropLocation(event.target, preview) && dropAllowed(preview) && supported && (!preview || !types.some(type => /^video\//i.test(type)));
        event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
        if (!allowed) { clearDrop(); return; }
        if (preview) {
          clearDrop(); highlightedPreview = preview; preview.classList.add('is-dragging-images');
          dragTimer = setTimeout(clearDrop, 1400); return;
        }
        if (drop.hidden) { closeEmoji(); close(); }
        drop.querySelector('span').textContent = types.length && types.every(type => /^video\//i.test(type)) ? '拖拽视频到此处发送' : '拖拽图片到此处发送';
        positionDrop(); drop.hidden = false;
        clearTimeout(dragTimer); dragTimer = setTimeout(clearDrop, 1400);
      };
      on(document, 'dragenter', dragOver, { capture: true });
      on(document, 'dragover', dragOver, { capture: true });
      on(document, 'dragleave', event => {
        if (event.relatedTarget ? !dropLocation(event.relatedTarget, previewTarget()) : event.target === document.documentElement || event.clientX <= 0 || event.clientY <= 0 || event.clientX >= innerWidth || event.clientY >= innerHeight) clearDrop();
      }, { capture: true });
      on(document, 'drop', event => {
        clearDrop();
        if (!hasFiles(event) && !event.dataTransfer?.files.length) return;
        event.preventDefault(); event.stopPropagation();
        const preview = previewTarget();
        if (!dropLocation(event.target, preview) || !dropAllowed(preview)) return;
        if (Array.from(event.dataTransfer.items || []).some(item => item.webkitGetAsEntry?.()?.isDirectory)) { feedback?.('请拖入图片文件，暂不支持整个文件夹。'); return; }
        const files = Array.from(event.dataTransfer.files);
        if (files.length) void Promise.resolve(sendFiles(files)).catch(error => { if (sameAccount()) feedback?.(error.message || '无法读取拖入的文件，请重试。'); });
      }, { capture: true });
      on(document, 'dragend', clearDrop, { capture: true });
      on(window, 'blur', clearDrop);
      on(document, 'visibilitychange', () => { if (document.hidden) clearDrop(); });
      on(document, 'keydown', event => {
        if (event.key === 'Escape' && !drop.hidden) { clearDrop(); event.preventDefault(); event.stopImmediatePropagation(); }
      }, { capture: true });
      const searchInput = document.getElementById('message-search');
      searchInput?.setAttribute('title', '搜索会话 (Ctrl + K)');
      document.getElementById('chat-search-button')?.setAttribute('title', '搜索聊天记录 (Ctrl + F)');
      const close = (focus = false) => { if (!menu.hidden) menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); if (focus && toggle.isConnected) toggle.focus(); };
      const choices = () => tools.filter(tool => !tool.hidden && !tool.disabled && tool.getClientRects().length);
      const open = () => {
        if (blocked() || composer.hidden || !state.active) return;
        closeEmoji(); menu.hidden = false; toggle.setAttribute('aria-expanded', 'true');
      };
      on(toggle, 'click', () => menu.hidden ? open() : close());
      on(toggle, 'keydown', event => {
        if (event.key !== 'ArrowDown') return;
        event.preventDefault(); open(); if (!menu.hidden) choices()[0]?.focus();
      });
      on(menu, 'click', event => { if (event.target.closest('button')) close(); });
      on(menu, 'click', event => {
        if (blocked() || composer.hidden || !state.active) { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      }, { capture: true });
      on(document, 'pointerdown', event => { if (!attachments.contains(event.target)) close(); });
      const resize = () => {
        if (!input.isConnected || composer.hidden) return;
        const messages = document.getElementById('messages');
        const atBottom = messages && messages.scrollHeight - messages.scrollTop - messages.clientHeight < 24;
        input.style.height = '0px';
        const maximum = Math.max(66, Math.min(176, window.innerHeight * .28));
        input.style.height = Math.min(maximum, Math.max(44, input.scrollHeight)) + 'px';
        input.style.overflowY = input.scrollHeight > maximum ? 'auto' : 'hidden';
        if (atBottom) messages.scrollTop = messages.scrollHeight;
      };
      let conversation = Number(state.active?.id) || 0, width = 0;
      const refresh = () => {
        if (!sameAccount()) { close(); clearDrop(); return; }
        const next = Number(state.active?.id) || 0;
        if (conversation !== next) { conversation = next; close(); clearDrop(); }
        if (composer.hidden) close();
        if (!dropAllowed(previewTarget())) clearDrop();
        resize();
      };
      on(input, 'input', resize);
      on(window, 'resize', resize);
      on(window, 'pulse-chat-typography-changed', resize);
      const sizeObserver = new ResizeObserver(entries => {
        const next = entries[0].contentRect.width;
        if (Math.abs(width - next) > .5) { width = next; resize(); }
      });
      sizeObserver.observe(composer);
      const stateObserver = new MutationObserver(refresh);
      stateObserver.observe(composer, { attributes: true, subtree: true, attributeFilter: ['hidden', 'disabled'] });
      on(document, 'keydown', event => {
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
        if (!menu.hidden && blocked()) { close(); return; }
        if (!menu.hidden && ['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopImmediatePropagation();
          if (event.key === 'Escape') { close(true); return; }
          const items = choices(), index = items.indexOf(document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
          items[next]?.focus(); return;
        }
        if (blocked()) return;
        if (event.key === 'Escape' && !detached && !state.favoriteMode && state.page === 'messages' && state.active && typeof leave === 'function') {
          // The persistent group member sidebar belongs to this conversation;
          // it must not prevent Esc from returning the main pane to its idle view.
          if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || state.desktopAccountVisible === false
            || document.hidden || document.fullscreenElement || state.chatSearch || (state.chatInfo && state.chatInfo.type !== 'group') || document.querySelector('[aria-modal="true"], [role="menu"]:not([hidden]), #composer-emoji-picker, #chat-more-menu, #conversation-context-menu, #chat-search-filter-popover, .message-selection-active')) return;
          event.preventDefault(); event.stopImmediatePropagation(); leave(); return;
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f' && state.active) {
          event.preventDefault(); event.stopImmediatePropagation(); close(); search(); return;
        }
        const arrow = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && ['ArrowUp', 'ArrowDown'].includes(event.key);
        const tab = event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Tab';
        if (detached || state.chatSearch || (!arrow && !tab)) return;
        const rows = [...document.querySelectorAll('#conversation-list .conversation[data-id]')].filter(row => !row.hidden && row.getClientRects().length);
        if (!rows.length) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.repeat) return;
        const direction = event.key === 'ArrowUp' || (tab && event.shiftKey) ? -1 : 1;
        const current = rows.findIndex(row => Number(row.dataset.id) === Number(state.active?.id));
        const next = current < 0 ? (direction > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, current + direction));
        if (current === next) return;
        close(); rows[next].scrollIntoView({ block: 'nearest' });
        void Promise.resolve(navigate(Number(rows[next].dataset.id))).catch(() => {});
      }, { capture: true });
      const removalObserver = new MutationObserver(() => { if (!composer.isConnected) dispose(); else if (!dropAllowed(previewTarget())) clearDrop(); });
      removalObserver.observe(document.body, { childList: true });
      const dispose = () => {
        controller.abort(); sizeObserver.disconnect(); stateObserver.disconnect(); removalObserver.disconnect();
        clearDrop(); drop.remove();
        for (const tool of tools) { tool.querySelector('.desktop-attach-label')?.remove(); tool.removeAttribute('role'); if (composer.isConnected) composer.append(tool); }
        attachments.remove(); composer.classList.remove('desktop-chat-composer');
        if (binding?.dispose === dispose) binding = null;
      };
      binding = { refresh, dispose }; refresh();
    },
  };
})();
