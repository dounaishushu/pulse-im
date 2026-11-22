const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const helpers = import(pathToFileURL(path.resolve(__dirname, '../web-vue/src/features/groups/memberActions.ts')).href);
function fixture(role, memberRole) {
  const writes = [];
  const chat = { active: { value: { id: 9 } }, me: { value: { id: 1 } },
    api: async () => ({ profile: { can_manage: role !== 'member', is_owner: role === 'owner' }, items: [{ id: 3, role: memberRole, is_muted: false }] }),
    post: async (route, body) => { writes.push({ route, body }); } };
  return { chat, writes };
}
test('explicit administrator assignment does not demote a concurrently promoted member', async () => {
  const { manageGroupMember } = await helpers;
  const { chat, writes } = fixture('owner', 'admin');
  assert.equal(await manageGroupMember(chat, 9, 3, 'role', { role: 'admin' }), true);
  assert.deepEqual(writes, []);
});
test('owner can assign and revoke administrator using freshly authorized membership', async () => {
  const { manageGroupMember } = await helpers;
  for (const [before, after] of [['member', 'admin'], ['admin', 'member']]) {
    const { chat, writes } = fixture('owner', before);
    await manageGroupMember(chat, 9, 3, 'role', { role: after });
    assert.deepEqual(writes, [{ route: '/conversations/members/role', body: { conversation_id: 9, user_id: 3, role: after } }]);
  }
});
test('admins and demoted viewers cannot assign administrators or mute peer managers', async () => {
  const { manageGroupMember } = await helpers;
  for (const [role, peer, action] of [['admin', 'member', 'role'], ['member', 'member', 'role'], ['admin', 'admin', 'mute']]) {
    const { chat, writes } = fixture(role, peer);
    await assert.rejects(manageGroupMember(chat, 9, 3, action, { minutes: 10 }), /权限已变化/);
    assert.equal(writes.length, 0);
  }
});
test('permission exception duration is validated and sent without a browser prompt', async () => {
  const { manageGroupMember } = await helpers;
  for (const minutes of [-2, 43201, 1.5, NaN]) {
    const { chat, writes } = fixture('owner', 'member');
    await assert.rejects(manageGroupMember(chat, 9, 3, 'mute', { minutes }), /有效的禁言/);
    assert.equal(writes.length, 0);
  }
  const { chat, writes } = fixture('admin', 'member');
  await manageGroupMember(chat, 9, 3, 'mute', { minutes: 30 });
  assert.deepEqual(writes[0].body, { conversation_id: 9, user_id: 3, minutes: 30 });
});
test('removing a restriction that already expired is idempotent', async () => {
  const { manageGroupMember } = await helpers;
  const { chat, writes } = fixture('admin', 'member');
  assert.equal(await manageGroupMember(chat, 9, 3, 'mute', { minutes: 0 }), true);
  assert.equal(writes.length, 0);
});
