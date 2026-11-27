const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.PULSE_CONTACT_POLICY_OUTPUT || path.join(root, '../.local/contact-management-ui'));
let server, browser;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{ name: 'contact-policy-fixture', configureServer(vite) {
      vite.middlewares.use('/__contact-policy', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/contact-management-fixture.ts"></script></html>');
      });
    } }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  const page = await browser.newPage({ viewport: { width: 1180, height: 850 } });
  page.setDefaultTimeout(8000);
  const errors = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  const pass = name => { checks.push(name); console.log('PASS ' + name); };
  const profile = () => page.getByRole('dialog', { name: '个人资料', exact: true });
  const more = () => page.getByRole('button', { name: '更多资料操作', exact: true });
  const role = allowed => page.evaluate(value => window.contactPolicyFixture.setStaff(value), allowed);
  const open = name => page.evaluate(value => window.contactPolicyFixture.open(value), name);
  const destructive = () => page.evaluate(() => window.contactPolicyFixture.writes.filter(row => ['/blocks', '/contacts/remove'].includes(row.path)));
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__contact-policy');
  await profile().getByRole('heading', { name: '测试好友' }).waitFor();
  assert.equal(await more().count(), 0);
  assert.equal(await profile().getByRole('textbox', { name: '备注', exact: true }).inputValue(), '保留备注');
  await profile().getByRole('textbox', { name: '备注', exact: true }).fill('普通账号仍可备注');
  await profile().getByRole('textbox', { name: '备注', exact: true }).blur();
  await page.waitForFunction(() => window.contactPolicyFixture.writes.some(row => row.path === '/contacts/remark'));
  assert.deepEqual(await destructive(), []);
  pass('ordinary/formal accounts have no remove/block menu and can still edit their own contact remarks');

  await open('settings');
  assert.equal(await page.getByRole('button', { name: '添加屏蔽用户' }).count(), 0);
  await page.getByRole('button', { name: '解除屏蔽', exact: true }).click();
  await page.getByText('暂无已屏蔽用户', { exact: true }).waitFor();
  assert.deepEqual(await destructive(), []);
  pass('ordinary accounts cannot add blocks in settings but can remove their own legacy block');

  await role(true); await open('contacts');
  await more().click();
  await page.getByRole('menuitem', { name: '删除好友', exact: true }).click();
  await page.getByRole('dialog', { name: '删除好友', exact: true }).waitFor();
  await role(false);
  await page.getByRole('dialog', { name: '删除好友', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await more().count(), 0); assert.deepEqual(await destructive(), []);
  pass('revoking staff permission cancels an open destructive confirmation without a write');

  await role(true); await open('contacts'); await more().click();
  await page.getByRole('menuitem', { name: '删除好友', exact: true }).click();
  await page.getByRole('button', { name: '确定删除', exact: true }).click();
  await page.waitForFunction(() => window.contactPolicyFixture.writes.some(row => row.path === '/contacts/remove'));
  pass('internal staff retain the confirmed friend-removal operation');

  await open('contacts'); await more().click();
  await page.getByRole('menuitem', { name: '拉黑好友', exact: true }).click();
  await page.getByRole('button', { name: '确定拉黑', exact: true }).click();
  await page.waitForFunction(() => window.contactPolicyFixture.writes.some(row => row.path === '/blocks'));
  await role(false); await open('contacts'); await more().click();
  assert.equal(await page.getByRole('menuitem', { name: '删除好友', exact: true }).count(), 0);
  assert.equal(await page.getByRole('menuitem', { name: '拉黑好友', exact: true }).count(), 0);
  await page.getByRole('menuitem', { name: '解除屏蔽', exact: true }).click();
  await more().waitFor({ state: 'hidden' });
  pass('staff retain blocking, while a downgraded account can only unblock an existing profile');

  await role(true); await open('settings');
  await page.getByRole('button', { name: '添加屏蔽用户' }).click();
  await role(false);
  await page.getByRole('button', { name: '添加屏蔽用户' }).waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(output, 'ordinary-settings.png') });
  assert.deepEqual(errors, []);
  pass('an open settings block picker closes when staff permission is revoked');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
})().finally(async () => { if (browser) await browser.close(); if (server) await server.close(); }).catch(error => { console.error(error.stack); process.exitCode = 1; });
