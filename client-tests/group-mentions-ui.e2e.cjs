// Real mention picker with local candidates; never sends a message.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), output = process.argv[2] || path.join(root, '.local/artifacts/group-mentions-ui');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true }), results = [];
  try {
    for (const role of ['member', 'owner', 'admin']) {
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } }), errors = [];
      page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
      await page.setContent('<!doctype html><html lang="zh-CN"><body class="desktop-mode"><main class="main" style="position:relative;height:600px"><form id="composer" class="desktop-chat-composer" style="position:absolute;bottom:0;width:100%;height:70px"><textarea id="message-input" style="width:80%;height:50px"></textarea></form></main></body></html>');
      await page.addStyleTag({ path: path.join(root, 'pc/web/group-mentions.css') });
      await page.addScriptTag({ path: path.join(root, 'client-shared/group-mentions.js') });
      await page.evaluate(role => {
        window.mentionContext = { token: 'fixture-token', userId: 1, id: 10, navigation: 1, role, staff: false, allowed: true };
        window.queries = []; window.canSearch = true;
        PulseGroupMentions.bind({ context: () => mentionContext, avatar: value => value, feedback: message => { throw Error(message); }, closeEmoji() {},
          request: async (id, query) => { queries.push({ id, query }); return { conversation_id: id, can_search: canSearch, can_mention_all: true, has_more: false, items: [{ user_id: 2, nickname: '呆萌萌', username: 'wenwen3', public_id: '123456' }, { user_id: 3, nickname: '晚春天灯', username: 'jmx12', public_id: '234567' }].filter(row => row.nickname.includes(query)) }; }
        });
      }, role);
      assert.equal(await page.locator('#group-mention-button').isVisible(), true);
      await page.click('#group-mention-button');
      await page.waitForSelector('.group-mention-row');
      assert.equal(await page.locator('[data-mention-all]').count(), role === 'member' ? 0 : 1);
      if (role === 'member') {
        assert.equal(await page.locator('.group-mention-row small').count(), 0);
        assert.doesNotMatch(await page.locator('#group-mention-picker').innerText(), /wenwen3|jmx12|123456|234567/);
      } else assert.match(await page.locator('#group-mention-picker').innerText(), /@wenwen3/);
      await page.fill('#message-input', '@萌');
      await page.waitForFunction(() => queries.at(-1)?.query === '萌' && document.querySelectorAll('.group-mention-row').length === 1);
      assert.equal(await page.locator('.group-mention-row strong').innerText(), '呆萌萌');
      await page.screenshot({ path: path.join(output, role + '-fuzzy-search.png') });
      await page.click('.group-mention-row');
      assert.equal(await page.inputValue('#message-input'), '@呆萌萌 ');
      assert.deepEqual(await page.evaluate(() => PulseGroupMentions.body(document.querySelector('#message-input').value)), { text: '@呆萌萌 ', mention_user_ids: [2] });
      await page.fill('#message-input', '删除了刚选择的成员');
      assert.deepEqual(await page.evaluate(() => PulseGroupMentions.body(document.querySelector('#message-input').value)), { text: '删除了刚选择的成员' });
      if (role !== 'member') {
        await page.fill('#message-input', '@'); await page.waitForSelector('[data-mention-all]'); await page.click('[data-mention-all]');
        assert.equal(await page.evaluate(() => PulseGroupMentions.body(document.querySelector('#message-input').value).mention_all), true);
        await page.evaluate(() => { mentionContext.role = 'member'; PulseGroupMentions.refresh(); });
        assert.equal(await page.evaluate(() => PulseGroupMentions.body(document.querySelector('#message-input').value).mention_all), undefined);
      }
      await page.evaluate(() => { mentionContext.allowed = false; PulseGroupMentions.refresh(); });
      assert.equal(await page.locator('#group-mention-button').isVisible(), false);
      assert.equal(await page.locator('#group-mention-picker').isVisible(), false);
      assert.deepEqual(errors, []);
      results.push({ role, search: 'passed', fuzzyNameMatch: 'passed', selectedIdentity: 'passed', permissionBoundaries: 'passed', accountLabels: role === 'member' ? 'hidden' : 'preserved' });
      await page.close();
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: results.length, results }, null, 2));
    console.log(JSON.stringify({ passed: results.length, results, output }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
