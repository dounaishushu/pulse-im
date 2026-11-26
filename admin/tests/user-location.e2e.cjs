const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = path.resolve(process.env.PULSE_ADMIN_LOCATION_OUTPUT || path.join(repo, '.local/admin-user-location-ui'));
const checks = [], errors = [], requests = [];
const uuid = n => String(n).padStart(8, '0') + '-2222-4222-8222-222222222222';
const location = (country, province, city) => ({ country, province, city, source: 'ippure', reported: true });
const user = (n, account, registration, login, registrationDetail, loginDetail) => ({
  id: uuid(n), account, nickname: account, public_id: uuid(n).replaceAll('-', '').toUpperCase(),
  active: true, created_at: '2026-11-27T00:00:00Z', registration_ip: registration,
  last_login_ip: login, last_login_at: login ? '2026-11-27T01:00:00Z' : null,
  registration_ip_location_detail: registrationDetail, last_login_ip_location_detail: loginDetail,
});
const alpha = user(1, 'alpha', '8.8.8.8', '7.7.7.7', location('中国', '浙江省', '杭州市'), location('United States', 'California', 'Los Angeles'));
const beta = user(2, 'beta', '8.8.8.8', '7.7.7.7', location('中国', '广东省', '深圳市'), location('中国', '北京市', '北京市'));
const cached = user(3, 'cache_only', '9.9.9.9', '9.9.9.9', null, null);
const missing = user(4, 'missing', '1.1.1.1', '', null, null);
const legacy = { ...user(5, 'old_backend', '4.4.4.4', '', null, null), registration_ip_location: '旧版归属地' };
let server, browser, page, release, mode = '';
const gate = new Promise(resolve => release = resolve);
const pass = name => { checks.push(name); console.log('PASS ' + name); };

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  const vue = (await import(pathToFileURL(path.join(root, 'node_modules/@vitejs/plugin-vue/dist/index.mjs')).href)).default;
  const tailwind = (await import(pathToFileURL(path.join(root, 'node_modules/@tailwindcss/vite/dist/index.mjs')).href)).default;
  const plugins = [vue(), tailwind(), { name: 'location-fixture', configureServer(vite) {
    vite.middlewares.use('/__user-location-test', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/user-location-fixture.ts"></script>');
    });
  } }];
  if (process.env.PULSE_ADMIN_LOCATION_PREIMAGE) plugins.unshift({ name: 'original-user-view', enforce: 'pre', load(id) {
    if (id.replaceAll('\\', '/').endsWith('/src/views/UsersView.vue')) return fs.readFileSync(process.env.PULSE_ADMIN_LOCATION_PREIMAGE, 'utf8');
  } });
  server = await createServer({ root, configFile: false, logLevel: 'error', cacheDir: path.join(output, 'vite-cache'), plugins,
    server: { host: '127.0.0.1', port: 0, open: false }, optimizeDeps: { entries: ['tests/user-location-fixture.ts'] } });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://my.ippure.com/**', route => {
    errors.push('Admin must not query its own exit IP for other users'); return route.abort();
  });
  await page.route('**/api/v2/**', async route => {
    const req = route.request(), url = new URL(req.url()), endpoint = url.pathname.replace('/api/v2', '');
    const headers = await req.allHeaders();
    requests.push({ endpoint, method: req.method(), query: url.search, entry_header: headers['x-admin-entry'] === 'a'.repeat(64) });
    const fulfill = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
    if (endpoint === '/admin/auth/login') return fulfill({ user: { id: uuid(90), account: 'location_fixture', role: 'superadmin', permissions: [], active: true }, csrf_token: 'b'.repeat(64) });
    if (endpoint === '/admin/users') {
      mode = url.searchParams.get('q') || '';
      return fulfill({ items: mode === 'held' ? [user(6, 'held_user', '5.5.5.5', '', null, null)] : mode === 'replacement' ? [alpha] : [alpha, beta, cached, missing, legacy], page: 1, size: 30, has_more: false });
    }
    if (endpoint === '/admin/ip-locations') {
      if (url.searchParams.getAll('ip').includes('5.5.5.5')) await gate;
      return fulfill({ items: url.searchParams.getAll('ip').map(ip => ({
        ip, country: ip === '9.9.9.9' ? 'United Kingdom' : '错误缓存国家',
        region: ip === '9.9.9.9' ? 'England' : '错误缓存省', city: ip === '9.9.9.9' ? 'London' : '错误缓存城市',
        status: ip === '1.1.1.1' ? 'failed' : 'resolved',
      })) });
    }
    return fulfill({ items: [] });
  });
  try {
    await page.goto(origin + '/__user-location-test');
    const row = name => page.locator('.el-table__body tr').filter({ hasText: name });
    await row('alpha').getByText('中国-浙江省-杭州市', { exact: true }).waitFor();
    await row('alpha').getByText('United States-California-Los Angeles', { exact: true }).waitFor();
    await page.getByText('正在读取 IP 归属地…', { exact: true }).waitFor({ state: 'hidden' });
    assert.doesNotMatch(await row('alpha').innerText(), /错误缓存/);
    const longLocation = row('alpha').getByText('United States-California-Los Angeles', { exact: true });
    assert.equal(await longLocation.getAttribute('title'), 'United States-California-Los Angeles');
    assert.equal(await longLocation.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    pass('registration and latest-login details retain all three IPPure fields and override shared cache');
    await row('beta').getByText('中国-广东省-深圳市', { exact: true }).waitFor();
    await row('beta').getByText('中国-北京市-北京市', { exact: true }).waitFor();
    assert.doesNotMatch(await row('beta').innerText(), /浙江|California/);
    pass('two users with identical IPs retain their own locations');
    assert.equal(await row('cache_only').getByText('United Kingdom-England-London', { exact: true }).count(), 2);
    pass('old clients without reports retain authoritative cache formatted as country-region-city');
    await row('missing').getByText('暂未识别', { exact: true }).waitFor();
    await row('missing').getByText('暂无记录', { exact: true }).waitFor();
    assert.doesNotMatch(await row('missing').innerText(), /错误缓存/);
    await row('old_backend').getByText('旧版归属地', { exact: true }).waitFor();
    pass('failed lookups and missing IPs remain distinct, and legacy per-user text has priority');
    await page.screenshot({ path: path.join(output, 'user-locations.png') });
    const input = page.locator('.filters input').first();
    await input.fill('held'); await page.getByRole('button', { name: '查询', exact: true }).click();
    await row('held_user').waitFor();
    await input.fill('replacement'); await page.getByRole('button', { name: '查询', exact: true }).click();
    await row('alpha').getByText('中国-浙江省-杭州市', { exact: true }).waitFor();
    release();
    await page.getByText('正在读取 IP 归属地…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await row('held_user').count(), 0);
    assert.doesNotMatch(await row('alpha').innerText(), /错误缓存/);
    pass('replaced user queries and late IP lookups cannot overwrite current per-user details');
    assert.ok(requests.filter(item => item.endpoint.startsWith('/admin/')).every(item => item.entry_header));
    assert.ok(requests.filter(item => item.endpoint !== '/admin/auth/login').every(item => item.method === 'GET'));
    assert.deepEqual(errors, []);
    pass('location reads retain admin authorization and never look up the administrator as another user');
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: checks.length, checks, errors, requests, production_connected: false }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, output }));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors, requests }, null, 2));
    throw error;
  } finally { release(); await browser?.close(); await server?.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
