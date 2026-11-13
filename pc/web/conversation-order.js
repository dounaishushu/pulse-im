// Keep the desktop pin order across refreshes and logins without storing credentials.
(function (root) {
  'use strict';
  function create({ storage = root.localStorage } = {}) {
    const memory = new Map(), pending = new Map();
    const id = value => ['number','string'].includes(typeof value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
    const pinned = row => row?.is_pinned === true || row?.is_pinned === 1 || row?.is_pinned === '1';
    const unique = values => [...new Set(values.map(id).filter(Boolean))];
    function key(account) {
      const userId = id(account?.userId), base = String(account?.base || '');
      return userId && base ? 'pulse_conversation_pin_order_v1:' + JSON.stringify([base,userId]) : '';
    }
    function read(account) {
      const name = key(account);
      if (!name) return [];
      if (pending.has(name)) return pending.get(name);
      try {
        const raw = storage?.getItem(name);
        if (raw === null) { memory.delete(name); return []; }
        if (raw !== null && raw !== undefined) {
          if (raw.length > 400000) throw new Error('Oversized pin order');
          const value = JSON.parse(raw);
          if (value?.version !== 1 || !Array.isArray(value.ids) || value.ids.length > 20000) throw new Error('Invalid pin order');
          const ids = unique(value.ids); memory.set(name,ids); return ids;
        }
      } catch { /* Storage failure keeps the order available for this session. */ }
      return memory.get(name) || [];
    }
    function write(account, ids) {
      const name = key(account); if (!name) return;
      ids = unique(ids);
      const value = JSON.stringify({version:1,ids});
      memory.set(name,ids);
      try {
        if (!storage) throw new Error('Unavailable storage');
        if (storage.getItem(name) !== value) storage.setItem(name,value);
        pending.delete(name);
      } catch { pending.set(name,ids); /* Keep this session stable if saving fails. */ }
    }
    return {
      key,
      // Only call with a successful complete snapshot, never a filter or a single chat.
      reconcile(account, rows) {
        if (!key(account)) return;
        const current = unique(rows.filter(row => row?.type !== 'favorites' && pinned(row)).map(row => row.id));
        const available = new Set(current), old = read(account).filter(value => available.has(value));
        const known = new Set(old);
        write(account,[...old,...current.filter(value => !known.has(value))]);
      },
      // A confirmed setting change can update one chat without deleting unseen pins.
      setPinned(account, value, isPinned) {
        value = id(value); if (!value || !key(account)) return;
        const old = read(account);
        write(account,isPinned ? old.includes(value) ? old : [...old,value] : old.filter(item => item !== value));
      },
      sort(account, rows) {
        const ids = read(account), rank = new Map(ids.map((value,index) => [value,index]));
        const pins = [], others = [];
        for (const row of rows) (pinned(row) ? pins : others).push(row);
        // Stable array sorting leaves as-yet unknown pins in their incoming order.
        pins.sort((a,b) => (rank.get(id(a?.id)) ?? ids.length) - (rank.get(id(b?.id)) ?? ids.length));
        return [...pins,...others];
      },
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { create };
  else root.PulseConversationOrder = { create };
})(typeof window === 'object' ? window : globalThis);
