const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diagnosticFields, decodeExitResponse } = require('../pc/client-network-probe.cjs');

test('desktop exit diagnostics forwards only the allowed display fields and keeps zero', async () => {
  const upstream = { ip: '2001:4860::1', fraudScore: 0, isResidential: false, isBroadcast: true, userAgent: 'not uploaded', asOrganization: 'not uploaded' };
  assert.deepEqual(await decodeExitResponse(Response.json(upstream)), {
    exit_ip: '2001:4860::1', risk_score: 0, is_residential: false, is_broadcast: true,
  });
});

test('unavailable, oversized or incomplete diagnostics cannot fabricate a score', async () => {
  assert.equal(await decodeExitResponse(new Response('busy', { status: 503 })), null);
  assert.equal(await decodeExitResponse(new Response('x'.repeat(16385))), null);
  assert.equal(diagnosticFields({ ip: 'not an address', fraudScore: 0 }), null);
  assert.deepEqual(diagnosticFields({ ip: '8.8.8.8', fraudScore: '0', isResidential: 1, isBroadcast: 'false' }), {
    exit_ip: '8.8.8.8', risk_score: null, is_residential: null, is_broadcast: null,
  });
});

test('IPPure geolocation forwards only actual bounded fields without inventing a district', () => {
  const result = diagnosticFields({ ip: '8.8.8.8', country: ' China ', region: '广东省', city: '深圳市', latitude: 22.5, longitude: 114.0 });
  assert.deepEqual(result.exit_location, { country: 'China', province: '广东省', city: '深圳市', district: '' });
  assert.equal(Object.hasOwn(result.exit_location, 'latitude'), false);
  assert.equal(Object.hasOwn(result.exit_location, 'longitude'), false);
  assert.equal(diagnosticFields({ ip: '8.8.8.8', region: 'x'.repeat(129), city: 'bad\ncity' }).exit_location, undefined);
});
