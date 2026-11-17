const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../client-shared/go-v2.js');

for (const platform of ['pc', 'web']) {
  for (const mode of ['login', 'register']) {
    test(`${platform} ${mode} reports the running client version with no extra request`, async () => {
      const values = new Map(), requests = [];
      const client = create({
        base: 'https://chat.example.org/api/v2', platform, clientVersion: '2.4.179',
        storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
        fetch: async (url, options) => {
          requests.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
          return Response.json(url.endsWith('/auth/register') ? { id: '11111111-1111-4111-8111-111111111111' }
            : { user_id: '11111111-1111-4111-8111-111111111111', access_token: 'local-fixture-session' });
        },
      });
      await client.request('/auth/' + mode, { method: 'POST', body: JSON.stringify({ username: 'versionuser01', password: 'LocalFixture2026', nickname: 'Version User', captcha_id: 'fixture', captcha_code: '12345' }) });
      assert.equal(requests.length, mode === 'register' ? 2 : 1);
      const login = requests.at(-1);
      assert.equal(login.path, '/api/v2/auth/login');
      assert.equal(login.body.platform, platform);
      assert.equal(login.body.client_version, '2.4.179');
      assert.equal(login.body.account, 'versionuser01');
      assert.ok(login.body.device_id.startsWith(platform + '-'));
    });
  }
}

test('an older adapter caller does not invent a client version', async () => {
  let version;
  const values = new Map();
  const client = create({
    base: 'https://chat.example.org/api/v2',
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    fetch: async (url, options) => {
      version = JSON.parse(options.body).client_version;
      return Response.json({ user_id: '11111111-1111-4111-8111-111111111111' });
    },
  });
  await client.request('/auth/login', { method: 'POST', body: JSON.stringify({ account: 'versionuser01', password: 'LocalFixture2026' }) });
  assert.equal(version, '');
});
