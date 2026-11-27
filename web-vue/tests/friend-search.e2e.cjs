const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.PULSE_FRIEND_SEARCH_OUTPUT;
let server, browser;
(async () => {
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'friend-search-fixture', configureServer(vite) {
      vite.middlewares.use('/__friend-search', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/friend-search-fixture.ts"></script></html>');
      });
    } }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1180, height: 850 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__friend-search`;
  const search = async () => { await page.getByPlaceholder('输入用户名或手机号').fill('peer001'); await page.getByRole('button', { name: '搜索', exact: true }).click(); };
  await page.goto(url); await search();
  const chat = page.getByRole('button', { name: '发送消息', exact: true });
  await chat.waitFor(); assert.equal(await page.getByRole('button', { name: '加好友', exact: true }).count(), 0);
  if (out) { fs.mkdirSync(out, { recursive: true }); await page.screenshot({ path: path.join(out, 'existing-friend.png') }); }
  await chat.click();
  await page.waitForFunction(() => window.friendSearchFixture.calls.some(call => call.path === 'choose'));
  let calls = await page.evaluate(() => window.friendSearchFixture.calls);
  assert.equal(calls.filter(call => call.path === '/conversations/direct').length, 1);
  assert.equal(calls.filter(call => ['/contact-requests', '/contacts/force-add'].includes(call.path)).length, 0);

  await page.goto(url);
  await page.waitForFunction(() => window.friendSearchFixture);
  await page.evaluate(() => { window.friendSearchFixture.model.friend = false; window.friendSearchFixture.setStaff(true); });
  await search(); await page.getByRole('button', { name: '加好友', exact: true }).click();
  await page.getByText('已添加为好友', { exact: true }).waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '加好友', exact: true }).count(), 0);
  if (out) await page.screenshot({ path: path.join(out, 'after-accepted.png') });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(() => window.friendSearchFixture.calls.some(call => call.path === 'choose'));
  calls = await page.evaluate(() => window.friendSearchFixture.calls);
  assert.equal(calls.filter(call => call.path === '/contacts/force-add').length, 1);
  assert.equal(calls.filter(call => call.path === '/conversations/direct').length, 1);
  assert.deepEqual(errors, []);
  const result = { passed: true, checks: ['existing friend without local friend-page entry', 'send action opens a direct chat without adding', 'accepted add immediately becomes send action', 'accepted add can enter chat'], browserErrors: errors };
  if (out) fs.writeFileSync(path.join(out, 'vue-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await server?.close(); });
