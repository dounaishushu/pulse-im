const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/go-v2.js');
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';
const source = uuid(9000), peer = uuid(4), media = uuid(30004);
const contact = { id: peer, nickname: '名片用户', account: 'account4', public_id: 'A'.repeat(32), avatar_id: media };
const message = { id: uuid(20003), conversation_id: source, seq: '3', version: '1', event_seq: '3', sender_id: uuid(1), kind: 'contact', body: '', content: { contact }, created_at: '2026-11-22T00:00:00Z', updated_at: '2026-11-22T00:00:00Z' };
function client(fetch) {
  const values = new Map();
  const go = create({ base: 'https://fixture.invalid/api/v2', storage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }, fetch });
  go.session('viewer'); return go;
}

test('sending a contact card submits only its user reference and keeps the server avatar/name snapshot without eager media', async () => {
  const calls = [];
  const go = client(async (raw, options) => {
    const path = new URL(raw).pathname; calls.push(path);
    assert.equal(path, '/api/v2/conversations/' + source + '/messages');
    assert.deepEqual(JSON.parse(options.body), { request_id: 'card-fixture', kind: 'contact', body: '', card_user_id: peer });
    return Response.json({ message, duplicate: false });
  });
  const result = await go.request('/messages', { method: 'POST', deferMedia: true, body: {
    conversation_id: go.local('conversation', source), type: 'contact_card', request_id: 'card-fixture',
    body: { user_id: go.local('user', peer), nickname: 'untrusted name', avatar_id: uuid(999) },
  } });
  assert.equal(result.type, 'contact_card');
  assert.equal(result.body.nickname, contact.nickname);
  assert.equal(result.body.avatar_id, media);
  assert.equal(result.body.public_id, contact.public_id);
  assert.equal(result.body.username, contact.account);
  assert.equal(result.body.avatar_url, '');
  assert.equal(calls.length, 1);
});

test('opening a card uses its authoritative message identity and preserves the returned profile/avatar relationship', async () => {
  const calls = [];
  const go = client(async raw => {
    const path = new URL(raw).pathname; calls.push(path);
    if (path.endsWith('/messages')) return Response.json({ message });
    assert.equal(path, '/api/v2/conversations/' + source + '/messages/' + message.id + '/contact');
    return Response.json({ user: { ...contact, bio: '对方资料', is_contact: false }, is_contact: false, can_add_friend: true });
  });
  const conversation = go.local('conversation', source);
  await go.request('/messages', { method: 'POST', deferMedia: true, body: { conversation_id: conversation, type: 'contact_card', body: { user_id: go.local('user', peer) } } });
  const result = await go.request(`/contacts/card-profile?conversation_id=${conversation}&message_id=3`);
  assert.equal(result.id, go.local('user', peer));
  assert.equal(result.avatar_id, media);
  assert.equal(result.signature, '对方资料');
  assert.equal(result.can_add_friend, true);
  assert.equal(calls.some(path => path.includes('/public-users/') || path.includes('/profiles/')), false);
});

test('hidden or recalled card access stays denied and never falls back to public profile lookup', async () => {
  const calls = [];
  const go = client(async raw => {
    const path = new URL(raw).pathname; calls.push(path);
    if (path.endsWith('/messages')) return Response.json({ message });
    assert.equal(path.endsWith('/contact'), true);
    return Response.json({ error: { code: 'forbidden' } }, { status: 403 });
  });
  const conversation = go.local('conversation', source);
  await go.request('/messages', { method: 'POST', deferMedia: true, body: { conversation_id: conversation, type: 'contact_card', body: { user_id: go.local('user', peer) } } });
  await assert.rejects(go.request(`/contacts/card-profile?conversation_id=${conversation}&message_id=3`), error => error.status === 403);
  assert.equal(calls.length, 2);
});

test('a contact without an avatar retains its valid identity for a letter fallback and profile navigation', async () => {
  const go = client(async () => Response.json({ message: { ...message, content: { contact: { ...contact, avatar_id: '' } } } }));
  const result = await go.request('/messages', { method: 'POST', deferMedia: true, body: {
    conversation_id: go.local('conversation', source), type: 'contact_card', body: { user_id: go.local('user', peer) },
  } });
  assert.equal(result.body.nickname, contact.nickname);
  assert.equal(result.body.user_id, go.local('user', peer));
  assert.equal(result.body.avatar_id, '');
  assert.equal(result.body.avatar_url, '');
});
