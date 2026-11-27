const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
function shippingFunction(source, name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, name);
  const rest = source.slice(match.index);
  const next = /\n(?:async )?function \w+\(/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const checks = [];
  try {
    for (const file of ['pc/web/app.js', 'web/app.js']) {
      const page = await browser.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<div class="contact-modal-backdrop"><input id="contact-search-input" value="peer001"><div id="contact-search-results"></div></div>');
      await page.evaluate(() => {
        window.state = { user: { id: 1, internal_staff: false }, token: 'isolated-viewer', contactCache: {} };
        window.searchFixture = { friend: true, added: 0, chats: [] };
        window.foregroundReadsAllowed = () => true;
        window.readPasscodeSettings = () => ({ locked: false });
        window.cancelContactSearch = () => { window.state.contactSearchRequest?.controller.abort(); window.state.contactSearchRequest = null; };
        window.escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
        window.avatarUrl = value => value; window.publicUserId = () => '';
        window.openContactChat = async id => { window.searchFixture.chats.push(id); };
        window.friendChats = { offer: async () => {}, changed() {} };
        window.loadConversations = async () => {};
        window.api = async (path, options = {}) => {
          if (path.startsWith('/contacts/search?')) return { items: [{ id: 2, user_id: 2, username: 'peer001', nickname: '测试好友', is_contact: window.searchFixture.friend }] };
          if (path === '/contact-requests' && options.method === 'POST') { window.searchFixture.added++; window.searchFixture.friend = true; return { status: 'accepted' }; }
          throw Error('Unexpected request: ' + path);
        };
      });
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      await page.addScriptTag({ content: ['exactUsernameUsers', 'bindContactDialogRows', 'searchContacts', 'contactRequestErrorText', 'setContactSearchChatAction', 'setContactRequestFeedback', 'sendFriendRequest'].map(name => shippingFunction(source, name)).join('\n') });
      await page.evaluate(() => searchContacts());
      const send = page.locator('[data-contact-chat="2"]');
      assert.equal(await send.innerText(), '发送消息'); assert.equal(await send.isEnabled(), true);
      assert.equal(await page.locator('[data-add-contact]').count(), 0);
      await send.click();
      assert.deepEqual(await page.evaluate(() => searchFixture.chats), [2]);
      assert.equal(await page.evaluate(() => searchFixture.added), 0);
      checks.push(file + ': existing friend has an enabled send action without adding');
      await page.evaluate(() => { searchFixture.friend = false; return searchContacts(); });
      await page.locator('[data-add-contact="2"]').click();
      await page.waitForFunction(() => document.querySelector('[data-contact-chat="2"]')?.textContent === '发送消息', null, { timeout: 5000 }).catch(async error => {
        console.error(JSON.stringify({ file, errors, body: await page.locator('body').innerText(), model: await page.evaluate(() => searchFixture) }));
        throw error;
      });
      assert.equal(await page.locator('[data-contact-chat="2"]').isEnabled(), true);
      await page.locator('[data-contact-chat="2"]').click();
      assert.deepEqual(await page.evaluate(() => searchFixture.chats), [2, 2]);
      assert.equal(await page.evaluate(() => searchFixture.added), 1);
      checks.push(file + ': accepted request becomes an enabled send action immediately');
      await page.evaluate(() => searchContacts());
      assert.equal(await page.locator('[data-contact-chat="2"]').innerText(), '发送消息');
      assert.deepEqual(errors, []);
      await page.close();
    }
    const output = { passed: true, checks };
    if (process.env.PULSE_FRIEND_SEARCH_OUTPUT) fs.writeFileSync(path.join(process.env.PULSE_FRIEND_SEARCH_OUTPUT, 'classic-results.json'), JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
