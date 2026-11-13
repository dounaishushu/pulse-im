/* Personal notifications and their read state belong to the signed-in account. */
window.PulseActivityCenter = (() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function create(options) {
    let accountKey = '', generation = 0, countRevision = 0, unreadCount = 0;
    let view = null, refreshTask = null, refreshAgain = false, readBusy = false, reloadQueued = false, eventTimer = null, interval = null, paused = false, disposed = false;
    const account = () => {
      const value = options.getAccount();
      return value?.token && Number(value.userId) > 0 ? { ...value, userId: Number(value.userId) } : null;
    };
    const same = (value, stamp) => {
      const current = account();
      return stamp === generation && current?.token === value?.token && current?.userId === value?.userId && current?.base === value?.base;
    };
    const allowed = value => !paused && !disposed && value && !value.blocked && value.visible !== false && !document.hidden;
    function paint() {
      const badge = document.getElementById('friend-request-badge'), button = document.getElementById('session-add');
      if (badge) { badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount); badge.hidden = unreadCount === 0; }
      if (button) button.setAttribute('aria-label', unreadCount ? `添加好友，${unreadCount} 条未读通知` : '添加好友');
    }
    function cancelList(target) {
      if (!target) return;
      const previous = target.loading; target.loading = null; target.queuedLoad = null;
      target.observer?.disconnect(); clearTimeout(target.readTimer); target.readTimer = null;
      previous?.controller.abort();
    }
    function cancelSummary() {
      const previous = refreshTask; refreshTask = null; refreshAgain = false;
      previous?.controller.abort();
    }
    function close() {
      if (view) { view.more.onclick = null; view.list.onclick = null; const refresh = view.modal.querySelector('[data-notice-refresh]'); if (refresh) refresh.onclick = null; }
      cancelList(view); view = null; reloadQueued = false;
    }
    function reset() {
      close(); cancelSummary(); generation++; countRevision++; unreadCount = 0; accountKey = ''; readBusy = false;
      clearTimeout(eventTimer); eventTimer = null; paint();
      clearInterval(interval); interval = null;
    }
    function context() {
      const value = account(), key = value ? JSON.stringify([value.base, value.userId, value.token]) : '';
      if (key !== accountKey) { reset(); accountKey = key; }
      return { value, stamp: generation };
    }
    function setCount(value, revision) {
      if (revision !== countRevision) return;
      unreadCount = Math.max(0, Math.floor(Number(value) || 0)); paint();
    }
    async function refresh() {
      if (disposed) return;
      const { value, stamp } = context();
      if (!allowed(value)) return;
      startPolling();
      if (readBusy) { refreshAgain = true; return; }
      if (refreshTask) { refreshAgain = true; return refreshTask.promise; }
      const revision = ++countRevision;
      const task = { controller: new AbortController() }; refreshTask = task;
      task.promise = (async () => {
        try {
          const result = await options.request('/notifications/summary', { authToken: value.token, signal: task.controller.signal });
          if (refreshTask === task && !task.controller.signal.aborted && same(value, stamp)) setCount(result.unread_count, revision);
        } catch { /* Keep the last confirmed count while offline. */ }
      })();
      try { await task.promise; }
      finally {
        if (same(value, stamp) && refreshTask === task) {
          refreshTask = null;
          if (refreshAgain && !readBusy) { refreshAgain = false; void refresh(); }
        }
      }
    }
    function description(item) {
      const actor = item.actor_name || '用户', group = item.group_name || '群聊';
      if (item.type === 'friend.request') return [`${actor} 请求添加你为好友`, item.message || '希望与你成为好友'];
      if (item.type === 'friend.accepted') return [`${actor} 已通过你的好友申请`, '你们已经成为好友'];
      if (item.type === 'friend.added') return [`${actor} 已添加你为好友`, '你们已经成为好友'];
      if (item.type === 'group.invited') return [`${actor} 邀请你加入群聊`, group];
      if (item.type === 'group.removed') return ['你已被移出群聊', group];
      return ['消息通知', item.message || ''];
    }
    function row(item, target) {
      const [title, detail] = description(item);
      const image = item.actor_avatar_url ? `<img src="${escape(options.mediaUrl(item.actor_avatar_url))}" alt="">` : escape((item.actor_name || '?').slice(0, 1));
      const pending = item.type === 'friend.request' && item.request_status === 'pending';
      const handling = target.handling.get(item.id);
      const status = { accepted: '已同意', rejected: '已拒绝' }[item.request_status] || '';
      return `<article class="activity-row${item.unread ? ' is-unread' : ''}" data-notification-id="${Number(item.id)}"><span class="activity-avatar" aria-hidden="true">${image}</span><div class="activity-copy"><strong>${escape(title)}</strong><p>${escape(detail)}</p><time>${escape(item.created_at || '')}</time>${pending ? `<div class="activity-actions" aria-busy="${Boolean(handling)}"><button type="button" data-notice-action="accept" ${handling ? 'disabled' : ''}>${handling === 'accept' ? '同意中…' : '同意'}</button><button type="button" data-notice-action="reject" ${handling ? 'disabled' : ''}>${handling === 'reject' ? '拒绝中…' : '拒绝'}</button></div>` : status ? `<span class="activity-status">${status}</span>` : item.can_open_group ? '<button type="button" class="activity-open-group" data-open-notice-group>查看群聊</button>' : ''}<p class="activity-error" role="status" hidden></p></div></article>`;
    }
    const currentView = target => !disposed && view === target && target.modal.isConnected && same(target.account, target.stamp);
    function observeVisible(target) {
      target.observer?.disconnect();
      if (!currentView(target) || !allowed(account())) return;
      target.observer = new IntersectionObserver(entries => {
        if (!currentView(target) || !allowed(account())) return;
        for (const entry of entries) if (entry.isIntersecting && entry.intersectionRatio >= .4) {
          const id = Number(entry.target.dataset.notificationId);
          if (target.items.find(item => item.id === id)?.unread) target.toRead.add(id);
        }
        clearTimeout(target.readTimer);
        if (target.toRead.size) target.readTimer = setTimeout(() => { void acknowledge(target); }, 180);
      }, { root: target.list, threshold: [.4] });
      target.list.querySelectorAll('[data-notification-id].is-unread').forEach(node => target.observer.observe(node));
    }
    async function acknowledge(target) {
      if (!currentView(target) || !allowed(account()) || readBusy || !target.toRead.size) return;
      const ids = [...target.toRead].slice(0, 100); target.toRead.clear();
      readBusy = true; const revision = ++countRevision;
      let succeeded = false;
      try {
        const result = await options.request('/notifications/read', { method: 'POST', authToken: target.account.token, body: JSON.stringify({ ids }) });
        if (!same(target.account, target.stamp)) return;
        succeeded = true;
        setCount(result.unread_count, revision);
        if (currentView(target)) {
          ids.forEach(id => target.readIds.add(id));
          for (const item of target.items) if (ids.includes(item.id)) { item.unread = false; target.list.querySelector(`[data-notification-id="${item.id}"]`)?.classList.remove('is-unread'); }
          target.feedback.textContent = '';
        }
      } catch {
        if (currentView(target)) {
          ids.forEach(id => target.toRead.add(id));
          target.feedback.textContent = '已读状态暂未同步，请点击刷新重试。';
        }
      } finally {
        if (same(target.account, target.stamp)) {
          readBusy = false;
          if (refreshAgain) { refreshAgain = false; void refresh(); }
          if (reloadQueued && view) { reloadQueued = false; void load(view, false, true); }
          if (succeeded && currentView(target) && target.toRead.size) target.readTimer = setTimeout(() => { void acknowledge(target); }, 180);
        }
      }
    }
    function render(target) {
      if (!currentView(target)) return;
      const top = target.list.scrollTop;
      target.list.innerHTML = target.items.map(item => row(item, target)).join('') || '<p class="activity-empty">暂无消息通知</p>';
      target.list.scrollTop = top;
      target.more.hidden = !target.hasMore; target.more.disabled = false;
      target.list.querySelectorAll('img').forEach(img => img.addEventListener('error', () => { img.parentElement.textContent = '?'; }, { once: true }));
      observeVisible(target);
    }
    async function load(target, more = false, preserve = false) {
      if (!currentView(target) || !allowed(account())) return;
      if (readBusy || target.handling.size) { reloadQueued = true; return; }
      if (target.loading) {
        // Refresh replaces a queued pagination request; another refresh keeps
        // the strongest intent without opening a parallel request.
        const previous = target.queuedLoad;
        if (!previous || (previous.more && !more)) target.queuedLoad = { more, preserve };
        else if (previous.more === more) previous.preserve = previous.preserve && preserve;
        return target.loading.promise;
      }
      const revision = ++target.revision;
      const task = { controller: new AbortController() }; target.loading = task;
      target.more.disabled = true; target.feedback.textContent = '';
      task.promise = (async () => {
      try {
        const result = await options.request(`/notifications?limit=30${more && target.before ? `&before_id=${target.before}` : ''}`, { authToken: target.account.token, signal: task.controller.signal });
        if (!currentView(target) || target.loading !== task || task.controller.signal.aborted || revision !== target.revision) return;
        const incoming = (result.items || []).map(item => ({ ...item, id: Number(item.id), ...(target.readIds.has(Number(item.id)) ? { unread: false } : {}), ...(target.handled.has(Number(item.id)) ? { request_status: target.handled.get(Number(item.id)), unread: false } : {}) }));
        // A burst larger than one page must retain a continuous cursor, rather
        // than leaving an unseen gap between new rows and cached history.
        const gap = preserve && target.items.length && incoming.length && incoming.at(-1).id > target.items[0].id && result.has_more;
        if (more || (preserve && !gap)) {
          const all = new Map(target.items.map(item => [item.id, item]));
          incoming.forEach(item => all.set(item.id, item));
          target.items = [...all.values()].sort((a, b) => b.id - a.id);
        } else target.items = incoming;
        if (more || !preserve || !target.loaded || gap) { target.before = result.next_before_id; target.hasMore = Boolean(result.has_more); }
        target.loaded = true;
        render(target); void refresh();
      } catch {
        if (currentView(target) && target.loading === task && !task.controller.signal.aborted && revision === target.revision) {
          if (!target.items.length) target.list.innerHTML = '<p class="activity-empty">通知暂时无法加载</p>';
          target.feedback.textContent = '请检查网络后点击刷新重试。';
        }
      } finally {
        if (target.loading === task) {
          target.loading = null;
          if (currentView(target)) {
            target.more.disabled = false;
            const queued = target.queuedLoad; target.queuedLoad = null;
            if (queued && allowed(account())) void load(target, queued.more, queued.preserve);
          }
        }
      }
      })();
      return task.promise;
    }
    async function handle(target, button) {
      if (!currentView(target) || !allowed(account())) return;
      const node = button.closest('[data-notification-id]'), item = target.items.find(row => row.id === Number(node.dataset.notificationId));
      if (!item || target.handling.has(item.id)) return;
      if (button.hasAttribute('data-open-notice-group')) {
        button.disabled = true;
        try { await options.onOpenGroup(item.conversation_id, target.account); }
        catch (error) { if (currentView(target)) { node.querySelector('.activity-error').hidden = false; node.querySelector('.activity-error').textContent = error.message || '暂时无法打开群聊'; } }
        finally { if (currentView(target)) button.disabled = false; }
        return;
      }
      const action = button.dataset.noticeAction;
      if (item.request_status !== 'pending' || !['accept', 'reject'].includes(action)) return;
      target.handling.set(item.id, action);
      target.revision++;
      node.querySelectorAll('button').forEach(control => { control.disabled = true; });
      button.textContent = action === 'accept' ? '同意中…' : '拒绝中…';
      node.querySelector('.activity-actions')?.setAttribute('aria-busy', 'true');
      node.querySelector('.activity-error').hidden = true;
      const signal = AbortSignal.timeout(12000);
      try {
        const result = await options.request('/contact-requests/handle', { method: 'POST', authToken: target.account.token, signal, body: JSON.stringify({ request_id: item.request_id, notification_id: item.id, action }) });
        if (!currentView(target)) return;
        if (!['accepted', 'rejected'].includes(result.status)) throw new Error('暂未确认处理结果，请刷新后重试。');
        item.request_status = result.status; item.unread = false; target.toRead.delete(item.id);
        target.handled.set(item.id, result.status); target.readIds.add(item.id);
        // Keep the other rows, decoded avatars and their pending clicks intact.
        node.querySelector('.activity-actions')?.remove();
        const status = document.createElement('span'); status.className = 'activity-status'; status.setAttribute('role', 'status');
        status.textContent = result.status === 'accepted' ? '已同意' : '已拒绝'; node.querySelector('.activity-copy').appendChild(status);
        node.classList.remove('is-unread');
        void Promise.resolve().then(() => options.onContactsChanged?.()).catch(() => {}); void refresh();
        if (result.status === 'accepted') void Promise.resolve().then(() => options.onFriendAccepted?.(result, target.account)).catch(() => {});
      } catch (error) {
        if (currentView(target)) { const text = node.querySelector('.activity-error'); text.hidden = false; text.textContent = signal.aborted ? '暂未收到处理结果，请刷新确认后重试。' : error.message || '处理失败，请重试'; }
      } finally {
        target.handling.delete(item.id);
        if (currentView(target)) {
          node.querySelector('.activity-actions')?.setAttribute('aria-busy', 'false');
          node.querySelectorAll('[data-notice-action]').forEach(control => { control.disabled = false; control.textContent = control.dataset.noticeAction === 'accept' ? '同意' : '拒绝'; });
          if (reloadQueued && !target.handling.size) { reloadQueued = false; void load(target, false, true); }
        }
      }
    }
    function mount(modal) {
      if (disposed) return;
      const { value, stamp } = context(); close();
      if (!allowed(value)) return;
      startPolling();
      const target = { modal, account: value, stamp, items: [], before: null, hasMore: false, loaded: false, revision: 0, toRead: new Set(), readIds: new Set(), handled: new Map(), handling: new Map(), list: modal.querySelector('.activity-list'), more: modal.querySelector('[data-notice-more]'), feedback: modal.querySelector('.activity-feedback') };
      view = target;
      target.more.onclick = () => { void load(target, true); };
      modal.querySelector('[data-notice-refresh]').onclick = () => { void acknowledge(target); void load(target, false, true); };
      target.list.onclick = event => { const button = event.target.closest('[data-notice-action], [data-open-notice-group]'); if (button) void handle(target, button); };
      void load(target);
    }
    function changed() {
      clearTimeout(eventTimer);
      eventTimer = null;
      if (!paused && !disposed) eventTimer = setTimeout(() => { eventTimer = null; void refresh(); if (view) void load(view, false, true); }, 100);
    }
    function startPolling() { if (interval === null && allowed(account())) interval = setInterval(() => { if (allowed(account())) { void refresh(); if (view) { void acknowledge(view); void load(view, false, true); } } }, 30000); }
    startPolling();
    function pause() { paused = true; cancelSummary(); cancelList(view); clearTimeout(eventTimer); eventTimer = null; clearInterval(interval); interval = null; reloadQueued = false; }
    return { refresh, mount, changed, close, reset, pause,
      resume() { if (disposed) return; paused = false; void refresh(); if (view) { observeVisible(view); void load(view, false, true); } },
      dispose() { disposed = true; pause(); close(); generation++; clearInterval(interval); },
    };
  }
  return { create };
})();
