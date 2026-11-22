const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/go-v2.js');
const cid = '33333333-3333-4333-8333-333333333333', uid = '11111111-1111-4111-8111-111111111111', peer = '22222222-2222-4222-8222-222222222222';
function fixture(role, capabilities = {}) {
  const requests = [], storage = new Map();
  const client = create({ base: 'https://fixture.invalid/api/v2', storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, fetch: async raw => {
    const url = new URL(raw), path = url.pathname.replace('/api/v2', ''); requests.push(url);
    if (path.endsWith('/search-members')) return Response.json({ items: [{ id: peer, nickname: '呆萌萌', account: 'wenwen3', public_id: '123456', role: 'member', ...(capabilities.avatar_id ? { avatar_id: capabilities.avatar_id } : {}) }], next_after: '', can_search: true, can_mention_all: true, ...capabilities });
    if (path === '/groups/' + cid) return Response.json({ id: cid, title: '群', my_role: role, owner_id: uid, member_limit: 500, member_count: 3 });
    assert.equal(path, '/conversations/' + cid);
    return Response.json({ id: cid, kind: 'group', title: '群', my_role: role, membership_version: '1', preference_version: '1', state: { clear_seq: '0' }, visible_from_seq: '1', message_seq: '0', unread_count: '0', updated_at: '2026-11-16T00:00:00Z' });
  } });
  client.session('fixture-token'); const id = client.local('conversation', cid);
  return { requests, search: (options) => client.request('/conversations/groups/mention-members?conversation_id=' + id + '&q=' + encodeURIComponent('萌') + '&page=1', options) };
}
test('ordinary members can search mention candidates while account labels stay hidden', async () => {
  const f = fixture('member'), result = await f.search();
  assert.equal(result.can_search, true); assert.equal(result.can_mention_all, false);
  assert.equal(result.items[0].nickname, '呆萌萌'); assert.ok(result.items[0].user_id > 0);
  for (const field of ['account', 'username', 'public_id']) assert.equal(result.items[0][field], '');
  assert.equal(f.requests[0].searchParams.get('q'), '萌');
  assert.equal(f.requests[0].searchParams.get('purpose'), 'mention');
});
test('owner and admin mention search retain existing account labels and mention-all permission', async () => {
  for (const role of ['owner', 'admin']) {
    const result = await fixture(role).search();
    assert.equal(result.can_search, true); assert.equal(result.can_mention_all, true);
    assert.equal(result.items[0].username, 'wenwen3'); assert.equal(result.items[0].public_id, '123456');
  }
});
test('server mention permissions still restrict the client', async () => {
  const result = await fixture('owner', { can_search: false, can_mention_all: false }).search();
  assert.equal(result.can_search, false); assert.equal(result.can_mention_all, false);
});

test('the composer can request mention identities without blocking on avatar grants', async () => {
  const media='44444444-4444-4444-8444-444444444444';
  const f=fixture('member',{avatar_id:media});
  const result=await f.search({deferMedia:true});
  assert.equal(result.items[0].avatar_id,media);
  assert.equal(result.items[0].avatar_url,'');
  assert.equal(f.requests.filter(url=>url.pathname.includes('/media/')).length,0);
});
