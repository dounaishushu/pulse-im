const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const helpers = import(pathToFileURL(path.resolve(__dirname, '../web-vue/src/platform/ippure.ts')).href);
const endpoint = 'https://my.ippure.com/v1/info';
const input = () => ({ ip: '8.8.8.8', country: 'United States', region: 'California', city: 'Los Angeles', fraudScore: 0, isResidential: false, isBroadcast: false });
const signal = () => new AbortController().signal;

test('browser maps actual country-region-city to the existing observation without credentials', async () => {
  const { browserIPPureExit } = await helpers;
  let called = 0;
  const result = await browserIPPureExit(endpoint, signal(), async (url, options) => {
    called++;
    assert.equal(url, endpoint); assert.equal(options.mode, 'cors'); assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined); assert.equal(options.body, undefined);
    return Response.json(input());
  });
  assert.equal(called, 1);
  assert.deepEqual(result, { exit_ip: '8.8.8.8', risk_score: 0, is_residential: false, is_broadcast: false,
    exit_location: { country: 'United States', province: 'California', city: 'Los Angeles', district: '' } });
});
test('browser only contacts the exact approved HTTPS self-IP endpoint', async () => {
  const { browserIPPureExit } = await helpers;
  for (const url of ['http://my.ippure.com/v1/info', endpoint + '?ip=7.7.7.7', endpoint + '#fragment', 'https://example.invalid/v1/info']) {
    assert.equal(await browserIPPureExit(url, signal(), () => { throw Error('must not fetch'); }), null);
  }
});
test('CORS, network errors, invalid JSON and HTTP failures do not invent an exit IP', async () => {
  const { browserIPPureExit } = await helpers;
  for (const fetcher of [async () => { throw new TypeError('Failed to fetch'); }, async () => new Response('denied', { status: 403 }), async () => new Response('not json')]) {
    assert.equal(await browserIPPureExit(endpoint, signal(), fetcher), null);
  }
});
test('malformed provider fields stay absent while valid actual fields are retained', async () => {
  const { browserIPPureExit } = await helpers;
  const value = { ...input(), country: 3, region: 'bad\u0000region', city: ' Shenzhen ', fraudScore: '0', isResidential: 1, isBroadcast: 'false' };
  assert.deepEqual(await browserIPPureExit(endpoint, signal(), async () => Response.json(value)), {
    exit_ip: '8.8.8.8', risk_score: null, is_residential: null, is_broadcast: null,
    exit_location: { country: '', province: '', city: 'Shenzhen', district: '' },
  });
  for (const ip of ['', 'not-an-ip', '999.1.1.1', '8.8.8.8/path']) {
    assert.equal(await browserIPPureExit(endpoint, signal(), async () => Response.json({ ...input(), ip })), null);
  }
});
test('large responses are cancelled before parsing beyond the existing 16 KiB limit', async () => {
  const { browserIPPureExit } = await helpers;
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(16385)); }, cancel() { cancelled = true; } }));
  assert.equal(await browserIPPureExit(endpoint, signal(), async () => response), null);
  assert.equal(cancelled, true);
});
test('cancelled account work never performs a provider request', async () => {
  const { browserIPPureExit } = await helpers;
  const controller = new AbortController(); controller.abort();
  assert.equal(await browserIPPureExit(endpoint, controller.signal, () => { throw Error('stale account fetch'); }), null);
});
