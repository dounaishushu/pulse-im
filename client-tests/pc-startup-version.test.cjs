const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../pc/web/app.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function fixture({ version = async () => ({ required: false }), auth = async () => ({ id: 7 }), conversations = async () => {} } = {}) {
  let now = 0, timerId = 0, logouts = 0, renders = 0, reads = 0, closes = 0, cancelled = 0;
  const timers = new Map(), requests = [], warnings = [], diagnostics = [], elements = new Map();
  const storage = new Map([['fixture-token', 'fixture-session']]);
  const state = { token: 'fixture-session', user: null, socket: { close() { closes++; } } };
  const body = { value: '', set innerHTML(value) { this.value = value; elements.clear(); for (const match of value.matchAll(/id="([^"]+)"/g)) elements.set(match[1], {}); }, get innerHTML() { return this.value; } };
  const context = vm.createContext({
    state, CLIENT_VERSION: '2.4.170', desktop: { isDesktop: true, reportDiagnostic: value => diagnostics.push(value) },
    GO: { tokenKey: 'fixture-token', session() {}, raw(route, options) { requests.push({ route, options }); return version(); } },
    Date: { now: () => now }, URL, AbortSignal, Promise,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id; }, clearTimeout(id) { timers.delete(id); },
    console: { warn: (...args) => warnings.push(args) },
    document: { body }, $: id => elements.get(id) || null, location: { reload() {} },
    escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    cancelForegroundReads() { cancelled++; }, stopSocketRetries() {}, closeContactProfile() {},
    contactActionRevision: 0, disposeAuthView: null, disposeConversationSidebarResize: null,
    api: async route => { assert.equal(route, '/auth/me'); reads++; return auth(); },
    localStorage: { getItem: key => storage.get(key) ?? null },
    isDetachedConversation: false, detachedConversationId: 0,
    passcodeIsEnabled: () => false, readPasscodeSettings: () => ({ locked: false }),
    syncDesktopSession() {}, resumeAccountWork() {}, contactNames: { refresh: async () => {} },
    renderShell() { renders++; body.innerHTML = '<section id="messages">existing chat and draft</section>'; },
    loadConversations: conversations,
    leaveAccount() { logouts++; state.token = ''; storage.delete('fixture-token'); },
  });
  vm.runInContext(source.slice(source.indexOf('function compareClientVersions('), source.indexOf('state.chatSearch = null;')), context);
  vm.runInContext(source.slice(source.indexOf('async function boot()'), source.indexOf('function cancelConversationRecovery()')), context);
  vm.runInContext(source.slice(source.indexOf('function requireClientUpgrade('), source.indexOf('function desktopNotificationState()')), context);
  return {
    context, state, body, requests, warnings, diagnostics, storage,
    stats: () => ({ logouts, renders, reads, closes, cancelled }),
    nextDelay: () => Math.min(...[...timers.values()].map(timer => timer.at - now)),
    async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await settle(); },
  };
}

test('a stalled version service does not delay authenticated startup or read saved credentials', async () => {
  const held = deferred(), f = fixture({ version: () => held.promise });
  await f.context.boot();
  assert.equal(f.stats().renders, 1); assert.equal(f.stats().reads, 1);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.authToken, '');
  assert.match(f.requests[0].route, /platform=pc&version=2\.4\.170/);
  assert.equal(f.state.token, 'fixture-session'); assert.match(f.body.innerHTML, /existing chat/);
  held.resolve({ required: false }); await settle();
});

test('the exact timeout failure retains chat, session and draft, then recovers in the background', async () => {
  const held = deferred(); let calls = 0;
  const f = fixture({ version: () => ++calls === 1 ? held.promise : Promise.resolve({ required: false }) });
  await f.context.boot(); const before = f.body.innerHTML;
  held.reject(new DOMException('signal timed out', 'TimeoutError')); await settle();
  assert.equal(f.body.innerHTML, before); assert.equal(f.stats().logouts, 0);
  assert.equal(f.storage.get('fixture-token'), 'fixture-session'); assert.equal(f.nextDelay(), 15000);
  assert.equal(f.diagnostics[0].name, 'ClientUpdateCheck');
  await f.advance(15000); assert.equal(calls, 2); assert.equal(f.nextDelay(), 300000);
  assert.equal(f.body.innerHTML, before);
});

for (const failure of [new TypeError('Failed to fetch'), Object.assign(Error('service busy'), { status: 503 }), Object.assign(Error('public request denied'), { status: 403 })]) {
  test(`an update endpoint failure (${failure.name}/${failure.status || 'network'}) cannot sign out a valid chat session`, async () => {
    const f = fixture({ version: async () => { throw failure; } });
    await f.context.boot(); await settle();
    assert.equal(f.stats().renders, 1); assert.equal(f.stats().logouts, 0);
    assert.equal(f.state.updateRequired, undefined); assert.doesNotMatch(f.body.innerHTML, /暂时无法加载聊天/);
  });
}

test('a malformed update response is retried without treating it as an upgrade decision', async () => {
  const f = fixture({ version: async () => ({ required: 'false' }) });
  await f.context.boot(); await settle();
  assert.equal(f.state.updateRequired, undefined); assert.equal(f.nextDelay(), 15000);
  assert.equal(f.stats().renders, 1);
});

test('parallel startup and login readiness checks share a request and respect the success cooldown', async () => {
  const held = deferred(), f = fixture({ version: () => held.promise });
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => f.context.enforceClientUpdate())), Array(8).fill(true));
  assert.equal(f.requests.length, 1);
  held.resolve({ required: false }); await settle();
  await f.context.enforceClientUpdate(); await settle(); assert.equal(f.requests.length, 1);
  await f.advance(300000); assert.equal(f.requests.length, 2);
});

test('repeated failures back off to five minutes instead of creating a tight retry loop', async () => {
  const f = fixture({ version: async () => { throw Error('offline'); } });
  await f.context.enforceClientUpdate(); await settle();
  for (const delay of [15000, 30000, 60000, 120000, 240000, 300000]) {
    assert.equal(f.nextDelay(), delay); await f.advance(delay);
  }
  assert.equal(f.requests.length, 7); assert.equal(f.nextDelay(), 300000);
});

test('a confirmed mandatory upgrade cancels chat work and renders safe upgrade instructions', async () => {
  const f = fixture({ version: async () => ({ required: true, minimum_version: '2.5.0', url: 'https://downloads.example.org/client.exe', notes: '<script>fixture</script>' }) });
  await f.context.boot(); await settle();
  assert.equal(f.state.updateRequired, true); assert.equal(f.stats().cancelled, 1); assert.equal(f.stats().closes, 1);
  assert.match(f.body.innerHTML, /需要更新客户端/); assert.match(f.body.innerHTML, /required-update-download/);
  assert.doesNotMatch(f.body.innerHTML, /<script>/); assert.match(f.body.innerHTML, /&lt;script&gt;/);
  assert.equal(await f.context.enforceClientUpdate(), false); assert.equal(f.nextDelay(), Infinity);
});

test('an explicit realtime upgrade signal stays blocked even when its details time out', async () => {
  const held = deferred(), f = fixture({ version: () => held.promise });
  await f.context.boot(); f.context.requireClientUpgrade('服务器要求升级');
  assert.equal(f.state.updateRequired, true); assert.match(f.body.innerHTML, /服务器要求升级/);
  held.reject(new DOMException('signal timed out', 'TimeoutError')); await settle();
  assert.equal(await f.context.enforceClientUpdate(), false); assert.match(f.body.innerHTML, /服务器要求升级/);
  assert.equal(f.nextDelay(), Infinity);
});

test('an optional reply cannot clear a mandatory realtime upgrade decision', async () => {
  const held = deferred(), f = fixture({ version: () => held.promise });
  await f.context.boot(); f.context.requireClientUpgrade('explicit upgrade');
  held.resolve({ required: false }); await settle();
  assert.equal(f.state.updateRequired, true); assert.match(f.body.innerHTML, /explicit upgrade/);
  assert.equal(await f.context.enforceClientUpdate(), false);
});

for (const rejected of [false, true]) {
  test(`late authentication ${rejected ? 'failure' : 'success'} cannot overwrite a confirmed upgrade page`, async () => {
    const user = deferred(), version = deferred(), f = fixture({ auth: () => user.promise, version: () => version.promise });
    const opening = f.context.boot(); await settle();
    version.resolve({ required: true, minimum_version: '2.5.0' }); await settle();
    if (rejected) user.reject(Object.assign(Error('offline'), { status: 503 })); else user.resolve({ id: 7 });
    await opening; assert.match(f.body.innerHTML, /需要更新客户端/); assert.equal(f.stats().renders, 0);
  });
}

test('a late conversation-list failure cannot replace the mandatory update page with a boot error', async () => {
  const list = deferred(), version = deferred(), f = fixture({ conversations: () => list.promise, version: () => version.promise });
  const opening = f.context.boot(); await settle(); assert.equal(f.stats().renders, 1);
  version.resolve({ required: true, minimum_version: '2.5.0' }); await settle();
  list.reject(Error('list request cancelled')); await opening;
  assert.match(f.body.innerHTML, /需要更新客户端/); assert.doesNotMatch(f.body.innerHTML, /暂时无法加载聊天/);
});

test('real authentication rejection still signs out even while update discovery is unavailable', async () => {
  const f = fixture({ version: async () => { throw Error('offline'); }, auth: async () => { throw Object.assign(Error('unauthorized'), { status: 401 }); } });
  await f.context.boot(); await settle(); assert.equal(f.stats().logouts, 1); assert.equal(f.state.token, '');
});

test('a real chat API outage still reports a retryable boot failure without discarding the token', async () => {
  const f = fixture({ version: async () => { throw Error('offline'); }, auth: async () => { throw Object.assign(Error('auth service unavailable'), { status: 503 }); } });
  await f.context.boot(); await settle();
  assert.match(f.body.innerHTML, /暂时无法加载聊天/); assert.match(f.body.innerHTML, /auth service unavailable/);
  assert.equal(f.stats().logouts, 0); assert.equal(f.state.token, 'fixture-session');
});
