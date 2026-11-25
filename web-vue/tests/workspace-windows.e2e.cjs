const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.PULSE_WINDOWS_TEST_OUTPUT || path.join(root, '../.local/workspace-windows-ui'));
const checks = [], errors = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
let server, browser;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
    plugins: [{ name: 'workspace-windows-fixture', configureServer(vite) {
      vite.middlewares.use('/__workspace-windows-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/workspace-windows-fixture.ts"></script></html>');
      });
    } }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  const page = await browser.newPage({ viewport: { width: 560, height: 760 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v2/**', route => { errors.push('Unexpected API request'); return route.abort(); });
  const dialog = name => page.getByRole('dialog', { name, exact: true });
  const list = () => dialog('账号窗口').getByRole('list', { name: '独立窗口列表' });
  const remove = name => list().getByRole('button', { name: '删除窗口 ' + name, exact: true });
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__workspace-windows-test');
  await list().getByText('登录账号甲', { exact: true }).waitFor();
  assert.equal(await list().getByRole('listitem').count(), 3);
  assert.equal(await list().getByText('独立窗口 2', { exact: true }).count(), 1);
  pass('each window shows its own signed-in nickname, with the ordinal retained and an unsigned-window fallback');
  await page.evaluate(() => { window.workspaceWindowsTest.rows[0].accountName = '修改后的昵称'; window.workspaceWindowsTest.update(); });
  await list().getByText('修改后的昵称', { exact: true }).waitFor();
  assert.equal(await list().getByText('登录账号甲', { exact: true }).count(), 0);
  pass('nickname and active-account changes refresh an already-open window list');
  await page.evaluate(() => { delete window.workspaceWindowsTest.rows[0].accountName; window.workspaceWindowsTest.update(); });
  await list().getByText('独立窗口 1', { exact: true }).waitFor();
  assert.equal(await list().getByText('修改后的昵称', { exact: true }).count(), 0);
  pass('signing out clears the stale account nickname');
  await remove('独立窗口 2').click();
  await dialog('删除窗口').getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.workspaceWindowsTest.calls), []);
  pass('delete has an independent confirmation and cancel never opens or removes a window');
  await page.evaluate(() => { window.workspaceWindowsTest.failRemoval = true; });
  await remove('独立窗口 2').click();
  await dialog('删除窗口').getByRole('button', { name: '确定删除', exact: true }).click();
  await dialog('删除窗口').getByRole('alert').filter({ hasText: '窗口删除失败' }).waitFor();
  await dialog('删除窗口').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await list().getByRole('listitem').count(), 3);
  pass('a failed deletion retains the window and shows a retryable error');
  await page.evaluate(() => { window.workspaceWindowsTest.failRemoval = false; });
  await remove('独立窗口 2').click();
  await dialog('删除窗口').getByRole('button', { name: '确定删除', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.workspace-window-list li').length === 2);
  assert.equal(await list().getByText('独立窗口 2', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.workspaceWindowsTest.calls.filter(call => call.action === 'open').length), 0);
  pass('confirm removes exactly the selected window without triggering the open action');
  // Two overlapping event refreshes must not allow the older response to win.
  await page.evaluate(() => {
    const test = window.workspaceWindowsTest;
    window.expectedWorkspaceResponses = test.returnedLists + 2;
    let release; const held = new Promise(resolve => { release = resolve; });
    test.holdList = async () => held; test.rows[0].accountName = '旧的异步结果'; test.update();
    test.holdList = null; test.rows[0].accountName = '最新账号名称'; test.update();
    window.releaseWorkspaceList = release;
  });
  await list().getByText('最新账号名称', { exact: true }).waitFor();
  await page.evaluate(() => window.releaseWorkspaceList());
  await page.waitForFunction(() => window.workspaceWindowsTest.returnedLists === window.expectedWorkspaceResponses);
  assert.equal(await list().getByText('旧的异步结果', { exact: true }).count(), 0);
  assert.equal(await list().getByText('最新账号名称', { exact: true }).count(), 1);
  pass('late responses cannot overwrite the latest account-window list');
  await page.setViewportSize({ width: 420, height: 640 });
  await page.evaluate(() => { window.workspaceWindowsTest.rows[0].accountName = '很长的昵称'.repeat(20); window.workspaceWindowsTest.update(); });
  await remove('很长的昵称'.repeat(20)).waitFor();
  assert.equal(await page.evaluate(() => {
    const panel = document.querySelector('.vue-dialog'); return panel.scrollWidth <= panel.clientWidth + 1;
  }), true);
  await page.screenshot({ path: path.join(output, 'window-list.png'), fullPage: true });
  pass('long account names keep delete controls visible in a narrow window');
  await remove('当前账号乙').click();
  await dialog('删除窗口').getByRole('button', { name: '确定删除', exact: true }).click();
  await page.getByRole('button', { name: '重新打开账号窗口', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.workspaceWindowsTest.subscribers), 0);
  assert.equal(await page.evaluate(() => window.workspaceWindowsTest.closed), 1);
  pass('deleting the current window closes its dialog and releases the change listener');
  await page.getByRole('button', { name: '重新打开账号窗口', exact: true }).click();
  await list().getByRole('listitem').waitFor();
  assert.equal(await list().getByRole('listitem').count(), 1);
  assert.equal(await list().getByText('当前账号乙', { exact: true }).count(), 0);
  pass('removed windows stay removed when the account-window dialog is reopened');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: true, checks, errors }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2)); })
  .finally(async () => { await browser?.close(); await server?.close(); });
