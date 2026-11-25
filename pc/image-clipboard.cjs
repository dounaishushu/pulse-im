const { randomUUID, createHash } = require('node:crypto');

// Prepare pixels first; the renderer must still own the selected message before
// committing them. A slower earlier copy must never overwrite a newer choice.
function createImageClipboard({ clipboard, nativeImage, read, allowed, maxBytes = 32 * 1024 * 1024, timeoutMs = 30000,
  maxDecodedBytes = 64 * 1024 * 1024, decodedTtlMs = 20000 }) {
  let pending = null, decoded = null;
  function clearDecoded() { if (decoded) clearTimeout(decoded.timer); decoded = null; }
  const sameSelection = (entry, owner, value) => entry?.owner === owner && entry.accountId === value.accountId
    && entry.conversationId === value.conversationId && entry.messageId === value.messageId;
  function remember(job) {
    clearDecoded();
    const dimensions = job.image.getSize(), bytes = dimensions.width * dimensions.height * 4;
    if (bytes > maxDecodedBytes || decodedTtlMs <= 0) return;
    const entry = { owner: job.owner, accountId: job.accountId, conversationId: job.conversationId, messageId: job.messageId,
      signature: job.signature, image: job.image, expiresAt: Date.now() + decodedTtlMs };
    entry.timer = setTimeout(() => { if (decoded === entry) clearDecoded(); }, decodedTtlMs); entry.timer.unref?.();
    decoded = entry;
  }
  function release(job) {
    if (!job) return;
    clearTimeout(job.timer); job.controller.abort(); job.image = null;
    if (pending === job) pending = null;
  }
  const current = job => pending === job && !job.controller.signal.aborted && allowed(job.owner, job.accountId);
  async function prepare(owner, value) {
    if (!allowed(owner, value.accountId)) throw Error('当前账号无法复制此图片。');
    release(pending);
    if (decoded && (!sameSelection(decoded, owner, value) || decoded.expiresAt <= Date.now())) clearDecoded();
    const job = { owner, accountId: value.accountId, conversationId: value.conversationId, messageId: value.messageId,
      ticket: randomUUID(), controller: new AbortController(), image: null };
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
      const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      job.signature = createHash('sha256').update(bytes).digest('hex');
      // Every copy still reads the authorized, verified source. Only decoding
      // the last successfully copied image is reused, with a strict RAM/TTL cap.
      if (sameSelection(decoded, owner, value) && decoded.expiresAt > Date.now() && decoded.signature === job.signature) {
        job.image = decoded.image; return { ticket: job.ticket };
      }
      clearDecoded();
      const image = nativeImage.createFromBuffer(bytes);
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
    try { clipboard.writeImage(job.image); remember(job); return { copied: true }; }
    finally { release(job); }
  }
  function cancel(owner, value) {
    if (pending?.owner === owner && pending.ticket === value.ticket) release(pending);
    return { copied: false, cancelled: true };
  }
  function invalidate(owner, conversationId = 0, ids = []) {
    const matches = entry => entry?.owner === owner && (!conversationId || (entry.conversationId === conversationId && (!ids.length || ids.includes(entry.messageId))));
    if (matches(decoded)) clearDecoded();
    if (matches(pending)) release(pending);
  }
  return { prepare, commit, cancel, invalidate, destroy() { release(pending); clearDecoded(); } };
}
module.exports = { createImageClipboard };
