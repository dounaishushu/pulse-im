/* Coalesce conversation hints; one bounded incremental request replaces full reloads. */
(function (root) {
  'use strict';
  function create({ account, load, apply, full, failed = () => {}, delay = 120, now = () => Date.now() }) {
    let owner = '', pending = new Map(), timer = null, flight = null, revision = 0, unsupportedUntil = 0, fullPending = false, paused = false, disposed = false;
    const key = value => value?.token && Number(value.userId) > 0 ? JSON.stringify([value.base, value.token, Number(value.userId)]) : '';
    function cancelFlight(retain) {
      const previous = flight; flight = null; clearTimeout(timer); timer = null;
      if (previous && retain) {
        if (previous.full) fullPending = true;
        for (const [id, ticket] of previous.tickets) if (!pending.has(id)) pending.set(id, ticket);
      }
      previous?.controller.abort();
    }
    function sync() {
      const next = key(account());
      if (next !== owner) { cancelFlight(false); owner = next; pending.clear(); fullPending = false; unsupportedUntil = 0; revision++; }
      return next;
    }
    function schedule() { if (!paused && !disposed && !timer && !flight && owner && (pending.size || fullPending)) timer = setTimeout(() => { timer = null; void flush(); }, delay); }
    async function flush() {
      if (!sync() || paused || disposed || flight || (!pending.size && !fullPending)) return;
      const currentOwner = owner, captured = { ...account() }, ids = [...pending.keys()].slice(0, 100);
      const tickets = new Map(ids.map(id => [id, pending.get(id)])); ids.forEach(id => pending.delete(id));
      const task = { owner: currentOwner, revision, tickets, controller: new AbortController(), full: fullPending || now() < unsupportedUntil }; fullPending = false; flight = task;
      const current = () => sync() === currentOwner && flight === task && !task.controller.signal.aborted && !paused && !disposed;
      const reconcile = async () => { task.full = true; await full({ signal: task.controller.signal, account: captured }); };
      try {
        if (task.full) { pending.clear(); await reconcile(); return; }
        const result = await load(ids, captured, { signal: task.controller.signal });
        if (!current()) return;
        if (result?.incremental !== true || !Array.isArray(result.items) || !Array.isArray(result.removed_ids)) {
          unsupportedUntil = now() + 60000; pending.clear(); await reconcile(); return;
        }
        // A newer event received while loading owns that conversation now.
        const eligible = new Set(ids.filter(id => !pending.has(id) || pending.get(id) <= tickets.get(id)));
        const requested = new Set(ids);
        if (result.items.some(item => !requested.has(Number(item?.id))) || result.removed_ids.some(id => !requested.has(Number(id)))) throw Error('会话更新响应范围无效。');
        apply({ items: result.items.filter(item => eligible.has(Number(item.id))), removed_ids: result.removed_ids.filter(id => eligible.has(Number(id))), readTicket: result.readTicket }, captured);
      } catch (error) {
        if (!current()) return;
        if (error.status === 404 || error.status === 405) unsupportedUntil = now() + 60000;
        failed(error);
        if (!task.full) { pending.clear(); try { await reconcile(); } catch (error) { if (current()) failed(error); } }
      } finally { if (flight === task) { flight = null; schedule(); } }
    }
    return {
      hint(values) {
        if (!sync() || disposed) return;
        const ids = [...new Set((Array.isArray(values) ? values : [values]).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
        for (const id of ids) pending.set(id, ++revision);
        if (!ids.length) fullPending = true;
        schedule();
      },
      flush,
      reset() { cancelFlight(false); pending.clear(); fullPending = false; owner = ''; unsupportedUntil = 0; revision++; sync(); },
      pause() { paused = true; cancelFlight(true); },
      resume() { if (disposed) return; paused = false; sync(); schedule(); },
      dispose() { disposed = true; paused = true; cancelFlight(false); pending.clear(); fullPending = false; owner = ''; },
      pending: () => pending.size,
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { create };
  else root.PulseConversationRefresh = { create };
})(typeof window === 'object' ? window : globalThis);
