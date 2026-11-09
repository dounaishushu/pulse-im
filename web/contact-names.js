// Contact remarks belong to the viewing account, never to shared message data.
(function (root) {
  'use strict';
  const label = value => Array.from(String(value || '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 64).join('');
  function create({ context, request, changed = () => {}, now = Date.now }) {
    let owner = '', revision = 0, records = new Map(), direct = new Map(), loading = null, nextRefresh = 0, queued = false;
    const identity = c => c.token && Number(c.userId) > 0 ? JSON.stringify([c.base, c.token, Number(c.userId)]) : '';
    function scope() {
      const c = context(), key = identity(c);
      if (owner !== key) { owner = key; revision++; records.clear(); direct.clear(); loading = null; nextRefresh = 0; queued = false; }
      return { ...c, key };
    }
    function capture() { return { key: scope().key, revision }; }
    function observe(ticket, userId, remark) {
      const c = scope(), id = Number(userId);
      if (!c.key || ticket.key !== c.key || !Number.isSafeInteger(id) || id <= 0 || typeof remark !== 'string') return false;
      if ((records.get(id)?.revision || 0) > ticket.revision) return false;
      const previous = resolve(id, '');
      records.set(id, { remark: label(remark), revision: ++revision });
      if (resolve(id, '') !== previous) changed();
      return true;
    }
    function remember(userId, remark) { return observe(capture(), userId, remark); }
    function conversations(rows) {
      scope();
      const next = new Map();
      for (const row of rows) {
        const id = Number(row.peer_user_id);
        if (row.type === 'direct' && Number.isSafeInteger(id) && id > 0 && typeof row.remark === 'string') next.set(id, label(row.remark));
      }
      const different = next.size !== direct.size || [...next].some(([id, value]) => value !== direct.get(id));
      direct = next;
      if (different) changed();
    }
    function resolve(userId, fallback = '会话成员') {
      const c = scope(), id = Number(userId);
      if (!c.key || !Number.isSafeInteger(id) || id <= 0) return label(fallback);
      if (id === Number(c.userId)) return label(c.nickname) || label(fallback);
      // An explicitly cleared remark must suppress older private-chat names.
      const remark = records.has(id) ? records.get(id).remark : direct.get(id);
      return remark || label(fallback);
    }
    async function refresh({ force = false } = {}) {
      const c = scope();
      if (!c.key || c.allowed === false) return false;
      if (loading) { if (force) queued = true; return loading.promise; }
      if (!force && now() < nextRefresh) return false;
      const ticket = capture(), task = { promise: null };
      loading = task;
      task.promise = (async () => {
        try {
          const names = new Map();
          let pages = 1, total = null, pageSize = null;
          for (let page = 1; page <= pages; page++) {
            const result = await request(`/contacts/names?size=100&page=${page}`, { authToken: c.token, signal: AbortSignal.timeout(15000) });
            if (scope().key !== ticket.key || loading !== task) return false;
            if (!Array.isArray(result.items)) throw Error('Invalid contact list');
            const size = Number(result.size);
            if (!Number.isSafeInteger(size) || size < 1 || size > 100 || Number(result.page) !== page || !Number.isSafeInteger(result.total) || result.total < 0 || result.items.length > size) throw Error('Invalid contact page');
            if (page === 1) { total = result.total; pageSize = size; pages = Math.max(1, Math.ceil(total / size)); }
            if (result.total !== total || size !== pageSize) throw Error('Contacts changed during refresh');
            if (pages > 10000 || page < pages && !result.items.length) throw Error('Incomplete contact list');
            for (const row of result.items) {
              const id = Number(row.user_id);
              if (!Number.isSafeInteger(id) || id <= 0 || typeof row.remark !== 'string' || names.has(id)) throw Error('Invalid contact identity');
              names.set(id, label(row.remark));
            }
          }
          if (names.size !== total) throw Error('Incomplete contact list');
          if (queued) return false;
          const next = new Map(), stamp = ++revision;
          // Missing contacts also clear remarks retained by an older list/view.
          for (const id of new Set([...records.keys(), ...direct.keys(), ...names.keys()])) {
            const old = records.get(id);
            next.set(id, old?.revision > ticket.revision ? old : { remark: names.get(id) || '', revision: stamp });
          }
          records = next; nextRefresh = now() + 60000;
          changed();
          return true;
        } catch (error) {
          if (scope().key === ticket.key && loading === task) nextRefresh = now() + 5000;
          throw error;
        } finally {
          if (loading === task) {
            loading = null;
            const again = queued; queued = false;
            if (again) void refresh({ force: true }).catch(() => {});
          }
        }
      })();
      return task.promise;
    }
    function clear() { owner = ''; revision++; records.clear(); direct.clear(); loading = null; nextRefresh = 0; queued = false; }
    return { capture, observe, remember, conversations, resolve, refresh, clear };
  }
  const exported = { create };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.PulseContactNames = exported;
})(typeof window === 'object' ? window : globalThis);
