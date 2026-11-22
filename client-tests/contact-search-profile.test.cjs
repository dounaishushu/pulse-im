const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/go-v2.js');
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';
const publicID = 'A'.repeat(32), peer = uuid(2), avatar = uuid(90);
function client(fetch) {
  const values = new Map();
  const go = create({ base: 'https://fixture.invalid/api/v2', storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, fetch });
  go.session('viewer');
  return go;
}

test('exact account discovery keeps the nickname, public identity and deferred avatar without eager grants', async () => {
  const calls = [];
  const go = client(async raw => {
    const path = new URL(raw).pathname; calls.push(path);
    assert.equal(path, '/api/v2/users/by-account/admin002');
    return Response.json({ id: peer, account: 'admin002', nickname: '工作发布员', public_id: publicID, avatar_id: avatar });
  });
  const result = await go.request('/contacts/search?q=admin002', { deferMedia: true });
  assert.equal(result.items[0].nickname, '工作发布员');
  assert.equal(result.items[0].public_id, publicID);
  assert.equal(result.items[0].avatar_id, avatar);
  assert.equal(result.items[0].avatar_url, '');
  assert.equal(calls.length, 1);
});

test('opening an account-search result reads its public profile and keeps privacy-filtered fields', async () => {
  const calls = [];
  const go = client(async raw => {
    const path = new URL(raw).pathname; calls.push(path);
    assert.equal(path, '/api/v2/public-users/' + publicID);
    return Response.json({ id: peer, account: 'admin002', public_id: publicID, nickname: '工作发布员', avatar_id: avatar, bio: '个人简介', is_contact: false, can_add_friend: true });
  });
  const result = await go.request(`/contacts/profile?user_id=${go.local('user', peer)}&lookup_public_id=${publicID}`, { deferMedia: true });
  assert.equal(result.signature, '个人简介');
  assert.equal(result.nickname, '工作发布员');
  assert.equal(result.avatar_id, avatar);
  assert.equal(result.last_seen_hidden, true);
  assert.equal(result.is_contact, false);
  assert.equal(result.can_add_friend, true);
  assert.deepEqual(calls, ['/api/v2/public-users/' + publicID]);
});

test('public lookup requires a valid public identity and cannot be mixed with a restricted group context', async () => {
  const go = client(async () => { throw Error('invalid requests must not reach the server'); });
  const id = go.local('user', peer), group = go.local('conversation', uuid(20));
  for (const path of [
    `/contacts/profile?user_id=${id}&lookup_public_id=bad`,
    `/contacts/profile?user_id=${id}&lookup_public_id=${publicID}&context_conversation_id=${group}`,
  ]) await assert.rejects(go.request(path), error => error.code === 'invalid_request');
});

test('private group profile rejection is propagated without falling back to public discovery', async () => {
  const calls = [];
  const go = client(async raw => {
    const url = new URL(raw); calls.push(url.pathname);
    assert.equal(url.searchParams.get('conversation_id'), uuid(20));
    return Response.json({ error: { code: 'forbidden' } }, { status: 403 });
  });
  await assert.rejects(go.request(`/contacts/profile?user_id=${go.local('user', peer)}&context_conversation_id=${go.local('conversation', uuid(20))}`), error => error.status === 403);
  assert.deepEqual(calls, ['/api/v2/profiles/' + peer]);
});

test('a mismatched public identity cannot open another person and blocked discovery stays denied', async () => {
  let blocked = false;
  const go = client(async () => blocked
    ? Response.json({ error: { code: 'not_found' } }, { status: 404 })
    : Response.json({ id: uuid(3), public_id: publicID, nickname: '其他人' }));
  const path = `/contacts/profile?user_id=${go.local('user', peer)}&lookup_public_id=${publicID}`;
  await assert.rejects(go.request(path), error => error.code === 'invalid_response');
  blocked = true;
  await assert.rejects(go.request(path), error => error.status === 404);
});

test('an account switch rejects an in-flight public profile before acquiring its avatar', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const go = client(async raw => {
    assert.equal(new URL(raw).pathname, '/api/v2/public-users/' + publicID);
    await gate;
    return Response.json({ id: peer, public_id: publicID, avatar_id: avatar });
  });
  const result = go.request(`/contacts/profile?user_id=${go.local('user', peer)}&lookup_public_id=${publicID}`);
  const rejected = assert.rejects(result, error => error.code === 'stale_session');
  go.session('another-account'); release();
  await rejected;
});
