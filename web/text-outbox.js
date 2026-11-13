/* Immediate text capture with ordered, idempotent delivery per conversation. */
(function (root) {
  function create({ send, allowed, changed, accepted, store = null, storageError = () => {} }) {
    const items = new Map(), lanes = new Map();
    const restoring = new Map(), restored = new Set(), generations = new Map(), warned = new Set(), storageDisabled = new Set();
    const accountKey = account => JSON.stringify([account.token, account.userId]);
    const laneKey = item => JSON.stringify([accountKey(item.account), item.payload.conversation_id]);
    function warn(account, error) { const key = accountKey(account); if (!warned.has(key)) { warned.add(key); storageError(error, account); } }
    function restore(account) {
      if (!store) return Promise.resolve();
      const key = accountKey(account), generation = generations.get(key) || 0;
      if (restoring.has(key)) return restoring.get(key);
      if (restored.has(key)) return Promise.resolve();
      const task = Promise.resolve().then(() => store.load(account)).then(records => {
        if ((generations.get(key) || 0) !== generation) return;
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
        changed();
      }).catch(error => { storageDisabled.add(key); warn(account, error); }).finally(() => {
        restored.add(key); if (restoring.get(key) === task) restoring.delete(key);
      });
      restoring.set(key, task); return task;
    }
    async function persist(account) {
      if (!store) return;
      const generation = generations.get(accountKey(account)) || 0;
      await restore(account);
      const key = accountKey(account);
      if (storageDisabled.has(key) || (generations.get(key) || 0) !== generation) return;
      const records = [...items.values()].filter(item => accountKey(item.account) === key).map(item => ({ payload: structuredClone(item.payload) }));
      try { await store.save(account, records); } catch (error) { warn(account, error); }
    }
    const validMessage = (item, message) => Number(message?.id) > 0
      && Number(message.conversation_id) === Number(item.payload.conversation_id)
      && Number(message.sender_id) === Number(item.account.userId);
    function settle(item, message, external) {
      if (!items.has(item.id) || !validMessage(item, message)) return false;
      items.delete(item.id); item.status = 'sent';
      void persist(item.account);
      if (!external) accepted(item, message);
      changed();
      const key = laneKey(item), lane = lanes.get(key);
      if (lane?.flight === item.id) { lane.flight = null; queueMicrotask(() => pump(key)); }
      return true;
    }
    async function pump(key) {
      const lane = lanes.get(key);
      if (!lane || lane.flight) return;
      const item = [...items.values()].find(entry => laneKey(entry) === key);
      if (!item) { lanes.delete(key); return; }
      if (store && !restored.has(accountKey(item.account))) { await restore(item.account); if (!items.has(item.id) || !allowed(item.account)) return; return pump(key); }
      if (item.status === 'failed' || !allowed(item.account)) return;
      lane.flight = item.id; item.status = 'sending'; changed();
      try {
        if (store) { await persist(item.account); if (!items.has(item.id) || !allowed(item.account)) { if (items.has(item.id)) item.status = 'queued'; return; } }
        const message = await send(item);
        if (items.has(item.id)) {
          if (!validMessage(item, message)) throw Error('消息回执无效，请重试');
          settle(item, message, false);
        }
      } catch (error) {
        if (items.has(item.id)) { item.status = 'failed'; item.error = error.message || '发送未确认'; changed(); }
      } finally {
        if (lane.flight === item.id) lane.flight = null;
        queueMicrotask(() => pump(key));
      }
    }
    return {
      enqueue(account, payload) {
        const item = { id: payload.request_id, account: { ...account }, payload: structuredClone(payload), status: 'queued', error: '' };
        if (items.has(item.id)) throw Error('重复的消息请求编号');
        items.set(item.id, item);
        const key = laneKey(item); if (!lanes.has(key)) lanes.set(key, { flight: null });
        changed(); queueMicrotask(() => pump(key));
        void persist(account);
        return item;
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
        if (!item || item.status !== 'failed' || accountKey(item.account) !== accountKey(account) || !allowed(account)) return;
        item.status = 'queued'; item.error = ''; changed(); queueMicrotask(() => pump(laneKey(item)));
      },
      discard(id, account) {
        const item = items.get(id);
        if (!item || item.status !== 'failed' || accountKey(item.account) !== accountKey(account)) return;
        items.delete(id); changed(); queueMicrotask(() => pump(laneKey(item)));
        void persist(account);
      },
      resume() { for (const key of lanes.keys()) queueMicrotask(() => pump(key)); },
      restore,
      clear(account) {
        const key = accountKey(account); generations.set(key, (generations.get(key) || 0) + 1); restored.add(key);
        for (const [id, item] of items) if (accountKey(item.account) === accountKey(account)) items.delete(id);
        if (store) { try { void Promise.resolve(store.clear ? store.clear(account) : store.save(account, [])).catch(error => warn(account, error)); } catch (error) { warn(account, error); } }
        changed();
      }
    };
  }
  root.PulseTextOutbox = { create };
  if (typeof module !== 'undefined') module.exports = { create };
})(globalThis);
