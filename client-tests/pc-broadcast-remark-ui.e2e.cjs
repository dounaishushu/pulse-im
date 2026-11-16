// Real recipient dialog, Go adapter and account-scoped remarks; all traffic is local fixture data.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, '.local/artifacts/pc-broadcast-remarks'));
const baseline = process.argv.includes('--baseline');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PULSE_BROWSER_EXECUTABLE });
  const results = [], errors = [];
  const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  async function check(name, fn) { await fn(); results.push({ name, passed: true }); }
  const search = '[data-broadcast-search]', targets = '[data-broadcast-target]';
  try {
    await page.route('**/*', route => route.abort());
    await page.route('https://broadcast.example.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><button id="open">群发消息</button></body></html>' }));
    await page.goto('https://broadcast.example.test/');
    await page.addStyleTag({ content: 'body{font:14px "Microsoft YaHei",sans-serif;background:#eaf3e7}.modal-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0005;box-sizing:border-box}' });
    await page.addStyleTag({ path: path.join(root, 'pc/web/broadcast-assistant.css') });
    for (const file of ['pc/web/go-v2.js', 'pc/web/contact-names.js', baseline ? '.local/pc-broadcast-remark-20261117/broadcast-before.js' : 'pc/web/broadcast-assistant.js']) {
      await page.addScriptTag({ path: path.join(root, file) });
    }
    await page.evaluate(() => {
      const uuid = n => n.toString(16).padStart(8, '0') + '-1234-4123-8123-000000000000';
      const localID = n => parseInt(uuid(n).replace(/-/g, '').slice(0, 13), 16) + 1;
      window.friendID = localID;
      window.fixtureAccount = { token: 'fixture-a', userId: localID(999), internalStaff: true, blocked: false };
      window.calls = []; window.sent = []; window.sentCallbacks = 0; window.holdNames = null; window.failNames = false;
      window.nameClock = Date.now();
      const snapshot = '2026-11-17T00:00:00Z';
      const friends = Array.from({ length: 112 }, (_, i) => ({ id: uuid(i + 1), type: 'friend', name: '原昵称 ' + (i + 1), username: 'Friend' + String(i + 1).padStart(3, '0') }));
      const groups = [201, 202].map(n => ({ id: uuid(n), type: 'group', name: '群组 ' + n, username: '' }));
      window.go = PulseGoV2.create({ base: 'https://api.example.test/api/v2', platform: 'pc', storage: localStorage,
        fetch: async (rawURL, options) => {
          const url = new URL(rawURL), token = options.headers.Authorization;
          calls.push({ path: url.pathname, query: url.search, token });
          if (url.pathname.endsWith('/broadcast-targets')) {
            const group = url.searchParams.get('kind') === 'group', items = group ? groups : friends;
            const offset = url.searchParams.has('after') ? 100 : 0, rows = items.slice(offset, offset + 100);
            return Response.json({ items: rows, total: items.length, snapshot_max_id: snapshot, has_more: !group && offset === 0, next_after_id: rows.at(-1)?.id || '' });
          }
          if (url.pathname.endsWith('/client/friend-page')) {
            if (holdNames) await holdNames;
            if (failNames) return Response.json({ error: { code: 'unavailable' } }, { status: 503 });
            const current = Number(url.searchParams.get('page')), size = 100;
            return Response.json({ items: friends.slice((current - 1) * size, current * size).map(row => ({
              id: row.id, account: row.username, nickname: row.name,
              remark: token === 'Bearer fixture-a' ? '测试' + row.username.slice(-3) : '另一个账号' + row.username.slice(-3),
              avatar_id: uuid(888),
            })), page: current, size, total: friends.length });
          }
          throw new Error('Unexpected fetch: ' + url.pathname);
        },
      });
      go.session(fixtureAccount.token);
      const request = (url, options) => {
        if (url === '/internal/broadcast/send') {
          sent.push({ body: JSON.parse(options.body), token: options.authToken });
          return Promise.resolve({ complete: true });
        }
        return go.request(url, options);
      };
      window.names = PulseContactNames.create({ context: () => ({ base: go.base, ...fixtureAccount, allowed: !fixtureAccount.blocked }), request,
        now: () => nameClock, changed: () => window.assistant?.refreshNames?.() });
      window.assistant = PulseBroadcastAssistant.create({ getAccount: () => fixtureAccount, request,
        friendName: (id, fallback) => names.resolve(id, fallback),
        prepareFriendNames: async (account, { retry }) => {
          if (account.token !== fixtureAccount.token || account.userId !== fixtureAccount.userId) throw Error('stale account');
          await names.refresh({ force: retry });
          if (retry && account.token === fixtureAccount.token && account.userId === fixtureAccount.userId) await names.refresh();
        },
        upload: () => { throw Error('Unexpected upload'); }, mediaUrl: value => value,
        onSent: () => sentCallbacks++,
      });
      document.querySelector('#open').onclick = () => assistant.open();
    });
    await page.click('#open');
    await page.waitForFunction(() => document.querySelectorAll('[data-broadcast-target]').length === 112 && !document.querySelector('[data-broadcast-all]').disabled);
    await page.fill(search, '测试');
    if (baseline) {
      const count = await page.locator(targets).count();
      assert.equal(count, 0, 'baseline should reproduce the missing remark search');
      await page.screenshot({ path: path.join(output, 'remark-search-before.png') });
      const report = { reproduced: true, friends: 112, query: '测试', matched: count, errors };
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      return;
    }
    await check('partial remark matches all 112 friends across two pages', async () => {
      assert.equal(await page.locator(targets).count(), 112);
      assert.equal(await page.locator('.broadcast-target strong').first().textContent(), '测试001');
      const requests = await page.evaluate(() => calls);
      assert.equal(requests.filter(row => row.path.endsWith('/client/friend-page')).length, 2);
      assert.equal(requests.filter(row => row.path.endsWith('/broadcast-targets') && row.query.includes('kind=friend')).length, 2);
      assert.ok(requests.every(row => !row.path.includes('/media')), 'remark metadata must not fetch avatars');
    });
    await check('page two remark finds and selects the correct friend', async () => {
      await page.fill(search, '试112');
      assert.equal(await page.locator(targets).count(), 1);
      await page.check('[data-broadcast-all]');
      assert.match(await page.locator('[data-broadcast-selected]').textContent(), /已选 1 个/);
      assert.equal(await page.locator(targets).getAttribute('data-broadcast-target'), 'friend:' + await page.evaluate(() => friendID(112)));
    });
    await check('nickname and case insensitive account searches remain available', async () => {
      await page.fill(search, '原昵称 112'); assert.equal(await page.locator(targets).count(), 1);
      assert.equal(await page.locator(targets).isChecked(), true);
      await page.fill(search, ' ＦＲＩＥＮＤ１０１ '); assert.equal(await page.locator(targets).count(), 1);
      assert.equal(await page.locator('.broadcast-target strong').textContent(), '测试101');
    });
    await check('select all only selects matching recipients and keeps hidden selections', async () => {
      await page.fill(search, '测试01'); assert.equal(await page.locator(targets).count(), 10);
      await page.check('[data-broadcast-all]');
      assert.match(await page.locator('[data-broadcast-selected]').textContent(), /已选 11 个/);
      await page.fill(search, ''); assert.equal(await page.locator(targets + ':checked').count(), 11);
    });
    await check('group search and selections remain separate from friend search', async () => {
      await page.click('[data-broadcast-tab="group"]'); await page.fill(search, '202');
      assert.equal(await page.locator(targets).count(), 1); await page.check('[data-broadcast-all]');
      await page.click('[data-broadcast-tab="friend"]'); assert.equal(await page.inputValue(search), '');
      assert.equal(await page.locator(targets + ':checked').count(), 11);
      assert.match(await page.locator('[data-broadcast-selected]').textContent(), /已选 12 个/);
    });
    await check('remark edits and clearing update the open dialog without stale matches', async () => {
      await page.fill(search, '测试112');
      await page.evaluate(() => names.remember(friendID(112), '新备注<测试>'));
      assert.equal(await page.locator(targets).count(), 0);
      await page.fill(search, '新备注<测'); assert.equal(await page.locator(targets).count(), 1);
      assert.equal(await page.locator('.broadcast-target strong').textContent(), '新备注<测试>');
      assert.equal(await page.locator('.broadcast-target strong > *').count(), 0, 'remark is text, not HTML');
      await page.evaluate(() => names.remember(friendID(112), ''));
      assert.equal(await page.locator(targets).count(), 0);
      await page.fill(search, 'friend112'); assert.equal(await page.locator('.broadcast-target strong').textContent(), '原昵称 112');
      assert.equal(await page.locator(targets).isChecked(), true);
    });
    await page.fill(search, '测试01');
    await page.screenshot({ path: path.join(output, 'remark-search-after.png') });
    await check('delivery still uses the 12 selected IDs once with one request key', async () => {
      await page.fill('[data-broadcast-text]', '本地群发备注回归'); await page.click('[data-broadcast-send]');
      await page.waitForFunction(() => sentCallbacks === 1);
      const sent = await page.evaluate(() => window.sent);
      const expected = await page.evaluate(() => [112, ...Array.from({ length: 10 }, (_, i) => i + 10)].map(n => ({ type: 'friend', id: friendID(n) })).concat({ type: 'group', id: friendID(202) }));
      assert.deepEqual(sent.map(row => row.body.target), expected);
      assert.equal(new Set(sent.map(row => row.body.request_id)).size, 1);
      assert.ok(sent.every(row => row.token === 'fixture-a' && row.body.messages[0].body.text === '本地群发备注回归'));
    });
    await check('different viewing account does not inherit the first account remarks', async () => {
      await page.evaluate(() => { assistant.close(); fixtureAccount = { ...fixtureAccount, token: 'fixture-b', userId: friendID(998) }; go.session(fixtureAccount.token); });
      await page.click('#open');
      await page.waitForFunction(() => !document.querySelector('[data-broadcast-all]').disabled);
      await page.fill(search, '测试'); assert.equal(await page.locator(targets).count(), 0);
      await page.fill(search, '另一个账号112'); assert.equal(await page.locator(targets).count(), 1);
    });
    await check('waiting for remark pages shows loading and then updates an existing query', async () => {
      await page.evaluate(() => { assistant.close(); names.clear(); window.holdNames = new Promise(resolve => window.releaseNames = resolve); });
      await page.click('#open'); await page.fill(search, '另一个账号112');
      await page.waitForFunction(() => document.querySelector('[data-broadcast-targets]').textContent.includes('正在加载'));
      assert.equal(await page.locator('[data-broadcast-all]').isDisabled(), true);
      await page.evaluate(() => { releaseNames(); holdNames = null; });
      await page.waitForFunction(() => document.querySelectorAll('[data-broadcast-target]').length === 1 && !document.querySelector('[data-broadcast-all]').disabled);
    });
    await check('remark failure has a retry instead of a false empty result', async () => {
      await page.evaluate(() => { assistant.close(); names.clear(); failNames = true; }); await page.click('#open'); await page.fill(search, '另一个账号112');
      await page.waitForSelector('[data-broadcast-reload]');
      assert.equal(await page.locator('[data-broadcast-all]').isDisabled(), true);
      await page.evaluate(() => { failNames = false; }); await page.click('[data-broadcast-reload]');
      await page.waitForFunction(() => document.querySelectorAll('[data-broadcast-target]').length === 1 && !document.querySelector('[data-broadcast-all]').disabled);
    });
    await check('closing during metadata load cannot revive a closed dialog', async () => {
      await page.evaluate(() => { assistant.close(); names.clear(); holdNames = new Promise(resolve => window.releaseNames = resolve); }); await page.click('#open');
      await page.click('[data-broadcast-close]'); await page.evaluate(() => { releaseNames(); holdNames = null; });
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
      assert.equal(await page.locator('#broadcast-modal').count(), 0);
    });
    assert.deepEqual(errors, []);
    const report = { passed: results.length, results, errors };
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
