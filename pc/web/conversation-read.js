/* Read a displayed conversation through a verified message, including older pages. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PulseConversationRead = factory();
})(typeof window === 'object' ? window : globalThis, () => {
  const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
  function create(options) {
    let account = '', generation = 0, revision = 0;
    const entries = new Map(), later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    function reset() {
      for (const entry of entries.values()) cancel(entry.timer);
      entries.clear(); account = ''; generation++; revision++;
    }
    function context() {
      const value = options.context(), key = value?.token && positive(value.userId) ? String(value.account || JSON.stringify([value.token, Number(value.userId)])) : '';
      if (key !== account) { reset(); account = key; }
      return { ...value, account: key, generation };
    }
    const same = entry => { const value = context(); return entry.account === value.account && entry.generation === value.generation && entries.get(entry.id) === entry; };
    const active = entry => { const value = context(); return same(entry) && value.available && Number(value.conversationId) === entry.id; };
    function capture() { const value = context(); return { account: value.account, generation, revision }; }
    function merge(row, ticket) {
      const value = context(), entry = entries.get(Number(row.id));
      if (entry && ticket?.account === value.account && ticket.generation === generation && ticket.revision < entry.ackRevision
          && entry.mentions === 0 && Number(row.last_mention_message_id || 0) <= entry.ackThrough)
        row = {...row, unread_mention_count: 0, last_mention_message_id: 0};
      if (entry && ticket?.account === value.account && ticket.generation === generation && ticket.revision < entry.ackRevision
          && Number(row.last_message?.id || 0) <= entry.ackThrough) return { ...row, unread_count: entry.unread,
            ...(entry.mentions === undefined ? {} : {unread_mention_count: entry.mentions, last_mention_message_id: entry.lastMention}) };
      return row;
    }
    function invalidate(id) {
      context(); const entry = entries.get(Number(id)); if (entry) cancel(entry.timer);
      entries.delete(Number(id)); revision++;
    }
    async function drain(entry) {
      if (!active(entry) || entry.busy || entry.wanted <= entry.ackThrough) return false;
      const through = entry.wanted; entry.busy = true; cancel(entry.timer); entry.timer = null;
      let success = false;
      const task = (async () => {
        try {
          const result = await options.request('/messages/receipt', { method: 'POST', authToken: entry.token,
            signal: AbortSignal.timeout(15000), body: JSON.stringify({ conversation_id: entry.id, through_message_id: through, status: 'read' }) });
          if (!same(entry)) return false;
          if (Number(result?.conversation_id) !== entry.id || Number(result?.through_message_id) !== through || result?.status !== 'read'
              || !Number.isSafeInteger(result?.unread_count) || result.unread_count < 0) throw Error('会话已读状态返回无效');
          if (Object.hasOwn(result, 'unread_mention_count') && (!Number.isSafeInteger(result.unread_mention_count) || result.unread_mention_count < 0
              || !Number.isSafeInteger(result.last_mention_message_id) || result.last_mention_message_id < 0
              || (result.unread_mention_count > 0 && result.last_mention_message_id === 0))) throw Error('艾特已读状态返回无效');
          entry.ackThrough = through; entry.unread = result.unread_count;
          if (Number.isSafeInteger(result.unread_mention_count) && result.unread_mention_count >= 0) {entry.mentions=result.unread_mention_count;entry.lastMention=result.last_mention_message_id||0;}
          entry.ackRevision = ++revision; entry.failures = 0;
          success = true; options.confirmed?.({ ...result }); return true;
        } catch (error) { if (same(entry)) { entry.failures++; options.failed?.(error); } return false; }
        finally {
          if (same(entry)) {
            entry.busy = false; entry.task = null;
            if (entry.wanted > entry.ackThrough && active(entry)) {
              if (success) void drain(entry);
              else entry.timer = later(() => { entry.timer = null; void drain(entry); }, Math.min(30000, 1000 * 2 ** Math.min(entry.failures - 1, 5)));
            }
          }
        }
      })();
      entry.task = task; return task;
    }
    function mark(id, through, { force = false } = {}) {
      const value = context(); id = Number(id); through = Number(through);
      if (!value.account || !value.available || !positive(id) || !positive(through) || Number(value.conversationId) !== id) return Promise.resolve(false);
      let entry = entries.get(id);
      if (!entry) {
        if (entries.size >= 200) { const oldest = [...entries.values()].find(item => !item.busy); if (oldest) { cancel(oldest.timer); entries.delete(oldest.id); } else return Promise.resolve(false); }
        entry = { id, token: value.token, account: value.account, generation, wanted: 0, ackThrough: 0, ackRevision: -1, unread: 0, failures: 0, busy: false, task: null, timer: null };
        entries.set(id, entry);
      }
      if (force && !entry.busy) { entry.ackThrough = 0; entry.wanted = through; }
      else entry.wanted = Math.max(entry.wanted, through);
      if (entry.busy) return entry.task;
      return drain(entry);
    }
    return { mark, capture, merge, invalidate, reset };
  }
  return { create };
});
