const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/go-v2.js');
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';

test('create-group contact pages expose avatar IDs immediately while preserving the legacy eager option', async () => {
  const requests = [], values = new Map();
  const client = create({ base: 'https://fixture.invalid/api/v2', storage: {
    getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v),
  }, fetch: async url => {
    const path = new URL(url).pathname.replace('/api/v2', ''); requests.push(path);
    if (path === '/client/friend-page') return Response.json({ items: [{ id: uuid(2), account: 'friend', nickname: '好友', remark: '备注', avatar_id: uuid(3) }], total: 1, page: 1 });
    if (path === '/media/' + uuid(3) + '/grants') return Response.json({ content_path: '/api/v2/media-grants/' + 'a'.repeat(64) + '/content', expires_in: 120 });
    throw Error('Unexpected request: ' + path);
  } });
  client.session('account');
  const deferred = await client.request('/contacts?page=1&size=100', { deferMedia: true });
  assert.equal(deferred.items[0].nickname, '好友'); assert.equal(deferred.items[0].remark, '备注');
  assert.equal(deferred.items[0].username, 'friend'); assert.equal(deferred.items[0].avatar_id, uuid(3));
  assert.equal(deferred.items[0].avatar_url, ''); assert.deepEqual(requests, ['/client/friend-page']);
  const eager = await client.request('/contacts?page=1&size=100');
  assert.match(eager.items[0].avatar_url, /a{64}\/content$/);
  assert.equal(requests.filter(p => p.startsWith('/media/')).length, 1);
});
