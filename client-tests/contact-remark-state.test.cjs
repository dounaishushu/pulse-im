const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/go-v2.js');
const base = 'https://chat.example.org/api/v2';
const uid = '11111111-1111-4111-8111-111111111111', cid = '33333333-3333-4333-8333-333333333333', avatar = '44444444-4444-4444-8444-444444444444';
function fixture(fetch) {
  const values = new Map(), go = create({ base, fetch, storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
  go.session('actor'); return { go, userId: go.local('user', uid), conversationId: go.local('conversation', cid) };
}
test('remark writes use raw friend metadata, preserving a large CAS version without waiting for avatars', async () => {
  const requests = [];
  const f = fixture(async (url, options) => {
    requests.push({ url, method: options.method, body: options.body });
    if (url.endsWith('/profiles/' + uid)) return Response.json({ id: uid, is_contact: true, remark: '旧备注', group_name: '工作', contact_version: '9007199254740994', avatar_id: avatar });
    assert.equal(url, base + '/friends/' + uid + '/metadata');
    assert.deepEqual(JSON.parse(options.body), { remark: '新备注', group_name: '工作', expected_version: '9007199254740994' });
    return Response.json({ version: '9007199254740995' });
  });
  const result = await f.go.request('/contacts/remark', { method: 'POST', authToken: 'actor', body: { user_id: f.userId, remark: '新备注' } });
  assert.equal(result.remark, '新备注'); assert.equal(requests.length, 2);
  assert.ok(requests.every(row => !row.url.includes('/media/')));
});
test('relationship rechecks retain group context and server-authoritative contact status without avatar requests', async () => {
  const requests = [];
  const f = fixture(async raw => {
    const url = new URL(raw); requests.push(url);
    assert.equal(url.pathname, '/api/v2/profiles/' + uid); assert.equal(url.searchParams.get('conversation_id'), cid);
    return Response.json({ id: uid, is_contact: false, remark: '', contact_version: '0', avatar_id: avatar });
  });
  const result = await f.go.request('/contacts/relationship?user_id=' + f.userId + '&context_conversation_id=' + f.conversationId);
  assert.equal(result.user_id, f.userId); assert.equal(result.is_contact, false); assert.equal(requests.length, 1);
});
test('profile permission denial prevents any metadata write', async () => {
  let calls = 0;
  const f = fixture(async (_url, options) => { calls++; assert.equal(options.method, 'GET'); return Response.json({ error: { code: 'forbidden' } }, { status: 403 }); });
  await assert.rejects(f.go.request('/contacts/remark', { method: 'POST', body: { user_id: f.userId, remark: '不应保存' } }), error => error.status === 403);
  assert.equal(calls, 1);
});
test('a session change during remark preflight cannot submit a write', async () => {
  let release, notify, calls = 0;
  const started = new Promise(resolve => { notify = resolve; });
  const f = fixture(async () => { calls++; notify(); return new Promise(resolve => { release = resolve; }); });
  const pending = f.go.request('/contacts/remark', { method: 'POST', authToken: 'actor', body: { user_id: f.userId, remark: '旧账号备注' } });
  await started; f.go.session('replacement');
  release(Response.json({ id: uid, is_contact: true, remark: '', contact_version: '0', group_name: '' }));
  await assert.rejects(pending, error => error.code === 'stale_session'); assert.equal(calls, 1);
});
test('a competing contact metadata edit remains a visible conflict without a blind overwrite', async () => {
  let writes = 0;
  const f = fixture(async (url, options) => {
    if (options.method === 'GET') return Response.json({ id: uid, is_contact: true, remark: '原备注', group_name: '原分组', contact_version: '3', avatar_id: avatar });
    writes++; assert.equal(JSON.parse(options.body).expected_version, '3');
    return Response.json({ error: { code: 'conflict' } }, { status: 409 });
  });
  await assert.rejects(f.go.request('/contacts/remark', { method: 'POST', body: { user_id: f.userId, remark: '新备注' } }), error => error.status === 409);
  assert.equal(writes, 1);
});
