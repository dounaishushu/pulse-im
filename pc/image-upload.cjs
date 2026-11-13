const { randomBytes } = require('node:crypto');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
const failure = (code, message) => Object.assign(new Error(message), { code });

// Use a dedicated Session with the account's global proxy policy, so background
// media/history cannot occupy every upload socket. No automatic POST replay.
function createImageUploader({ net, proxy, version, createSession, report = () => {}, limits = {} }) {
  const totalMs = limits.totalMs ?? 120000, idleMs = limits.idleMs ?? 30000, responseMs = limits.responseMs ?? 30000;
  const uploadSessions = new WeakMap(), retiredOwners = new WeakSet(), activeUploads = new WeakMap();
  function startRegistration(entry) {
    entry.pending = true;
    const finish = error => {
      if (entry.released) error = failure('UPLOAD_SESSION_CHANGED', '账号或客户端状态已改变，图片上传已停止。');
      entry.pending = false; entry.ready = !error;
      for (const waiter of [...entry.waiters]) waiter(error);
    };
    // Only this small shared entry belongs to the uncancellable registration.
    // Individual upload waiters are removable, including while setup is stuck.
    try { Promise.resolve(proxy.registerSession(entry.target)).then(() => finish(), finish); }
    catch (error) { finish(error); }
  }
  function waitForRegistration(entry, signal) {
    return new Promise((resolve, reject) => {
      const finish = error => {
        entry.waiters.delete(finish); signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(signal.reason || failure('UPLOAD_CANCELLED', '图片发送已停止。'));
      if (signal.aborted) { aborted(); return; }
      if (entry.released) { finish(failure('UPLOAD_SESSION_CHANGED', '账号或客户端状态已改变，图片上传已停止。')); return; }
      // Registration success is cached, but readiness can be revoked later by
      // proxy quarantine. Reuse the same Session and explicitly recover it.
      if (entry.ready && !proxy.isSessionReady(entry.target)) entry.ready = false;
      if (entry.ready) { resolve(); return; }
      entry.waiters.add(finish); signal.addEventListener('abort', aborted, { once: true });
      if (!entry.pending) startRegistration(entry);
    });
  }
  async function transportSession(owner, signal) {
    if (retiredOwners.has(owner)) throw failure('UPLOAD_SESSION_CHANGED', '此账号的图片上传会话已经释放。');
    if (!createSession) return owner;
    let entry = uploadSessions.get(owner);
    if (!entry) {
      const target = createSession('pulse-image-upload-' + randomBytes(18).toString('hex'));
      if (!target || target === owner) throw failure('UPLOAD_PROXY', '图片上传网络会话无法建立，请重试。（UPLOAD_PROXY）');
      entry = { target, ready: false, pending: false, released: false, waiters: new Set() }; uploadSessions.set(owner, entry);
    }
    await waitForRegistration(entry, signal);
    return entry.target;
  }
  function uploadImage({ session, url, token, mime, bytes, signal, allowed = () => true, progress = () => {} }) {
    if (retiredOwners.has(session)) return Promise.reject(failure('UPLOAD_SESSION_CHANGED', '此账号的图片上传会话已经释放。'));
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES || !Object.hasOwn(TYPES, mime)
      || typeof token !== 'string' || !token || token.length > 4096 || /[\r\n]/.test(token)) {
      return Promise.reject(failure('UPLOAD_INVALID', '图片上传参数无效，请重新选择图片。'));
    }
    let endpoint;
    try { endpoint = new URL(url); } catch { return Promise.reject(failure('UPLOAD_ROUTE', '图片上传线路无效。')); }
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) return Promise.reject(failure('UPLOAD_ROUTE', '图片上传线路无效。'));
    const fileBytes = bytes.byteLength;
    let file = Buffer.from(bytes.buffer, bytes.byteOffset, fileBytes);
    const boundary = '----PulseImage' + randomBytes(18).toString('hex');
    // The original display name stays in the message body, never in transport logs.
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${TYPES[mime]}"\r\nContent-Type: ${mime}\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`), bodySize = prefix.length + fileBytes + suffix.length;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const lifetime = new AbortController();
      let request, timer, settled = false, sent = 0, uploadedAt = 0, lastActivity = started, status = 0, authAttempts = 0, reported = -1, reportedWaiting = null;
      const emit = waiting => {
        if (settled) return;
        const current = Math.max(0, Math.min(fileBytes, sent - prefix.length));
        if (current === reported && waiting === reportedWaiting) return;
        reported = current; reportedWaiting = waiting;
        try { progress({ sent: current, total: fileBytes, waiting, elapsedMs: Date.now() - started }); } catch { /* A closed renderer cannot interrupt cleanup. */ }
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearInterval(timer); signal?.removeEventListener('abort', aborted);
        // Error stacks may retain this closure after callers keep the error for
        // display. Drop its large backing store even in that case.
        file = null;
        const active = activeUploads.get(session); active?.delete(ownerReleased); if (active?.size === 0) activeUploads.delete(session);
        lifetime.abort();
        if (error) { try { request?.abort(); } catch {} }
        const now = Date.now();
        // Deliberately exclude tokens, URLs, paths, filenames and response bodies.
        try { report(error || status >= 400 ? 'image-upload-failed' : 'image-upload-completed', {
          code: error?.code || (status >= 400 ? 'UPLOAD_HTTP' : 'OK'), bytes: fileBytes, status,
          elapsedMs: now - started, transferMs: (uploadedAt || now) - started, responseMs: uploadedAt ? now - uploadedAt : 0,
        }, error || status >= 400 ? 'warn' : 'info'); } catch {}
        if (error) reject(error); else resolve(result);
      };
      const aborted = () => finish(failure('UPLOAD_CANCELLED', '图片发送已停止。'));
      const ownerReleased = () => finish(failure('UPLOAD_SESSION_CHANGED', '账号或客户端状态已改变，图片上传已停止。'));
      const check = () => {
        if (settled) return;
        if (signal?.aborted) return aborted();
        if (retiredOwners.has(session) || !allowed()) return ownerReleased();
        const now = Date.now();
        if (now - started >= totalMs) return finish(failure('UPLOAD_TIMEOUT', '图片上传超时，请检查网络后重试。（UPLOAD_TIMEOUT）'));
        if (request && !uploadedAt) {
          const current = request.getUploadProgress();
          if (current.started && current.total > 0) {
            const next = Math.max(sent, Math.min(bodySize, current.current));
            if (next > sent) { sent = next; lastActivity = now; }
            if (sent >= bodySize) { uploadedAt = now; lastActivity = now; }
            emit(Boolean(uploadedAt));
          }
        }
        if (now - lastActivity >= (uploadedAt ? responseMs : idleMs)) {
          finish(uploadedAt
            ? failure('UPLOAD_RESPONSE_TIMEOUT', '图片已上传，服务器响应超时，可重试。（UPLOAD_RESPONSE_TIMEOUT）')
            : failure('UPLOAD_STALLED', '图片上传长时间无进展，请检查网络后重试。（UPLOAD_STALLED）'));
        }
      };
      signal?.addEventListener('abort', aborted, { once: true });
      if (!activeUploads.has(session)) activeUploads.set(session, new Set());
      activeUploads.get(session).add(ownerReleased);
      timer = setInterval(() => { try { check(); } catch { finish(failure('UPLOAD_NETWORK', '图片上传连接中断，请重试。（UPLOAD_NETWORK）')); } }, 100);
      check();
      if (settled) return;
      emit(false);
      (async () => {
        await proxy.whenIdle({ signal: lifetime.signal });
        check(); if (settled) return;
        if (!proxy.isSessionReady(session)) throw failure('UPLOAD_PROXY', '此账号的网络会话尚未准备好，请稍后重试。');
        let target;
        try { target = await transportSession(session, lifetime.signal); }
        catch { throw failure('UPLOAD_PROXY', '图片上传网络会话尚未准备好，请稍后重试。（UPLOAD_PROXY）'); }
        await proxy.whenIdle({ signal: lifetime.signal });
        check(); if (settled) return;
        if (!proxy.isSessionReady(session) || !proxy.isSessionReady(target)) throw failure('UPLOAD_PROXY', '此账号的网络会话尚未准备好，请稍后重试。');
        request = net.request({ url: endpoint.href, method: 'POST', session: target, redirect: 'manual', useSessionCookies: false });
        request.on('login', (authInfo, callback) => {
          const auth = proxy.credentialsFor(authInfo, target);
          if (auth && authAttempts++ === 0 && !settled && allowed()) callback(auth.username, auth.password); else callback();
        });
        request.on('redirect', () => finish(failure('UPLOAD_REDIRECT', '图片上传地址发生跳转，请检查服务器配置。（UPLOAD_REDIRECT）')));
        request.on('error', () => finish(failure('UPLOAD_NETWORK', '图片上传连接失败，请检查网络后重试。（UPLOAD_NETWORK）')));
        request.on('abort', () => { if (!settled) aborted(); });
        request.on('response', response => {
          if (settled) return;
          status = response.statusCode; lastActivity = Date.now();
          if (status >= 200 && status < 300) { sent = bodySize; uploadedAt ||= lastActivity; emit(true); }
          const chunks = []; let size = 0;
          response.on('data', chunk => {
            if (settled) return;
            size += chunk.length; lastActivity = Date.now();
            if (size > 1024 * 1024) return finish(failure('UPLOAD_RESPONSE_INVALID', '图片上传响应过大，请检查服务器。（UPLOAD_RESPONSE_INVALID）'));
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (!allowed()) return finish(failure('UPLOAD_SESSION_CHANGED', '账号或客户端状态已改变，图片上传已停止。'));
            finish(null, { status, headers: { 'content-type': String(response.headers['content-type'] || '') }, body: Buffer.concat(chunks).toString('utf8') });
          });
          response.on('aborted', () => finish(failure('UPLOAD_NETWORK', '图片上传响应中断，请重试。（UPLOAD_NETWORK）')));
          response.on('error', () => finish(failure('UPLOAD_NETWORK', '图片上传响应中断，请重试。（UPLOAD_NETWORK）')));
        });
        request.setHeader('Authorization', `Bearer ${token}`);
        request.setHeader('X-Client-Platform', 'pc'); request.setHeader('X-Client-Version', version);
        request.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);
        request.setHeader('Cache-Control', 'no-store');
        // The default buffered body lets Chromium calculate Content-Length. Never
        // use chunked HTTP/1 uploads: PHP deployments may reject those bodies.
        request.write(prefix); request.write(file); request.end(suffix);
      })().catch(error => finish(typeof error?.code === 'string' && error.code.startsWith('UPLOAD_') ? error : failure('UPLOAD_NETWORK', '图片上传连接失败，请检查网络后重试。（UPLOAD_NETWORK）')));
    });
  }
  // Called only when the owning profile is permanently discarded. The original
  // account Session is released separately by its owner; sibling windows share it.
  uploadImage.releaseSession = owner => {
    retiredOwners.add(owner);
    for (const cancel of [...(activeUploads.get(owner) || [])]) cancel();
    activeUploads.delete(owner);
    const entry = uploadSessions.get(owner); uploadSessions.delete(owner);
    if (entry) {
      entry.released = true; entry.ready = false;
      for (const waiter of [...entry.waiters]) waiter(failure('UPLOAD_SESSION_CHANGED', '此账号的图片上传会话已经释放。'));
      try { Promise.resolve(proxy.unregisterSession?.(entry.target)).catch(() => {}); } catch {}
    }
    return { released: true, hadTransport: Boolean(entry) };
  };
  return uploadImage;
}
module.exports = { createImageUploader };
