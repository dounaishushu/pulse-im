const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/go-v2.js');
const first = '33333333-3333-4333-8333-333333333333', second = '77777777-7777-4777-8777-777777777777';
const head = (id = first, extra = {}) => ({ id, kind: 'group', title: '会话', message_seq: '10', event_seq: '12', membership_version: '1', visible_from_seq: '1', visible_from_event_seq: '1', history_allowed: false, state: { version: '2', personal_seq: '0', clear_seq: '0', read_seq: '8', delivered_seq: '8' }, ...extra });
function setup(handler) {
  const values = new Map(), calls = [];
  const api = create({ base: 'https://chat.example.invalid/api/v2', storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, fetch: (url, options) => { calls.push(new URL(url)); return handler(new URL(url), options); } });
  api.session('fixture');
  const listed = raw => ({ ...raw, id: api.local('conversation', raw.id), message_seq: Number(raw.message_seq) });
  return { api, calls, listed };
}

test('没有变化时只读轻量时钟，不读取摘要、头像或历史', async () => {
  const { api, calls, listed } = setup(url => { assert.equal(url.pathname, '/api/v2/conversations'); return Response.json({ items: [head()], next_after: '' }); });
  assert.deepEqual(await api.directoryChanges([listed(head())]), []);
  assert.equal(calls.length, 1);
});

test('消息、个人状态、成员身份变化、新会话和退出均能被发现', async () => {
  for (const scenario of ['message', 'personal', 'membership', 'state', 'title', 'new', 'removed']) {
    const rows = scenario === 'removed' ? [] : [head(first, scenario === 'message' ? { event_seq: '13' } : scenario === 'membership' ? { membership_version: '2' } : scenario === 'title' ? { title: '新名称' } : scenario === 'personal' ? { state: { ...head().state, personal_seq: '1' } } : scenario === 'state' ? { state: { ...head().state, version: '3' } } : {})];
    if (scenario === 'new') rows.push(head(second));
    const { api, listed } = setup(() => Response.json({ items: rows, next_after: '' }));
    const changed = await api.directoryChanges([listed(head())]);
    assert.deepEqual(changed, [api.local('conversation', scenario === 'new' ? second : first)], scenario);
  }
});

test('已确认隐藏的未知会话不会每次探测都请求摘要，内容变化仍会重查', async () => {
  let sequence = '12';
  const { api, calls } = setup(url => url.pathname.endsWith('/conversation-updates')
    ? Response.json({ items: [], removed_ids: [first], incremental: true })
    : Response.json({ items: [head(first, { event_seq: sequence })], next_after: '' }));
  const id = api.local('conversation', first);
  assert.deepEqual(await api.directoryChanges([]), [id]);
  await api.request('/conversations/updates?ids=' + id);
  assert.deepEqual(await api.directoryChanges([]), []);
  sequence = '13'; assert.deepEqual(await api.directoryChanges([]), [id]);
  api.session('another'); assert.deepEqual(await api.directoryChanges([]), [id]);
  assert.equal(calls.filter(url => url.pathname.endsWith('/conversation-updates')).length, 1);
});

test('轻量目录遍历全部页面，拒绝重复、倒退和停滞分页', async () => {
  const { api, calls, listed } = setup(url => Response.json(url.searchParams.get('after') ? { items: [head(second)], next_after: '' } : { items: [head()], next_after: first }));
  assert.deepEqual(await api.directoryChanges([listed(head())]), [api.local('conversation', second)]); assert.equal(calls.length, 2);
  for (const invalid of [{ items: [head(second), head()], next_after: '' }, { items: [head()], next_after: second }]) {
    const { api } = setup(() => Response.json(invalid));
    await assert.rejects(api.directoryChanges([]), { code: 'invalid_response' });
  }
});

test('退出账号、后台切换或认证失败的结果不会应用到新的目录', async () => {
  for (const cancel of ['session', 'current']) {
    let release, current = true;
    const { api } = setup(async () => { await new Promise(resolve => release = resolve); return Response.json({ items: [head()], next_after: '' }); });
    const pending = api.directoryChanges([], { current: () => current });
    if (cancel === 'session') api.session('another'); else current = false;
    release(); await assert.rejects(pending, { code: 'stale_session' });
  }
  const { api } = setup(() => Response.json({ error: { code: 'unauthorized' } }, { status: 401 }));
  await assert.rejects(api.directoryChanges([]), { status: 401 });
});
