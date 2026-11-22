const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/go-v2.js');
const uuid = n => String(n).padStart(8, '0') + '-dddd-4ddd-8ddd-dddddddddddd';
const gid = uuid(9000);
function setup(candidates) {
  const calls = [], values = new Map();
  const group = { id: gid, kind: 'group', title: '邀请测试', my_role: 'owner', owner_id: uuid(1),
    membership_version: '1', preference_version: '1', member_limit: 500, member_count: 1, updated_at: '2026-11-22T12:00:00Z',
    can_invite: true, can_send: true, unread_count: '0', message_seq: '0', event_seq: '0', visible_from_seq: '1',
    state: { read_seq: '0', delivered_seq: '0', clear_seq: '0', version: '1', personal_seq: '0' } };
  const client = create({ base: 'https://invite.example.invalid/api/v2',
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    fetch: async (url, options) => {
      const parsed = new URL(url); calls.push(parsed.pathname);
      if (parsed.pathname.endsWith('/invite-candidates')) return Response.json(candidates(parsed.searchParams, options));
      if (parsed.pathname === '/api/v2/groups/' + gid || parsed.pathname === '/api/v2/conversations/' + gid) return Response.json(group);
      throw Error('Unexpected request ' + parsed.pathname);
    } });
  client.session('first-account');
  const id = client.local('conversation', gid);
  const read = (page = 1) => client.request(`/conversations/invite-candidates?conversation_id=${id}&page=${page}&size=100`, { deferMedia: true });
  return { client, read, calls };
}
const person = (n, extra = {}) => ({ id: uuid(n), account: 'peer' + n, nickname: '用户' + n,
  avatar_id: uuid(10000 + n), last_activity: '', ...extra });

test('invite adapter preserves explicit pin and unpin but leaves older or malformed pin fields unknown', async () => {
  const { read, calls } = setup(() => ({ items: [person(2, { pinned: true }), person(3, { pinned: false }), person(4), person(5, { pinned: 'true' })], next_after: '' }));
  const result = await read();
  assert.deepEqual(result.items.map(row => row.is_pinned), [true, false, undefined, undefined]);
  assert.equal(result.has_more, false);
  assert.equal(calls.some(path => /grants|conversation-page|history/.test(path)), false);
});

test('pins beyond the first candidate page survive cursor pagination without eager avatar grants', async () => {
  const people = Array.from({ length: 101 }, (_, index) => person(index + 2, { pinned: index === 100 }));
  const { read, calls } = setup(params => {
    const after = params.get('after') || '', size = Number(params.get('limit'));
    const remaining = people.filter(row => row.id > after), items = remaining.slice(0, size);
    return { items, next_after: remaining.length > size ? items.at(-1).id : '' };
  });
  const first = await read(), second = await read(2);
  assert.equal(first.items.length, 100); assert.equal(first.has_more, true);
  assert.equal(second.items.length, 1); assert.equal(second.has_more, false);
  assert.equal(second.items[0].is_pinned, true);
  assert.equal(calls.filter(path => path.endsWith('/invite-candidates')).length, 2);
  assert.equal(calls.some(path => path.endsWith('/grants')), false);
});

test('switching accounts never retains the preceding invitation pin snapshot', async () => {
  let pinned = true;
  const { client, read } = setup(() => ({ items: [person(2, { pinned })], next_after: '' }));
  assert.equal((await read()).items[0].is_pinned, true);
  pinned = false; client.session('second-account');
  assert.equal((await read()).items[0].is_pinned, false);
});
