const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/text-outbox.js');
const account = { token: 'fixture-session', userId: 7 };
const payload = id => ({ conversation_id: 11, type: 'text', body: { text: id }, request_id: id });
const receipt = item => ({ id: 1, conversation_id: item.payload.conversation_id, sender_id: item.account.userId, body: { request_id: item.id } });
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const end = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < end, 'pending messages did not make progress');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const path of ['../client-shared/text-outbox.js', '../pc/web/text-outbox.js', '../web/text-outbox.js']) {
  test(path + ': a rejected message stays retryable without blocking later text', async t => {
    const { create } = require(path), calls = [], accepted = [];
    const queue = create({ allowed: () => true, changed() {}, accepted: item => accepted.push(item.id),
      send: async item => {
        calls.push(item.id);
        if (item.id === 'bad') throw Object.assign(new Error('invalid message content'), { status: 400, code: 'invalid_request' });
        return receipt(item);
      } });
    t.after(() => queue.dispose());
    const original = payload('bad'); original.body.mention_user_ids = [99];
    const failed = queue.enqueue(account, original);
    queue.enqueue(account, payload('second'));
    queue.enqueue(account, payload('third'));
    await until(() => accepted.length === 2);
    assert.deepEqual(calls, ['bad', 'second', 'third']);
    assert.deepEqual(accepted, ['second', 'third']);
    assert.deepEqual(queue.pending(account, 11), [failed]);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'invalid message content');
    assert.deepEqual(failed.payload, original);
  });
}

test('a failed-only conversation can retry the original ID and continue after another failed retry', async t => {
  const calls = [], accepted = [], snapshots = [];
  let reject = true;
  const queue = create({ allowed: () => true, changed() {}, accepted: item => accepted.push(item.id),
    send: async item => {
      calls.push(item.id); snapshots.push(structuredClone(item.payload));
      if (item.id === 'bad' && reject) throw Object.assign(new Error('request conflict'), { status: 409, code: 'request_conflict' });
      return receipt(item);
    } });
  t.after(() => queue.dispose());
  const original = payload('bad'), failed = queue.enqueue(account, original);
  await until(() => failed.status === 'failed');
  queue.enqueue(account, payload('second'));
  await until(() => accepted.length === 1);
  queue.retry('bad', account);
  await until(() => calls.filter(id => id === 'bad').length === 2 && failed.status === 'failed');
  queue.enqueue(account, payload('third'));
  await until(() => accepted.length === 2);
  reject = false;
  queue.retry('bad', account);
  await until(() => queue.pending(account, 11).length === 0);
  assert.deepEqual(calls, ['bad', 'second', 'bad', 'third', 'bad']);
  assert.deepEqual(accepted, ['second', 'third', 'bad']);
  assert.deepEqual(snapshots.filter(p => p.request_id === 'bad'), [original, original, original]);
});

test('a message-specific forbidden reply does not suppress a later permitted message', async t => {
  const sent = [], accepted = [];
  const queue = create({ allowed: () => true, changed() {}, accepted: item => accepted.push(item.id),
    send: async item => {
      sent.push(item.id);
      if (item.id === 'unavailable-reply') throw Object.assign(new Error('reply is not visible'), { status: 403, code: 'forbidden' });
      return receipt(item);
    } });
  t.after(() => queue.dispose());
  queue.enqueue(account, payload('unavailable-reply'));
  queue.enqueue(account, payload('plain-text'));
  await until(() => accepted.length === 1);
  assert.deepEqual(sent, ['unavailable-reply', 'plain-text']);
  assert.deepEqual(accepted, ['plain-text']);
  assert.equal(queue.pending(account, 11)[0].status, 'failed');
});

test('restoring a rejected head retains its payload while delivering the later durable message', async t => {
  let records = [{ payload: payload('bad') }, { payload: payload('later') }];
  const accepted = [];
  const queue = create({ allowed: () => true, changed() {}, accepted: item => accepted.push(item.id),
    store: { load: async () => structuredClone(records), save: async (_, rows) => { records = structuredClone(rows); } },
    send: async item => {
      if (item.id === 'bad') throw Object.assign(new Error('invalid request'), { status: 400 });
      return receipt(item);
    } });
  t.after(() => queue.dispose());
  await queue.restore(account);
  await until(() => accepted.length === 1 && records.length === 1);
  assert.deepEqual(accepted, ['later']);
  assert.deepEqual(records, [{ payload: payload('bad') }]);
  assert.equal(queue.pending(account, 11)[0].status, 'failed');
});

test('a late receipt for a failed message does not release the next message HTTP slot', async t => {
  const calls = [], accepted = [];
  let finishSecond;
  const queue = create({ concurrency: 1, allowed: () => true, changed() {}, accepted: item => accepted.push(item.id),
    send: async item => {
      calls.push(item.id);
      if (item.id === 'bad') throw new Error('unconfirmed response');
      if (item.id === 'second') return new Promise(resolve => { finishSecond = () => resolve(receipt(item)); });
      return receipt(item);
    } });
  t.after(() => queue.dispose());
  const first = queue.enqueue(account, payload('bad'));
  queue.enqueue(account, payload('second'));
  await until(() => finishSecond);
  assert.equal(queue.confirm(account, receipt(first)), true);
  queue.enqueue(account, payload('third'));
  await turn(); await turn();
  assert.deepEqual(calls, ['bad', 'second']);
  assert.equal(queue.pending(account, 11)[0].status, 'sending');
  finishSecond();
  await until(() => queue.pending(account, 11).length === 0);
  assert.deepEqual(calls, ['bad', 'second', 'third']);
  assert.deepEqual(accepted, ['second', 'third']);
});

test('migration review and failed messages retain manual retries without blocking later text', async t => {
  let records = [], reject = true;
  const calls = [], accepted = [];
  const queue = create({ allowed: () => true, changed() {}, accepted: item => accepted.push(item.id),
    store: {
      load: async () => structuredClone(records),
      save: async (_, rows) => { records = structuredClone(rows); },
    },
    send: async item => {
      calls.push(item.id);
      if (item.id === 'bad' && reject) throw Object.assign(new Error('invalid request'), { status: 400 });
      return receipt(item);
    } });
  t.after(() => queue.dispose());
  assert.equal(await queue.importForReview(account, [payload('legacy')]), 1);
  await turn();
  assert.deepEqual(calls, []);
  assert.equal(queue.pending(account, 11)[0].requiresReview, true);
  queue.enqueue(account, payload('bad'));
  queue.enqueue(account, payload('later'));
  await until(() => accepted.length === 1);
  assert.deepEqual(accepted, ['later']);
  queue.retry('bad', account);
  await until(() => calls.filter(id => id === 'bad').length === 2 && queue.pending(account, 11).find(item => item.id === 'bad').status === 'failed');
  queue.retry('legacy', account);
  await until(() => accepted.length === 2);
  assert.deepEqual(accepted, ['later', 'legacy']);
  reject = false;
  queue.retry('bad', account);
  await until(() => queue.pending(account, 11).length === 0 && records.length === 0);
  assert.deepEqual(calls, ['bad', 'later', 'bad', 'legacy', 'bad']);
  assert.deepEqual(accepted, ['later', 'legacy', 'bad']);
});
