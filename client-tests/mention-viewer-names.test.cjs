const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { create } = require('../client-shared/go-v2.js');
const { create: names } = require('../web/contact-names.js');
const helper = (async () => {
  const root = path.resolve(__dirname, '../web-vue');
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  const server = await createServer({ root, configFile: false, logLevel: 'silent', appType: 'custom',
    cacheDir: path.resolve(__dirname, '../.local/mention-text-unit-vite-cache'), server: { middlewareMode: true } });
  try { return await server.ssrLoadModule('/src/features/chat/mentionText.ts'); }
  finally { await server.close(); }
})();
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';
const body = () => ({ text: '@备注一下 请查看', mention_user_ids: [2], mention_users: [{ user_id: 2, nickname: '自己的昵称', labels: ['备注一下'] }] });
const resolver = (self, nickname, remark) => {
  const service = names({ context: () => ({ base: 'fixture', token: 'account-' + self, userId: self, nickname }), request: async () => { throw Error('unexpected lookup'); } });
  service.remember(2, remark);
  return service.resolve;
};

test('sender, mentioned user and third viewer each see their own name choice without changing source text', async () => {
  const { mentionText } = await helper, message = body(), original = JSON.stringify(message);
  assert.equal(mentionText(message, resolver(1, '发送者', '备注一下')), '@备注一下 请查看');
  assert.equal(mentionText(message, resolver(2, '自己的昵称', '应忽略的自备注')), '@自己的昵称 请查看');
  assert.equal(mentionText(message, resolver(3, '第三个人', '我的另一备注')), '@我的另一备注 请查看');
  assert.equal(mentionText(message, resolver(3, '第三个人', '')), '@自己的昵称 请查看');
  assert.equal(JSON.stringify(message), original);
});

test('names with spaces, regex punctuation and emoji render without replacing plain text or prefix collisions', async () => {
  const { mentionText } = await helper;
  const message = { text: '@工作 张姐[VIP] hello\n@😀甲 @工作 张姐[VIP]后缀 邮箱@工作 张姐[VIP]', mention_user_ids: [2, 3], mention_users: [
    { user_id: 2, nickname: '张姐', labels: ['工作 张姐[VIP]'] }, { user_id: 3, nickname: '甲', labels: ['😀甲'] },
  ] };
  assert.equal(mentionText(message, (id, name) => id === 2 ? '当前备注 $&' : name), '@当前备注 $& hello\n@甲 @工作 张姐[VIP]后缀 邮箱@工作 张姐[VIP]');
});

test('unverified @ text, @everyone and removed target IDs stay unchanged', async () => {
  const { mentionText } = await helper;
  assert.equal(mentionText({ text: '@备注一下 @所有人', mention_all: true }, () => '错误'), '@备注一下 @所有人');
  assert.equal(mentionText({ ...body(), mention_user_ids: [] }, () => '错误'), body().text);
  assert.equal(mentionText({ ...body(), mention_user_ids: [9] }, () => '错误'), body().text);
});

test('remark changes and account switches recompute names without retaining another account label', async () => {
  const { mentionText } = await helper;
  let account = { base: 'fixture', token: 'a', userId: 1, nickname: '甲' };
  const service = names({ context: () => account, request: async () => { throw Error('unexpected lookup'); } });
  service.remember(2, '新备注');
  assert.equal(mentionText(body(), service.resolve), '@新备注 请查看');
  service.remember(2, '');
  assert.equal(mentionText(body(), service.resolve), '@自己的昵称 请查看');
  service.remember(2, '发送者私有备注');
  account = { ...account, token: 'b', userId: 2, nickname: '现在的自己昵称' };
  assert.equal(mentionText(body(), service.resolve), '@现在的自己昵称 请查看');
});

test('one shared alias for two explicit targets preserves both identities when displaying distinct names', async () => {
  const { mentionText } = await helper;
  assert.equal(mentionText({ text: '@同名 你好', mention_user_ids: [2, 3], mention_users: [
    { user_id: 2, nickname: '甲', labels: ['同名'] }, { user_id: 3, nickname: '乙', labels: ['同名'] },
  ] }, (_id, name) => name), '@甲 @乙 你好');
});

test('Go adapter retains mention IDs and labels in the message and reply preview without extra requests', async () => {
  const client = create({ base: 'https://fixture.invalid/api/v2', storage: { getItem: () => null, setItem() {} }, fetch: async () => { throw Error('unexpected lookup'); } });
  const parent = { id: uuid(100), conversation_id: uuid(9000), sender_id: uuid(1), seq: '1', version: '1', kind: 'text', body: '@备注一下 请查看', created_at: '2026-11-23T00:00:00Z', content: {
    mentions: [uuid(2)], mention_users: [{ user_id: uuid(2), nickname: '自己的昵称', labels: ['备注一下'] }, { user_id: uuid(3), nickname: '无效目标', labels: ['请查看'] }],
  } };
  const row = client.message({ ...parent, id: uuid(101), seq: '2', content: {}, body: '引用回复', _go_reply: { reply_seq: '1', message: parent } });
  const reply = row.body.reply_to, id = client.local('user', uuid(2));
  assert.deepEqual(reply.mention_user_ids, [id]);
  assert.deepEqual(reply.mention_users, [{ user_id: id, nickname: '自己的昵称', labels: ['备注一下'] }]);
  const { mentionText } = await helper;
  assert.equal(mentionText(reply, (_id, name) => name), '@自己的昵称 请查看');
  assert.equal(reply.text, parent.body);
});


test('notification and search previews use the current viewer and preserve recall/media placeholders', async () => {
  const { mentionPreview } = await helper;
  const message = { type: 'text', status: 'sent', body: body() };
  assert.equal(mentionPreview(message, resolver(1, '发送者', '备注一下')), '@备注一下 请查看');
  assert.equal(mentionPreview(message, resolver(2, '自己的昵称', '忽略自备注')), '@自己的昵称 请查看');
  assert.equal(mentionPreview(message, resolver(3, '旁观者', '我自己的备注')), '@我自己的备注 请查看');
  assert.equal(mentionPreview(message, resolver(3, '旁观者', '')), '@自己的昵称 请查看');
  assert.equal(mentionPreview({ ...message, status: 'recalled' }, () => '错误'), '消息已撤回');
  assert.equal(mentionPreview({ ...message, type: 'image', body: {} }, () => '错误'), '[图片]');
  assert.equal(mentionPreview(null, () => '错误'), '暂无消息');
  assert.equal(message.body.text, '@备注一下 请查看');
});

test('a server legacy fallback resolves names for every viewer without recovering or sharing private labels', async () => {
  const { mentionText } = await helper;
  const fallback = { text: '@自己的昵称 （历史提及名称已变更）', mention_user_ids: [2],
    mention_users: [{ user_id: 2, nickname: '自己的昵称', labels: ['自己的昵称'] }] };
  assert.equal(mentionText(fallback, resolver(2, '现在的自己昵称', '不应显示')), '@现在的自己昵称 （历史提及名称已变更）');
  assert.equal(mentionText(fallback, resolver(3, '旁观者', '我的备注')), '@我的备注 （历史提及名称已变更）');
});
