const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/go-v2.js');
const cid = '33333333-3333-4333-8333-333333333333';
const uid = '11111111-1111-4111-8111-111111111111';
const wire = n => '44444444-4444-4444-8444-' + String(n).padStart(12, '0');
const row = (n, extra = {}) => ({ id: wire(n), conversation_id: cid, sender_id: uid, seq: String(n), version: '1', kind: 'text', body: '正文 ' + n, content: {}, created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:00:00Z', ...extra });
function setup(handler) {
  const values = new Map(), calls = [];
  const client = create({ base: 'https://chat.example.invalid/api/v2', storage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }, fetch: async (url, options) => {
    const parsed = new URL(url); calls.push({ path: parsed.pathname, method: options.method, query: parsed.searchParams, body: options.body && JSON.parse(options.body) });
    return handler(parsed, options);
  } });
  client.session('fixture'); const id = client.local('conversation', cid); client.version(id, 1);
  return { client, id, calls };
}
function history(item) { return Response.json({ items: item ? [item] : [], membership_version: '1', visible_from_seq: '1', clear_seq: '0' }); }
function evict(client) { for (let n = 1; n <= 600; n++) client.message(row(n)); }

test('正文缓存淘汰后，旧消息编辑、回复和转发仍使用正确的服务器 ID', async () => {
  const { client, id, calls } = setup((url, options) => {
    if (url.pathname.endsWith('/history')) {
      assert.equal(url.searchParams.get('after_seq'), '0'); assert.equal(url.searchParams.get('limit'), '1');
      return history(row(1));
    }
    const body = JSON.parse(options.body);
    if (options.method === 'PATCH') {
      assert.ok(url.pathname.endsWith('/messages/' + wire(1)));
      assert.deepEqual(body, { body: '编辑', expected_version: '1' }); return Response.json(row(1, { version: '2', body: '编辑' }));
    }
    if (body.source_message_id) { assert.equal(body.source_message_id, wire(1)); return Response.json({ message: row(602) }); }
    assert.equal(body.reply_to_id, wire(1)); return Response.json({ message: row(601) });
  });
  const visible = client.message(row(1)); evict(client);
  const edited = await client.request('/messages/edit', { method: 'POST', body: { conversation_id: id, message_id: 1, expected_version: '1', text: '编辑' } });
  assert.equal(edited.body.text, '编辑');
  await client.request('/messages', { method: 'POST', body: { conversation_id: id, type: 'text', request_id: 'reply', body: { text: '回复', reply_to_id: 1 } } });
  await client.request('/messages', { method: 'POST', body: { conversation_id: id, type: 'text', request_id: 'forward', body: { _source_wire_id: visible.body._go_wire_id } } });
  assert.equal(calls.filter(call => call.path.endsWith('/history')).length, 1);
});

test('淘汰后的消息仍能撤回、删除和查询回执', async () => {
  for (const action of ['recall', 'delete', 'receipts']) {
    const { client, id, calls } = setup((url, options) => {
      if (url.pathname.endsWith('/history')) return history(row(1));
      if (url.pathname.endsWith('/me')) return Response.json({ user_id: uid });
      if (url.pathname.endsWith('/personal-deletions')) { assert.deepEqual(JSON.parse(options.body).message_ids, [wire(1)]); return Response.json({}); }
      assert.ok(url.pathname.includes('/messages/' + wire(1)));
      return Response.json(action === 'recall' ? row(1, { revoked: true, version: '2' }) : { items: [] });
    });
    evict(client);
    await client.request(action === 'receipts' ? '/messages/receipts?conversation_id=' + id + '&message_id=1' : '/messages/' + action,
      action === 'receipts' ? {} : { method: 'POST', body: { conversation_id: id, message_id: 1 } });
    assert.equal(calls.filter(call => call.path.endsWith('/history')).length, 1);
  }
});

test('旧消息批量操作的补读最多并发四个请求，保持消息顺序', async () => {
  let running = 0, maximum = 0; const written = [];
  const { client, id } = setup(async (url, options) => {
    if (url.pathname.endsWith('/history')) {
      maximum = Math.max(maximum, ++running);
      await new Promise(resolve => setTimeout(resolve, 2)); running--;
      return history(row(Number(url.searchParams.get('after_seq')) + 1));
    }
    written.push(url.pathname.split('/').at(-2));
    assert.equal(JSON.parse(options.body).status, 'delivered'); return Response.json({ status: 'delivered' });
  });
  evict(client);
  await client.request('/messages/receipt', { method: 'POST', body: { conversation_id: id, message_ids: Array.from({ length: 20 }, (_, i) => i + 1), status: 'delivered' } });
  assert.ok(maximum <= 4); assert.deepEqual(written, Array.from({ length: 20 }, (_, i) => wire(i + 1)));
});

test('旧消息已删除、权限失效或响应属于别的会话时，不发起写操作', async () => {
  for (const result of ['removed', 'denied', 'other-chat', 'other-sequence']) {
    const { client, id, calls } = setup(url => {
      assert.ok(url.pathname.endsWith('/history'));
      if (result === 'denied') return Response.json({ error: { code: 'forbidden' } }, { status: 403 });
      return history(result === 'removed' ? null : result === 'other-chat' ? row(1, { conversation_id: uid }) : row(2));
    });
    evict(client);
    await assert.rejects(client.request('/messages/recall', { method: 'POST', body: { conversation_id: id, message_id: 1 } }), { status: result === 'denied' ? 403 : 404 });
    assert.equal(calls.length, 1);
  }
});

test('账号和成员身份变化清理缓存，迟到的补读不能用于修改', async () => {
  let release;
  const { client, id, calls } = setup(async () => { await new Promise(resolve => release = resolve); return history(row(1)); });
  evict(client);
  const pending = client.request('/messages/recall', { method: 'POST', body: { conversation_id: id, message_id: 1 } });
  client.session('other'); release(); await assert.rejects(pending, { code: 'stale_session' }); assert.equal(calls.length, 1);
  client.message(row(1)); client.version(id, 1); client.version(id, 2);
  const denied = client.request('/messages/recall', { method: 'POST', body: { conversation_id: id, message_id: 1 } });
  release(); await assert.rejects(denied, { code: 'membership_changed' }); assert.equal(calls.length, 2);
});

test('缓存全局上限跨会话生效，近期消息版本不会被迟到旧响应覆盖', async () => {
  const { client, calls } = setup(() => history(row(1)));
  for (let chat = 3; chat < 8; chat++) {
    const conversation = String(chat).repeat(8) + '-3333-4333-8333-333333333333';
    for (let n = 1; n <= 500; n++) client.message(row(n, { conversation_id: conversation }));
  }
  const id = client.local('conversation', cid);
  // The first conversation is out of the global LRU, even though it fits its own limit.
  await assert.rejects(client.request('/messages/recall', { method: 'POST', body: { conversation_id: id, message_id: 1 } }));
  assert.ok(calls.some(call => call.path.endsWith('/history')));
  client.message(row(600, { version: '3', body: '最新版本' }));
  assert.equal(client.message(row(600, { version: '1' })).body.text, '最新版本');
});
