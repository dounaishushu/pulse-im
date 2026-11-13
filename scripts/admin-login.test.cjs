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

test('an explicit entrance still accompanies the login password', async () => {
  let sent;
  const context = fixture(async (_, options) => { sent = options; return Response.json({ user: account, csrf_token: 'fixture-csrf' }); });
  const entry = 'a'.repeat(64);
  context.sessionStorage.setItem('pulse.go.admin.entry', entry);
  await context.window.PulseGoAdmin.request('/admin/auth/login', { method: 'POST', body: '{}' });
  assert.equal(sent.headers['X-Admin-Entry'], entry);
  assert.equal(JSON.parse(sent.body).entry_token, entry);
});
