const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { create } = require('../client-shared/go-v2.js');
const id = '00000001-eeee-4eee-8eee-eeeeeeeeeeee';
function fixture(prepareImage, prepareUpload) {
  const storage = new Map(), requests = [];
  const go = create({ base: 'https://fixture.invalid/api/v2', storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, prepareImage, prepareUpload,
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/media/uploads')) return Response.json({ id, status: 'pending' });
      if (init.method === 'PUT') return Response.json({ id, status: 'ready', bytes: String(init.body.size), mime: init.body.type, original: false });
      throw Error('unexpected request');
    } });
  go.session('owner'); return { go, requests };
}

test('image normalization precedes the hash, upload declaration and body transfer', async () => {
  const source = new File([new Uint8Array(Math.round(5.2 * 1024 * 1024))], 'large.png', { type: 'image/png' });
  const resized = new File(['compressed'], 'large.png', { type: 'image/png' });
  let count = 0;
  const f = fixture(async file => { assert.equal(file, source); count++; return resized; });
  await f.go.uploadMedia('image', source);
  const metadata = JSON.parse(f.requests[0].init.body);
  assert.equal(count, 1); assert.equal(metadata.bytes, String(resized.size));
  assert.equal(metadata.sha256, crypto.createHash('sha256').update('compressed').digest('hex'));
  assert.equal(f.requests[1].init.body, resized);
});

test('original images and non-image uploads retain their exact source bytes', async () => {
  for (const [kind, original] of [['image', true], ['file', false], ['video', false], ['avatar', false]]) {
    const file = new File(['unchanged'], 'source.png', { type: 'image/png' });
    const f = fixture(async () => { throw Error('must not normalize'); });
    await f.go.uploadMedia(kind, file, { original });
    assert.equal(f.requests[1].init.body, file);
    assert.equal(JSON.parse(f.requests[0].init.body).original, original);
  }
});

test('native staged uploads receive the transformed file and release their stage', async () => {
  const source = new File(['source'], 'large.png'), resized = new File(['normalized'], 'large.png');
  let received, sent = 0, released = 0;
  const sum = crypto.createHash('sha256').update('normalized').digest('hex');
  const f = fixture(async () => resized, async (file, token) => {
    received = file; assert.equal(token, 'owner');
    return { sha256: sum,
      send: async () => { sent++; return Response.json({ id, status:'ready',bytes:String(file.size),mime:'image/png' }); },
      release: async () => { released++; },
    };
  });
  await f.go.uploadMedia('image', source);
  assert.equal(received, resized); assert.equal(sent, 1); assert.equal(released, 1);
  assert.equal(JSON.parse(f.requests[0].init.body).sha256, sum);
  assert.equal(f.requests.length, 1);
});

test('oversized source and oversized transformed images fail before hashing or admission', async () => {
  let transformed = false;
  const f = fixture(async file => { transformed = true; return { ...file, size: 10 * 1024 * 1024 + 1 }; });
  await assert.rejects(f.go.uploadMedia('image', { size: 10 * 1024 * 1024 + 1 }), { code: 'media_too_large' });
  assert.equal(transformed, false);
  await assert.rejects(f.go.uploadMedia('image', new File(['safe'], 'safe.png')), { code: 'media_too_large' });
  assert.equal(f.requests.length, 0);
});

test('account changes and cancellation during normalization cannot upload as another account', async () => {
  for (const cancel of [false, true]) {
    let finish; const done = new Promise(resolve => { finish = resolve; });
    const source = new File(['source'], 'safe.png', { type: 'image/png' });
    const f = fixture(async () => { await done; return source; });
    const controller = new AbortController();
    const upload = f.go.uploadMedia('image', source, { signal: controller.signal });
    const rejected = assert.rejects(upload, { code: 'stale_session' });
    await new Promise(resolve => setImmediate(resolve));
    if (cancel) controller.abort(); else f.go.session('other');
    finish(); await rejected;
    assert.equal(f.requests.length, 0);
  }
});

test('image processing failures explain the reason and always free the upload slot', async () => {
  const file = new File(['bytes'], 'safe.png', { type: 'image/png' });
  let attempts = 0;
  const f = fixture(async source => { if (++attempts <= 3) throw Error('分辨率过大'); return source; });
  for (let i = 0; i < 3; i++) await assert.rejects(f.go.uploadMedia('image', file), /分辨率过大/);
  await f.go.uploadMedia('image', file);
  assert.equal(f.requests.length, 2);
  assert.match(f.go.fail('image_pixel_limit', 422).message, /取消发送原图/);
});
