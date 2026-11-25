const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { createMediaDiskCache } = require('../pc/media-disk-cache.cjs');
const sources = require('../pc/web/media-source.js');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
async function until(predicate) { const deadline = Date.now() + 3000; while (!predicate()) { assert.ok(Date.now() < deadline, 'download did not start'); await new Promise(resolve => setImmediate(resolve)); } }
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-copy-priority-'));
  const started = [], gates = new Map(); let handler, active = 0, maximum = 0;
  const profile = { id: 'priority-test', accountId: 1, locked: false, session: { protocol: { handle: (_, callback) => { handler = callback; }, unhandle() {} } } };
  const cache = createMediaDiskCache({ directory, fetch: async (_, url, options) => {
    assert.equal(options.headers, undefined, 'local priority must not become a server header');
    const token = /media-grants\/([a-f0-9]{64})\//.exec(url)[1]; started.push(token); active++; maximum = Math.max(maximum, active);
    const gate = deferred(); gates.set(token, gate);
    const aborted = () => gate.resolve('aborted'); options.signal.addEventListener('abort', aborted, { once: true });
    try { const result = await gate.promise; if (result === 'aborted') throw Error('aborted'); return new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) } }); }
    finally { active--; options.signal.removeEventListener('abort', aborted); }
  } });
  cache.register(profile, url => new URL(url).hostname === 'chat.example.org' ? url : null);
  const token = number => number.toString(16).padStart(64, '0');
  const url = number => sources.display('https://chat.example.org/api/v2/media-grants/' + token(number) + '/content', 1, 2, number, true, 'image');
  const request = (number, priority = false, signal) => handler(new Request(url(number), { ...(signal ? { signal } : {}), ...(priority ? { headers: { 'X-Pulse-Media-Priority': 'clipboard' } } : {}) })).then(async response => ({ status: response.status, bytes: Buffer.from(await response.arrayBuffer()) }));
  return { cache, profile, started, token, url, request, release: number => gates.get(token(number))?.resolve(), maximum: () => maximum,
    async close() { await cache.clear(); cache.unregister(profile); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('a user copy starts while two background downloads are occupied, with at most three transfers', async () => {
  const f = await fixture();
  try {
    const first = f.request(11), second = f.request(12);
    await until(() => f.started.length === 2);
    const queued = f.request(13), copied = f.request(14, true);
    await until(() => f.started.includes(f.token(14)));
    assert.equal(f.started.includes(f.token(13)), false);
    assert.equal(f.maximum(), 3);
    f.release(14); assert.deepEqual((await copied).bytes, png);
    assert.equal(f.started.includes(f.token(13)), false, 'background work remains limited to two downloads');
    f.release(11); await first; await until(() => f.started.includes(f.token(13)));
    f.release(12); f.release(13); await Promise.all([second, queued]);
    assert.equal(f.maximum(), 3);
  } finally { await f.close(); }
});

test('copying an already queued original promotes the shared download without another fetch', async () => {
  const f = await fixture();
  try {
    const first = f.request(21), second = f.request(22); await until(() => f.started.length === 2);
    const queued = f.request(23);
    await new Promise(resolve => setImmediate(resolve));
    const copied = f.request(23, true); await until(() => f.started.includes(f.token(23)));
    f.release(23);
    const both = await Promise.all([queued, copied]); assert.ok(both.every(row => row.status === 200 && row.bytes.equals(png)));
    assert.equal(f.started.filter(token => token === f.token(23)).length, 1);
    f.release(21); f.release(22); await Promise.all([first, second]);
    assert.equal(f.maximum(), 3);
  } finally { await f.close(); }
});

test('cancelling a foreground copy frees its slot for the next copy', async () => {
  const f = await fixture();
  try {
    const first = f.request(31), second = f.request(32); await until(() => f.started.length === 2);
    const controller = new AbortController(), copied = f.request(33, true, controller.signal);
    await until(() => f.started.includes(f.token(33))); controller.abort();
    assert.equal((await copied).status, 403);
    const next = f.request(34, true); await until(() => f.started.includes(f.token(34)));
    f.release(34); assert.equal((await next).status, 200);
    f.release(31); f.release(32); await Promise.all([first, second]);
    assert.equal(f.maximum(), 3);
  } finally { await f.close(); }
});

test('copy priority does not bypass account checks or repeat a cached network download', async () => {
  const f = await fixture();
  try {
    const copied = f.request(41, true); await until(() => f.started.length === 1); f.release(41); assert.equal((await copied).status, 200);
    assert.equal((await f.request(41, true)).status, 200); assert.equal(f.started.length, 1);
    f.profile.accountId = 2; assert.equal((await f.request(41, true)).status, 403); assert.equal(f.started.length, 1);
  } finally { await f.close(); }
});
