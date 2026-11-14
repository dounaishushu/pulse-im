const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../admin/src/go-api.js'), 'utf8');

function fixture(fetch) {
  const storage = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  };
  const context = { location: { origin: 'https://admin.example.invalid' }, window: {},
    sessionStorage: storage(), localStorage: storage(), fetch, Response, FormData, URL, URLSearchParams, AbortController };
  vm.runInNewContext(source, context);
  return context;
}

const account = { id: '01010101-0101-4101-8101-010101010101', account: 'fixture-admin', role: 'superadmin', permissions: [] };

test('cookie login reaches Go without a tab-scoped entrance token', async () => {
  const requests = [];
  const context = fixture(async (url, options) => {
    requests.push({ url, options });
    return Response.json({ user: account, csrf_token: 'fixture-csrf' });
  });
  const result = await context.window.PulseGoAdmin.request('/admin/auth/login', { method: 'POST', body: JSON.stringify({ username: account.account, password: 'fixture-password' }) });
  assert.equal(result.session_mode, 'cookie');
  assert.equal(requests[0].url, 'https://admin.example.invalid/api/v2/admin/auth/login');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(requests[0].options.headers['X-Admin-Entry'], undefined);
  assert.equal(JSON.parse(requests[0].options.body).entry_token, '');
});

test('missing entrance returns a readable instruction', async () => {
  const context = fixture(async () => Response.json({ error: { code: 'admin_entry_required' } }, { status: 401 }));
  await assert.rejects(context.window.PulseGoAdmin.request('/admin/auth/login', { method: 'POST', body: '{}' }), error => error.code === 'admin_entry_required' && error.message.includes('专属入口'));
});

test('admin user lookup resolves a specific UUID instead of searching only the first page', async () => {
  let requested;
  const context = fixture(async url => {
    requested=url;
    return Response.json({id:account.id,account:'older-user',profile_version:'7'});
  });
  const local=context.window.PulseGoAdmin.local('user',account.id);
  const result=await context.window.PulseGoAdmin.request('/admin/users?user_id='+local);
  assert.equal(requested,'https://admin.example.invalid/api/v2/admin/users/'+account.id);
  assert.equal(result.items[0].username,'older-user');
});

test('an explicit entrance still accompanies the login password', async () => {
  let sent;
  const context = fixture(async (_, options) => { sent = options; return Response.json({ user: account, csrf_token: 'fixture-csrf' }); });
  const entry = 'a'.repeat(64);
  context.sessionStorage.setItem('pulse.go.admin.entry', entry);
  await context.window.PulseGoAdmin.request('/admin/auth/login', { method: 'POST', body: '{}' });
  assert.equal(sent.headers['X-Admin-Entry'], entry);
  assert.equal(JSON.parse(sent.body).entry_token, entry);
});

test('unconfigured location lookup keeps cached regions without submitting a refresh', async () => {
  const methods = [];
  const context = fixture(async (url, options) => {
    methods.push(options.method);
    if (url.includes('/ip-locations/pending')) return Response.json({ items: ['192.0.2.10'], lookup_available: false });
    if (url.includes('/admin/regions')) return Response.json({ items: [] });
    if (url.endsWith('/admin/stats')) return Response.json({ users: 3 });
    throw new Error('Unexpected location request');
  });
  const result = await context.window.PulseGoAdmin.request('/admin/stats/regions/resolve', { method: 'POST', body: '{}' });
  assert.equal(result.lookup_available, false);
  assert.equal(result.pending_ip_count, 1);
  assert.equal(result.next_ips.length, 0);
  assert.equal(result.total, 3);
  assert.equal(methods.includes('POST'), false);
});

test('unconfigured offsite lookup does not submit addresses or claim that they were processed', async () => {
  let calls = 0;
  const context = fixture(async (url, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    assert.ok(url.includes('/admin/offsite-logins?'));
    return Response.json({ items: [], next_ips: ['192.0.2.10'], pending_ip_count: 1, lookup_available: false });
  });
  const result = await context.window.PulseGoAdmin.request('/admin/stats/offsite-logins/resolve', { method: 'POST', body: '{}' });
  assert.equal(calls, 1);
  assert.equal(result.next_ips.length, 0);
  assert.equal(result.processed_ips, 0);
  assert.equal(result.pending_ip_count, 1);
});

test('dispatch list does not download step images before a task is opened', async () => {
  let calls = 0;
  const context = fixture(async (url, options) => {
    calls++;
    assert.ok(url.includes('/admin/dispatch-plans?'));
    assert.equal(options.method, 'GET');
    return Response.json({ page: 1, size: 20, items: [{ id: account.id, payload: {
      steps: Array.from({ length: 500 }, () => ({ kind: 'image', media_id: account.id })) }, enabled: true }] });
  });
  const result = await context.window.PulseGoAdmin.request('/admin/dispatch-tasks?page=1&size=20');
  assert.equal(calls, 1);
  assert.equal(result.items[0].step_count, 500);
  assert.equal(result.items[0].steps.length, 500);
});

test('a late admin response cannot repopulate data after logout or account replacement', async () => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  const context = fixture(async () => {
    started(); await pending;
    return Response.json({ page: 1, size: 20, items: [{ id: account.id, account: 'private-user' }] });
  });
  const api = context.window.PulseGoAdmin;
  const result = api.request('/admin/users');
  await waiting;
  api.reset();
  release();
  await assert.rejects(result, error => error.code === 'session_changed');
});

test('an admin write does not continue under new credentials after its preliminary read', async () => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  let writes = 0;
  const context = fixture(async (_, options) => {
    if (options.method !== 'GET') { writes++; return new Response(null, { status: 204 }); }
    started(); await pending;
    return Response.json({ version: '1', value: {} });
  });
  const api = context.window.PulseGoAdmin;
  const result = api.request('/admin/announcement', { method: 'POST', body: { enabled: true, title: 'old account', content: 'old draft' } });
  await waiting;
  context.sessionStorage.setItem(api.csrfKey, 'new-account-csrf');
  context.sessionStorage.setItem(api.entryKey, 'new-account-entry');
  api.reset();
  release();
  await assert.rejects(result, error => error.code === 'session_changed');
  assert.equal(writes, 0);
});
