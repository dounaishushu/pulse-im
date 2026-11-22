const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const helpers = import(pathToFileURL(path.resolve(__dirname, '../web-vue/src/features/groups/memberPresentation.ts')).href);
const member = (id, role, nickname, extra = {}) => ({ id, user_id: id, role, nickname, ...extra });
const group = (role, open) => ({ type: 'group', my_role: role, can_manage: role === 'owner' || role === 'admin', allow_member_add_friend: open, block_member_friend_requests: !open });

test('one flat member list puts the owner and all administrators first, with stable deduplication across pages', async () => {
  const { sortGroupMembers } = await helpers;
  const result = sortGroupMembers([member(1, 'member', '阿甲'), member(9, 'admin', '乙管理'), member(8, 'owner', '群主'),
    member(10, 'admin', '甲管理'), member(9, 'admin', '乙管理', { is_muted: true })]);
  assert.deepEqual(result.map(row => row.id), [8, 10, 9, 1]);
  assert.equal(result.find(row => row.id === 9).is_muted, true);
});

test('group profile restriction applies to friends and managers when the viewer is an ordinary member', async () => {
  const { canViewGroupMember } = await helpers;
  assert.equal(canViewGroupMember(group('member', false), 2, 1), false);
  assert.equal(canViewGroupMember(group('member', true), 2, 1), true);
  assert.equal(canViewGroupMember(group('member', false), 1, 1), true);
  for (const role of ['owner', 'admin']) assert.equal(canViewGroupMember(group(role, false), 2, 1), true);
  assert.equal(canViewGroupMember(null, 2, 1), false);
  assert.equal(canViewGroupMember({ type: 'group', my_role: 'member', can_manage: false }, 2, 1), false);
});
