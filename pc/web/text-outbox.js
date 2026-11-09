/* Immediate text capture with ordered, idempotent delivery per conversation. */
(function (root) {
  function create({ send, allowed, changed, accepted, store = null, storageError = () => {}, concurrency = 2 }) {
    const items = new Map(), lanes = new Map(), flights = new Set();
    const restoring = new Map(), restored = new Set(), generations = new Map(), warned = new Set(), storageDisabled = new Set();
    const accounts = new Map(), paused = new Set(), persisting = new Map(), releasing = new Map();
    const limit = Math.max(1, Math.min(4, Number.isInteger(concurrency) ? concurrency : 2));
    let scheduled = false, disposed = false;
    const accountKey = account => JSON.stringify([account.token, account.userId]);
    const ownerKey = account => Number(account.userId); // The enclosing store supplies the server namespace.
    const laneKey = item => JSON.stringify([accountKey(item.account), item.payload.conversation_id]);
    const generation = key => generations.get(key);
    function remember(account) {
      const key = accountKey(account);
      if (!generations.has(key)) generations.set(key, Symbol());
      accounts.set(key, { ...account }); return key;
    }
    const owns = item => items.get(item.id) === item;
    const notify = () => { if (!disposed) changed(); };
    function warn(account, error) { const key = accountKey(account); if (!warned.has(key)) { warned.add(key); storageError(error, account); } }
    function restore(account) {
      if (!store) return Promise.resolve();
      const key = remember(account), epoch = generation(key);
      if (restoring.has(key)) return restoring.get(key);
      if (restored.has(key)) return Promise.resolve();
      const release = releasing.get(ownerKey(account));
      const task = Promise.resolve(release).then(() => store.load(account)).then(records => {
        if (generation(key) !== epoch) return;
        const current = [...items.values()].filter(item => accountKey(item.account) === key);
        for (const item of current) items.delete(item.id);
        for (const record of records) {
          const payload = record.payload;
          if (!payload || typeof payload.request_id !== 'string' || payload.type !== 'text' || !Number.isSafeInteger(Number(payload.conversation_id)) || Number(payload.conversation_id) <= 0 || typeof payload.body?.text !== 'string') continue;
          const item = { id: payload.request_id, account: { ...account }, payload: structuredClone(payload), status: 'failed', error: '上次发送未确认，请重试；发送编号保持不变。' };
          if (!items.has(item.id)) items.set(item.id, item);
          const lane = laneKey(item); if (!lanes.has(lane)) lanes.set(lane, { flight: null });
        }
        for (const item of current) items.set(item.id, item);
        notify();
      }).catch(error => { if (generation(key) === epoch) { storageDisabled.add(key); warn(account, error); } }).finally(() => {
        if (generation(key) === epoch) restored.add(key);
        if (restoring.get(key) === task) restoring.delete(key);
        schedule();
      });
      restoring.set(key, task); return task;
    }
    function persist(account) {
      if (!store) return Promise.resolve(true);
      const key = accountKey(account), epoch = generation(key), previous = persisting.get(key);
      if (previous?.epoch === epoch) { previous.dirty = true; return previous.task; }
      const state = { epoch, dirty: true, task: null, saved: false };
      state.task = (async () => {
        await restore(account);
        while (state.dirty && generation(key) === epoch && !storageDisabled.has(key)) {
          state.dirty = false;
          const records = [...items.values()].filter(item => accountKey(item.account) === key).map(item => ({ payload: structuredClone(item.payload) }));
          try { await store.save(account, records); state.saved = true; } catch (error) { state.saved = false; warn(account, error); }
        }
        return state.saved && generation(key) === epoch;
      })().finally(() => { if (persisting.get(key) === state) persisting.delete(key); });
      persisting.set(key, state); return state.task;
    }
    const validMessage = (item, message) => Number(message?.id) > 0
      && Number(message.conversation_id) === Number(item.payload.conversation_id)
      && Number(message.sender_id) === Number(item.account.userId);
    function settle(item, message, external) {
      if (!owns(item) || !validMessage(item, message)) return false;
      items.delete(item.id); item.status = 'sent';
      void persist(item.account);
      if (!external) accepted(item, message);
      notify();
      const lane = lanes.get(laneKey(item));
      // A WS receipt completes the message, not the still-running HTTP transport.
      // Its slot is retained until that transport settles (or is explicitly aborted).
      if (lane?.flight?.item === item) lane.flight = null;
      schedule(); return true;
    }
    function finish(flight) {
      if (!flights.delete(flight)) return;
      if (flight.lane.flight === flight) flight.lane.flight = null;
      schedule();
    }
    function active(flight) {
      return flights.has(flight) && !flight.controller.signal.aborted && generation(accountKey(flight.item.account)) === flight.epoch;
    }
    async function deliver(flight) {
      const item = flight.item;
      try {
        if (store) await persist(item.account);
        if (!active(flight) || !owns(item)) return;
        if (!allowed(item.account) || paused.has(accountKey(item.account))) {
          item.status = 'failed'; item.error = '发送已暂停，结果未确认，请确认后重试'; notify(); return;
        }
        const message = await send(item, flight.controller.signal);
        if (active(flight) && owns(item)) {
          if (!validMessage(item, message)) throw Error('消息回执无效，请重试');
          settle(item, message, false);
        }
      } catch (error) {
        if (active(flight) && owns(item)) { item.status = 'failed'; item.error = error?.message || '发送未确认'; notify(); }
      } finally { finish(flight); }
    }
    function pump() {
      if (disposed) return;
      for (const [key, lane] of lanes) {
        if (flights.size >= limit) break;
        if (lane.flight) continue;
        const item = [...items.values()].find(entry => laneKey(entry) === key);
        if (!item) { lanes.delete(key); continue; }
        const owner = accountKey(item.account);
        if (item.status !== 'queued' || paused.has(owner) || !allowed(item.account)) continue;
        if (store && !restored.has(owner)) { void restore(item.account); continue; }
        const flight = { item, lane, epoch: generation(owner), controller: new AbortController() };
        lane.flight = flight; flights.add(flight); item.status = 'sending'; notify();
        void deliver(flight);
      }
    }
    function schedule() {
      if (scheduled || disposed) return;
      scheduled = true; queueMicrotask(() => { scheduled = false; pump(); });
    }
    function pause(account) {
      const keys = account ? [accountKey(account)] : [...accounts.keys()];
      for (const key of keys) paused.add(key);
      for (const item of items.values()) if (keys.includes(accountKey(item.account))) {
        item.status = 'failed'; item.error = '发送已暂停，结果未确认，请确认后重试';
      }
      for (const flight of [...flights]) if (keys.includes(accountKey(flight.item.account))) {
        flight.controller.abort(); finish(flight);
      }
      notify();
      return Promise.all(keys.map(key => accounts.get(key)).filter(Boolean).map(persist));
    }
    function release(account) {
      const key = accountKey(account), owner = ownerKey(account), epoch = generation(key);
      const previous = releasing.get(owner);
      if (previous?.accountKey === key) return previous;
      // Start restore/persist before publishing this barrier; it must not wait on itself.
      const saved = pause(account);
      const task = Promise.resolve(saved).then(results => {
        if (generation(key) !== epoch || results.some(result => result === false)) return;
        for (const [id, item] of items) if (accountKey(item.account) === key) items.delete(id);
        for (const [lane, value] of lanes) if (!value.flight && JSON.parse(lane)[0] === key) lanes.delete(lane);
        generations.delete(key); restored.delete(key); storageDisabled.delete(key); accounts.delete(key); paused.delete(key); warned.delete(key);
      }).finally(() => { if (releasing.get(owner) === task) releasing.delete(owner); notify(); });
      task.accountKey = key; releasing.set(owner, task); return task;
    }
    return {
      enqueue(account, payload) {
        if (disposed) throw Error('待发队列已关闭');
        const key = accountKey(account);
        if (paused.has(key) || releasing.get(ownerKey(account))?.accountKey === key) throw Error('当前账号发送已暂停');
        remember(account);
        const item = { id: payload.request_id, account: { ...account }, payload: structuredClone(payload), status: 'queued', error: '' };
        if (items.has(item.id)) throw Error('重复的消息请求编号');
        items.set(item.id, item);
        const lane = laneKey(item); if (!lanes.has(lane)) lanes.set(lane, { flight: null });
        notify(); schedule(); void persist(account); return item;
      },
      pending(account, conversationId) {
        return [...items.values()].filter(item => accountKey(item.account) === accountKey(account) && Number(item.payload.conversation_id) === Number(conversationId));
      },
      confirm(account, message) {
        const item = items.get(message?.body?.request_id || message?.request_id);
        return Boolean(item && accountKey(item.account) === accountKey(account) && settle(item, message, true));
      },
      retry(id, account) {
        const item = items.get(id);
        if (disposed || paused.has(accountKey(account)) || !item || item.status !== 'failed' || accountKey(item.account) !== accountKey(account) || !allowed(account)) return;
        item.status = 'queued'; item.error = ''; notify(); schedule();
      },
      discard(id, account) {
        const item = items.get(id);
        if (!item || item.status !== 'failed' || accountKey(item.account) !== accountKey(account)) return;
        items.delete(id); notify(); schedule(); void persist(account);
      },
      resume(account) {
        if (disposed) return;
        const owners = account ? [account] : [...accounts.values()].filter(allowed);
        for (const owner of owners) {
          const key = accountKey(owner), release = releasing.get(ownerKey(owner));
          if (release?.accountKey === key) { void release.then(() => { if (!disposed) { paused.delete(key); schedule(); } }); }
          else paused.delete(key);
        }
        schedule();
      },
      pause, release,
      restore(account) {
        if (disposed) return Promise.resolve();
        const release = releasing.get(ownerKey(account));
        return release ? release.then(() => disposed ? undefined : restore(account)) : restore(account);
      },
      dispose() {
        if (disposed) return Promise.resolve();
        const tasks = [...accounts.values()].map(release); disposed = true; return Promise.all(tasks);
      },
      clear(account) {
        const key = accountKey(account); generations.set(key, Symbol()); restored.add(key); paused.delete(key);
        for (const flight of [...flights]) if (accountKey(flight.item.account) === key) { flight.controller.abort(); finish(flight); }
        for (const [id, item] of items) if (accountKey(item.account) === key) items.delete(id);
        restoring.delete(key); storageDisabled.delete(key);
        let result = Promise.resolve();
        if (store) { try { result = Promise.resolve(store.clear ? store.clear(account) : store.save(account, [])).catch(error => warn(account, error)); } catch (error) { warn(account, error); } }
        notify(); schedule(); return result;
      }
    };
  }
  root.PulseTextOutbox = { create };
  if (typeof module !== 'undefined') module.exports = { create };
})(globalThis);
