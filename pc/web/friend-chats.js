/* One durable cursor per account/device. Read receipts never consume chat opens. */
window.PulseFriendChats = (() => {
  const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
  function create(options) {
    let owner = '', generation = 0, task = null, pending = null, queued = false, refreshing = null, timer = null, paused = false, disposed = false;
    function cancelReads() {
      clearTimeout(timer); timer = null; queued = false;
      const oldRefresh = refreshing, oldTask = task; refreshing = null; task = null;
      oldRefresh?.controller.abort(); oldTask?.controller.abort();
    }
    const snapshot = () => {
      const a = options.context();
      const key = a?.token && positive(a.userId) ? JSON.stringify([a.base, Number(a.userId)]) : '';
      if (owner !== `${key}:${a?.token || ''}`) {
        cancelReads(); synchronized.delete(owner);
        owner = `${key}:${a?.token || ''}`; generation++; pending = null;
      }
      return { ...a, key, generation };
    };
    // Updating the list must not depend on being free to navigate (recording,
    // photo selection, or another page can defer presentation for much longer).
    const canSync = a => !paused && !disposed && (a.syncAllowed ?? a.allowed);
    const current = a => { const b = snapshot(); return a.generation === b.generation && a.key === b.key && a.token === b.token && canSync(b); };
    const storageKey = a => `pulse_friend_chat_v1:${a.key}`;
    const memory = new Map(), synchronized = new Map();
    const cursor = a => {
      let saved = 0;
      try { saved = Number(options.storage.getItem(storageKey(a))) || 0; } catch {}
      return Math.max(memory.get(a.key) || 0, saved);
    };
    const valid = event => event && positive(event.id) && positive(event.conversation_id) && positive(event.peer_user_id);
    async function drain(a) {
      if (!current(a) || task || !pending) return;
      const run = { controller: new AbortController() }; task = run;
      const active = () => task === run && !run.controller.signal.aborted && current(a);
      run.promise = (async () => {
        while (pending && active()) {
          const event = pending;
          if (Number(event.id) <= cursor(a)) { if (pending === event) pending = null; continue; }
          try {
            if ((synchronized.get(owner) || 0) < Number(event.id)) {
              if (options.synchronize && !await options.synchronize(event, a, active, { signal: run.controller.signal })) throw Error('Friend list refresh incomplete');
              if (!active()) return;
              synchronized.set(owner, Number(event.id));
            }
            if (!snapshot().allowed) { pending = pending && pending.id > event.id ? pending : event; break; }
            const opened = await options.open(event, a, () => active() && snapshot().allowed, { signal: run.controller.signal });
            if (!active()) return;
            if (!opened) { pending = pending && pending.id > event.id ? pending : event; break; }
            const next = Math.max(cursor(a), Number(event.id)); memory.set(a.key, next);
            try { options.storage.setItem(storageKey(a), String(next)); } catch {}
            if (pending === event) pending = null;
          } catch {
            if (active()) pending = pending && pending.id > event.id ? pending : event;
            break;
          }
        }
      })();
      try { await run.promise; } finally { if (task === run) task = null; }
    }
    async function offer(event, account) {
      if (disposed) return;
      const a = snapshot();
      if (account && (account.token !== a.token || Number(account.userId) !== Number(a.userId) || (account.base !== undefined && account.base !== a.base))) return;
      if (!a.key || !valid(event) || Number(event.id) <= cursor(a)) return;
      if (!pending || Number(event.id) > Number(pending.id)) pending = event;
      await drain(a);
    }
    async function refresh() {
      if (disposed) return;
      const a = snapshot(); if (!a.key || !canSync(a)) return;
      if (refreshing?.generation === a.generation) { queued = true; return refreshing.promise; }
      const refresh = { generation: a.generation, controller: new AbortController() }; refreshing = refresh;
      refresh.promise = (async () => {
        try {
          const result = await options.request(`/notifications/friend-chats?after_id=${cursor(a)}`, { authToken: a.token, signal: refresh.controller.signal });
          if (refreshing !== refresh || refresh.controller.signal.aborted || !current(a)) return;
          const newest = (result.items || []).filter(valid).sort((x, y) => Number(y.id) - Number(x.id))[0];
          if (newest) await offer(newest, a);
          else await drain(a);
        } catch { if (refreshing === refresh && !refresh.controller.signal.aborted && current(a)) await drain(a); }
      })();
      try { await refresh.promise; }
      finally {
        if (refreshing === refresh) {
          refreshing = null;
          if (queued && current(a)) { queued = false; void refreshSoon(); }
        }
      }
    }
    function refreshSoon() { clearTimeout(timer); timer = null; if (!paused && !disposed) timer = setTimeout(() => { timer = null; void refresh(); }, 100); }
    function reset() { cancelReads(); generation++; synchronized.delete(owner); owner = ''; pending = null; }
    return { refresh, changed: refreshSoon, offer, reset,
      pause() { paused = true; cancelReads(); },
      resume() { if (disposed) return; paused = false; return refresh(); },
      dispose() { disposed = true; paused = true; reset(); memory.clear(); synchronized.clear(); },
    };
  }
  return { create };
})();
