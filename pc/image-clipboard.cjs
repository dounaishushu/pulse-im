const { randomUUID } = require('node:crypto');

// Prepare pixels first; the renderer must still own the selected message before
// committing them. A slower earlier copy must never overwrite a newer choice.
function createImageClipboard({ clipboard, nativeImage, read, allowed, maxBytes = 32 * 1024 * 1024, timeoutMs = 30000 }) {
  let pending = null;
  function release(job) {
    if (!job) return;
    clearTimeout(job.timer); job.controller.abort(); job.image = null;
    if (pending === job) pending = null;
  }
  const current = job => pending === job && !job.controller.signal.aborted && allowed(job.owner, job.accountId);
  async function prepare(owner, value) {
    if (!allowed(owner, value.accountId)) throw Error('当前账号无法复制此图片。');
    release(pending);
    const job = { owner, accountId: value.accountId, ticket: randomUUID(), controller: new AbortController(), image: null };
    pending = job;
    job.timer = setTimeout(() => { job.expired = true; release(job); }, timeoutMs); job.timer.unref?.();
    try {
      const response = await read(owner, value, job.controller.signal);
      if (!current(job)) { await response.body?.cancel(); if (job.expired) throw Error('图片复制超时，请重试。'); return { cancelled: true }; }
      if (response.status !== 200 || !/^image\/(?:png|jpeg|gif|webp|avif|bmp|x-ms-bmp)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel(); throw Error('图片加载失败，请重试。');
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel(); throw Error('图片过大，无法复制。');
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body || []) {
        if (!current(job)) { if (job.expired) throw Error('图片复制超时，请重试。'); return { cancelled: true }; }
        size += chunk.byteLength;
        if (size > maxBytes) throw Error('图片过大，无法复制。');
        chunks.push(Buffer.from(chunk));
      }
      if (!current(job)) { if (job.expired) throw Error('图片复制超时，请重试。'); return { cancelled: true }; }
      if (!size) throw Error('图片加载失败，请重试。');
      const image = nativeImage.createFromBuffer(Buffer.concat(chunks, size));
      const dimensions = image.getSize();
      if (image.isEmpty() || dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > 40 * 1024 * 1024) throw Error('图片无法复制，请重试。');
      job.image = image;
      return { ticket: job.ticket };
    } catch (error) {
      const cancelled = !job.expired && (pending !== job || !allowed(owner, value.accountId));
      release(job);
      if (cancelled) return { cancelled: true };
      if (job.expired) throw Error('图片复制超时，请重试。');
      throw Error(/^(图片加载失败|图片过大|图片无法复制)/.test(error.message) ? error.message : '图片复制失败，请重试。');
    } finally {
      if (pending === job && !job.image) release(job);
    }
  }
  function commit(owner, value) {
    const job = pending;
    if (!job || job.owner !== owner || job.ticket !== value.ticket || job.accountId !== value.accountId) return { copied: false, cancelled: true };
    if (!current(job) || !job.image) { release(job); return { copied: false, cancelled: true }; }
    try { clipboard.writeImage(job.image); return { copied: true }; }
    finally { release(job); }
  }
  function cancel(owner, value) {
    if (pending?.owner === owner && pending.ticket === value.ticket) release(pending);
    return { copied: false, cancelled: true };
  }
  return { prepare, commit, cancel, destroy() { release(pending); } };
}
module.exports = { createImageClipboard };
