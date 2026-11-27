const test = require('node:test');
const assert = require('node:assert/strict');
for (const file of ['../client-shared/go-v2.js', '../pc/web/go-v2.js', '../web/go-v2.js']) {
  const { create } = require(file);
  test(`${file}: repeated account searches preserve the current server friendship without scanning friend pages`, async () => {
    let friend = true;
    const paths = [];
    const go = create({ base: 'https://fixture.invalid/api/v2', storage: { getItem: () => null, setItem() {} }, fetch: async raw => {
      const path = new URL(raw).pathname;
      paths.push(path);
      assert.equal(path, '/api/v2/users/by-account/peer001');
      return Response.json({ id: '22222222-2222-4222-8222-222222222222', account: 'peer001', nickname: '测试好友', is_contact: friend });
    } });
    go.session('current-viewer');
    assert.equal((await go.request('/contacts/search?q=peer001', { deferMedia: true })).items[0].is_contact, true);
    friend = false;
    assert.equal((await go.request('/contacts/search?q=peer001', { deferMedia: true })).items[0].is_contact, false);
    friend = true;
    assert.equal((await go.request('/contacts/search?q=peer001', { deferMedia: true })).items[0].is_contact, true);
    assert.equal(paths.length, 3, 'each search should use one request');
  });
}
