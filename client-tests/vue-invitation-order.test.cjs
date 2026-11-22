const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const helpers = import(pathToFileURL(path.resolve(__dirname, '../web-vue/src/features/groups/invitationCandidates.ts')).href);
const person = (id, extra = {}) => ({ id, user_id: id, nickname: '用户' + id, username: 'peer' + id, public_id: 'ID' + id, avatar_url: '', signature: '', ...extra });
const direct = (user, extra = {}) => ({ id: 100 + user, peer_user_id: user, type: 'direct', name: '私聊', message_seq: 0, ...extra });

test('Vue invitation order uses precise private-message activity and preserves the two columns', async () => {
  const { invitationSections } = await helpers;
  const people = [person(1), person(2, { last_activity: '2026-11-21T00:00:02.000000010Z' }),
    person(3, { last_activity: '2026-11-21T00:00:02.000000090Z' }), person(4, { last_activity: '2026-11-21T00:00:03Z' }),
    person(5, { last_activity: '' }), person(3, { last_activity: '2026-11-21T00:00:02.000000090Z' })];
  const rows = [direct(4, { is_pinned: true }), direct(2, { updated_at: '2099-01-01T00:00:00Z' }),
    direct(5, { last_message: { created_at: '2099-01-01T00:00:00Z' } })];
  const [pinned, recent] = invitationSections(people, rows, 1);
  assert.deepEqual(pinned.items.map(row => row.id), [4]);
  assert.deepEqual(recent.items.map(row => row.id), [3, 2, 5]);
});

test('legacy activity fallback only uses message timestamps and never adds unapproved directory users', async () => {
  const { invitationSections } = await helpers;
  const [pinned, recent] = invitationSections([person(2), person(3), person(4)], [
    direct(2, { updated_at: '2099-01-01T00:00:00Z', last_message: { created_at: '2026-11-21T08:00:00+08:00' } }),
    direct(3, { last_message: { created_at: '2026-11-21T00:00:00.001Z' } }), direct(99, { is_pinned: true }),
  ]);
  assert.equal(pinned.items.length, 0);
  assert.deepEqual(recent.items.map(row => row.id), [3, 2, 4]);
});

test('search includes private remarks and public IDs without changing the recent-message order', async () => {
  const { filterInvitees } = await helpers;
  const people = [person(3, { remark: '同名 三' }), person(2, { nickname: '同名 二' }), person(4)];
  assert.deepEqual(filterInvitees(people, ' 同名 ').map(row => row.id), [3, 2]);
  assert.deepEqual(filterInvitees(people, 'PEER4').map(row => row.id), [4]);
  assert.deepEqual(filterInvitees(people, 'ID2').map(row => row.id), [2]);
});

test('current invitation pin flags override stale conversation flags and include peers absent from the directory', async () => {
  const { invitationSections } = await helpers;
  const [pinned, recent] = invitationSections([
    person(2, { is_pinned: true }), person(3, { is_pinned: false }),
    person(4, { is_pinned: true }), person(5, { is_pinned: false }), person(6),
  ], [direct(2, { is_pinned: false }), direct(3, { is_pinned: true }), direct(5, { is_pinned: true })]);
  assert.deepEqual(pinned.items.map(row => row.id), [2, 4]);
  assert.deepEqual(recent.items.map(row => row.id), [3, 5, 6]);
});

test('legacy duplicate directory rows cannot overwrite a pinned peer or change fallback activity order', async () => {
  const { invitationSections } = await helpers;
  const rows = [
    direct(2, { id: 101, is_pinned: true, last_message: { created_at: '2026-11-21T00:00:03Z' } }),
    direct(2, { id: 102, is_pinned: false, last_message: { created_at: '2026-11-21T00:00:01Z' } }),
    direct(3, { is_pinned: true, last_message: { created_at: '2026-11-21T00:00:02Z' } }),
    direct(99, { is_pinned: true }),
  ];
  for (const directory of [rows, [...rows].reverse()]) {
    const [pinned, recent] = invitationSections([person(2), person(3), person(2), person(4)], directory);
    assert.deepEqual(pinned.items.map(row => row.id), [2, 3]);
    assert.deepEqual(recent.items.map(row => row.id), [4]);
  }
});
