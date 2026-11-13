(function(root) {
  'use strict';
  // Upload at most two photos ahead; commit messages in selection order.
  // Upload results and request IDs survive a failed message acknowledgement.
  function create(options) {
    const items = options.items;
    const uploads = new Map();
    const controller = new AbortController();
    let running = false, stopped = false, next = 0;
    const changed = () => options.changed?.();
    const current = () => {
      if (stopped || controller.signal.aborted) throw new Error('图片发送已停止');
      if (!options.allowed()) throw new Error('账号、权限或客户端状态已改变，请返回原会话后重试');
    };
    const ensure = index => {
      if (index >= items.length || uploads.has(index) || items[index].uploaded) return;
      const item = items[index];
      uploads.set(index, (async () => {
        try {
          current(); item.phase = 'processing'; changed();
          const prepared = await options.prepare(item);
          current(); item.phase = 'uploading'; changed();
          const upload = await options.upload(item, prepared, controller.signal);
          current(); item.uploaded = upload; item.phase = 'waiting'; changed();
          return { upload };
        } catch (error) { return { error }; }
      })());
    };
    const queue = {
      items, signal: controller.signal,
      get running() { return running; },
      get completed() { return next === items.length; },
      get nextIndex() { return next; },
      stop() { stopped = true; controller.abort(); changed(); },
      async run() {
        if (running || stopped || queue.completed) return;
        running = true;
        for (const item of items) if (!item.sent) { item.error = ''; if (item.phase === 'failed') item.phase = 'waiting'; }
        changed();
        try {
          while (next < items.length) {
            current();
            ensure(next); ensure(next + 1);
            const item = items[next];
            if (!item.uploaded) {
              const result = await uploads.get(next);
              uploads.delete(next);
              if (result?.error) throw result.error;
            }
            current(); item.phase = 'sending'; changed();
            const message = await options.send(item, item.uploaded, next, controller.signal);
            current(); item.sent = true; item.phase = 'sent'; next++;
            options.accepted(message, item, next - 1); changed();
          }
        } catch (error) {
          if (!stopped && items[next]) { items[next].phase = 'failed'; items[next].error = error.message || '图片发送失败'; }
        } finally {
          running = false;
          if (queue.completed) options.completed?.();
          changed();
        }
      }
    };
    return queue;
  }
  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PulseImageSendQueue = api;
})(typeof globalThis === 'object' ? globalThis : this);
