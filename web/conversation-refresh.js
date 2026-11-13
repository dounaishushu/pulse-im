/* Coalesce conversation hints; one bounded incremental request replaces full reloads. */
(function (root) {
  'use strict';
  function create({ account, load, apply, full, failed = () => {}, delay = 120, now = () => Date.now() }) {
    let owner = '', pending = new Map(), timer = null, flight = null, revision = 0, unsupportedUntil = 0;
    const key = value => value?.token && Number(value.userId) > 0 ? JSON.stringify([value.token, Number(value.userId)]) : '';
    function sync() {
      const next = key(account());
      if (next !== owner) { owner = next; pending.clear(); clearTimeout(timer); timer = null; flight = null; unsupportedUntil = 0; revision++; }
      return next;
    }
    function schedule() { if (!timer && !flight && owner && pending.size) timer = setTimeout(() => { timer = null; void flush(); }, delay); }
    async function flush() {
      if (!sync() || flight || !pending.size) return;
      if (now() < unsupportedUntil) { pending.clear(); await full().catch(failed); return; }
      const currentOwner = owner, captured = { ...account() }, ids = [...pending.keys()].slice(0, 100);
      const tickets = new Map(ids.map(id => [id, pending.get(id)])); ids.forEach(id => pending.delete(id));
      const task = { owner: currentOwner, revision }; flight = task;
      try {
        const result = await load(ids, captured);
        if (sync() !== currentOwner || flight !== task) return;
        if (result?.incremental !== true || !Array.isArray(result.items) || !Array.isArray(result.removed_ids)) {
          unsupportedUntil = now() + 60000; pending.clear(); await full().catch(failed); return;
        }
        // A newer event received while loading owns that conversation now.
        const eligible = new Set(ids.filter(id => !pending.has(id) || pending.get(id) <= tickets.get(id)));
        const requested = new Set(ids);
        if (result.items.some(item => !requested.has(Number(item?.id))) || result.removed_ids.some(id => !requested.has(Number(id)))) throw Error('会话更新响应范围无效。');
        apply({ items: result.items.filter(item => eligible.has(Number(item.id))), removed_ids: result.removed_ids.filter(id => eligible.has(Number(id))), readTicket: result.readTicket }, captured);
      } catch (error) {
        if (sync() !== currentOwner || flight !== task) return;
        if (error.status === 404 || error.status === 405) unsupportedUntil = now() + 60000;
        failed(error);
        pending.clear(); await full().catch(failed);
      } finally { if (flight === task) { flight = null; schedule(); } }
    }
    return {
      hint(values) {
        if (!sync()) return;
        const ids = [...new Set((Array.isArray(values) ? values : [values]).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
        for (const id of ids) pending.set(id, ++revision);
        if (!ids.length) { void full().catch(failed); return; }
        schedule();
      },
      flush,
      reset() { owner = ''; sync(); },
      pending: () => pending.size,
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { create };
  else root.PulseConversationRefresh = { create };
})(typeof window === 'object' ? window : globalThis);
