const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/go-v2.js');
const base = 'https://chat.example.org/api/v2';
const uid = '11111111-1111-4111-8111-111111111111';
const media = '22222222-2222-4222-8222-222222222222';
const cid = '33333333-3333-4333-8333-333333333333';

function fixture(fetch) {
  const values = new Map();
  return create({ base, fetch, storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
}

test('a late avatar grant cannot return the previous account profile after switching login', async () => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  const client = fixture(async url => {
    if (url.endsWith('/me/profile')) return Response.json({ id: uid, account: 'account-a', avatar_id: media });
    started();
    await pending;
    return Response.json({ content_path: '/api/v2/media-grants/' + 'a'.repeat(64) + '/content', expires_in: 120 });
  });
  client.session('account-a-token');
  const profile = client.request('/auth/me');
  await waiting;
  client.session('account-b-token');
  release();
  await assert.rejects(profile, error => error.code === 'stale_session');
});

test('media grants from the previous login are rejected even if a new login has a cached grant', async () => {
  let requests = 0;
  const client = fixture(async () => { requests++; return Response.json({ content_path: '/api/v2/media-grants/' + 'b'.repeat(64) + '/content', expires_in: 120 }); });
  client.session('account-b-token');
  await client.mediaGrant(media);
  await assert.rejects(client.mediaGrant(media, 'account-a-token'), error => error.code === 'stale_session');
  assert.equal(requests, 1);
});

test('public update checks may omit authorization while an account is logged in', async () => {
  const client = fixture(async (_, options) => {
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ latest: '1.0.0' });
  });
  client.session('active-token');
  assert.equal((await client.raw('/client/update', { authToken: '' })).latest, '1.0.0');
});

test('clearing a contact group preserves a remark omitted from the edit', async () => {
  let sent;
  const client = fixture(async (url, options) => {
    if (options.method === 'GET') return Response.json({ id: uid, account: 'peer', remark: 'keep remark', group_name: 'old group', contact_version: '3' });
    sent = JSON.parse(options.body);
    return new Response(null, { status: 204 });
  });
  const localID = client.local('user', uid);
  const result = await client.request('/contacts/remark', { method: 'POST', body: { user_id: localID, group_name: '' } });
  assert.equal(sent.group_name, '');
  assert.equal(sent.remark, 'keep remark');
  assert.equal(result.remark, 'keep remark');
  assert.equal(result.group_name, '');
});

test('a group pin-only edit sends a versioned preference update', async () => {
  let sent;
  const client = fixture(async (url, options) => {
    if (options.method === 'PATCH') { sent = JSON.parse(options.body); return Response.json({}); }
    if (url.includes('/groups/')) return Response.json({ id: cid, title: 'Fixture', kind: 'group', owner_id: uid, my_role: 'owner', member_limit: 500 });
    return Response.json({ id: cid, kind: 'group', my_role: 'owner', membership_version: '1', preference_version: '3',
      state: { clear_seq: '0' }, visible_from_seq: '1', unread_count: 0, message_seq: '0', updated_at: '2026-11-13T00:00:00Z', pinned: !!sent?.pinned });
  });
  const result = await client.request('/conversations/groups/settings', { method: 'POST', body: { conversation_id: client.local('conversation', cid), is_pinned: true } });
  assert.deepEqual(sent, { expected_version: '3', pinned: true });
  assert.equal(result.is_pinned, true);
});

test('image messages retain the original grant and expose a separate preview', async () => {
  const content = '/api/v2/media-grants/' + 'c'.repeat(64) + '/content';
  const client = fixture(async () => Response.json({ content_path: content, expires_in: 120 }));
  await client.mediaGrant(media);
  const result = client.message({ id: media, conversation_id: cid, sender_id: uid, seq: '1', version: '1', body: '',
    kind: 'image', request_id: 'fixture-image', created_at: '2026-11-13T00:00:00Z', updated_at: '2026-11-13T00:00:00Z',
    content: { media: { id: media, bytes: '120', mime: 'image/png', original: true } } });
  assert.equal(result.body.url, new URL(content, base).href);
  assert.equal(result.body.thumbnail_url, new URL(content.replace('/content', '/preview'), base).href);
  assert.equal(result.body.original, true);
});

test('an older history page cannot repopulate messages after membership advances during media hydration', async () => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  const client = fixture(async url => {
    if (url.includes('/history?')) return Response.json({ membership_version: '1', snapshot_max_seq: '1', clear_seq: '0', visible_from_seq: '1', next_after_seq: '1', items: [{
      id: media, conversation_id: cid, sender_id: uid, seq: '1', version: '1', body: '', kind: 'image',
      created_at: '2026-11-13T00:00:00Z', updated_at: '2026-11-13T00:00:00Z', content: { media: { id: media, bytes: '120' } } }] });
    started(); await pending;
    return Response.json({ content_path: '/api/v2/media-grants/' + 'd'.repeat(64) + '/content', expires_in: 120 });
  });
  const local = client.local('conversation', cid);
  const history = client.request('/messages/history?conversation_id=' + local);
  await waiting;
  client.version(local, '2');
  release();
  await assert.rejects(history, error => error.code === 'membership_changed');
});

test('oversized uploads are rejected before reading their bytes or creating network requests', async () => {
  const client = fixture(async () => { throw new Error('upload must not be admitted'); });
  for (const [kind, maximum] of [['image', 10], ['video', 100], ['file', 50], ['voice', 10]]) {
    const file = { size: maximum * 1024 * 1024 + 1, arrayBuffer() { throw new Error('large file must not be read'); } };
    await assert.rejects(client.uploadMedia(kind, file), error => error.status === 413 && error.code === 'media_too_large');
  }
});
