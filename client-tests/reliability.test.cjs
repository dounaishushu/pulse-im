const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/text-outbox.js');
const account = { token: 'test-session', userId: 7 };
const payload = (id, text = id) => ({ conversation_id: 11, type: 'text', body: { text }, request_id: id });
const receipt = item => ({ id: 1, conversation_id: 11, sender_id: 7, body: { request_id: item.id } });
async function until(predicate) {
  const end = Date.now() + 2500;
  while (!predicate()) { assert.ok(Date.now() < end, 'queue did not settle'); await new Promise(r => setTimeout(r, 5)); }
}
test('busy server and lost acknowledgement retry without changing the message or its position', async () => {
  const calls = [], accepted = [], stored = new Map();
  let first = true;
  const queue = create({ allowed: () => true, changed() {}, accepted: item => accepted.push(item.id), retryDelay: () => 10,
    send: async item => {
      calls.push(item.id);
      if (calls.length === 1) throw Object.assign(new Error('busy'), { status: 503 });
      stored.set(item.id, item.payload.body.text);
      if (first) { first = false; throw new TypeError('connection reset after commit'); }
      return receipt(item);
    } });
  queue.enqueue(account, payload('first')); queue.enqueue(account, payload('second'));
  await until(() => accepted.length === 2);
  assert.deepEqual(calls, ['first', 'first', 'first', 'second']);
  assert.deepEqual(accepted, ['first', 'second']);
  assert.equal(stored.size, 2);
  assert.equal(queue.pending(account, 11).length, 0);
  await queue.dispose();
});
test('recovered durable submissions automatically continue with their original request IDs', async () => {
  const sent = [], writes = [];
  const queue = create({ allowed: () => true, changed() {}, accepted() {},
    store: { load: async () => [{ payload: payload('durable') }], save: async (_, rows) => writes.push(rows) },
    send: async item => { sent.push(item.id); return receipt(item); } });
  await queue.restore(account); await until(() => sent.length === 1 && queue.pending(account, 11).length === 0);
  assert.deepEqual(sent, ['durable']); await queue.dispose();
});
test('permission denial keeps each message failed without automatically retrying it', async () => {
  let calls = 0;
  const queue = create({ allowed: () => true, changed() {}, accepted() {}, retryDelay: () => 1,
    send: async () => { calls++; throw Object.assign(new Error('muted'), { status: 403 }); } });
  queue.enqueue(account, payload('blocked')); queue.enqueue(account, payload('later'));
  await until(() => queue.pending(account, 11)[0]?.status === 'failed');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(calls, 2);
  assert.ok(queue.pending(account, 11).every(item => item.status === 'failed'));
  await queue.dispose();
});
test('switching accounts stops retry work for the previous credential', async () => {
  let enabled = true, calls = 0;
  const queue = create({ allowed: () => enabled, changed() {}, accepted() {}, retryDelay: () => 100,
    send: async () => { calls++; throw Object.assign(new Error('busy'), { status: 503 }); } });
  queue.enqueue(account, payload('old-account'));
  await until(() => calls === 1 && queue.pending(account, 11)[0]?.status === 'queued');
  enabled = false; await queue.release(account);
  await new Promise(r => setTimeout(r, 120)); assert.equal(calls, 1); await queue.dispose();
});
