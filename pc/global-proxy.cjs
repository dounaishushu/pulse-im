const defaultProxySettings = () => ({ mode: 'direct', proxyUrl: '', useIpv6: false, saved: [], activeProxyId: null });

function normalizeProxySettings(input) {
  const source = typeof input === 'string' ? { mode: input.trim() ? 'custom' : 'direct', proxyUrl: input.trim() } : (input || {});
  const mode = ['direct', 'system', 'custom'].includes(source.mode) ? source.mode : (source.proxyUrl ? 'custom' : 'direct');
  const saved = (Array.isArray(source.saved) ? source.saved : Array.isArray(source.savedProxies) ? source.savedProxies : [])
    .map((item, index) => typeof item === 'string' ? { id: `proxy-${index}`, url: item.trim() } : { id: String(item?.id || `proxy-${index}`), url: String(item?.url || item?.proxyUrl || '').trim(), createdAt: item?.createdAt || '', updatedAt: item?.updatedAt || '' })
    .filter(item => item.url);
  return { ...defaultProxySettings(), mode, proxyUrl: String(source.proxyUrl || '').trim(), useIpv6: Boolean(source.useIpv6), saved, activeProxyId: source.activeProxyId ? String(source.activeProxyId) : null };
}

const normalizedHost = value => String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();

function compileProxySettings(input) {
  const settings = normalizeProxySettings(input);
  if (settings.mode !== 'custom') return { settings, config: { mode: settings.mode }, auth: null };
  let url;
  try { url = new URL(settings.proxyUrl); } catch { throw new Error('代理链接格式不正确，例如 socks5://127.0.0.1:1080。'); }
  const protocol = url.protocol.toLowerCase();
  if (!['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(protocol)) throw new Error('仅支持 HTTP、HTTPS、SOCKS4 和 SOCKS5 代理链接。');
  if (!url.hostname) throw new Error('代理链接缺少服务器地址。');
  const port = Number(url.port || (protocol === 'http:' ? 80 : protocol === 'https:' ? 443 : 1080));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理端口必须在1到65535之间。');
  const hostname = normalizedHost(url.hostname), authority = `${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`;
  let username, password;
  try { username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { throw new Error('代理用户名或密码的编码格式不正确。'); }
  const proxyRules = protocol === 'socks4:' ? `socks4=${authority}` : protocol === 'socks5:' || protocol === 'socks5h:' ? `socks5=${authority}` : `http=${authority};https=${authority};ftp=${authority}`;
  return { settings, config: { mode: 'fixed_servers', proxyRules, proxyBypassRules: '<local>' }, auth: username || password ? { host: hostname, port, username, password } : null };
}

// Registration and changes share one queue: a new partition cannot load while an
// older change is still applying. Authentication follows each session's policy.
function createGlobalProxy({ persist = async () => {}, limits = {} } = {}) {
  const sessions = new Map(), retired = new WeakSet(), idleWaiters = new Set(), queue = [];
  const duration = (value, fallback) => Number.isFinite(value) && value > 0 ? Math.max(1, value) : fallback;
  const totalMs = duration(limits.totalMs, 45000), stageMs = duration(limits.stageMs, 10000);
  const rollbackMs = Math.min(totalMs / 2, duration(limits.rollbackMs, 10000));
  let current = compileProxySettings(defaultProxySettings()), activeJob = null, pending = 0;
  const cloneSettings = value => JSON.parse(JSON.stringify(value.settings));
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const expired = () => failure('PROXY_TIMEOUT', '代理配置等待超时，请稍后重试。');
  const released = () => failure('PROXY_SESSION_RELEASED', '此账号的网络会话已经释放。');
  const busy = () => failure('PROXY_SESSION_PENDING', '此账号的代理配置仍在处理中，已暂停网络访问，请稍后重试。');
  const newRecord = target => ({ target, policy: null, ready: false, active: null, released: false, cleanupStep: 0, lifetime: new AbortController() });
  const persistence = newRecord(null);
  function completed(job, error, value) {
    if (job.done) return;
    job.done = true; clearTimeout(job.timer); job.action = null;
    const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
    if (activeJob === job) activeJob = null;
    if (error) job.reject(error); else job.resolve(value);
    if (--pending === 0) for (const finish of [...idleWaiters]) finish();
    pump();
  }
  function pump() {
    if (activeJob || !queue.length) return;
    const job = queue.shift(); activeJob = job;
    Promise.resolve().then(() => {
      if (job.controller.signal.aborted || Date.now() >= job.deadline) throw expired();
      return job.action(job);
    }).then(value => completed(job, null, value), error => completed(job, error));
  }
  function enqueue(action, target = null) {
    return new Promise((resolve, reject) => {
      const job = { action, target, resolve, reject, deadline: Date.now() + totalMs, controller: new AbortController(), done: false };
      job.timer = setTimeout(() => {
        job.controller.abort(expired());
        // Running work observes this signal at every native phase. Do not race
        // the entire action: it must finish rollback/isolation before the next job.
        if (activeJob !== job) completed(job, expired());
      }, totalMs);
      pending++; queue.push(job); pump();
    });
  }
  function whenIdle({ signal } = {}) {
    // Request cancellation detaches its waiter. The shared configuration and
    // rollback chain must keep running, and must never retain request bodies.
    return new Promise((resolve, reject) => {
      const finish = error => {
        idleWaiters.delete(finish); signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(signal.reason || new Error('网络请求已取消。'));
      if (signal?.aborted) { aborted(); return; }
      if (!pending) { resolve(); return; }
      idleWaiters.add(finish); signal?.addEventListener('abort', aborted, { once: true });
    });
  }
  // A native Electron operation cannot be cancelled. Keep only this small
  // record attached to it, never the timed-out job or its waiting callers.
  // Late completion permits explicit recovery; it never makes a Session ready.
  function begin(record, stage, invoke) {
    if (record.active) throw busy();
    const operation = { stage, waiters: new Set(), settled: false, error: null };
    record.active = operation;
    const finish = error => {
      operation.settled = true; operation.error = error || null;
      if (record.active === operation) record.active = null;
      for (const waiter of [...operation.waiters]) waiter(error);
      if (record.released) queueMicrotask(() => cleanupReleased(record));
    };
    try { Promise.resolve(invoke()).then(() => finish(), finish); }
    catch (error) { finish(error); }
    return operation;
  }
  function observe(record, operation, deadline, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = error => {
        clearTimeout(timer); operation.waiters.delete(finish);
        signal?.removeEventListener('abort', aborted); record.lifetime.signal.removeEventListener('abort', removed);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(signal.reason || expired()), removed = () => finish(released());
      if (record.released) { removed(); return; }
      if (signal?.aborted) { aborted(); return; }
      if (operation.settled) { finish(operation.error); return; }
      operation.waiters.add(finish);
      signal?.addEventListener('abort', aborted, { once: true }); record.lifetime.signal.addEventListener('abort', removed, { once: true });
      timer = setTimeout(() => finish(failure('PROXY_STAGE_TIMEOUT', '代理配置处理超时，此账号的网络访问已暂停。')), Math.max(0, Math.min(stageMs, deadline - Date.now())));
    });
  }
  function check(record, deadline, signal) {
    if (record.released) throw released();
    if (signal?.aborted) throw signal.reason || expired();
    if (Date.now() >= deadline) throw expired();
    if (record.active) throw busy();
  }
  async function phase(record, stage, invoke, deadline, signal) {
    check(record, deadline, signal);
    await observe(record, begin(record, stage, invoke), deadline, signal);
    check(record, deadline, signal);
  }
  async function configure(record, policy, deadline, signal) {
    record.ready = false;
    await phase(record, 'setProxy', () => record.target.setProxy({ ...policy.config }), deadline, signal);
    record.policy = policy;
    await phase(record, 'clearAuthCache', () => record.target.clearAuthCache(), deadline, signal);
    await phase(record, 'closeAllConnections', () => record.target.closeAllConnections(), deadline, signal);
    record.ready = true;
  }
  function registerSession(target) {
    if (retired.has(target)) return Promise.reject(released());
    // A quarantined native call must settle before this same Session can be
    // configured again. A separate healthy Session may still join the queue.
    if (sessions.get(target)?.active) return Promise.reject(busy());
    return enqueue(async job => {
      if (retired.has(target)) throw released();
      let record = sessions.get(target);
      if (record?.ready) return cloneSettings(current);
      if (!record) { record = newRecord(target); sessions.set(target, record); }
      try { await configure(record, current, job.deadline, job.controller.signal); }
      catch (error) { record.ready = false; throw error; }
      return cloneSettings(current);
    }, target);
  }
  async function apply(input, { persist: shouldPersist = true } = {}) {
    const next = compileProxySettings(input);
    return enqueue(async job => {
      if (shouldPersist && persistence.active) throw failure('PROXY_PERSIST_PENDING', '上次代理设置仍在保存，请稍后重试。');
      const touched = [], deadline = job.deadline - rollbackMs;
      try {
        for (const record of sessions.values()) {
          // Never overlap a still-running native operation, including rollback.
          // Once it settles a later explicit apply/register can repair this record.
          if (record.released || record.active) continue;
          const previous = record.ready ? record.policy : null;
          touched.push([record, previous]);
          try { await configure(record, next, deadline, job.controller.signal); }
          catch (error) { if (!record.released) throw error; }
        }
        if (shouldPersist) await phase(persistence, 'persist', () => persist(cloneSettings(next)), deadline, job.controller.signal);
      } catch (error) {
        let rollbackFailures = 0;
        for (const [record, previous] of touched.reverse()) {
          if (record.released) continue;
          try {
            if (!previous || record.active) throw busy();
            await configure(record, previous, job.deadline, job.controller.signal);
          } catch { record.ready = false; rollbackFailures++; }
        }
        const failure = new Error(rollbackFailures ? '代理设置失败，部分账号无法恢复原配置，请重启客户端后重试。' : '代理设置失败，已恢复原配置，请重试。', { cause: error });
        failure.code = rollbackFailures ? 'PROXY_ROLLBACK_FAILED' : 'PROXY_APPLY_FAILED';
        throw failure;
      }
      current = next;
      return cloneSettings(current);
    });
  }
  function credentialsFor(authInfo, target) {
    if (authInfo?.isProxy !== true) return null;
    const record = target ? sessions.get(target) : null, auth = record?.ready ? record.policy?.auth : null;
    if (!auth || normalizedHost(authInfo.host) !== auth.host || Number(authInfo.port) !== auth.port) return null;
    return { username: auth.username, password: auth.password };
  }
  function cleanupReleased(record) {
    if (!record.released || record.active || record.cleanupStep >= 2) return;
    const stage = ['clearAuthCache', 'closeAllConnections'][record.cleanupStep++];
    begin(record, stage, () => record.target[stage]());
  }
  // Permanent profile disposal only. Closing a child window, hiding, locking or
  // signing out must not retire a Session still shared by other windows.
  function unregisterSession(target) {
    retired.add(target);
    const record = sessions.get(target); sessions.delete(target);
    for (const job of [...queue]) if (job.target === target) completed(job, released());
    if (record) {
      record.released = true; record.ready = false; record.policy = null; record.lifetime.abort(released());
      cleanupReleased(record);
    }
    return { released: true, cleanupPending: Boolean(record?.active) };
  }
  function sessionState(target) {
    const record = sessions.get(target);
    return { state: retired.has(target) ? 'released' : !record ? 'unregistered' : record.ready ? 'ready' : record.active ? 'pending' : 'quarantined',
      pendingNative: Boolean(record?.active), stage: record?.active?.stage || null };
  }
  return { registerSession, unregisterSession, releaseSession: unregisterSession, sessionState, apply, settings: () => cloneSettings(current), credentialsFor,
    isSessionReady: target => Boolean(sessions.get(target)?.ready), hasAuthentication: target => Boolean(sessions.get(target)?.ready && sessions.get(target).policy?.auth), whenIdle };
}

module.exports = { createGlobalProxy, defaultProxySettings, normalizeProxySettings, compileProxySettings };
