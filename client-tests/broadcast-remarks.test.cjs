const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/go-v2.js');
const names = require('../pc/web/contact-names.js');
const base = 'https://chat.example.org/api/v2';
const uuid = n => n.toString(16).padStart(8, '0') + '-1234-4123-8123-000000000000';
const id = n => parseInt(uuid(n).replace(/-/g, '').slice(0, 13), 16) + 1;
function client(fetch) {
  const values = new Map();
  const go = create({ base, fetch, storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
  go.session('fixture'); return go;
}

test('broadcast remark preparation reads all friend pages without requesting avatar capabilities', async () => {
  const calls = [];
  const go = client(async (raw, options) => {
    const url = new URL(raw); calls.push(url.pathname + url.search);
    assert.equal(url.pathname, '/api/v2/client/friend-page');
    assert.equal(options.headers.Authorization, 'Bearer fixture');
    const page = Number(url.searchParams.get('page')), size = 100;
    return Response.json({ page, size, total: 112, items: Array.from({ length: page === 1 ? 100 : 12 }, (_, i) => {
      const n = (page - 1) * size + i + 1;
      return { id: uuid(n), account: 'account' + n, nickname: '昵称' + n, remark: '备注' + n, avatar_id: uuid(999) };
    }) });
  });
  const controller = names.create({ context: () => ({ base, token: 'fixture', userId: id(998), allowed: true }), request: go.request });
  assert.equal(await controller.refresh(), true);
  assert.equal(controller.resolve(id(1), 'fallback'), '备注1');
  assert.equal(controller.resolve(id(112), 'fallback'), '备注112');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('page=1') && calls[1].includes('page=2'));
});

test('the regular friend directory still loads avatar capabilities', async () => {
  const calls = [];
  const go = client(async raw => {
    const url = new URL(raw); calls.push(url.pathname);
    if (url.pathname.endsWith('/client/friend-page')) return Response.json({ page: 1, size: 100, total: 1, items: [{ id: uuid(1), account: 'friend', nickname: '原昵称', remark: '测试备注', avatar_id: uuid(999) }] });
    assert.equal(url.pathname, '/api/v2/media/' + uuid(999) + '/grants');
    return Response.json({ content_path: '/api/v2/media-grants/' + 'a'.repeat(64) + '/content', expires_in: 120 });
  });
  const result = await go.request('/contacts?size=100&page=1', { authToken: 'fixture' });
  assert.equal(result.items[0].remark, '测试备注');
  assert.equal(result.items[0].user_id, id(1));
  assert.match(result.items[0].avatar_url, /\/media-grants\/a{64}\/content$/);
  assert.equal(calls.length, 2);
});

test('a late remark page cannot enter the replacement account after switching sessions', async () => {
  let release, requested;
  const started = new Promise(resolve => { requested = resolve; });
  const go = client(async () => { requested(); return new Promise(resolve => { release = resolve; }); });
  let context = { base, token: 'fixture', userId: id(998), allowed: true };
  const controller = names.create({ context: () => context, request: go.request });
  const loading = controller.refresh();
  await started;
  context = { ...context, token: 'other', userId: id(997) }; go.session('other');
  assert.equal(controller.resolve(id(1), '原昵称'), '原昵称');
  release(Response.json({ page: 1, size: 100, total: 1, items: [{ id: uuid(1), account: 'friend', nickname: '原昵称', remark: '旧账号备注', avatar_id: uuid(999) }] }));
  await assert.rejects(loading, error => error.code === 'stale_session');
  assert.equal(controller.resolve(id(1), '原昵称'), '原昵称');
});
