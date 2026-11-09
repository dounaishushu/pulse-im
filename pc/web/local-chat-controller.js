(function(root) {
  'use strict';
  root.PulseLocalChat = function create({ enabled, owner, request, denied = () => {}, failed = () => {} }) {
    const store = root.PulseLocalChatStore({ enabled, owner });
    const queued = new Map(), events = new Map(); let running = false, timer, eventTimer, epoch = 0, active;
    const same = identity => identity && identity === owner();
    const quiet = operation => new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timeout); resolve(value); };
      const report = code => { try { failed(code); } catch {} };
      const timeout = setTimeout(() => { report('PC-MSG-CACHE-TIMEOUT'); finish(null); }, 5000);
      Promise.resolve().then(operation).then(finish, () => { if (!settled) report('PC-MSG-CACHE-FAILED'); finish(null); });
    });
    const guarded = operation => { const identity = owner(); return quiet(() => same(identity) ? operation() : null); };
    function validPage(result, cid, before = Number.MAX_SAFE_INTEGER) {
      if (!Array.isArray(result?.items) || result.items.length > 100 || result.items.some(m => !Number.isSafeInteger(Number(m.id)) || Number(m.id) <= 0 || Number(m.id) > before || Number(m.conversation_id) !== cid)
        || new Set(result.items.map(m => Number(m.id))).size !== result.items.length) throw Error('LOCAL_CHAT_INVALID_PAGE');
      return result.items;
    }
    function paging(result) {
      const ids = result.items.map(m => Number(m.id)), next = ids.length ? Math.max(0, Math.min(...ids) - 1) : 0;
      const more = ids.length > 0 && next > 0 && (typeof result.has_more === 'boolean' ? result.has_more : Number.isFinite(Number(result.total)) ? Number(result.total) > ids.length : true);
      return { cursor: next, complete: !more };
    }
    async function savePage(cid, result, options = {}) {
      if (!enabled || !owner()) return null;
      const values = validPage(result, cid, options.before || Number.MAX_SAFE_INTEGER), next = paging(result);
      const ids = values.map(m => Number(m.id)), ticket = options.ticket || await store.ticket(cid);
      await store.save(cid, values, { ticket, cleared: options.cleared, conversation: options.conversation, ...next, latest: !options.before,
        floor: ids.length ? Math.min(...ids) : Number(options.cleared || 0) + 1, maximum: options.before || (ids.length ? Math.max(...ids) : Number.MAX_SAFE_INTEGER) });
      const saved = await store.read(cid, { limit: 1 });
      return { cursor: saved.meta.cursor, complete: saved.meta.complete };
    }
    function enqueue(cid, { latest = false } = {}) {
      if (!enabled || !owner()) return;
      if (queued.has(cid)) { queued.get(cid).latest ||= latest; return; }
      if (queued.size >= 32) queued.delete(queued.keys().next().value);
      queued.set(cid, { identity: owner(), epoch, latest }); clearTimeout(timer); timer = setTimeout(pump, 3000);
    }
    async function pump() {
      if (running) return; running = true;
      try {
        while (queued.size) {
          const [cid, work] = queued.entries().next().value; queued.delete(cid);
          if (!same(work.identity) || work.epoch !== epoch) continue;
          try {
            let page = await store.read(cid, { limit: 1 });
            // A slow first cache open may miss the foreground write checkpoint.
            // Capture a new ticket before a fresh read; never persist the old page
            // under a ticket obtained after that page's network request began.
            if (work.latest && same(work.identity) && work.epoch === epoch) {
              const ticket = await store.ticket(cid), controller = new AbortController(); active = controller;
              const result = await request(`/messages/history?conversation_id=${cid}&size=50`, { signal: controller.signal }, work.identity);
              if (!same(work.identity) || work.epoch !== epoch) continue;
              await savePage(cid, result, { ticket, cleared: page.meta.cleared });
              page = await store.read(cid, { limit: 1 });
            }
            let cursor = page.meta.cursor;
            while (!page.meta.complete && Number.isSafeInteger(cursor) && cursor > 0 && same(work.identity) && work.epoch === epoch) {
              const ticket = await store.ticket(cid), controller = new AbortController(); active = controller;
              const result = await request(`/messages/history?conversation_id=${cid}&page=1&size=50&max_id=${cursor}`, { signal: controller.signal }, work.identity);
              if (!same(work.identity) || work.epoch !== epoch) break;
              validPage(result, cid, cursor);
              const next = await savePage(cid, result, { ticket, before: cursor, cleared: page.meta.cleared });
              if (!next || next.complete || next.cursor >= cursor) break;
              cursor = next.cursor; await new Promise(resolve => setTimeout(resolve, 150));
            }
          } catch (error) {
            if ([401,403].includes(error.status) && same(work.identity) && work.epoch === epoch) { await store.clearConversation(cid); denied(cid); }
            // Other failures leave the checkpoint for the next opening.
          }
        }
      } finally { active = null; running = false; }
    }
    function event(type, message) {
      if (!enabled || !owner() || !Number.isSafeInteger(Number(message?.conversation_id)) || !Number.isSafeInteger(Number(message?.id))) return;
      const identity = owner(), cid = Number(message.conversation_id), value = JSON.parse(JSON.stringify(message));
      if (['message.recalled', 'message.deleted'].includes(type)) value.status = 'deleted';
      if (!events.has(cid)) events.set(cid, new Map()); events.get(cid).set(Number(message.id), { identity, value });
      if (eventTimer) return;
      eventTimer = setTimeout(() => {
        eventTimer = null;
        const pending = [...events]; events.clear();
        for (const [conversation, rows] of pending) {
          const values = [...rows.values()].filter(r => same(r.identity)).map(r => r.value);
          if (values.length) void guarded(() => store.save(conversation, values, { event: true }));
        }
      }, 40);
    }
    function stop() { epoch++; queued.clear(); events.clear(); clearTimeout(timer); clearTimeout(eventTimer); eventTimer = null; active?.abort(); }
    return {
      enabled, read: (...args) => enabled ? guarded(() => store.read(...args)) : Promise.resolve(null),
      ticket: cid => enabled ? guarded(() => store.ticket(cid)) : Promise.resolve(null),
      savePage: (...args) => enabled ? guarded(() => savePage(...args)) : Promise.resolve(null),
      reconcile: (cid, values, options) => enabled ? guarded(() => store.save(cid, values, options)) : Promise.resolve(null),
      clearConversation: (cid, cutoff) => { stop(); return enabled ? guarded(() => store.clearConversation(cid, cutoff)) : Promise.resolve(); },
      clear: () => { stop(); return enabled ? guarded(() => store.clear()) : Promise.resolve(); },
      event, enqueue, stop
    };
  };
})(globalThis);
