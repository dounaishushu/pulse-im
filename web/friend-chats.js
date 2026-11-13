/* One durable cursor per account/device. Read receipts never consume chat opens. */
window.PulseFriendChats = (() => {
  const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
  function create(options) {
    let owner = '', generation = 0, task = null, pending = null, queued = false;
    const snapshot = () => {
      const a = options.context();
      const key = a?.token && positive(a.userId) ? JSON.stringify([a.base, Number(a.userId)]) : '';
      if (owner !== `${key}:${a?.token || ''}`) {
        owner = `${key}:${a?.token || ''}`; generation++; task = null; pending = null; queued = false;
      }
      return { ...a, key, generation };
    };
    // Updating the list must not depend on being free to navigate (recording,
    // photo selection, or another page can defer presentation for much longer).
    const canSync = a => a.syncAllowed ?? a.allowed;
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
      const run = (async () => {
        while (pending && current(a)) {
          const event = pending; pending = null;
          if (Number(event.id) <= cursor(a)) continue;
          try {
            if ((synchronized.get(owner) || 0) < Number(event.id)) {
              if (options.synchronize && !await options.synchronize(event, a, () => current(a))) throw Error('Friend list refresh incomplete');
              if (!current(a)) return;
              synchronized.set(owner, Number(event.id));
            }
            if (!snapshot().allowed) { pending = pending && pending.id > event.id ? pending : event; break; }
            const opened = await options.open(event, a, () => current(a) && snapshot().allowed);
            if (!current(a)) return;
            if (!opened) { pending = pending && pending.id > event.id ? pending : event; break; }
            const next = Math.max(cursor(a), Number(event.id)); memory.set(a.key, next);
            try { options.storage.setItem(storageKey(a), String(next)); } catch {}
          } catch {
            if (current(a)) pending = pending && pending.id > event.id ? pending : event;
            break;
          }
        }
      })();
      task = run;
      try { await run; } finally { if (a.generation === generation && task === run) task = null; }
    }
    async function offer(event, account) {
      const a = snapshot();
      if (account && (account.token !== a.token || Number(account.userId) !== Number(a.userId))) return;
      if (!a.key || !valid(event) || Number(event.id) <= cursor(a)) return;
      if (!pending || Number(event.id) > Number(pending.id)) pending = event;
      await drain(a);
    }
    let refreshing = null;
    async function refresh() {
      const a = snapshot(); if (!a.key || !canSync(a)) return;
      if (refreshing?.generation === a.generation) { queued = true; return refreshing.promise; }
      const refresh = { generation: a.generation };
      refresh.promise = (async () => {
        try {
          const result = await options.request(`/notifications/friend-chats?after_id=${cursor(a)}`, { authToken: a.token });
          if (!current(a)) return;
          const newest = (result.items || []).filter(valid).sort((x, y) => Number(y.id) - Number(x.id))[0];
          if (newest) await offer(newest, a);
          else await drain(a);
        } catch { if (current(a)) await drain(a); }
      })();
      refreshing = refresh;
      try { await refresh.promise; }
      finally {
        if (refreshing === refresh) {
          refreshing = null;
          if (queued && current(a)) { queued = false; void refreshSoon(); }
        }
      }
    }
    let timer;
    function refreshSoon() { clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 100); }
    return { refresh, changed: refreshSoon, offer };
  }
  return { create };
})();
