// Read status is independent of message/media rendering and account scoped.
(function (root) {
  'use strict';
  function create({ context, request, container }) {
    let account = '', owner = '', timer = null, flight = null, dirty = false;
    const cache = new Map();
    const identity = c => JSON.stringify([c.account, c.conversationId, c.type, c.revision]);
    function scope(c) {
      if (account !== c.account) { account = c.account; cache.clear(); }
      const next = identity(c);
      if (owner !== next) { owner = next; flight?.abort(); flight = null; dirty = false; }
    }
    const valid = c => c.token && c.userId > 0 && c.conversationId > 0 && ['direct', 'group'].includes(c.type) && c.available;
    const key = (c, id) => c.conversationId + ':' + id;
    function status(c, id) { return cache.get(key(c, id)); }
    function text(c, value) { return value == null ? '…' : c.type === 'group' ? value + '人已读' : value > 0 ? '已读' : '未读'; }
    function update(c, node) {
      const value = status(c, Number(node.dataset.messageReceipt));
      const label = text(c, value);
      if (node.textContent !== label) node.textContent = label;
      node.classList.toggle('is-read', value > 0);
      node.classList.toggle('is-loading', value == null);
      node.title = value == null ? '正在获取消息回执' : c.type === 'group' ? '累计 ' + value + ' 位成员已读' : value > 0 ? '对方已读' : '对方尚未读';
    }
    function html(message) {
      const c = context(); scope(c);
      if (!valid({...c, available:true}) || Number(message.sender_id) !== c.userId || Number(message.conversation_id) !== c.conversationId
          || !Number.isSafeInteger(Number(message.id)) || Number(message.id) <= 0 || message.recalled_at
          || ['recalled','deleted'].includes(message.status) || ['system','red_packet'].includes(message.type)) return '';
      const value = status(c, Number(message.id));
      return '<span class="message-receipt' + (value > 0 ? ' is-read' : value == null ? ' is-loading' : '') + '" data-message-receipt="' + Number(message.id) + '"' + (c.type === 'group' ? ' data-receipt-group' : '') + ' role="status">' + text(c, value) + '</span>';
    }
    function schedule(delay) { clearTimeout(timer); timer = setTimeout(poll, delay); }
    function refresh() {
      const c = context(); scope(c);
      const host = container();
      if (!host || !valid(c)) { clearTimeout(timer); timer = null; flight?.abort(); flight = null; return; }
      host.querySelectorAll('[data-message-receipt]').forEach(node => update(c, node));
      if (flight) { dirty = true; return; }
      schedule(0);
    }
    async function poll() {
      timer = null;
      const c = context(); scope(c); const host = container();
      if (!host || !valid(c) || flight) return;
      const target = owner;
      const current = () => owner === target && identity(context()) === target && valid(context()) && container() === host && host.isConnected;
      const ids = [...new Set([...host.querySelectorAll('[data-message-receipt]')].map(node => Number(node.dataset.messageReceipt)))];
      // Direct read is final. Group counts can grow as more members open the chat.
      const pending = ids.filter(id => c.type === 'group' || !(status(c, id) > 0));
      if (!pending.length) return;
      const controller = new AbortController(); flight = controller; dirty = false;
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        for (let offset = 0; offset < pending.length && current(); offset += 100) {
          const batch = pending.slice(offset, offset + 100), selected = new Set(batch);
          const query = new URLSearchParams({conversation_id:c.conversationId, message_ids:batch.join(',')});
          const result = await request('/messages/receipts?' + query, {authToken:c.token, signal:controller.signal});
          if (!current() || controller.signal.aborted) return;
          if (Number(result?.conversation_id) !== c.conversationId || result.conversation_type !== c.type || !Array.isArray(result.items)) throw Error('消息回执返回范围无效');
          const seen = new Set();
          for (const item of result.items) {
            const id = Number(item.message_id), count = Number(item.read_count);
            if (!selected.has(id) || seen.has(id) || !Number.isSafeInteger(count) || count < 0 || item.status !== (count > 0 ? 'read' : 'unread')) throw Error('消息回执数据无效');
            seen.add(id);
          }
          for (const item of result.items) {
            const id = Number(item.message_id);
            cache.set(key(c, id), Math.max(status(c, id) || 0, Number(item.read_count)));
          }
          while (cache.size > 2000) cache.delete(cache.keys().next().value);
          host.querySelectorAll('[data-message-receipt]').forEach(node => update(c, node));
        }
      } catch (error) {
        if (current() && !controller.signal.aborted) host.querySelectorAll('.message-receipt.is-loading').forEach(node => { node.title = '暂时无法获取回执，稍后重试'; });
      } finally {
        clearTimeout(timeout);
        if (flight === controller) { flight = null; if (current()) schedule(dirty ? 0 : 3000); }
      }
    }
    function reset() { clearTimeout(timer); timer = null; flight?.abort(); flight = null; account = ''; owner = ''; dirty = false; cache.clear(); }
    return {html, refresh, reset};
  }
  root.PulseMessageReceipts = {create};
})(window);
