/* Account-scoped, expiring status snapshots, independent of conversation ordering. */
(function (root) {
  'use strict';
  function create({ context, load, changed = () => {}, now = () => Date.now() }) {
    let owner = '', epoch = 0, flight = null, queued = false;
    const snapshots = new Map(), attempts = new Map();
    const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
    function sync() {
      const c = context(), key = c.token && positive(c.userId) ? JSON.stringify([c.base || '', c.token, Number(c.userId)]) : '';
      if (key !== owner) { pause(); owner = key; epoch++; snapshots.clear(); attempts.clear(); }
      return c;
    }
    function get(row) {
      sync(); const saved = snapshots.get(Number(row?.id));
      return saved && saved.peer_user_id === Number(row?.peer_user_id) && now() - saved.at < 70000 ? saved : null;
    }
    function pause() { queued = false; if (flight) { flight.controller.abort(); for (const row of flight.rows) attempts.delete(row.id); } flight = null; }
    function clear() { pause(); owner = ''; epoch++; snapshots.clear(); attempts.clear(); }
    function refresh({ force = false } = {}) {
      const c = sync();
      if (!owner || !c.visible) { pause(); return Promise.resolve(); }
      if (flight) { queued = true; return flight.promise; }
      const unique = new Map();
      for (const row of (typeof c.rows === 'function' ? c.rows() : c.rows) || []) if (positive(row.id) && positive(row.peer_user_id) && Number(row.peer_user_id) !== Number(c.userId)) unique.set(Number(row.id), { id:Number(row.id), peer_user_id:Number(row.peer_user_id) });
      const rows = [...unique.values()].filter(row => {
        const attempt = attempts.get(row.id), saved = get(row);
        return (attempt == null || now() - attempt >= 5000) && (force || !saved || now() - saved.at >= 25000);
      }).slice(0, 100);
      if (!rows.length) return Promise.resolve();
      const task = { owner, epoch, rows, controller:new AbortController(), promise:null }; flight = task;
      const current = () => { const latest = sync(); return flight === task && task.owner === owner && task.epoch === epoch && !task.controller.signal.aborted && latest.visible; };
      for (const row of rows) attempts.set(row.id, now());
      while (attempts.size > 512) attempts.delete(attempts.keys().next().value);
      task.promise = Promise.resolve().then(() => load(rows, c, { signal:task.controller.signal })).then(result => {
        if (!current()) return;
        const requested = new Map(rows.map(row => [row.id, row.peer_user_id])), seen = new Set();
        if (!Array.isArray(result?.items) || !Array.isArray(result.removed_ids)) throw Error('Invalid presence response');
        for (const item of result.items) {
          const id = Number(item.id);
          if (!requested.has(id) || seen.has(id) || Number(item.peer_user_id) !== requested.get(id)
            || typeof item.peer_last_seen_hidden !== 'boolean' || (!item.peer_last_seen_hidden && typeof item.peer_online !== 'boolean')) throw Error('Invalid presence identity');
          seen.add(id);
        }
        for (const value of result.removed_ids) { const id = Number(value); if (!requested.has(id) || seen.has(id)) throw Error('Invalid removed presence'); seen.add(id); }
        if (seen.size !== requested.size) throw Error('Incomplete presence response');
        for (const item of result.items) snapshots.set(Number(item.id), { peer_user_id:Number(item.peer_user_id), peer_online:item.peer_last_seen_hidden ? null : item.peer_online, peer_last_seen_hidden:item.peer_last_seen_hidden, at:now() });
        for (const id of result.removed_ids) snapshots.delete(Number(id));
        for (const [id, saved] of snapshots) if (now() - saved.at >= 70000) { snapshots.delete(id); attempts.delete(id); }
        while (snapshots.size > 256) { const id = snapshots.keys().next().value; snapshots.delete(id); attempts.delete(id); }
        changed();
      }).catch(() => { if (current()) changed(); }).finally(() => {
        task.controller.abort();
        if (flight !== task) return;
        flight = null;
        const again = queued; queued = false;
        if (again) void refresh();
      });
      return task.promise;
    }
    return { get, refresh, pause, clear };
  }
  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PulseConversationPresence = api;
})(typeof window === 'object' ? window : globalThis);
