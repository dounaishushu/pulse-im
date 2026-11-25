const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createImageClipboard } = require('../pc/image-clipboard.cjs');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function renderer(write, scope = () => ({ key: 'account/chat', accountId: 1, allowed: true })) {
  const sandbox = { window: {}, HTMLImageElement: class {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pc/web/image-clipboard.js'), 'utf8'), sandbox);
  return sandbox.window.PulseImageClipboard.create({ context: scope, write });
}
function native(options = {}) {
  const written = [], decoded = [], reads = [], owner = { accountId: 1, locked: false };
  const api = createImageClipboard({
    clipboard: { writeImage: image => written.push(image.bytes.toString()) },
    nativeImage: { createFromBuffer: bytes => { decoded.push(bytes.toString()); return { bytes, isEmpty: () => bytes.toString() === 'corrupt', getSize: () => ({ width: 2, height: 3 }) }; } },
    allowed: (who, id) => who === owner && owner.accountId === id && !owner.locked,
    read: async (_, value) => { reads.push(value.url); return new Response(value.url, { headers: { 'content-type': 'image/png' } }); },
    ...options,
  });
  return { api, written, decoded, reads, owner };
}
const selection = (url = 'selected-original') => ({ accountId: 1, url, conversationId: 2, messageId: 3 });

test('copying an unloaded image uses its source, without image coordinates or DOM decoding', async () => {
  const calls = [], copy = renderer(async value => { calls.push(value); return value.phase === 'prepare' ? { ticket: 'selected-image' } : { copied: true }; });
  assert.equal(await copy.copySource(selection()), true);
  assert.equal(calls[0].url, 'selected-original');
  assert.equal(calls[0].phase, 'prepare'); assert.equal(calls[1].phase, 'commit');
  assert.equal(calls[1].ticket, 'selected-image');
  assert.equal(Object.hasOwn(calls[0], 'x'), false); assert.equal(Object.hasOwn(calls[0], 'y'), false);
});

test('changing conversation during image loading cancels the prepared copy', async () => {
  const loaded = deferred(), calls = []; let key = 'first';
  const copy = renderer(async value => { calls.push(value.phase); return value.phase === 'prepare' ? loaded.promise : { copied: false }; }, () => ({ key, accountId: 1, allowed: true }));
  const pending = copy.copySource(selection()); key = 'other-conversation'; loaded.resolve({ ticket: 'old-image' });
  assert.equal(await pending, false); assert.deepEqual(calls, ['prepare', 'cancel']);
});

test('a revoked message cannot commit an image that finished downloading later', async () => {
  const loaded = deferred(), calls = []; let valid = true;
  const copy = renderer(async value => { calls.push(value.phase); return value.phase === 'prepare' ? loaded.promise : {}; });
  const pending = copy.copySource(selection(), () => valid); valid = false; loaded.resolve({ ticket: 'old-image' });
  assert.equal(await pending, false); assert.deepEqual(calls, ['prepare', 'cancel']);
});

test('a slow grant for the first message cannot replace the second copied message', async () => {
  const first = deferred(), calls = [];
  const copy = renderer(async value => { calls.push(value); return value.phase === 'prepare' ? { ticket: value.url } : { copied: true }; });
  const slow = copy.copySource(() => first.promise);
  assert.equal(await copy.copySource(selection('second-original')), true);
  first.resolve(selection('first-original'));
  assert.equal(await slow, false);
  assert.deepEqual(calls.map(value => value.phase), ['prepare', 'commit']);
  assert.equal(calls[0].url, 'second-original');
});

test('the selected original is decoded and only written after explicit commit', async () => {
  const f = native();
  try {
    const prepared = await f.api.prepare(f.owner, selection());
    assert.deepEqual(f.written, []);
    assert.equal(f.api.commit(f.owner, { accountId: 1, ticket: prepared.ticket }).copied, true);
    assert.deepEqual(f.written, ['selected-original']);
    assert.equal(f.api.commit(f.owner, { accountId: 1, ticket: prepared.ticket }).copied, false);
  } finally { f.api.destroy(); }
});

test('two native downloads finishing out of order copy only the most recent selection', async () => {
  const first = deferred(), f = native({ read: async (_, value) => value.url === 'first' ? first.promise : new Response(value.url, { headers: { 'content-type': 'image/png' } }) });
  try {
    const slow = f.api.prepare(f.owner, selection('first'));
    const second = await f.api.prepare(f.owner, selection('second'));
    assert.equal(f.api.commit(f.owner, { accountId: 1, ticket: second.ticket }).copied, true);
    first.resolve(new Response('first', { headers: { 'content-type': 'image/png' } }));
    assert.equal((await slow).cancelled, true); assert.deepEqual(f.written, ['second']);
  } finally { f.api.destroy(); }
});

test('an account switch, lock, or different owner cannot commit another account image', async () => {
  const f = native();
  try {
    let prepared = await f.api.prepare(f.owner, selection());
    assert.equal(f.api.commit({}, { accountId: 1, ticket: prepared.ticket }).copied, false);
    f.owner.accountId = 2;
    assert.equal(f.api.commit(f.owner, { accountId: 1, ticket: prepared.ticket }).copied, false);
    f.owner.accountId = 1; prepared = await f.api.prepare(f.owner, selection()); f.owner.locked = true;
    assert.equal(f.api.commit(f.owner, { accountId: 1, ticket: prepared.ticket }).copied, false);
    assert.deepEqual(f.written, []);
  } finally { f.api.destroy(); }
});

test('explicit cancellation preserves the previous clipboard and rejects a delayed commit', async () => {
  const f = native();
  try {
    const prepared = await f.api.prepare(f.owner, selection());
    f.api.cancel(f.owner, { ticket: prepared.ticket });
    assert.equal(f.api.commit(f.owner, { accountId: 1, ticket: prepared.ticket }).copied, false);
    assert.deepEqual(f.written, []);
  } finally { f.api.destroy(); }
});

test('network errors, non-image bodies and corrupt images do not replace the clipboard', async () => {
  for (const response of [() => { throw Error('network secret'); }, () => new Response('not an image', { headers: { 'content-type': 'text/html' } }), () => new Response('corrupt', { headers: { 'content-type': 'image/png' } })]) {
    const f = native({ read: response });
    try { await assert.rejects(f.api.prepare(f.owner, selection()), /图片/); assert.deepEqual(f.written, []); }
    finally { f.api.destroy(); }
  }
});

test('both declared and streaming image sizes are bounded', async () => {
  for (const headers of [{ 'content-type': 'image/png', 'content-length': '10' }, { 'content-type': 'image/png' }]) {
    const f = native({ maxBytes: 4, read: async () => new Response('0123456789', { headers }) });
    try { await assert.rejects(f.api.prepare(f.owner, selection()), /图片过大/); assert.deepEqual(f.written, []); }
    finally { f.api.destroy(); }
  }
});

test('an unused prepared image expires without modifying the clipboard', async () => {
  const f = native({ timeoutMs: 5 });
  try {
    const prepared = await f.api.prepare(f.owner, selection());
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.api.commit(f.owner, { accountId: 1, ticket: prepared.ticket }).copied, false);
    assert.deepEqual(f.written, []);
  } finally { f.api.destroy(); }
});

test('a stalled download times out instead of reporting a successful or silent copy', async () => {
  const f = native({ timeoutMs: 5, read: (_, __, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })) });
  try {
    const rejected = assert.rejects(f.api.prepare(f.owner, selection()), /图片复制超时/);
    await new Promise(resolve => setTimeout(resolve, 20)); await rejected;
    assert.deepEqual(f.written, []);
  } finally { f.api.destroy(); }
});

async function copy(f, value = selection()) {
  const prepared = await f.api.prepare(f.owner, value);
  assert.equal(f.api.commit(f.owner, { accountId: value.accountId, ticket: prepared.ticket }).copied, true);
}

test('repeated copies reuse decoded pixels but still authorize and verify the source bytes', async () => {
  const f = native();
  try {
    await copy(f); await copy(f);
    assert.equal(f.decoded.length, 1); assert.equal(f.reads.length, 2);
    assert.deepEqual(f.written, ['selected-original', 'selected-original']);
  } finally { f.api.destroy(); }
});

test('changed bytes for the same message cannot reuse the previous decoded image', async () => {
  let bytes = 'first';
  const f = native({ read: async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }) });
  try {
    await copy(f); bytes = 'updated'; await copy(f);
    assert.deepEqual(f.decoded, ['first', 'updated']); assert.deepEqual(f.written, ['first', 'updated']);
  } finally { f.api.destroy(); }
});

test('decoded image reuse never crosses accounts or messages', async () => {
  const f = native();
  try {
    await copy(f); await copy(f, { ...selection(), messageId: 4 });
    f.owner.accountId = 2; await copy(f, { ...selection(), accountId: 2 });
    assert.equal(f.decoded.length, 3);
  } finally { f.api.destroy(); }
});

test('decode cache has a hard byte limit and expires', async () => {
  const oversized = native({ maxDecodedBytes: 23 });
  try { await copy(oversized); await copy(oversized); assert.equal(oversized.decoded.length, 2); }
  finally { oversized.api.destroy(); }
  const expired = native({ decodedTtlMs: 5 });
  try {
    await copy(expired); await new Promise(resolve => setTimeout(resolve, 20)); await copy(expired);
    assert.equal(expired.decoded.length, 2);
  } finally { expired.api.destroy(); }
});

test('recall and account invalidation drop decoded pixels without clearing another message', async () => {
  const f = native();
  try {
    await copy(f); f.api.invalidate(f.owner, 2, [4]); await copy(f); assert.equal(f.decoded.length, 1);
    f.api.invalidate(f.owner, 2, [3]); await copy(f); assert.equal(f.decoded.length, 2);
    f.api.invalidate(f.owner); await copy(f); assert.equal(f.decoded.length, 3);
  } finally { f.api.destroy(); }
});

test('a recalled image still downloading cannot later be committed', async () => {
  const response = deferred(), f = native({ read: () => response.promise });
  try {
    const prepared = f.api.prepare(f.owner, selection()); f.api.invalidate(f.owner, 2, [3]);
    response.resolve(new Response('old', { headers: { 'content-type': 'image/png' } }));
    assert.equal((await prepared).cancelled, true); assert.deepEqual(f.written, []);
  } finally { f.api.destroy(); }
});
