/* Encrypted per-message records, isolated by server/account and Electron Session. */
(function (root) {
  'use strict';
  function create({ base, databaseName = 'pulse-pending-texts-v1', indexedDB = root.indexedDB, crypto = root.crypto } = {}) {
    if (!indexedDB || !crypto?.subtle) return null;
    let database;
    const writes = new Map(), known = new Map(), epochs = new Map(), cached = new Map();
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    const scope = account => {
      if (!Number.isSafeInteger(Number(account?.userId)) || Number(account.userId) <= 0) throw Error('待发消息账号无效');
      return JSON.stringify([String(base || ''), Number(account.userId)]);
    };
    const open = () => database ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' }).createIndex('owner', 'owner');
      };
      request.onerror = () => reject(Error('待发消息存储不可用'));
      request.onblocked = () => reject(Error('待发消息存储正在升级，请重新打开程序'));
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = null; }; resolve(request.result); };
    });
    async function descriptor(id) {
      const db = await open();
      const existing = await new Promise((resolve, reject) => { const request = db.transaction('keys').objectStore('keys').get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('待发消息密钥读取失败')); });
      if (existing?.key) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      return new Promise((resolve, reject) => {
        const tx = db.transaction('keys', 'readwrite'), store = tx.objectStore('keys'), request = store.get(id); let selected;
        request.onsuccess = () => { selected = request.result || { id, key, epoch: 0 }; if (!request.result) store.put(selected); };
        tx.oncomplete = () => resolve(selected); tx.onerror = tx.onabort = () => reject(Error('待发消息密钥保存失败'));
      });
    }
    function validate(records) {
      if (!Array.isArray(records) || records.length > 1000) throw Error('待发消息数量超过限制');
      const ids = new Set();
      return records.map(record => {
        const p = record?.payload;
        if (!p || p.type !== 'text' || !Number.isSafeInteger(Number(p.conversation_id)) || Number(p.conversation_id) <= 0
          || typeof p.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(p.request_id) || ids.has(p.request_id)
          || typeof p.body?.text !== 'string' || p.body.text.length > 20000) throw Error('待发消息快照无效');
        ids.add(p.request_id);
        return { payload: { conversation_id: Number(p.conversation_id), type: 'text', body: structuredClone(p.body), request_id: p.request_id } };
      });
    }
    function serialize(id, operation) {
      const task = (writes.get(id) || Promise.resolve()).catch(() => {}).then(operation);
      writes.set(id, task); task.finally(() => { if (writes.get(id) === task) writes.delete(id); }).catch(() => {}); return task;
    }
    return {
      async load(account) {
        const id = scope(account); await writes.get(id)?.catch(() => {});
        const db = await open(), secret = await descriptor(id);
        const rows = await new Promise((resolve, reject) => { const request = db.transaction('messages').objectStore('messages').index('owner').getAll(id, 1001); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('待发消息读取失败')); });
        if (rows.length > 1000) throw Error('待发消息数量超过限制');
        const records = []; let size = 0;
        for (const row of rows) {
          if (row.epoch !== secret.epoch) continue;
          const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv, additionalData: encoder.encode(row.id) }, secret.key, row.cipher);
          size += clear.byteLength; if (size > 8 * 1024 * 1024) throw Error('待发消息快照过大');
          records.push({ record: JSON.parse(decoder.decode(clear)), order: row.order || 0 });
        }
        if ((await descriptor(id)).epoch !== secret.epoch) return [];
        records.sort((a, b) => a.order - b.order);
        const safe = validate(records.map(item => item.record));
        known.set(id, new Set(safe.map(item => item.payload.request_id))); epochs.set(id, secret.epoch);
        cached.set(id, new Map(safe.map(item => [item.payload.request_id, JSON.stringify(item)]))); return safe;
      },
      save(account, records) {
        const id = scope(account), safe = validate(records), expectedEpoch = epochs.get(id);
        return serialize(id, async () => {
          const db = await open(), secret = await descriptor(id);
          if (expectedEpoch !== undefined && expectedEpoch !== secret.epoch) return;
          const previous = known.get(id) || new Set(), next = new Set(safe.map(item => item.payload.request_id)), cache = cached.get(id) || new Map();
          const removed = [...previous].filter(value => !next.has(value)), additions = []; let size = 0;
          for (let index = 0; index < safe.length; index++) {
            const record = safe[index], requestId = record.payload.request_id, json = JSON.stringify(record);
            size += encoder.encode(json).byteLength; if (size > 8 * 1024 * 1024) throw Error('待发消息快照过大');
            if (cache.get(requestId) === json) continue;
            const recordId = JSON.stringify([id, requestId]), iv = crypto.getRandomValues(new Uint8Array(12));
            const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(recordId) }, secret.key, encoder.encode(json));
            additions.push({ id: recordId, owner: id, epoch: secret.epoch, iv, cipher, order: Date.now() + index / 1000 });
          }
          await new Promise((resolve, reject) => {
            const tx = db.transaction(['keys', 'messages'], 'readwrite'), check = tx.objectStore('keys').get(id);
            check.onsuccess = () => {
              if (check.result?.epoch !== secret.epoch) return;
              const store = tx.objectStore('messages');
              for (const requestId of removed) store.delete(JSON.stringify([id, requestId]));
              for (const record of additions) store.put(record);
            };
            tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(Error('待发消息保存失败'));
          });
          known.set(id, next); epochs.set(id, secret.epoch); cached.set(id, new Map(safe.map(item => [item.payload.request_id, JSON.stringify(item)])));
        });
      },
      clear(account) {
        const id = scope(account);
        return serialize(id, async () => {
          const db = await open(); await descriptor(id);
          await new Promise((resolve, reject) => {
            const tx = db.transaction(['keys', 'messages'], 'readwrite'), keys = tx.objectStore('keys'), get = keys.get(id);
            get.onsuccess = () => { const row = get.result; keys.put({ ...row, epoch: row.epoch + 1 }); epochs.set(id, row.epoch + 1); };
            const messages = tx.objectStore('messages'), list = messages.index('owner').getAllKeys(id);
            list.onsuccess = () => list.result.forEach(value => messages.delete(value));
            tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(Error('待发消息清理失败'));
          });
          known.set(id, new Set()); cached.set(id, new Map());
        });
      },
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { create };
  else root.PulsePendingTextStore = { create };
})(typeof window === 'object' ? window : globalThis);
