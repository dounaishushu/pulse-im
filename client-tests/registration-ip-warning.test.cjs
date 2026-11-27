const test = require('node:test');
const assert = require('node:assert/strict');
const base = 'https://chat.example.org/api/v2';

for (const file of ['../client-shared/go-v2.js', '../web/go-v2.js', '../pc/web/go-v2.js']) {
  const { create } = require(file);
  function client(error, status = 429) {
    const requests = [];
    const api = create({ base, storage: { getItem: () => null, setItem() {} }, fetch: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ error }, { status });
    } });
    return { api, requests };
  }
  for (const ip of ['203.0.113.15', '2001:db8::15']) {
    test(`${file}: registration rejection shows the observed ${ip.includes(':') ? 'IPv6' : 'IPv4'} address`, async () => {
      const { api, requests } = client({ code: 'registration_ip_limit', current_ip: ip, retryable: false });
      await assert.rejects(api.request('/auth/register', { method: 'POST', body: JSON.stringify({
        username: 'quota01', nickname: '注册测试', password: 'Example123', captcha_id: 'challenge', captcha_code: 'ABCDE',
      }) }), error => {
        assert.equal(error.code, 'registration_ip_limit');
        assert.equal(error.status, 429);
        assert.equal(error.message, '该IP已经注册过账户\n当前IP：' + ip);
        return true;
      });
      assert.equal(requests.length, 1, 'a rejected registration must not log in or retry');
      assert.equal(new URL(requests[0].url).pathname, '/api/v2/auth/register');
    });
  }
  test(`${file}: older servers without an IP field use the specific registration warning`, async () => {
    const { api } = client({ code: 'registration_ip_limit' });
    await assert.rejects(api.raw('/auth/register', { method: 'POST' }), { message: '该IP已经注册过账户' });
  });
  test(`${file}: unrelated failures keep their own message and never append an IP`, async () => {
    const { api } = client({ code: 'rate_limited', current_ip: '203.0.113.15' });
    await assert.rejects(api.raw('/auth/register', { method: 'POST' }), { code: 'rate_limited', message: '操作太频繁，请稍后重试' });
  });
}
