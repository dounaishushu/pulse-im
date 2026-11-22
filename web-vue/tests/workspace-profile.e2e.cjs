// Regression for the workspace avatar/profile entry and menu-only switching.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.PULSE_PROFILE_TEST_OUTPUT || path.join(root, '../.local/workspace-profile-ui'));
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';
const people = new Map([1, 2].map(n => [n, {
  id: uuid(n), account: 'account' + n, nickname: n === 1 ? '账号甲' : '账号乙',
  public_id: 'PROFILE' + n, avatar_id: uuid(100 + n), bio: '账号' + n + '的签名', version: '1',
}]));
const requests = [], failures = [], checks = [];
let server, browser, page, holdGrant, held;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const image = () => page.locator('.vue-profile-open .avatar img');
const profileButton = () => page.locator('.vue-profile-open');
async function loaded(target = image()) {
  await target.waitFor();
  await target.evaluate(img => img.complete && img.naturalWidth > 0 || new Promise((resolve, reject) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', () => reject(Error('avatar did not load')), { once: true });
  }));
}
async function closeDialog(name) {
  await page.getByRole('dialog', { name, exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
}
async function menu() {
  await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  return page.getByRole('region', { name: '功能菜单', exact: true });
}
async function switchTo(name) {
  const region = await menu();
  await region.locator('[data-account-id]').filter({ hasText: name }).click();
  await profileButton().filter({ hasText: name }).waitFor();
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  process.chdir(root);
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
    plugins: [{ name: 'workspace-profile-fixture', configureServer(vite) {
      vite.middlewares.use('/__workspace-profile-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/workspace-profile-fixture.ts"></script></html>');
      });
    } }],
  });
  await server.listen();
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => failures.push(error.message));
  await page.route('**/api/v2/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname.replace('/api/v2', ''), method = req.method();
    const account = Number((req.headers().authorization || '').split('-').at(-1));
    const body = req.postDataJSON(), person = people.get(account);
    requests.push({ path: p, method, account, body });
    let data = { items: [] }, status = 200;
    if (p === '/client/config') data = { registration: {}, display: {}, releases: {}, ippure_enabled: false };
    else if (p === '/client/update') data = { required: false };
    else if (p === '/me/profile') {
      assert.ok(person, 'profile requests must use their own synthetic account');
      if (method === 'PATCH') {
        assert.equal(body.expected_version, person.version);
        person.nickname = body.nickname; person.bio = body.bio;
        person.version = String(Number(person.version) + 1);
      }
      data = { ...person, user_id: person.id };
    } else if (p === '/client/conversation-page' || p === '/client/friend-page') data = { items: [], total: 0, page: 1, size: 100 };
    else if (p.endsWith('/unread')) data = { count: '0' };
    else if (/^\/media\/[^/]+\/grants$/.test(p) || p === '/media/grants') {
      const ids = p === '/media/grants' ? body.media_ids : [p.split('/')[2]];
      assert.ok(person && ids.every(id => id === person.avatar_id), 'a self avatar grant must use the matching account');
      if (holdGrant && account === 1) { held = true; await holdGrant; }
      const access = id => ({ content_path: '/api/v2/media-grants/' + Number(id.slice(0, 8)).toString(16).padStart(64, '0') + '/content', expires_in: 120 });
      data = p === '/media/grants' ? { items: ids.map(id => ({ id, access: access(id) })) } : access(ids[0]);
    } else if (/^\/media-grants\/[a-f0-9]{64}\/content$/.test(p)) {
      const n = parseInt(p.split('/')[2], 16);
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${n % 2 ? '#62b9b1' : '#8b9cde'}"/><circle cx="32" cy="24" r="13" fill="#ffdfc2"/><path d="M8 64C8 30 56 30 56 64" fill="#32566b"/></svg>` });
      return;
    } else if (method !== 'GET' && p !== '/client/network-observation') {
      failures.push('Unexpected write ' + p); status = 404; data = { error: { code: 'not_found' } };
    }
    await route.fulfill({ status, json: data });
  });
  await page.goto(origin + '/__workspace-profile-test');
  await profileButton().filter({ hasText: '账号甲' }).waitFor();
  await loaded();
  const first = await image().getAttribute('src');
  assert.ok(requests.some(r => r.account === 1 && r.path === '/media/' + uuid(101) + '/grants'));
  pass('cold restore displays the current account avatar from media ID without a prefilled URL');

  await profileButton().click();
  let dialog = page.getByRole('dialog', { name: '个人信息', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel('昵称', { exact: true }).inputValue(), '账号甲');
  assert.equal(await dialog.getByLabel('账号', { exact: true }).inputValue(), 'account1');
  assert.equal(await page.getByRole('dialog', { name: '已登录账号', exact: true }).count(), 0);
  await loaded(dialog.locator('.profile-avatar img'));
  await page.screenshot({ path: path.join(output, 'self-profile.png'), fullPage: true });
  pass('clicking the top avatar opens editable self profile with the matching avatar and identity');
  await closeDialog('个人信息');

  await page.getByRole('button', { name: '设置', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('button', { name: '切换或添加账号', exact: true }).count(), 0);
  await loaded(dialog.locator('.vue-settings-account img'));
  await closeDialog('设置');
  assert.equal(await page.locator('.vue-accounts-open').count(), 0);
  pass('settings keeps its normal start page and no extra account-switch entry is exposed');

  await switchTo('账号乙');
  await loaded();
  assert.notEqual(await image().getAttribute('src'), first);
  await profileButton().click();
  dialog = page.getByRole('dialog', { name: '个人信息', exact: true });
  assert.equal(await dialog.getByLabel('账号', { exact: true }).inputValue(), 'account2');
  await dialog.getByLabel('昵称', { exact: true }).fill('账号乙已修改');
  await dialog.getByRole('button', { name: '保存资料', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(people.get(1).nickname, '账号甲');
  assert.equal(people.get(2).nickname, '账号乙已修改');
  await closeDialog('个人信息');
  await profileButton().filter({ hasText: '账号乙已修改' }).waitFor();
  pass('menu account switching changes avatar/profile and profile edits save only to the selected account');

  let region = await menu();
  await region.getByRole('button', { name: '管理账号', exact: true }).click();
  await page.getByRole('dialog', { name: '已登录账号', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: '已登录账号', exact: true }).locator('[data-account-id]').count(), 2);
  await closeDialog('已登录账号');
  region = await menu();
  await region.getByRole('button', { name: '添加账号', exact: true }).click();
  await page.getByLabel('用户名 / 手机号', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回已登录账号', exact: true }).click();
  await profileButton().filter({ hasText: '账号乙已修改' }).waitFor();
  pass('menu still supports managing and adding accounts and cancelling back to the current workspace');

  people.get(2).avatar_id = '';
  await page.reload();
  await profileButton().filter({ hasText: '账号乙已修改' }).waitFor();
  assert.equal(await image().count(), 0);
  assert.equal(await profileButton().locator('.avatar').innerText(), '账');
  pass('an account without an avatar uses its own fallback instead of the previously displayed image');

  people.get(1).avatar_id = uuid(201);
  people.get(2).avatar_id = uuid(202);
  let release;
  holdGrant = new Promise(resolve => { release = resolve; });
  await page.reload();
  await loaded();
  await switchTo('账号甲');
  await page.waitForFunction(() => !!document.querySelector('.vue-profile-open'));
  for (let i = 0; !held && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(held, 'avatar request must be held before switching');
  await switchTo('账号乙已修改');
  await loaded();
  const oldGrant = page.waitForResponse(response => response.url().includes('/media/' + uuid(201) + '/grants'));
  release(); holdGrant = undefined;
  await oldGrant;
  await profileButton().filter({ hasText: '账号乙已修改' }).waitFor();
  assert.ok((await image().getAttribute('src')).includes(Number(202).toString(16).padStart(64, '0')));
  await page.screenshot({ path: path.join(output, 'workspace-avatar.png'), fullPage: true });
  pass('switching after an interrupted avatar load shows the selected account image');

  assert.deepEqual(failures, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: checks.length, failed: failures.length, checks, production_connected: false }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, failed: failures.length, output }));
})().catch(async error => {
  console.error(error);
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => { await browser?.close(); await server?.close(); });
