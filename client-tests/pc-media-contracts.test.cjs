const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sources = require('../pc/web/media-source.js');
const { createMediaDiskCache } = require('../pc/media-disk-cache.cjs');

test('opaque Go video and audio grants retain their media types through the desktop cache', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-go-media-review-'));
  let handler;
  const profile = { id: 'fixture-profile', accountId: 1, locked: false, session: { protocol: {
    handle: (_, callback) => { handler = callback; }, unhandle: () => {},
  } } };
  let kind;
  const bytes = Buffer.from('isolated-media-fixture');
  const cache = createMediaDiskCache({ directory, fetch: async () => new Response(bytes, {
    headers: { 'Content-Type': kind === 'audio' ? 'audio/mp4' : 'video/mp4', 'Content-Length': String(bytes.length) },
  }) });
  try {
    assert.equal(cache.register(profile, value => value), true);
    for (kind of ['video', 'audio']) {
      const url = 'https://chat.example.org/api/v2/media-grants/' + (kind === 'audio' ? 'a' : 'b').repeat(64) + '/content';
      const displayed = sources.display(url, 1, 2, kind === 'audio' ? 4 : 3, true, kind);
      assert.equal(sources.isImage(displayed), false);
      const response = await handler(new Request(displayed));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Content-Type'), kind === 'audio' ? 'audio/mp4' : 'video/mp4');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      const range = await handler(new Request(displayed, { headers: { Range: 'bytes=2-6' } }));
      assert.equal(range.status, 206);
      assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2, 7));
    }
  } finally {
    await cache.clear();
    cache.unregister(profile);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('desktop media classification does not accept malformed type hints', () => {
  const raw = 'https://chat.example.org/api/v2/media-grants/' + 'd'.repeat(64) + '/content';
  const displayed = sources.display(raw, 1, 2, 3, true, 'image');
  assert.equal(sources.isImage(displayed), true);
  assert.equal(sources.parseDisplay(displayed + '&kind=video'), null);
});
