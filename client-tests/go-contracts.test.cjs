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

function rawMessage(seq, extra = {}) {
  return { id: `${String(seq).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, conversation_id: cid, sender_id: uid,
    seq: String(seq), version: '1', kind: 'text', body: 'message ' + seq, request_id: 'fixture-' + seq,
    created_at: '2026-11-13T00:00:00Z', updated_at: '2026-11-13T00:00:00Z', content: {}, ...extra };
}

test('visible message author and quoted author retain display names and authorized avatars', async () => {
  const parent = rawMessage(1, { sender: { name: '甲 <member>', avatar_id: media } });
  const child = rawMessage(2, { reply_to_id: parent.id, sender: { name: '乙', avatar_id: media } });
  const client = fixture(async url => {
    if (url.endsWith('/pins')) return Response.json({ items: [child] });
    if (url.endsWith('/reply-contexts')) return Response.json({ items: [{ message_id: child.id, reply_seq: '1', message: parent }] });
    assert.ok(url.endsWith('/media/' + media + '/grants'));
    return Response.json({ content_path: '/api/v2/media-grants/' + 'a'.repeat(64) + '/content', expires_in: 120 });
  });
  const id = client.local('conversation', cid); client.version(id, 1);
  const page = await client.request('/messages/pins?conversation_id=' + id);
  assert.equal(page.items[0].sender_name, '乙');
  assert.ok(page.items[0].sender_avatar_url.endsWith('/content'));
  assert.equal(page.items[0].body.reply_to.sender_name, '甲 <member>');
});

test('timed group mute retains its duration instead of rejecting the old control', async () => {
  let sent;
  const client = fixture(async (_, options) => {
    if (options.method === 'PUT') { sent = JSON.parse(options.body); return new Response(null, { status: 204 }); }
    return Response.json({ items: [{ id: uid, muted: true, muted_until: '2026-11-13T00:10:00Z', muted_permanent: false }] });
  });
  const result = await client.request('/conversations/members/mute', { method: 'POST', body: {
    conversation_id: client.local('conversation', cid), user_id: client.local('user', uid), minutes: 10 } });
  assert.deepEqual(sent, { minutes: 10 });
  assert.equal(result.is_muted, true);
  assert.equal(result.muted_permanent, false);
});

test('locating a message returns each surrounding sequence once, in order', async t => {
  for (const seq of [1, 2, 30]) await t.test('target sequence ' + seq, async () => {
    const client = fixture(async url => {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith('/history')) return Response.json(rawMessage(seq));
      const before = Number(parsed.searchParams.get('before_seq') || 0);
      const after = Number(parsed.searchParams.get('after_seq') || 0);
      let rows = Array.from({ length: 35 }, (_, index) => rawMessage(index + 1)).filter(row => Number(row.seq) > after && (!before || Number(row.seq) <= before));
      rows.sort((a, b) => parsed.searchParams.get('order') === 'asc' ? a.seq - b.seq : b.seq - a.seq);
      return Response.json({ items: rows.slice(0, 25) });
    });
    const id = client.local('conversation', cid); client.message(rawMessage(seq));
    const result = await client.request(`/messages/locate?conversation_id=${id}&message_id=${seq}`);
    const sequences = result.items.map(row => row.id);
    assert.equal(sequences.filter(value => value === seq).length, 1);
    assert.equal(new Set(sequences).size, sequences.length);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  });
});

test('a late pinned-media response cannot refill the cache after membership advances', async () => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  const client = fixture(async url => {
    if (url.endsWith('/pins')) return Response.json({ items: [rawMessage(1, { kind: 'image', content: { media: { id: media, bytes: '100' } } })] });
    started(); await pending;
    return Response.json({ content_path: '/api/v2/media-grants/' + 'e'.repeat(64) + '/content', expires_in: 120 });
  });
  const id = client.local('conversation', cid); client.version(id, 1);
  const result = client.request(`/messages/pins?conversation_id=${id}`);
  await waiting; client.version(id, 2); release();
  await assert.rejects(result, error => error.code === 'membership_changed');
});

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

test('group member avatars are hydrated without changing the restricted roster', async () => {
  let grants = 0;
  const client = fixture(async url => {
    if (url.includes('/member-profiles')) return Response.json({ items: [{ id: uid, account: 'owner', role: 'owner', avatar_id: media }], next_after: '' });
    if (url.endsWith('/grants')) { grants++; return Response.json({ content_path: '/api/v2/media-grants/' + 'e'.repeat(64) + '/content', expires_in: 120 }); }
    if (url.includes('/groups/')) return Response.json({ id: cid, title: 'Fixture', kind: 'group', owner_id: uid, my_role: 'member', member_limit: 500, block_member_friend_requests: true });
    return Response.json({ id: cid, kind: 'group', my_role: 'member', membership_version: '1', preference_version: '1', state: { clear_seq: '0' }, visible_from_seq: '1', unread_count: 0, message_seq: '0', updated_at: '2026-11-13T00:00:00Z' });
  });
  const result = await client.request('/conversations/members?conversation_id=' + client.local('conversation', cid));
  assert.equal(result.items.length, 1);
  assert.equal(result.members_visibility, 'managers');
  assert.ok(result.items[0].avatar_url.endsWith('/content'));
  assert.equal(grants, 1);
});
