const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = path.resolve(process.env.PULSE_ADMIN_PASSWORD_TEST_OUTPUT || path.join(repo, '.local/admin-password-browser'));
const uuid = n => `${String(n).padStart(8, '0')}-2222-4222-8222-222222222222`;
const report = { checks: [], errors: [] };
const model = { role: 'superadmin', reason: '', requests: [], held: null, password: 'UserFixture888' };
const pass = name => { report.checks.push(name); process.stdout.write('PASS ' + name + '\n'); };
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')));
  const vue = (await import(pathToFileURL(path.join(root, 'node_modules/@vitejs/plugin-vue/dist/index.mjs')))).default;
  const tailwind = (await import(pathToFileURL(path.join(root, 'node_modules/@tailwindcss/vite/dist/index.mjs')))).default;
  const server = await createServer({ root, configFile: false, clearScreen: false, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { entries: ['tests/user-password-fixture.ts'] },
    plugins: [vue(), tailwind(), { name: 'password-test', configureServer(vite) {
      vite.middlewares.use('/__password-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/user-password-fixture.ts"></script></html>');
      });
    } }],
  });
  await server.listen();
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  const page = await browser.newPage({ viewport: { width: 1180, height: 920 } });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async value => { window.passwordCopied = value; },
    } });
  });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/api/v2/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.replace('/api/v2', '');
    const body = req.postDataJSON(); model.requests.push({ path: p, method: req.method(), body });
    let status = 200, data;
    const admin = { id: uuid(90), account: 'fixtureadmin', role: model.role, active: true, permissions: ['users.manage'] };
    if (p === '/admin/auth/login') data = { user: admin, csrf_token: '2'.repeat(64) };
    else if (p === '/admin/me') data = admin;
    else if (p === '/admin/users') data = { items: [1, 2].map(n => ({ id: uuid(n), account: 'fixtureuser' + n, nickname: '测试用户' + n, profile_version: '1', public_id: 'public' + n })), page: 1, size: 50 };
    else if (p.endsWith('/password-status')) data = { enabled: true, available: !model.reason, reason: model.reason };
    else if (p.endsWith('/password-reveal')) {
      if (body?.admin_password !== 'AdminFixture888') { status = 422; data = { error: { code: 'admin_password_invalid' } }; }
      else { data = { password: model.password, visible_for_seconds: 30 }; if (model.held) await model.held; }
    } else throw new Error('Unexpected fixture request: ' + p);
    await route.fulfill({ status, json: data });
  });
  const field = () => page.getByRole('textbox', { name: '当前用户密码', exact: true });
  const view = () => page.getByRole('button', { name: '查看密码', exact: true });
  const challenge = () => page.getByRole('dialog', { name: '验证管理员身份', exact: true });
  async function prompt() { await view().click(); await challenge().waitFor(); }
  async function submit(password = 'AdminFixture888') {
    await challenge().getByRole('textbox', { name: '当前管理员密码', exact: true }).fill(password);
    await challenge().getByRole('button', { name: '验证并查看', exact: true }).click();
  }
  async function expectHidden() { await page.waitForFunction(() => document.querySelector('input[aria-label="当前用户密码"]')?.value === '••••••••'); }
  try {
    await page.goto(origin + '/__password-test');
    await view().waitFor({ state: 'visible' });
    assert.equal(await field().inputValue(), '••••••••');
    assert.equal(model.requests.some(req => req.path.endsWith('/password-reveal')), false);
    pass('opening Edit User requests metadata only and shows a masked password');
    await prompt(); await submit('wrong-password');
    await challenge().getByText('管理员密码不正确，请重新输入。', { exact: true }).waitFor();
    assert.equal(await field().inputValue(), '••••••••');
    pass('failed administrator reauthentication keeps the password hidden and shows a useful error');
    await submit();
    await page.waitForFunction(() => document.querySelector('input[aria-label="当前用户密码"]')?.value === 'UserFixture888');
    await challenge().waitFor({ state: 'hidden' });
    assert.equal(model.requests.filter(req => req.path.endsWith('/password-reveal')).length, 2);
    const secretStored = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => String(value).includes('UserFixture888') || String(value).includes('AdminFixture888')));
    assert.equal(secretStored, false);
    await page.screenshot({ path: path.join(output, 'user-password-visible.png') });
    pass('successful reauthentication reveals only the selected password without browser storage');
    await page.getByRole('button', { name: '复制原始密码', exact: true }).click();
    assert.equal(await page.evaluate(() => window.passwordCopied), 'UserFixture888');
    await page.getByRole('button', { name: '隐藏密码', exact: true }).click(); await expectHidden();
    model.password = 'Line\r\nBreak\t888\u007f\u2028\u2029';
    await prompt(); await submit();
    await page.getByRole('button', { name: '隐藏密码', exact: true }).waitFor();
    assert.equal(await field().inputValue(), '"Line\\r\\nBreak\\t888\\u007f\\u2028\\u2029"');
    await page.locator('.user-password-viewer').getByText(/按 JSON 转义显示/).waitFor();
    await page.getByRole('button', { name: '复制原始密码', exact: true }).click();
    assert.equal(await page.evaluate(() => window.passwordCopied), model.password);
    pass('CR, LF, tab, DEL and Unicode line separators are explicitly escaped for display and copied from the original response');
    model.password = 'UserFixture888';
    await page.getByRole('button', { name: '隐藏密码', exact: true }).click(); await expectHidden();
    await page.clock.install(); await prompt(); await submit();
    await page.getByRole('button', { name: '隐藏密码', exact: true }).waitFor();
    await page.clock.fastForward(30001); await expectHidden();
    pass('manual concealment and the 30-second timer remove the password');
    await prompt(); await submit(); await page.getByRole('button', { name: '隐藏密码', exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await expectHidden();
    pass('window blur immediately conceals the password');
    let release;
    model.held = new Promise(resolve => { release = resolve; });
    await prompt(); await submit();
    await page.waitForFunction(() => document.querySelector('input[aria-label="当前管理员密码"]')?.disabled);
    await page.evaluate(() => { const f = window.passwordFixture; f.selected.value = f.rows[1]; });
    release(); model.held = null;
    await expectHidden(); await page.waitForTimeout(100);
    assert.equal(await field().inputValue(), '••••••••');
    pass('switching users aborts an in-flight reveal and discards the previous user password');
    await prompt(); await submit(); await page.getByRole('button', { name: '隐藏密码', exact: true }).waitFor();
    await page.evaluate(() => { window.passwordFixture.open.value = false; });
    await page.locator('.el-drawer:visible').waitFor({ state: 'hidden' });
    await page.evaluate(() => { window.passwordFixture.open.value = true; });
    await expectHidden();
    pass('closing and reopening Edit User never restores a revealed password');
    await page.evaluate(() => { window.passwordFixture.session.account.value = { ...window.passwordFixture.session.account.value, role: 'operator', is_super_admin: false }; });
    await page.locator('.user-password-viewer').waitFor({ state: 'hidden' });
    pass('delegated user-management operators have no password viewer');
    for (const reason of ['not_recorded', 'not_configured', 'key_unavailable']) {
      model.reason = reason; await page.reload();
      await view().waitFor(); assert.equal(await view().isDisabled(), true);
      await page.locator('.user-password-viewer').getByText(reason === 'not_recorded' ? /历史哈希无法还原/ : reason === 'not_configured' ? /尚未配置密码加密密钥/ : /加密密钥已变更/).waitFor();
    }
    await page.screenshot({ path: path.join(output, 'user-password-unavailable.png') });
    pass('historical records, disabled configuration and changed keys have explicit disabled states');
    assert.deepEqual(report.errors, []);
  } finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    await browser.close(); await server.close();
  }
}
main().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
