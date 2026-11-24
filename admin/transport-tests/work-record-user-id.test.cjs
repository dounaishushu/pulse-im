const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const user = '7762e6a7-684e-401b-b979-5c42ae528303';
const publicID = '7762E6A7684E401BB9795C42AE528303';
const record = '00000011-2222-4222-8222-222222222222';
const task = '00000022-2222-4222-8222-222222222222';
const row = () => ({ id: record, user_id: user, task_id: task, user_public_id: publicID, total: 20, correct_count: 19, questions: [], answers: {}, results: {} });
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
  saved.set('pulse.go.admin.id.user.' + user, '517');
  saved.set('pulse.go.admin.wire.user.517', user);
  return { api, saved, requests };
}

test('record list retains the long user ID separately from its internal numeric reference', async () => {
  const f = fixture(() => Response.json({ items: [row()], page: 1, size: 10 }));
  const result = await f.api.request('/admin/work-records?user_id=' + publicID);
  assert.equal(result.items[0].user_public_id, publicID);
  assert.equal(result.items[0].user_id, 517);
  assert.equal(result.items[0].wrong_count, 1);
  assert.equal(new URL(f.requests[0].url).searchParams.get('user_id'), publicID);
});

test('record detail and review keep the original record UUID while displaying the long user ID', async () => {
  const f = fixture((url, options) => Response.json(options.method === 'POST' ? {} : row()));
  const id = f.api.local('record', record);
  const result = await f.api.request('/admin/work-records/detail?id=' + id);
  assert.equal(result.record.user_public_id, publicID);
  assert.equal(result.record.user_id, 517);
  await f.api.request('/admin/work-records/review', { method: 'POST', body: JSON.stringify({ record_id: id, request_id: 'review-fixture', results: {}, note: '' }) });
  assert.equal(f.requests[1].url, 'https://admin.invalid/api/v2/admin/task-records/' + record + '/review');
});

test('an older backend without the display field derives the same long ID from the raw UUID', async () => {
  const legacy = row(); delete legacy.user_public_id;
  const f = fixture(url => Response.json(url.includes('/task-records?') ? { items: [legacy], page: 1, size: 10 } : legacy));
  const list = await f.api.request('/admin/work-records');
  const detail = await f.api.request('/admin/work-records/detail?id=' + list.items[0].id);
  assert.equal(list.items[0].user_public_id, publicID);
  assert.equal(detail.record.user_public_id, publicID);
  assert.equal(detail.record.user_id, 517);
});

test('record queries and downloads preserve every digit of numeric-only long IDs', async () => {
  const value = '12345678123442348234123456781234';
  const f = fixture(() => Response.json({ items: [] }));
  await f.api.request('/admin/work-records?user_id=' + value);
  await f.api.download('/admin/work-records/export?user_id=' + value + '&status=reviewed');
  for (const request of f.requests) assert.equal(new URL(request.url).searchParams.get('user_id'), value);
  assert.equal(new URL(f.requests[1].url).pathname, '/api/v2/admin/exports/wages');
  assert.equal(new URL(f.requests[1].url).searchParams.get('format'), 'xlsx');
  assert.equal(new URL(f.requests[1].url).searchParams.get('status'), 'reviewed');
});
