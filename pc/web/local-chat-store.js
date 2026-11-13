(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.PulseLocalChatStore = factory;
})(typeof globalThis === 'object' ? globalThis : this, function createLocalChatStore({ owner, enabled = true, name = 'pulse-local-chat-v1' }) {
  const encoder = new TextEncoder(); let database, generation = 0, lastOwner = '', keyCache = new Map();
  const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
  const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error || Error('LOCAL_CHAT_ABORTED')); });
  const valid = n => Number.isSafeInteger(Number(n)) && Number(n) > 0;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null;
  if (channel) channel.onmessage = event => { if (event.data === 'clear') { generation++; keyCache.clear(); } };
  async function db() {
    if (!enabled || !globalThis.indexedDB) throw Error('LOCAL_CHAT_UNAVAILABLE');
    if (!database) database = new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => { if (settled) return; settled = true; clearTimeout(timeout); reject(error); };
      const timeout = setTimeout(() => fail(Error('LOCAL_CHAT_OPEN_TIMEOUT')), 3000);
      let pending;
      try { pending = indexedDB.open(name, 1); } catch (error) { fail(error); return; }
      pending.onupgradeneeded = () => {
        if (settled) { pending.transaction?.abort(); return; }
        pending.result.createObjectStore('messages', { keyPath: ['scope', 'conversation', 'id'] });
        pending.result.createObjectStore('meta', { keyPath: ['scope', 'conversation'] });
        pending.result.createObjectStore('keys', { keyPath: 'scope' });
      };
      pending.onsuccess = () => {
        const storage = pending.result;
        if (settled) { storage.close(); return; }
        settled = true; clearTimeout(timeout);
        storage.onversionchange = () => { storage.close(); database = null; };
        resolve(storage);
      };
      pending.onerror = () => fail(pending.error);
      pending.onblocked = () => fail(Error('LOCAL_CHAT_OPEN_BLOCKED'));
    }).catch(error => { database = null; throw error; });
    return database;
  }
  async function capture() {
    const identity = String(owner() || ''); if (!identity) throw Error('LOCAL_CHAT_NO_ACCOUNT');
    if (identity !== lastOwner) { lastOwner = identity; generation++; keyCache.clear(); }
    const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(identity));
    const scope = [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
    return { scope, identity, generation };
  }
  function current(ticket) { return ticket.generation === generation && ticket.identity === String(owner() || ''); }
  async function key(ticket) {
    if (keyCache.has(ticket.scope)) return keyCache.get(ticket.scope);
    const storage = await db(); let tx = storage.transaction('keys', 'readonly');
    let stored = await request(tx.objectStore('keys').get(ticket.scope));
    if (!stored) {
      const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      if (!current(ticket)) throw Error('LOCAL_CHAT_CANCELLED');
      tx = storage.transaction('keys', 'readwrite'); const finished = done(tx), store = tx.objectStore('keys');
      stored = await request(store.get(ticket.scope)); if (!stored) { stored = { scope: ticket.scope, key: candidate }; store.put(stored); }
      await finished;
    }
    if (!current(ticket)) throw Error('LOCAL_CHAT_CANCELLED'); keyCache.set(ticket.scope, stored.key); return stored.key;
  }
  async function seal(ticket, conversation, id, value) {
    const raw = encoder.encode(JSON.stringify(value)); if (raw.byteLength > 1024 * 1024) throw Error('LOCAL_CHAT_MESSAGE_SIZE');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${ticket.scope}:${conversation}:${id}`) }, await key(ticket), raw);
    return { iv, cipher };
  }
  async function unseal(ticket, conversation, id, value) {
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: value.iv, additionalData: encoder.encode(`${ticket.scope}:${conversation}:${id}`) }, await key(ticket), value.cipher);
    return JSON.parse(new TextDecoder().decode(raw));
  }
  function range(ticket, conversation, low = 0, high = Number.MAX_SAFE_INTEGER) { return IDBKeyRange.bound([ticket.scope, conversation, low], [ticket.scope, conversation, high]); }
  async function ticket(conversation) {
    if (!valid(conversation)) throw Error('LOCAL_CHAT_CONVERSATION');
    const ownerTicket = await capture(), storage = await db(), tx = storage.transaction(['meta', 'keys'], 'readonly');
    const [meta, epoch] = await Promise.all([request(tx.objectStore('meta').get([ownerTicket.scope, Number(conversation)])), request(tx.objectStore('keys').get('__epoch'))]);
    return { ...ownerTicket, conversation: Number(conversation), revision: meta?.revision || 0, barrier: meta?.barrier || 0, diskEpoch: epoch?.value || 0 };
  }
  async function read(conversation, { before = Number.MAX_SAFE_INTEGER, limit = 50 } = {}) {
    const t = await ticket(conversation), storage = await db(); if (!current(t)) return { items: [], meta: {} };
    const tx = storage.transaction(['messages', 'meta'], 'readonly'), entries = [];
    const metaPromise = request(tx.objectStore('meta').get([t.scope, t.conversation]));
    await new Promise((resolve, reject) => {
      const scan = tx.objectStore('messages').openCursor(range(t, t.conversation, 1, Math.max(1, Number(before))), 'prev');
      scan.onerror = () => reject(scan.error); scan.onsuccess = () => {
        const cursor = scan.result; if (!cursor || entries.length >= Math.min(100, Math.max(1, limit))) { resolve(); return; }
        if (!cursor.value.removed) entries.push(cursor.value); cursor.continue();
      };
    });
    const meta = await metaPromise || {}, items = [];
    for (const entry of entries.reverse()) try {
      const message = await unseal(t, t.conversation, entry.id, entry);
      if (message.id === entry.id && Number(message.conversation_id) === t.conversation && entry.id > (meta.cleared || 0)) items.push(message);
    } catch { /* A damaged local row cannot prevent server recovery. */ }
    let conversationInfo = null;
    if (meta.info) try { conversationInfo = await unseal(t, t.conversation, 0, meta.info); } catch {}
    return current(t) ? { items, meta: { ...meta, info: undefined }, conversation: conversationInfo, ticket: t } : { items: [], meta: {} };
  }
  async function save(conversation, values, options = {}) {
    const t = options.ticket || await ticket(conversation); if (!current(t) || t.conversation !== Number(conversation)) return false;
    const items = values.filter(m => valid(m.id) && Number(m.conversation_id) === t.conversation).slice(0, 500);
    const encrypted = new Map();
    for (const message of items) {
      const removed = Boolean(message.recalled_at) || ['deleted', 'recalled'].includes(message.status);
      if (!removed) encrypted.set(Number(message.id), await seal(t, t.conversation, Number(message.id), message));
    }
    const info = options.conversation ? await seal(t, t.conversation, 0, options.conversation) : null;
    if (!current(t)) return false;
    const storage = await db(), tx = storage.transaction(['messages', 'meta', 'keys'], 'readwrite'), finished = done(tx);
    const rows = tx.objectStore('messages'), metas = tx.objectStore('meta');
    const epoch = await request(tx.objectStore('keys').get('__epoch'));
    if ((epoch?.value || 0) !== t.diskEpoch) { await finished; return false; }
    const existing = new Map((await Promise.all(items.map(async m => [Number(m.id), await request(rows.get([t.scope, t.conversation, Number(m.id)]))]))));
    const meta = await request(metas.get([t.scope, t.conversation])) || { scope: t.scope, conversation: t.conversation, revision: 0, cleared: 0 };
    if ((meta.barrier || 0) !== t.barrier) { await finished; return false; }
    meta.revision++; meta.cleared = Math.max(meta.cleared || 0, Number(options.cleared) || 0);
    if (info) meta.info = info;
    for (const message of items) {
      const id = Number(message.id), old = existing.get(id), removed = Boolean(message.recalled_at) || ['deleted', 'recalled'].includes(message.status);
      if (id <= meta.cleared) { rows.delete([t.scope, t.conversation, id]); continue; }
      if (!removed && (old?.removed || (String(old?.edited || '') > String(message.edited_at || '')) || (!options.event && (old?.revision || 0) > t.revision))) continue;
      rows.put({ scope: t.scope, conversation: t.conversation, id, edited: message.edited_at || '', revision: meta.revision, removed, ...(encrypted.get(id) || {}) });
    }
    const incoming = new Set(items.map(m => Number(m.id))), floor = Number(options.floor), maximum = Number(options.maximum);
    if (meta.cleared > 0) rows.delete(range(t, t.conversation, 0, meta.cleared));
    if (Number.isSafeInteger(floor) && Number.isSafeInteger(maximum) && maximum >= floor) await new Promise((resolve, reject) => {
      const scan = rows.openCursor(range(t, t.conversation, Math.max(0, floor), maximum));
      scan.onerror = () => reject(scan.error); scan.onsuccess = () => {
        const cursor = scan.result; if (!cursor) { resolve(); return; } const row = cursor.value;
        if (row.id <= meta.cleared) cursor.delete();
        else if (Number.isSafeInteger(floor) && Number.isSafeInteger(maximum) && row.id >= floor && row.id <= maximum && !incoming.has(row.id) && row.revision <= t.revision) cursor.update({ ...row, removed: true, iv: undefined, cipher: undefined, revision: meta.revision });
        cursor.continue();
      };
    });
    if (Number.isSafeInteger(options.cursor) && options.cursor >= 0) {
      const previousCursor = meta.cursor, previousComplete = meta.complete === true;
      let cursor = previousCursor == null ? options.cursor : Math.min(previousCursor, options.cursor), complete = previousComplete || options.complete === true;
      if (options.latest && items.length && !options.complete && meta.upper > 0 && Math.min(...items.map(m => Number(m.id))) > meta.upper) {
        if (meta.bridge == null) { meta.bridge = meta.upper; meta.resume = previousCursor; meta.resumeComplete = previousComplete; }
        cursor = options.cursor; complete = false;
      } else if (!options.latest && meta.bridge != null && options.cursor <= meta.bridge) {
        cursor = meta.resume ?? options.cursor; complete = meta.resumeComplete || options.complete === true;
        delete meta.bridge; delete meta.resume; delete meta.resumeComplete;
      }
      if (options.latest) meta.upper = Math.max(meta.upper || 0, ...items.map(m => Number(m.id)));
      meta.cursor = cursor; meta.complete = complete;
    }
    if (!current(t)) { tx.abort(); return false; } metas.put(meta); await finished; return true;
  }
  async function remove(conversation, ids) { return save(conversation, ids.map(id => ({ id: Number(id), conversation_id: Number(conversation), status: 'deleted' })), { event: true }); }
  async function clearConversation(conversation, cleared = 0) {
    generation++;
    const t = await ticket(conversation), storage = await db(), tx = storage.transaction(['messages', 'meta'], 'readwrite'), finished = done(tx);
    tx.objectStore('messages').delete(range(t, t.conversation)); tx.objectStore('meta').put({ scope: t.scope, conversation: t.conversation, revision: t.revision + 1, barrier: t.barrier + 1, cleared: Number(cleared) || 0 }); await finished;
  }
  async function clear() {
    generation++; keyCache.clear(); channel?.postMessage('clear');
    const storage = await db(), tx = storage.transaction(['messages', 'meta', 'keys'], 'readwrite'), finished = done(tx);
    for (const store of ['messages', 'meta', 'keys']) tx.objectStore(store).clear(); tx.objectStore('keys').put({scope:'__epoch',value:crypto.randomUUID()}); await finished;
  }
  function close() { generation++; channel?.close(); keyCache.clear(); const opened = database; database = null; opened?.then(storage => storage.close()).catch(() => {}); }
  return { ticket, read, save, remove, clearConversation, clear, close, get generation() { return generation; } };
});
