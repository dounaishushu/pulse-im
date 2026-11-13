/* Staff broadcast drafts stay in this account and reuse normal media uploads. */
(() => {
  const icons = {
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>',
    image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 6-5 4 3 3-3 5 5"/></svg>',
    video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>',
  };
  const labels = { friend: '好友', group: '群组' };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const key = item => `${item.type}:${item.id}`;
  const charCount = value => Array.from(value).length;
  const errorText = error => {
    if (error?.status === 404 || error?.status === 405 || error?.code === 'INVALID_API_RESPONSE') return '服务器尚未安装群发助手补丁，请先更新后端。';
    if (error?.name === 'TimeoutError') return '请求超时，可以重试；已经发送成功的消息不会重复发送。';
    return error?.message || '请求失败，请检查网络后重试。';
  };

  window.PulseBroadcastAssistant = {
    create({ getAccount, request, upload, mediaUrl, onPermissionRevoked, onSent }) {
      let view = null;
      const current = candidate => {
        const account = getAccount();
        return view === candidate && !candidate.closed && account.token === candidate.account.token && account.userId === candidate.account.userId && !account.blocked;
      };
      const canWork = candidate => current(candidate) && !candidate.denied && getAccount().internalStaff;
      const draftLocked = candidate => Boolean(candidate.job && !candidate.job.complete);
      function editCompletedDraft(candidate) {
        if (!candidate.job?.complete || candidate.busy) return;
        candidate.job = null;
        candidate.modal.querySelector('[data-broadcast-failures]').hidden = true;
      }
      function close() {
        if (!view) return;
        const old = view;
        view = null; old.closed = true;
        if (old.job) old.job.stop = true;
        old.controller.abort();
        old.attachments.forEach(item => URL.revokeObjectURL(item.preview));
        old.modal.remove();
        if (old.previousFocus?.isConnected) old.previousFocus.focus();
      }
      function deny(candidate) {
        if (!current(candidate)) return;
        candidate.denied = true;
        if (candidate.job) candidate.job.stop = true;
        onPermissionRevoked?.();
        candidate.status = '后台已关闭内部人员权限，无法继续群发。';
        candidate.statusError = true;
        render(candidate);
      }
      function handleError(candidate, error) {
        if (!current(candidate)) return;
        if (error?.code === 'INTERNAL_STAFF_REQUIRED' || error?.status === 403) { deny(candidate); return; }
        if (error?.name === 'AbortError') return;
        candidate.status = errorText(error); candidate.statusError = true;
        render(candidate);
      }
      function visibleTargets(candidate) {
        const term = candidate.search[candidate.tab].trim().toLocaleLowerCase();
        return candidate.targets[candidate.tab].items.filter(item => !term || `${item.name}\n${item.username}`.toLocaleLowerCase().includes(term));
      }
      function updateFooter(candidate) {
        const { modal, job } = candidate;
        const total = candidate.selected.size;
        const text = modal.querySelector('[data-broadcast-text]').value;
        const length = charCount(text);
        const count = modal.querySelector('[data-broadcast-count]');
        count.textContent = `${length}/5000`; count.classList.toggle('is-error', length > 5000);
        modal.querySelector('[data-broadcast-selected]').textContent = `已选 ${total} 个`;
        const status = modal.querySelector('[data-broadcast-status]');
        status.textContent = candidate.status || `将向 ${total} 个目标发送${candidate.attachments.length ? '多媒体' : '文字'}消息`;
        status.classList.toggle('is-error', candidate.statusError);
        const send = modal.querySelector('[data-broadcast-send]');
        send.textContent = candidate.busy ? '发送中…' : draftLocked(candidate) ? '继续发送' : candidate.hasCompleted ? '再次发送' : '发送';
        send.disabled = candidate.busy || candidate.denied || (!draftLocked(candidate) && (!total || (!text.trim() && !candidate.attachments.length) || length > 5000));
        modal.querySelector('[data-broadcast-cancel]').textContent = candidate.busy ? '停止群发' : job?.complete || candidate.denied ? '关闭' : '取消';
        modal.querySelector('[data-broadcast-new]').hidden = candidate.busy || (!job && !candidate.hasCompleted);
        modal.querySelector('[data-broadcast-new]').disabled = candidate.denied;
        modal.querySelector('[data-broadcast-text]').readOnly = candidate.busy || draftLocked(candidate) || candidate.denied;
        modal.querySelectorAll('[data-broadcast-add], [data-broadcast-remove]').forEach(button => { button.disabled = candidate.busy || draftLocked(candidate) || candidate.denied; });
        modal.setAttribute('aria-busy', String(candidate.busy));
      }
      function renderTargets(candidate) {
        const { modal, tab, job } = candidate;
        for (const type of ['friend', 'group']) {
          const button = modal.querySelector(`[data-broadcast-tab="${type}"]`);
          button.textContent = `${labels[type]} (${candidate.targets[type].total})`;
          button.classList.toggle('active', tab === type);
          button.setAttribute('aria-selected', String(tab === type));
        }
        const search = modal.querySelector('[data-broadcast-search]');
        search.placeholder = `搜索${labels[tab]}`; search.setAttribute('aria-label', search.placeholder);
        if (search.value !== candidate.search[tab]) search.value = candidate.search[tab];
        const list = modal.querySelector('[data-broadcast-targets]');
        const collection = candidate.targets[tab];
        const items = visibleTargets(candidate);
        const disabled = candidate.busy || draftLocked(candidate) || candidate.denied;
        const oldScroll = list.scrollTop;
        const focusedTarget = document.activeElement?.dataset.broadcastTarget;
        list.innerHTML = items.map(item => {
          const itemKey = key(item);
          const selected = candidate.selected.has(itemKey);
          const state = job?.done.has(itemKey) ? '已发送' : job?.failed.has(itemKey) ? '发送失败' : labels[item.type];
          const name = escape(item.name);
          let avatar = '';
          try { const url = new URL(mediaUrl(item.avatar_url)); if (item.avatar_url && ['https:', 'http:', 'file:'].includes(url.protocol)) avatar = `<img src="${escape(url.href)}" alt="" loading="lazy">`; } catch { /* Initials cover invalid avatars. */ }
          return `<label class="broadcast-target${selected ? ' is-selected' : ''}" title="${name}"><input type="checkbox" data-broadcast-target="${itemKey}" ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span class="broadcast-avatar" aria-hidden="true">${avatar || escape(Array.from(item.name)[0] || (tab === 'group' ? '群' : '友'))}</span><span class="broadcast-target-copy"><strong>${name}</strong><small${job?.failed.has(itemKey) ? ' class="is-error"' : ''}>${state}</small></span></label>`;
        }).join('');
        if (!items.length) list.innerHTML = `<p class="broadcast-empty">${collection.loading ? '正在加载…' : collection.error ? '目标加载失败' : candidate.search[tab] ? '没有匹配的' + labels[tab] : '暂无' + labels[tab]}</p>`;
        if (collection.loading && items.length) list.insertAdjacentHTML('beforeend', '<p class="broadcast-loading">正在加载更多…</p>');
        if (collection.error) list.insertAdjacentHTML('beforeend', `<div class="broadcast-load-error"><span>${escape(collection.error)}</span><button type="button" data-broadcast-reload="${tab}" ${disabled ? 'disabled' : ''}>重新加载</button></div>`);
        list.scrollTop = oldScroll;
        if (focusedTarget) list.querySelector(`[data-broadcast-target="${focusedTarget}"]`)?.focus({ preventScroll: true });
        const all = modal.querySelector('[data-broadcast-all]');
        const selectedCount = items.filter(item => candidate.selected.has(key(item))).length;
        all.checked = items.length > 0 && selectedCount === items.length;
        all.indeterminate = selectedCount > 0 && selectedCount < items.length;
        all.disabled = disabled || collection.loading || !collection.loaded || items.length === 0;
        modal.querySelector('[data-broadcast-all-label]').textContent = candidate.search[tab].trim() ? '全选搜索结果' : '全选';
      }
      function renderAttachments(candidate) {
        candidate.modal.querySelector('[data-broadcast-attachments]').innerHTML = candidate.attachments.map(item => `<div class="broadcast-attachment" title="${escape(item.file.name)}">${item.kind === 'image' ? `<img src="${escape(item.preview)}" alt="${escape(item.file.name)}">` : `<video src="${escape(item.preview)}" preload="metadata" muted></video><span class="broadcast-video-mark" aria-hidden="true">▶</span>`}<button type="button" data-broadcast-remove="${item.id}" aria-label="移除${escape(item.file.name)}" ${candidate.busy || draftLocked(candidate) || candidate.denied ? 'disabled' : ''}>×</button><small>${escape(item.file.name)}</small></div>`).join('');
        candidate.modal.querySelector('[data-broadcast-preview-label]').hidden = !candidate.attachments.length;
      }
      function clearDraft(candidate) {
        candidate.modal.querySelector('[data-broadcast-text]').value = '';
        candidate.attachments.forEach(item => URL.revokeObjectURL(item.preview));
        candidate.attachments = [];
        candidate.modal.querySelectorAll('[data-broadcast-file]').forEach(input => { input.value = ''; });
        renderAttachments(candidate);
      }
      function render(candidate) {
        if (!current(candidate)) return;
        renderTargets(candidate); updateFooter(candidate);
      }
      async function loadTargets(candidate, type) {
        if (!canWork(candidate) || candidate.targets[type].loading) return;
        const collection = candidate.targets[type];
        collection.loading = true; collection.loaded = false; collection.error = '';
        collection.items = []; collection.total = 0;
        render(candidate);
        let afterId = '', snapshot;
        try {
          do {
            if (!canWork(candidate)) return;
            const query = new URLSearchParams({ type, after_id: String(afterId), limit: '100' });
            if (snapshot !== undefined) query.set('snapshot_max_id', String(snapshot));
            const data = await request('/internal/broadcast/targets?' + query, { authToken: candidate.account.token, signal: AbortSignal.any([candidate.controller.signal, AbortSignal.timeout(20000)]) });
            if (!current(candidate)) return;
            if (!Array.isArray(data.items) || typeof data.snapshot_max_id !== 'string' || !data.snapshot_max_id || (snapshot !== undefined && snapshot !== data.snapshot_max_id)) throw new Error('群发目标列表无效，请重新加载。');
            snapshot = data.snapshot_max_id;
            const existing = new Set(collection.items.map(item => item.id));
            for (const item of data.items) {
              if (!Number.isSafeInteger(item.id) || item.id <= 0 || item.type !== type || existing.has(item.id)) throw new Error('群发目标列表无效，请重新加载。');
              existing.add(item.id);
              collection.items.push({ id: item.id, type, name: String(item.name || labels[type]), username: String(item.username || ''), avatar_url: String(item.avatar_url || '') });
            }
            collection.total = Math.max(collection.items.length, Number(data.total) || 0);
            render(candidate);
            if (!data.has_more) break;
            if (typeof data.next_after_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.next_after_id) || data.next_after_id === afterId) throw new Error('群发目标分页无效，请重新加载。');
            afterId = data.next_after_id;
          } while (true);
          collection.loaded = true; collection.total = collection.items.length;
          const validKeys = new Set(collection.items.map(key));
          for (const [itemKey, item] of candidate.selected) if (item.type === type && !validKeys.has(itemKey)) candidate.selected.delete(itemKey);
        } catch (error) {
          if (!current(candidate)) return;
          if (error?.code === 'INTERNAL_STAFF_REQUIRED' || error?.status === 403) deny(candidate);
          else if (error?.name !== 'AbortError') collection.error = errorText(error);
        } finally {
          collection.loading = false;
          render(candidate);
        }
      }
      function addFiles(candidate, kind, files) {
        if (!canWork(candidate) || candidate.busy || draftLocked(candidate)) return;
        editCompletedDraft(candidate);
        candidate.status = ''; candidate.statusError = false;
        for (const file of files) {
          if (candidate.attachments.length >= 10) { candidate.status = '每次最多添加 10 个图片或视频附件。'; candidate.statusError = true; break; }
          const allowed = kind === 'image' ? /\.(?:jpe?g|png|gif|webp)$/i : /\.(?:mp4|webm|mov|avi|mkv|ogv|mpeg|mpg|3gp|m4v|wmv)$/i;
          if (!allowed.test(file.name)) { candidate.status = `请选择支持的${kind === 'image' ? '图片' : '视频'}文件。`; candidate.statusError = true; continue; }
          const max = kind === 'image' ? 10 : 100;
          if (!file.size || file.size > max * 1024 * 1024) { candidate.status = `${kind === 'image' ? '图片' : '视频'}大小需大于 0，且不能超过 ${max} MB。`; candidate.statusError = true; continue; }
          candidate.attachments.push({ id: crypto.randomUUID(), kind, file, preview: URL.createObjectURL(file), uploaded: null });
        }
        renderAttachments(candidate); render(candidate);
      }
      async function send(candidate) {
        if (!canWork(candidate) || candidate.busy) return;
        // Only unfinished jobs keep their snapshot and request ID for retries.
        // A completed round starts a new job from the editable draft in this dialog.
        editCompletedDraft(candidate);
        if (!candidate.job) {
          const text = candidate.modal.querySelector('[data-broadcast-text]').value.trim();
          if (!candidate.selected.size || (!text && !candidate.attachments.length) || charCount(text) > 5000) return;
          candidate.job = { requestId: crypto.randomUUID(), text, attachments: [...candidate.attachments], targets: [...candidate.selected.values()], messages: null, done: new Set(), failed: new Map(), stop: false, complete: false };
        }
        const job = candidate.job;
        job.stop = false; job.failed.clear(); candidate.busy = true; candidate.statusError = false;
        render(candidate);
        try {
          if (!job.messages) {
            const messages = job.text ? [{ type: 'text', body: { text: job.text } }] : [];
            for (let index = 0; index < job.attachments.length; index++) {
              if (!canWork(candidate) || job.stop) break;
              const attachment = job.attachments[index];
              if (!attachment.uploaded) {
                candidate.status = `正在上传${attachment.kind === 'image' ? '图片' : '视频'} ${index + 1}/${job.attachments.length}…`; updateFooter(candidate);
                attachment.uploaded = await upload(attachment.kind, attachment.file, candidate.account.token, AbortSignal.any([candidate.controller.signal, AbortSignal.timeout(180000)]));
                if (!current(candidate)) return;
              }
              const uploaded = attachment.uploaded;
              messages.push({ type: attachment.kind, body: { url: uploaded.url, mime: uploaded.mime, size: uploaded.size, name: Array.from(attachment.file.name).slice(0, 255).join('') } });
            }
            if (!canWork(candidate) || job.stop) { candidate.status = '已停止群发。'; return; }
            job.messages = messages;
          }
          let stoppedThisTarget = false;
          for (const target of job.targets) {
            if (!canWork(candidate) || job.stop) break;
            const itemKey = key(target);
            if (job.done.has(itemKey)) continue;
            candidate.status = `正在发送 ${job.done.size + job.failed.size + 1}/${job.targets.length} · ${target.name}`; candidate.statusError = false; updateFooter(candidate);
            job.activeController = new AbortController();
            try {
              // Closing/stopping prevents subsequent targets. The in-flight request
              // retains its original token and idempotency key until it settles.
              const result = await request('/internal/broadcast/send', { method: 'POST', authToken: candidate.account.token, signal: AbortSignal.any([candidate.controller.signal, job.activeController.signal, AbortSignal.timeout(45000)]), body: JSON.stringify({ target: { type: target.type, id: target.id }, messages: job.messages, request_id: job.requestId }) });
              if (!current(candidate)) return;
              if (result.complete === true) job.done.add(itemKey);
              else job.failed.set(itemKey, result.error?.message || '部分消息未发送成功');
            } catch (error) {
              if (!current(candidate)) return;
              if (job.stop && job.activeController.signal.aborted) { stoppedThisTarget = true; break; }
              if (error?.code === 'INTERNAL_STAFF_REQUIRED' || error?.status === 403) { deny(candidate); break; }
              job.failed.set(itemKey, errorText(error));
              // A lost connection must not trigger a burst of more requests.
              if (!error?.status || error.status >= 500 || error.status === 401 || error.status === 426) { job.stop = true; break; }
            } finally {
              job.activeController = null;
            }
            render(candidate);
          }
          if (!current(candidate) || candidate.denied) return;
          job.complete = job.done.size === job.targets.length;
          if (stoppedThisTarget) {
            candidate.status = `已停止群发，${job.done.size}/${job.targets.length} 个目标已完成。`;
            candidate.statusError = false;
          } else if (job.complete) {
            candidate.hasCompleted = true;
            clearDraft(candidate);
          }
          const remaining = job.targets.length - job.done.size;
          if (!job.stop) candidate.status = job.complete ? `群发完成，已发送至 ${job.done.size} 个目标。内容已清空，可输入新消息继续群发。` : `已发送 ${job.done.size}/${job.targets.length} 个目标，${remaining} 个尚未完成。${job.failed.size ? '可继续发送未完成的目标。' : ''}`;
          candidate.statusError = !stoppedThisTarget && job.failed.size > 0;
          const failures = candidate.modal.querySelector('[data-broadcast-failures]');
          failures.hidden = !job.failed.size;
          failures.textContent = job.targets.filter(target => job.failed.has(key(target))).map(target => `${target.name}：${job.failed.get(key(target))}`).join('\n');
        } catch (error) { handleError(candidate, error); }
        finally {
          candidate.busy = false;
          if (current(candidate)) { render(candidate); if (job.done.size) onSent?.(); }
        }
      }
      function open() {
        close();
        const account = { ...getAccount() };
        if (!account.token || !account.userId || !account.internalStaff || account.blocked) return;
        const modal = document.createElement('div');
        modal.className = 'modal-backdrop broadcast-backdrop'; modal.id = 'broadcast-modal';
        modal.innerHTML = `<section class="broadcast-modal" role="dialog" aria-modal="true" aria-labelledby="broadcast-title"><header class="broadcast-head"><h2 id="broadcast-title">群发消息</h2><button type="button" data-broadcast-close aria-label="关闭群发助手">×</button></header><div class="broadcast-body"><section class="broadcast-picker" aria-label="选择发送目标"><div class="broadcast-section-title"><strong>选择发送目标</strong><span data-broadcast-selected>已选 0 个</span></div><div class="broadcast-tabs" role="tablist" aria-label="发送目标类型"><button type="button" role="tab" data-broadcast-tab="friend" aria-controls="broadcast-target-list">好友 (0)</button><button type="button" role="tab" data-broadcast-tab="group" aria-controls="broadcast-target-list">群组 (0)</button></div><label class="broadcast-search">${icons.search}<input type="search" data-broadcast-search placeholder="搜索好友" aria-label="搜索好友"></label><label class="broadcast-select-all"><input type="checkbox" data-broadcast-all><span data-broadcast-all-label>全选</span></label><div class="broadcast-targets" id="broadcast-target-list" data-broadcast-targets></div></section><section class="broadcast-editor" aria-label="编辑消息内容"><div class="broadcast-section-title"><strong>编辑消息内容</strong></div><div class="broadcast-text-wrap"><textarea data-broadcast-text aria-label="群发消息内容" maxlength="10000" placeholder="输入要群发的消息…"></textarea><small data-broadcast-count>0/5000</small></div><div class="broadcast-preview"><small data-broadcast-preview-label hidden>附件预览</small><div class="broadcast-attachments" data-broadcast-attachments></div></div><div class="broadcast-failures" data-broadcast-failures hidden></div><div class="broadcast-attachment-tools"><button type="button" data-broadcast-add="image">${icons.image}图片</button><button type="button" data-broadcast-add="video">${icons.video}视频</button><input type="file" data-broadcast-file="image" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden><input type="file" data-broadcast-file="video" accept="video/*,.mkv,.avi,.wmv,.m4v" multiple hidden></div></section></div><footer class="broadcast-footer"><p data-broadcast-status role="status" aria-live="polite"></p><button type="button" data-broadcast-new hidden>新建群发</button><button type="button" data-broadcast-cancel>取消</button><button type="button" class="broadcast-send" data-broadcast-send disabled>发送</button></footer></section>`;
        const candidate = { account, modal, previousFocus: document.activeElement, controller: new AbortController(), tab: 'friend', search: { friend: '', group: '' },
          targets: { friend: { items: [], total: 0, loading: false, loaded: false, error: '' }, group: { items: [], total: 0, loading: false, loaded: false, error: '' } },
          selected: new Map(), attachments: [], job: null, hasCompleted: false, busy: false, denied: false, closed: false, status: '', statusError: false };
        view = candidate; document.body.append(modal);
        const { signal } = candidate.controller;
        modal.addEventListener('click', event => {
          if (event.target === modal || event.target.closest('[data-broadcast-close]')) { close(); return; }
          const tab = event.target.closest('[data-broadcast-tab]');
          if (tab) { candidate.tab = tab.dataset.broadcastTab; modal.querySelector('[data-broadcast-targets]').scrollTop = 0; render(candidate); return; }
          const add = event.target.closest('[data-broadcast-add]');
          if (add && !add.disabled) modal.querySelector(`[data-broadcast-file="${add.dataset.broadcastAdd}"]`).click();
          const remove = event.target.closest('[data-broadcast-remove]');
          if (remove && canWork(candidate) && !candidate.busy && !draftLocked(candidate) && !remove.disabled) { editCompletedDraft(candidate); const index = candidate.attachments.findIndex(item => item.id === remove.dataset.broadcastRemove); if (index >= 0) { URL.revokeObjectURL(candidate.attachments[index].preview); candidate.attachments.splice(index, 1); candidate.status = ''; candidate.statusError = false; renderAttachments(candidate); render(candidate); } }
          const reload = event.target.closest('[data-broadcast-reload]');
          if (reload && !reload.disabled) void loadTargets(candidate, reload.dataset.broadcastReload);
          if (event.target.closest('[data-broadcast-send]')) void send(candidate);
          if (event.target.closest('[data-broadcast-cancel]')) {
            if (candidate.busy) { candidate.job.stop = true; candidate.job.activeController?.abort(); candidate.status = '正在停止，撤销当前尚未发送的目标…'; updateFooter(candidate); }
            else close();
          }
          if (event.target.closest('[data-broadcast-new]') && !candidate.busy && !candidate.denied) {
            candidate.job = null; candidate.status = ''; candidate.statusError = false;
            clearDraft(candidate);
            modal.querySelector('[data-broadcast-failures]').hidden = true;
            render(candidate); modal.querySelector('[data-broadcast-text]').focus();
          }
        }, { signal });
        modal.addEventListener('change', event => {
          const input = event.target;
          if (input.matches('[data-broadcast-file]')) { addFiles(candidate, input.dataset.broadcastFile, [...input.files]); input.value = ''; return; }
          // Text/search blur also emits change. Rebuilding recipient rows then
          // would replace the checkbox between pointer-down and pointer-up.
          if (!input.matches('[data-broadcast-target], [data-broadcast-all]') || !canWork(candidate) || candidate.busy || draftLocked(candidate)) return;
          editCompletedDraft(candidate);
          if (input.matches('[data-broadcast-target]')) {
            const item = candidate.targets[candidate.tab].items.find(item => key(item) === input.dataset.broadcastTarget);
            if (item) { if (input.checked) candidate.selected.set(key(item), item); else candidate.selected.delete(key(item)); }
          } else if (input.matches('[data-broadcast-all]') && !input.disabled) {
            for (const item of visibleTargets(candidate)) { if (input.checked) candidate.selected.set(key(item), item); else candidate.selected.delete(key(item)); }
          }
          candidate.status = ''; candidate.statusError = false; render(candidate);
        }, { signal });
        modal.addEventListener('input', event => {
          if (event.target.matches('[data-broadcast-search]')) { candidate.search[candidate.tab] = event.target.value; render(candidate); }
          if (event.target.matches('[data-broadcast-text]') && canWork(candidate) && !candidate.busy && !draftLocked(candidate)) { const completed = candidate.job?.complete; editCompletedDraft(candidate); candidate.status = ''; candidate.statusError = false; if (completed) render(candidate); else updateFooter(candidate); }
        }, { signal });
        document.addEventListener('keydown', event => {
          if (!current(candidate)) { close(); return; }
          if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
          if (event.key === 'Tab') {
            const nodes = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled):not([hidden]), textarea:not(:disabled)')].filter(node => node.getClientRects().length);
            const first = nodes[0], last = nodes.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }, { signal, capture: true });
        render(candidate); modal.querySelector('[data-broadcast-search]').focus();
        void Promise.allSettled([loadTargets(candidate, 'friend'), loadTargets(candidate, 'group')]);
      }
      return { open, close };
    },
  };
})();
