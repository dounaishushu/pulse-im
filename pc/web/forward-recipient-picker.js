(function () {
  'use strict';

  // Loaded before app.js; application state is only read when a picker opens.
  function open(source, options = {}) {
    const messages = [...new Map((Array.isArray(source) ? source : [source]).map(message => [Number(message?.id), message])).values()]
      .sort((a, b) => Number(a.id) - Number(b.id));
    if (!messages.length || messages.length > 100 || !messages.every(canForwardSource)) return;
    const originals = messages.map(message => ({ type: message.type, body: forwardMessageBody(message) }));
    const count = messages.length, maxRecipients = 100;
    closeFeatureModal();
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop feature-modal message-forward-backdrop" data-feature-modal data-message-forward data-forward-count="${count}"><section class="forward-recipient-dialog" role="dialog" aria-modal="true" aria-labelledby="message-forward-title" aria-description="转发 ${count} 条消息。单击直接转发，右键选择多个会话后发送。"><header class="forward-recipient-header"><h2 id="message-forward-title">选择接收者...</h2><button type="button" class="forward-recipient-multi" id="message-forward-multi" aria-pressed="false">多选</button></header><div class="forward-recipient-selected" id="message-forward-selected" aria-label="已选接收者" hidden></div><label class="forward-recipient-search"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m6.5 14.5-4 4"/></svg><input id="message-forward-search" type="search" placeholder="搜索" aria-label="搜索接收者" autocomplete="off" spellcheck="false"></label><div class="forward-recipient-scroll" id="message-forward-list"><div id="message-forward-rows"></div><p class="forward-recipient-empty" id="message-forward-empty" hidden>没有找到接收者</p><button type="button" class="forward-recipient-more" data-forward-more hidden>加载更多会话</button></div><footer class="forward-recipient-footer"><p id="message-forward-feedback" role="status" aria-live="polite" hidden></p><button type="button" data-close-modal>取消</button><button type="button" id="message-forward-submit" hidden>发送</button></footer></section></div>`);
    bindFeatureModal();
    const modal = document.querySelector('[data-message-forward]');
    const context = folderOperationContext(null, modal), navigationRevision = messageForwardNavigationRevision;
    const search = modal.querySelector('#message-forward-search'), list = modal.querySelector('#message-forward-list');
    const rows = modal.querySelector('#message-forward-rows'), chips = modal.querySelector('#message-forward-selected');
    const feedback = modal.querySelector('#message-forward-feedback'), submit = modal.querySelector('#message-forward-submit');
    const multiButton = modal.querySelector('#message-forward-multi'), more = modal.querySelector('[data-forward-more]');
    const targets = new Map(), selected = new Map(), attempts = new Map();
    const lifetime = new AbortController();
    let page = 0, hasMore = true, loading = false, loadError = false, multi = false, failed = false;
    // The queue and request IDs survive a retry; confirmed deliveries are never repeated.
    let queue = null, queueIndex = 0, lockedTarget = 0, menu = null, menuKey = '';
    let favoriteTarget = null;
    const favorite = { id: 0, type: 'favorites', name: '收藏夹' };
    const current = () => !lifetime.signal.aborted && state.desktopAccountVisible !== false
      && navigationRevision === messageForwardNavigationRevision && currentFolderOperation(context);
    const keyFor = target => target.type === 'favorites' ? 'favorites' : String(target.id);
    const targetFor = key => key === 'favorites' ? favorite : targets.get(Number(key));
    const remember = target => {
      if (!Number.isSafeInteger(Number(target?.id)) || Number(target.id) <= 0) return;
      if (target.type === 'favorites') favoriteTarget = target;
      else targets.set(Number(target.id), target);
    };
    (state.conversations || []).forEach(remember);
    const title = target => target.type === 'favorites' ? '收藏夹' : target.name || (target.type === 'direct' ? '联系人' : '会话');
    const subtitle = target => target.type === 'favorites' ? '转发消息到这里以便快速访问'
      : target.is_bot || target.peer_is_bot ? '机器人' : target.type === 'group' ? '群组' : target.type === 'channel' ? '频道'
        : target.type === 'customer_service' ? '客服' : target.peer_online ? '在线' : target.peer_last_seen_at ? '近期曾上线' : '最近上线时间不可见';
    const avatar = target => {
      const colors = [['#59b7ff', '#3989d7'], ['#ff9b62', '#e34e45'], ['#65d4df', '#2b9ac7'], ['#ff89b3', '#e64d82'], ['#a0d66b', '#65af48']];
      const [top, bottom] = colors[Math.abs(Number(target.id) || 0) % colors.length];
      const image = target.avatar_url && target.type !== 'favorites' ? `<img src="${escapeHtml((globalThis.avatarUrl || mediaUrl)(target.avatar_url))}" alt="" loading="lazy">` : '';
      const icon = target.type === 'favorites' ? '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 3.5h12v17l-6-4-6 4z"/></svg>' : escapeHtml(Array.from(title(target).trim())[0] || '?');
      return `<span class="forward-recipient-avatar" style="--recipient-top:${top};--recipient-bottom:${bottom}" aria-hidden="true"><span>${icon}</span>${image}</span>`;
    };
    const closeMenu = (restoreFocus = false) => {
      const key = menuKey;
      menu?.remove(); menu = null; menuKey = '';
      if (restoreFocus) rows.querySelector(`[data-forward-recipient="${key}"]`)?.focus({ preventScroll: true });
    };
    modal.disposeForwardPicker = () => { closeMenu(); lifetime.abort(); };
    const render = () => {
      const focusedKey = document.activeElement?.closest('[data-forward-recipient]')?.dataset.forwardRecipient;
      const query = search.value.trim().toLocaleLowerCase();
      const visible = [favorite, ...targets.values()].filter(target => forwardTargetAllowed(target)
        && (!query || [title(target), target.username, target.peer_public_id, target.remark].some(value => String(value || '').toLocaleLowerCase().includes(query))));
      const previousScroll = list.scrollTop;
      rows.innerHTML = visible.map(target => {
        const key = keyFor(target), chosen = selected.has(key);
        return `<button type="button" class="forward-recipient-row${chosen ? ' is-selected' : ''}${queue?.[queueIndex] === key ? ' is-forwarding' : ''}" data-forward-recipient="${key}" aria-label="${multi ? (chosen ? '取消选择 ' : '选择 ') : '转发到 '}${escapeHtml(title(target))}" ${multi ? `aria-pressed="${chosen}"` : ''} aria-haspopup="menu" ${queue ? 'disabled' : ''}>${avatar(target)}<span class="forward-recipient-copy"><strong>${escapeHtml(title(target))}</strong><small>${escapeHtml(subtitle(target))}</small></span>${chosen ? '<span class="forward-recipient-check" aria-hidden="true">✓</span>' : ''}</button>`;
      }).join('');
      chips.hidden = !selected.size;
      chips.innerHTML = [...selected].map(([key, target]) => `<button type="button" class="forward-recipient-chip" data-forward-remove="${key}" aria-label="移除 ${escapeHtml(title(target))}" title="${escapeHtml(title(target))}" ${queue ? 'disabled' : ''}>${avatar(target)}<span class="forward-recipient-chip-name">${escapeHtml(title(target))}</span><span class="forward-recipient-chip-close" aria-hidden="true">×</span></button>`).join('');
      modal.querySelectorAll('.forward-recipient-avatar img').forEach(image => { image.onerror = () => image.remove(); });
      list.scrollTop = previousScroll;
      if (focusedKey) rows.querySelector(`[data-forward-recipient="${focusedKey}"]`)?.focus({ preventScroll: true });
      modal.querySelector('#message-forward-empty').hidden = Boolean(visible.length) || loading;
      multiButton.textContent = multi ? '取消多选' : '多选'; multiButton.setAttribute('aria-pressed', String(multi)); multiButton.disabled = Boolean(queue);
      search.disabled = Boolean(queue);
      submit.hidden = !multi && !failed;
      submit.disabled = context.pending || (!queue && !selected.size);
      const progress = attempts.get(lockedTarget)?.next || 0;
      submit.textContent = context.pending ? '发送中…' : failed ? multi ? `继续发送（${queue.length - queueIndex}）` : progress ? `继续转发 ${count - progress} 条` : '重试' : `发送（${selected.size}）`;
      more.hidden = !hasMore || Boolean(queue); more.disabled = loading || context.pending;
      more.textContent = loading ? '正在加载…' : loadError ? '重试加载会话' : '加载更多会话';
      feedback.hidden = !feedback.textContent;
      modal.dataset.forwardTargetLocked = queue ? queue[queueIndex] || '' : '';
      modal.dataset.forwardSelectionCount = String(selected.size);
      modal.dataset.forwardMulti = String(multi);
    };
    const toggle = key => {
      if (!current() || queue) return;
      const target = targetFor(key);
      if (!target || !forwardTargetAllowed(target)) return;
      multi = true;
      if (selected.has(key)) selected.delete(key);
      else if (selected.size < maxRecipients) selected.set(key, target);
      else { feedback.textContent = `一次最多选择 ${maxRecipients} 个会话。`; render(); return; }
      feedback.textContent = ''; render();
    };
    const openMenu = (button, x, y) => {
      if (!current() || queue || !button || button.disabled) return;
      closeMenu(); menuKey = button.dataset.forwardRecipient;
      menu = document.createElement('div'); menu.className = 'forward-recipient-menu'; menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', '选择转发对象');
      menu.innerHTML = `<button type="button" role="menuitem" data-forward-select><span aria-hidden="true">${selected.has(menuKey) ? '✓' : '⊕'}</span>${selected.has(menuKey) ? '取消选择这个会话' : '选择这个会话'}</button>`;
      modal.append(menu);
      const bounds = menu.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(x, innerWidth - bounds.width - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(y, innerHeight - bounds.height - 8)) + 'px';
      menu.querySelector('button').onclick = () => { const key = menuKey; closeMenu(); toggle(key); rows.querySelector(`[data-forward-recipient="${key}"]`)?.focus({ preventScroll: true }); };
      menu.querySelector('button').focus({ preventScroll: true });
    };
    const load = async () => {
      if (!current() || loading || queue || !hasMore) return;
      loading = true; loadError = false; render();
      try {
        const result = await api(`/conversations?page=${page + 1}&size=50`, { authToken: context.account.token, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]) });
        if (!current()) return;
        const items = result.items || []; items.forEach(remember); page++;
        const size = Number(result.size) || 50;
        hasMore = items.length > 0 && (Number.isFinite(Number(result.total)) ? page * size < Number(result.total) : items.length >= size);
        if (!queue) feedback.textContent = '';
      } catch (error) { if (current()) { loadError = true; if (!queue) feedback.textContent = error.message || '会话加载失败，请重试。'; } }
      finally {
        loading = false;
        if (current()) {
          render();
          if (!loadError && hasMore && (search.value.trim() || list.scrollHeight <= list.clientHeight)) queueMicrotask(load);
        }
      }
    };
    const send = async keys => {
      if (!current() || context.pending) return;
      if (!queue) {
        const unique = [...new Set(keys)];
        if (!unique.length || unique.length > maxRecipients || unique.some(key => !targetFor(key))) return;
        queue = unique;
      }
      closeMenu(); context.pending = true; failed = false; feedback.textContent = '正在转发…'; render();
      let attempt;
      try {
        while (queueIndex < queue.length) {
          if (!current()) return;
          // Do not continue the batch if one of its original messages was recalled.
          if (!messages.every(canForwardSource)) throw new Error('原消息已不可转发，请取消后重新选择。');
          const key = queue[queueIndex];
          const target = key === 'favorites' ? favoriteTarget || await api('/conversations/favorites', { method: 'POST', authToken: context.account.token, body: JSON.stringify({}) }) : targetFor(key);
          if (!current()) return;
          if (!forwardTargetAllowed(target) || !Number.isSafeInteger(Number(target.id)) || Number(target.id) <= 0) throw new Error('这个会话暂时无法接收消息，请取消后重新选择。');
          if (key === 'favorites') favoriteTarget = target;
          const targetId = Number(target.id); lockedTarget = targetId;
          attempt = attempts.get(targetId);
          if (!attempt) {
            attempt = { next: 0, payloads: originals.map(message => ({ conversation_id: targetId, type: message.type, body: message.body, request_id: newMessageRequestId('forward') })) };
            attempts.set(targetId, attempt);
          }
          while (attempt.next < count) {
            if (!current()) return;
            if (!canForwardSource(messages[attempt.next])) throw new Error('原消息已不可转发，请取消后重新选择。');
            feedback.textContent = `${multi ? `会话 ${queueIndex + 1}/${queue.length}，` : ''}正在转发 ${attempt.next + 1}/${count}…`;
            const sent = await api('/messages', { method: 'POST', authToken: context.account.token, body: JSON.stringify(attempt.payloads[attempt.next]) });
            attempt.next++;
            if (!current()) return;
            if (Number(state.active?.id) === targetId) appendMessage(sent);
            render();
          }
          queueIndex++; attempt = null;
        }
        if (!current()) return;
        closeFeatureModal(); options.onComplete?.();
        const refreshContext = { ...context, modal: null };
        try { await loadConversations(); }
        catch { if (state.desktopAccountVisible !== false && navigationRevision === messageForwardNavigationRevision && currentFolderOperation(refreshContext)) composerFeedback('转发已完成，列表刷新失败，请稍后刷新。'); }
      } catch (error) {
        if (current()) {
          failed = true;
          feedback.textContent = `${multi ? `已完成 ${queueIndex}/${queue.length} 个会话，` : ''}${count > 1 ? `已转发 ${attempt?.next || 0}/${count} 条。` : ''}${error.message || '转发失败，请重试。'}`;
        }
      } finally { context.pending = false; if (current()) { render(); if (failed) submit.focus(); } }
    };
    modal.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (menu) closeMenu(true); else closeFeatureModal(); }
    });
    modal.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target) && !event.target.closest('[data-forward-recipient]')) closeMenu(); }, true);
    rows.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); openMenu(event.target.closest('[data-forward-recipient]'), event.clientX, event.clientY); });
    rows.addEventListener('click', event => {
      const button = event.target.closest('[data-forward-recipient]');
      if (!button || button.disabled) return;
      if (menu) { closeMenu(); button.focus(); return; }
      if (multi) toggle(button.dataset.forwardRecipient); else void send([button.dataset.forwardRecipient]);
    });
    rows.addEventListener('keydown', event => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        const button = event.target.closest('[data-forward-recipient]'); if (!button) return;
        event.preventDefault(); event.stopPropagation(); const bounds = button.getBoundingClientRect(); openMenu(button, bounds.x + 72, bounds.y + bounds.height); return;
      }
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const buttons = [...rows.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
      event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    });
    chips.addEventListener('click', event => {
      const button = event.target.closest('[data-forward-remove]'); if (!button || button.disabled) return;
      toggle(button.dataset.forwardRemove); search.focus();
    });
    multiButton.onclick = () => { if (queue) return; closeMenu(); multi = !multi; selected.clear(); feedback.textContent = ''; render(); search.focus(); };
    more.onclick = load;
    list.addEventListener('scroll', () => { closeMenu(); if (list.scrollHeight - list.scrollTop - list.clientHeight < 100 && !loadError) void load(); });
    search.addEventListener('input', () => { closeMenu(); render(); list.scrollTop = 0; if (search.value.trim() && hasMore && !loadError) void load(); });
    search.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); rows.querySelector('button:not(:disabled)')?.focus(); } });
    window.addEventListener('resize', () => closeMenu(), { signal: lifetime.signal });
    submit.onclick = () => { if (queue || multi) void send(queue || [...selected.keys()]); };
    render(); search.focus(); void load();
  }
  window.PulseForwardRecipients = Object.freeze({ open });
})();
