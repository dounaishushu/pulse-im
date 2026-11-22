const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const id = '00000001-2222-4222-8222-222222222222';
function fixture(fetcher) {
  const saved = new Map(), requests = [];
  const sandbox = { window: {}, location: { origin: 'https://admin.invalid' }, URL, URLSearchParams, Response, FormData, AbortController, AbortSignal, DOMException, setTimeout, clearTimeout,
    localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) },
    sessionStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    fetch: async (url, options) => { requests.push({ url, options }); return fetcher(url, options); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/go-api.js'), 'utf8'), sandbox);
  const api = sandbox.window.PulseGoAdmin;
  saved.set(api.entryKey, '1'.repeat(64)); saved.set(api.csrfKey, '2'.repeat(64));
  return { api, saved, requests, uid: api.local('user', id) };
}
test('password read uses a dedicated POST and never populates user data or browser storage', async () => {
  const f = fixture((url, options) => Response.json(url.endsWith('/password-status') ? { available: true } : { password: 'OnlyATest888', visible_for_seconds: 30 }));
  await f.api.request('/admin/users/password-status?user_id=' + f.uid);
  assert.equal(f.requests[0].url, 'https://admin.invalid/api/v2/admin/users/' + id + '/password-status');
  for (let i = 0; i < 2; i++) {
    const result = await f.api.request('/admin/users/password-reveal', { method: 'POST', body: JSON.stringify({ user_id: f.uid, admin_password: 'FakeAdmin888' }) });
    assert.equal(result.password, 'OnlyATest888');
  }
  assert.equal(f.requests.length, 3);
  for (const req of f.requests.slice(1)) {
    assert.equal(req.options.method, 'POST');
    assert.equal(req.options.cache, 'no-store');
    assert.equal(req.options.headers['X-CSRF-Token'], '2'.repeat(64));
    assert.equal(req.options.headers['X-Admin-Entry'], '1'.repeat(64));
    assert.deepEqual(JSON.parse(req.options.body), { admin_password: 'FakeAdmin888' });
    assert.equal(req.url.includes('FakeAdmin888'), false);
  }
  assert.equal([...f.saved.values()].some(value => /OnlyATest888|FakeAdmin888/.test(String(value))), false);
  await assert.rejects(f.api.request('/admin/users/password-reveal'), { status: 405 });
});
test('a late password response is rejected after logout or account replacement', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { await gate; return Response.json({ password: 'OnlyATest888' }); });
  const pending = f.api.request('/admin/users/password-reveal', { method: 'POST', body: JSON.stringify({ user_id: f.uid, admin_password: 'FakeAdmin888' }) });
  const rejected = assert.rejects(pending, { status: 409, code: 'session_changed' });
  f.api.reset(); release(); await rejected;
});
