// Electron 33 Session.fetch returns a cold proxy 407 without emitting login.
// Negotiate only that proxy via one owned HEAD request, then reuse Chromium's
// session auth cache for the streaming fetch. Never answer origin challenges.
function createSessionFetch({ net, proxy, target }) {
  const checkCancelled = signal => { if (signal?.aborted) throw signal.reason || new Error('下载已取消。'); };
  function authenticate(url, signal) {
    return new Promise((resolve, reject) => {
      let request, finished = false, attempts = 0;
      const finish = error => {
        if (finished) return;
        finished = true; signal?.removeEventListener('abort', aborted);
        request?.abort();
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(signal.reason || new Error('下载已取消。'));
      if (signal?.aborted) { aborted(); return; }
      try {
        request = net.request({ url, method: 'HEAD', session: target, redirect: 'manual' });
        request.on('login', (authInfo, callback) => {
          const auth = proxy.credentialsFor(authInfo, target);
          if (auth && attempts++ === 0 && !finished) callback(auth.username, auth.password);
          else callback();
        });
        // HEAD status describes origin support, not whether the proxy auth cache
        // is warm. A 405/500 still permits the actual GET to decide its status.
        request.on('response', response => finish(response.statusCode === 407 ? new Error('代理认证失败，请检查代理用户名和密码。') : null));
        request.on('redirect', () => finish());
        request.on('error', error => finish(error));
        request.on('abort', () => { if (!finished) finish(new Error('代理认证请求已取消。')); });
        signal?.addEventListener('abort', aborted, { once: true });
        request.end();
      } catch (error) { finish(error); }
    });
  }
  return async function sessionFetch(value, options = {}) {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('下载地址无效。');
    checkCancelled(options.signal);
    await proxy.whenIdle({ signal: options.signal });
    checkCancelled(options.signal);
    if (!proxy.isSessionReady(target)) throw new Error('此账号的网络会话尚未准备好。');
    let response = await target.fetch(url.href, options);
    if (response.status !== 407 || !proxy.hasAuthentication(target)) return response;
    await response.body?.cancel();
    await authenticate(url.href, options.signal);
    await proxy.whenIdle({ signal: options.signal });
    checkCancelled(options.signal);
    if (!proxy.isSessionReady(target)) throw new Error('此账号的网络会话尚未准备好。');
    // Exactly one retry. A repeated 407 is handled by the normal downloader.
    return target.fetch(url.href, options);
  };
}
module.exports = { createSessionFetch };
