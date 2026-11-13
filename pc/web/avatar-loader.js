// Recover only avatar images. Message attachments keep their existing loading policy.
(() => {
  'use strict';
  const frames = ['avatar', 'conversation-avatar', 'classic-avatar-button', 'desktop-avatar', 'contact-avatar', 'friend-card-avatar', 'profile-avatar', 'group-avatar',
    'member-avatar', 'classic-drawer-avatar', 'classic-drawer-account-avatar', 'classic-settings-avatar',
    'classic-profile-detail-avatar', 'classic-group-info-avatar', 'classic-panel-avatar', 'classic-search-sender-avatar',
    'classic-privacy-picker-avatar', 'classic-message-avatar', 'group-message-avatar', 'contact-modal-avatar',
    'contact-card-message-avatar', 'new-friend-request-avatar', 'forward-recipient-avatar', 'group-create-person-avatar',
    'group-invite-avatar', 'received-card-avatar', 'gs-avatar', 'gm-avatar', 'activity-avatar', 'broadcast-avatar'];
  const selector = frames.map(name => `.${name} > img`).join(',') + ',img[data-message-avatar-fallback]';
  let controller;
  function create({ context, request, mediaPath, report, persist, drop, timeout = 8000, retryDelays = [400, 1600], cooldown = 30000,
    maxEntries = 96, maxBytes = 12 * 1024 * 1024, maxImageBytes = 8 * 1024 * 1024 }) {
    let owner = '', disposed = false, running = 0, generation = 0, logCount = 0, logStart = Date.now();
    const records = new WeakMap(), entries = new Map(), queue = [], timers = new Set();
    const identity = value => window.PulseMessageView.mediaIdentity(value);
    const accountKey = value => value?.token && Number(value.userId) > 0 ? JSON.stringify([value.base, value.token, Number(value.userId)]) : '';
    function clear() {
      generation++; queue.length = 0;
      for (const timer of timers) clearTimeout(timer); timers.clear();
      for (const entry of entries.values()) { entry.abort?.abort(); if (entry.url) URL.revokeObjectURL(entry.url); }
      entries.clear(); owner = '';
    }
    function account() {
      const value = context(), key = accountKey(value);
      if (key !== owner) { clear(); owner = key; }
      return !disposed && key ? value : null;
    }
    function diagnostic(entry, kind, code, status = 0) {
      if (Date.now() - logStart >= 60000) { logCount = 0; logStart = Date.now(); }
      if (++logCount > 20) return;
      try { report({ kind, code, source: entry.source, area: entry.area, status, attempt: entry.attempt,
        elapsedMs: Math.max(0, Date.now() - entry.started), online: navigator.onLine !== false }); } catch { /* Diagnostics never block recovery. */ }
    }
    function area(img) { return frames.find(name => img.parentElement?.classList.contains(name)) || 'message-avatar'; }
    function fallback(img, value) {
      const frame = img.parentElement; if (!frame) return;
      if (value) {
        const rowName = frame.closest('.conversation,.group-create-person,.gs-member,.friend-row,.classic-drawer-account,.forward-recipient')
          ?.querySelector('strong,.classic-drawer-account-name')?.textContent.trim();
        const name = img.dataset.messageAvatarFallback || img.dataset.avatarFallback || frame.textContent.trim() || rowName
          || frame.getAttribute('aria-label') || frame.title || '?';
        frame.setAttribute('data-avatar-load-placeholder', Array.from(name)[0] || '?');
        img.setAttribute('data-avatar-load-state', value);
      } else { frame.removeAttribute('data-avatar-load-placeholder'); img.removeAttribute('data-avatar-load-state'); }
    }
    function valid(img, record) {
      return img.isConnected && records.get(img) === record && account() && record.owner === owner
        && (img.getAttribute('src') === record.source || img.getAttribute('src') === record.entry?.url);
    }
    function apply(img, record, entry) {
      if (!valid(img, record)) return;
      record.entry = entry;
      if (entry.state === 'ready') { fallback(img, 'loading'); if (img.getAttribute('src') !== entry.url) img.src = entry.url; }
      else fallback(img, entry.state === 'failed' ? 'failed' : 'loading');
    }
    function prune() {
      let bytes = [...entries.values()].reduce((sum, value) => sum + (value.bytes || 0), 0);
      for (const [key, entry] of entries) {
        if (entries.size <= maxEntries && bytes <= maxBytes) break;
        if (entry.state === 'pending') continue;
        entries.delete(key); bytes -= entry.bytes || 0;
        if (entry.url) URL.revokeObjectURL(entry.url);
      }
    }
    const delay = (ms, signal) => new Promise(resolve => {
      if (signal.aborted) return resolve();
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
    });
    function update(entry) {
      for (const img of document.querySelectorAll(selector)) {
        const record = records.get(img);
        if (record?.key === entry.key && record.owner === owner) apply(img, record, entry);
      }
    }
    async function load(entry, value, epoch) {
      entry.abort = new AbortController();
      try {
        for (let i = 0; i < retryDelays.length; i++) {
          await delay(retryDelays[i], entry.abort.signal);
          if (entry.abort.signal.aborted || epoch !== generation || accountKey(context()) !== owner) return;
          entry.attempt = i + 1;
          let code = 'AVATAR_NETWORK', status = 0, transient = true;
          try {
            const signal = AbortSignal.any([entry.abort.signal, AbortSignal.timeout(timeout)]);
            const response = await request(entry.path, value, signal);
            if (signal.aborted) throw signal.reason;
            status = response.status;
            if (!response.ok) { code = `AVATAR_HTTP_${status}`; transient = [408, 429].includes(status) || status >= 500; await response.body?.cancel(); }
            else {
              const type = response.headers.get('content-type') || '';
              if (!/^image\/(?:jpeg|png|gif|webp|avif|bmp)(?:;|$)/i.test(type)) { code = 'AVATAR_CONTENT_TYPE'; transient = false; await response.body?.cancel(); }
              else if (Number(response.headers.get('content-length')) > maxImageBytes) { code = 'AVATAR_TOO_LARGE'; transient = false; await response.body?.cancel(); }
              else {
                const reader = response.body.getReader(), chunks = []; let size = 0;
                try {
                  for (;;) {
                    if (signal.aborted) throw signal.reason;
                    const next = await reader.read(); if (next.done) break;
                    size += next.value.length; if (size > maxImageBytes) { await reader.cancel(); throw Object.assign(Error(), { avatarTooLarge: true }); }
                    chunks.push(next.value);
                  }
                } finally { reader.releaseLock(); }
                if (!size) { code = 'AVATAR_EMPTY'; transient = false; }
                else {
                  if (entry.abort.signal.aborted || epoch !== generation || accountKey(context()) !== owner) return;
                  entry.blob = new Blob(chunks, { type }); entry.url = URL.createObjectURL(entry.blob); entry.bytes = size; entry.state = 'ready';
                  update(entry); prune(); return;
                }
              }
            }
          } catch (error) {
            if (entry.abort.signal.aborted || epoch !== generation) return;
            if (error?.avatarTooLarge) { code = 'AVATAR_TOO_LARGE'; transient = false; }
            else if (error?.name === 'TimeoutError' || error?.name === 'AbortError') code = 'AVATAR_TIMEOUT';
            else if (navigator.onLine === false) code = 'AVATAR_OFFLINE';
          }
          diagnostic(entry, 'avatar-load-failed', code, status);
          entry.transient = transient;
          if (!transient) break;
        }
        entry.state = 'failed'; entry.retryAt = Date.now() + cooldown; update(entry);
      } finally { entry.abort = null; }
    }
    function pump() {
      while (running < 4 && queue.length && !disposed) {
        const { entry, value, epoch } = queue.shift();
        if (epoch !== generation) continue;
        running++;
        void load(entry, value, epoch).catch(() => { /* Unexpected failures must not become renderer rejections. */ })
          .finally(() => { running--; prune(); pump(); });
      }
    }
    function recover(img, record) {
      if (!valid(img, record)) return;
      const value = account(); if (!value) return;
      let entry = entries.get(record.key);
      if (entry && (entry.state !== 'failed' || !entry.transient || Date.now() < entry.retryAt)) { apply(img, record, entry); return; }
      if (queue.length >= 64) { fallback(img, 'failed'); return; }
      const path = mediaPath(record.source);
      if (!path) {
        entry = { key: record.key, source: record.source, area: area(img), started: Date.now(), attempt: 0, state: 'failed', transient: false };
        entries.set(record.key, entry); record.entry = entry; fallback(img, 'failed');
        diagnostic(entry, 'avatar-load-failed', 'AVATAR_SOURCE_UNSUPPORTED'); prune(); return;
      }
      entry = { key: record.key, source: record.source, path, area: area(img), started: Date.now(), attempt: 0, state: 'pending' };
      const expires = Number(new URL(record.source, document.baseURI).searchParams.get('media_expires'));
      diagnostic(entry, 'avatar-load-failed', expires > 0 && expires * 1000 < Date.now() ? 'AVATAR_GRANT_EXPIRED' : record.timedOut ? 'AVATAR_TIMEOUT' : 'AVATAR_IMAGE_ERROR');
      entries.delete(record.key); entries.set(record.key, entry); record.entry = entry;
      fallback(img, 'loading'); queue.push({ entry, value, epoch: generation }); prune(); pump();
    }
    function observe(img) {
      if (!img.matches(selector) || !img.isConnected || !account()) return;
      const source = img.getAttribute('src'); if (!source) return;
      let record = records.get(img);
      if (record?.owner === owner && (source === record.source || source === record.entry?.url)) {
        if (img.complete && img.naturalWidth) fallback(img, '');
        return record;
      }
      fallback(img, '');
      if (record?.timer) { clearTimeout(record.timer); timers.delete(record.timer); }
      record = { source, owner, key: identity(source) }; records.set(img, record);
      const entry = entries.get(record.key);
      if (entry) { entries.delete(record.key); entries.set(record.key, entry); apply(img, record, entry); }
      else if (img.complete && !img.naturalWidth) recover(img, record);
      else if (!img.complete && timers.size < 256) {
        const timer = record.timer = setTimeout(() => {
          timers.delete(timer); record.timer = null;
          if (valid(img, record) && !img.naturalWidth) { record.timedOut = true; recover(img, record); }
        }, timeout); timers.add(timer);
      }
      return record;
    }
    function scan(node = document) {
      if (node.nodeType === 1 && node.matches('img')) observe(node);
      node.querySelectorAll?.(selector).forEach(observe);
    }
    function failed(event) {
      const img = event.target; if (!img?.matches?.(selector)) return;
      const failedSource = img.getAttribute('src');
      const record = observe(img); if (!record) return;
      if (drop && failedSource.startsWith('pulse-avatar:')) Promise.resolve(drop(failedSource, context())).catch(()=>{});
      if (record.timer) { clearTimeout(record.timer); timers.delete(record.timer); record.timer = null; }
      // Existing per-view handlers remove failed avatars; keep the node so it can recover.
      event.stopImmediatePropagation();
      if (failedSource !== img.getAttribute('src')) return;
      if (record.entry?.url === failedSource) {
        const entry = record.entry; entry.state = 'failed'; entry.transient = false;
        diagnostic(entry, 'avatar-load-failed', 'AVATAR_DECODE'); update(entry); URL.revokeObjectURL(entry.url); entry.url = ''; fallback(img, 'failed');
      } else recover(img, record);
    }
    function loaded(event) {
      const img = event.target, record = records.get(img); if (!record || !valid(img, record)) return;
      if (record.timer) { clearTimeout(record.timer); timers.delete(record.timer); record.timer = null; }
      fallback(img, '');
      const entry = record.entry;
      if (entry?.state === 'ready' && img.getAttribute('src') === entry.url && !entry.reported) {
        entry.reported = true; diagnostic(entry, 'avatar-load-recovered', 'AVATAR_RECOVERED', 200);
        if (persist && entry.blob) {
          const c = context(), expected = generation, blob = entry.blob;
          void blob.arrayBuffer().then(bytes => { if (expected === generation && accountKey(c) === accountKey(context())) return persist(entry.source, bytes, blob.type, c); }).catch(()=>{});
        }
      }
    }
    const observer = new MutationObserver(changes => {
      for (const change of changes) {
        if (change.type === 'attributes') observe(change.target);
        else change.addedNodes.forEach(scan);
      }
    });
    function resume() {
      if (!account()) return;
      for (const img of document.querySelectorAll(selector)) {
        const record = observe(img);
        if (record && img.complete && !img.naturalWidth) recover(img, record);
      }
    }
    document.addEventListener('error', failed, true); document.addEventListener('load', loaded, true);
    window.addEventListener('online', resume); window.addEventListener('focus', resume);
    const timer = setInterval(() => { if (!document.hidden) resume(); }, cooldown);
    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] }); scan();
    return {
      clear,
      retainSource(img, source) {
        const record = records.get(img);
        if (!record || !account() || record.owner !== owner || record.key !== identity(source)) return false;
        record.source = source;
        return record.entry?.state === 'ready' && record.entry.url === img.getAttribute('src');
      },
      dispose() {
        disposed = true; clear(); clearInterval(timer); observer.disconnect();
        document.removeEventListener('error', failed, true); document.removeEventListener('load', loaded, true);
        window.removeEventListener('online', resume); window.removeEventListener('focus', resume);
      },
    };
  }
  window.PulseAvatarLoader = Object.freeze({
    create(options) { controller?.dispose(); return controller = create(options); },
    retainSource(node, source) { return controller?.retainSource(node, source) === true; },
  });
})();
