const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { create } = require('../client-shared/go-v2.js');
const helpers = import(pathToFileURL(path.resolve(__dirname, '../web-vue/src/components/avatarRequests.ts')).href);
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('deferred group roster returns names and media IDs without waiting for any avatar grant', async () => {
  const requests = [], values = new Map();
  const client = create({ base: 'https://fixture.invalid/api/v2', storage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }, fetch: async (url, options) => {
    const p = new URL(url).pathname.replace('/api/v2', ''); requests.push(p);
    if (p === '/groups/' + uuid(1)) return Response.json({ id: uuid(1), kind: 'group', title: '群', owner_id: uuid(2), my_role: 'owner', avatar_id: uuid(3), public_id: '12345678', join_policy: 'open', block_member_friend_requests: false });
    if (p === '/conversations/' + uuid(1)) return Response.json({ id: uuid(1), kind: 'group', title: '群', my_role: 'owner', membership_version: '1', message_seq: '0', event_seq: '0', unread_count: '0', visible_from_seq: '1', updated_at: '2026-11-22T00:00:00Z', state: { clear_seq: '0' } });
    if (p.startsWith('/groups/' + uuid(1) + '/member-profiles')) return Response.json({ items: [{ id: uuid(2), nickname: '群主', role: 'owner', avatar_id: uuid(4) }], next_after: '', query: '', members_visibility: 'all', search_scope: 'group' });
    if (p === '/media/' + uuid(4) + '/grants') return Response.json({ content_path: '/api/v2/media-grants/' + 'a'.repeat(64) + '/content', expires_in: 120 });
    if (p === '/groups/' + uuid(1) && options.method === 'PATCH') throw Error('Unexpected write');
    throw Error('Unexpected request ' + p);
  } });
  client.session('account');
  const page = await client.request('/conversations/members?conversation_id=' + client.local('conversation', uuid(1)) + '&page=1', { deferMedia: true });
  assert.equal(page.items[0].nickname, '群主'); assert.equal(page.items[0].avatar_id, uuid(4)); assert.equal(page.items[0].avatar_url, '');
  assert.equal(requests.some(p => p.startsWith('/media')), false);
  const { requestAvatar } = await helpers;
  assert.match(await requestAvatar(client, uuid(4), 'account', new AbortController().signal), /a{64}\/content$/);
  assert.equal(requests.filter(p => p.startsWith('/media')).length, 1);
});

test('visible avatars share requests, keep at most four grants active and cancel unused queued rows', async () => {
  const { requestAvatar } = await helpers;
  const held = [], calls = [];
  const client = { token: 'a', mediaGrant: async id => { calls.push(id); const gate = deferred(); held.push(gate); await gate.promise; return id; } };
  const controllers = Array.from({ length: 7 }, () => new AbortController());
  const rows = controllers.map((controller, i) => requestAvatar(client, uuid(i), 'a', controller.signal));
  const shared = new AbortController();
  const duplicate = requestAvatar(client, uuid(0), 'a', shared.signal);
  controllers[0].abort(); controllers[6].abort();
  const cancelled = [assert.rejects(rows[0], { name: 'AbortError' }), assert.rejects(rows[6], { name: 'AbortError' })];
  assert.equal(calls.length, 4);
  held.slice(0, 4).forEach(gate => gate.resolve()); await flush();
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5].map(uuid));
  held.slice(4).forEach(gate => gate.resolve());
  await Promise.all([duplicate, ...rows.slice(1, 6), ...cancelled]);
  assert.equal(await duplicate, uuid(0));
});

test('queued avatars do not issue requests for an account that has been switched out', async () => {
  const { requestAvatar } = await helpers;
  const gate = deferred(), calls = [];
  const client = { token: 'old', mediaGrant: async id => { calls.push(id); await gate.promise; return id; } };
  const rows = Array.from({ length: 5 }, (_, i) => requestAvatar(client, uuid(i), 'old', new AbortController().signal));
  const rejected = assert.rejects(rows[4], { name: 'AbortError' });
  client.token = 'new'; gate.resolve();
  await Promise.all([...rows.slice(0, 4), rejected]);
  assert.equal(calls.length, 4);
});

test('a failed visible grant can be retried with forced renewal and does not poison the shared queue', async () => {
  const { requestAvatar } = await helpers;
  const calls = [];
  const client = { token: 'a', mediaGrant: async (id, token, signal, force) => { calls.push({ id, token, force }); if (!force) throw Object.assign(Error('unavailable'), { status: 503 }); return 'fresh'; } };
  await assert.rejects(requestAvatar(client, uuid(1), 'a', new AbortController().signal), { status: 503 });
  assert.equal(await requestAvatar(client, uuid(1), 'a', new AbortController().signal, true), 'fresh');
  assert.deepEqual(calls.map(row => row.force), [false, true]);
});

test('a newly loaded profile avatar repairs viewers of the same account and media only', async () => {
  const { shareAvatar, avatarLoaded } = await helpers;
  const account = { token: 'a' }, otherClient = { token: 'a' }, calls = [];
  const stop = shareAvatar(account, uuid(1), 'a', url => calls.push(url));
  const cleanup = [shareAvatar(account, uuid(2), 'a', () => { throw Error('wrong media'); }),
    shareAvatar(account, uuid(1), 'b', () => { throw Error('wrong account'); }),
    shareAvatar(otherClient, uuid(1), 'a', () => { throw Error('wrong client'); })];
  avatarLoaded(account, uuid(1), 'b', 'stale');
  avatarLoaded(account, uuid(1), 'a', 'fresh-profile-image');
  assert.deepEqual(calls, ['fresh-profile-image']);
  stop(); avatarLoaded(account, uuid(1), 'a', 'after-close');
  assert.equal(calls.length, 1); cleanup.forEach(dispose => dispose());
});

test('invitation pages can return uncached avatar IDs without making any grant request', async () => {
  const values = new Map(), requests = [];
  const client = create({ base: 'https://fixture.invalid/api/v2', storage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }, fetch: async (raw, options) => {
    const url = new URL(raw), p = url.pathname.replace('/api/v2', ''); requests.push(url);
    if (p === '/groups/' + uuid(1)) return Response.json({ id: uuid(1), kind: 'group', title: '群', owner_id: uuid(2), my_role: 'owner', member_limit: 1000, member_count: 3, block_member_friend_requests: false });
    if (p === '/conversations/' + uuid(1)) return Response.json({ id: uuid(1), kind: 'group', title: '群', my_role: 'owner', membership_version: '1', message_seq: '0', event_seq: '0', unread_count: '0', visible_from_seq: '1', updated_at: '2026-11-22T00:00:00Z', state: { clear_seq: '0' } });
    if (p === '/groups/' + uuid(1) + '/invite-candidates') {
      const after = url.searchParams.get('after') || '';
      const rows = Array.from({ length: 553 }, (_, i) => ({ id: uuid(i + 4), nickname: '用户' + (i + 4), avatar_id: uuid(10000 + i) })).filter(row => row.id > after);
      const size = Number(url.searchParams.get('limit')), items = rows.slice(0, size);
      return Response.json({ items, next_after: rows.length > size ? items.at(-1).id : '' });
    }
    if (p === '/media/grants') {
      const ids = JSON.parse(options.body).media_ids;
      return Response.json({ items: ids.map(id => ({ id, access: { content_path: '/api/v2/media-grants/' + 'b'.repeat(64) + '/content', expires_in: 120 } })) });
    }
    throw Error('Unexpected request ' + p);
  } });
  client.session('account');
  const prefix = '/conversations/invite-candidates?conversation_id=' + client.local('conversation', uuid(1));
  const first = await client.request(prefix + '&page=1&size=100', { deferMedia: true });
  const second = await client.request(prefix + '&page=2&size=100', { deferMedia: true });
  assert.equal(first.items.length, 100); assert.equal(second.items.length, 100);
  assert.ok(first.has_more && second.has_more);
  assert.ok([...first.items, ...second.items].every(row => row.avatar_id && !row.avatar_url));
  assert.equal(requests.filter(url => url.pathname.includes('/media')).length, 0);
  assert.notEqual(first.items[0].id, second.items[0].id);
  const legacy = await client.request(prefix + '&page=1&size=100');
  assert.ok(legacy.items.every(row => row.avatar_url));
  assert.equal(requests.filter(url => url.pathname.endsWith('/media/grants')).length, 1);
});
