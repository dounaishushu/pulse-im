// Real Vue workspace and Go-v2 adapter against isolated HTTP fixtures.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = path.resolve(process.env.PULSE_GROUP_TEST_OUTPUT || path.join(repo, '.local/ip-location-ui'));
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';
const self = uuid(1), first = uuid(9000), second = uuid(9001);
const model = { staff: true, denied: false, held: null, requests: [] };
const person = n => ({ id: uuid(n), account: 'peer' + n, nickname: n === 1 ? '内部人员' : n === 2 ? '测试联系人' : '另一位联系人', public_id: 'ID' + n, avatar_id: '', is_contact: n !== 1, internal_staff: n === 1 && model.staff, online: false, last_seen_at: '2026-11-21T21:22:32Z', version: '1', contact_version: '1' });
const summary = (id, peer) => ({ id, kind: 'direct', title: person(peer).nickname, peer_id: uuid(peer), peer_name: person(peer).nickname, my_role: 'member', membership_version: '1', preference_version: '1', can_send: true, visible_from_seq: '1', message_seq: '0', event_seq: '0', unread_count: '0', updated_at: '2026-11-21T21:22:32Z', state: { clear_seq: '0', read_seq: '0', delivered_seq: '0', personal_seq: '0', version: '1' } });
const rows = () => [summary(first, 2), summary(second, 3)];
const location = (province, city, district = '') => ({ country: '中国', province, city, district, source: 'ippure', reported: true });
const details = n => ({ id: uuid(n), nickname: person(n).nickname, public_id: 'ID' + n, registration_ip: '8.8.8.8', registration_ip_location_detail: location('浙江省', '杭州市', '西湖区'), registration_ip_location_status: 'reported',
  logins: [{ ip: n === 2 ? '7.7.7.7' : '9.9.9.9', created_at: '2026-11-21T15:35:26Z', platform: 'android', device_name: '测试手机', location_detail: n === 2 ? location('广东省', '深圳市') : location('江苏省', '南京市', '鼓楼区'), location_status: 'reported' }] });
const checks = [], errors = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
async function waitFor(test) { for (let n = 0; n < 200; n++) { if (await test()) return; await new Promise(ok => setTimeout(ok, 40)); } throw Error('condition did not become true'); }
let server, browser, page;
(async () => {
  fs.mkdirSync(output, { recursive: true }); process.chdir(root);
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
    plugins: [{ name: 'ip-location-fixture', configureServer(vite) { vite.middlewares.use('/__ip-location-test', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/group-chat-fixture.ts"></script></html>');
    }); } }],
  });
  await server.listen(); const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1180, height: 800 } }); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v2/**', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname.replace('/api/v2', ''), method = request.method();
    model.requests.push(p); let data = { items: [] }, status = 200;
    if (p === '/me' || p === '/me/profile') data = { ...person(1), user_id: self };
    else if (p === '/client/config') data = { registration: {}, display: {}, releases: {} };
    else if (p === '/client/update') data = { required: false };
    else if (p === '/client/friend-page') data = { items: [person(2), person(3)], total: 2, page: 1, size: 100 };
    else if (p === '/client/conversation-page' || p === '/conversations') data = { items: rows(), total: 2, page: 1, size: 100 };
    else if (p === '/client/conversation-updates') data = { items: rows(), removed_ids: [], incremental: true };
    else if (p === '/client/network-observation') data = method === 'GET' ? { ippure_url: '' } : { recorded: true };
    else if (p.startsWith('/staff/users/')) {
      if (!model.staff || model.denied) { status = 403; data = { error: { code: 'forbidden' } }; }
      else {
        const n = Number(p.split('/').at(-1).slice(0, 8)); data = details(n);
        if (n === 2 && model.held) await model.held;
      }
    } else if (/^\/profiles\/[^/]+$/.test(p)) data = person(Number(p.split('/').at(-1).slice(0, 8)));
    else if (p.endsWith('/common-groups')) data = { items: [] };
    else if (p.endsWith('/unread')) data = { count: '0', truncated: false };
    else if (/\/(read|delivered)$/.test(p)) data = { version: '1', reminder: false };
    else if (p.endsWith('/history')) data = { items: [], membership_version: '1', snapshot_max_seq: '0', next_after_seq: '0', next_before_seq: '0', visible_from_seq: '1', clear_seq: '0', has_more: false };
    else if (/\/(personal-sync|sync)$/.test(p)) data = { items: [], events: [], membership_version: '1', snapshot_max_seq: '0', next_after_seq: '0', visible_from_seq: '1', has_more: false };
    else if (/^\/conversations\/[^/]+$/.test(p)) data = rows().find(row => row.id === p.split('/').at(-1));
    await route.fulfill({ status, json: data });
  });
  const network = () => page.locator('.conversation-peer-network');
  const choose = id => page.evaluate(async id => { const { chat, client } = window.groupFixture; await chat.choose(client.local('conversation', id)); }, id);
  try {
    await page.goto(origin + '/__ip-location-test');
    await network().getByText('IP：7.7.7.7 · 归属地：广东省-深圳市（区县未提供）', { exact: true }).waitFor();
    assert.match(await network().getAttribute('title'), /最近成功登录.*IPPure/s);
    assert.equal(model.requests.filter(p => p.startsWith('/staff/users/')).length, 1);
    pass('the authorized direct-chat header displays the latest login IP and actual IPPure province/city without inventing a district');
    await page.getByRole('button', { name: '资料', exact: true }).click();
    const profile = page.getByRole('dialog', { name: '个人资料', exact: true });
    await profile.getByText('登录与注册信息', { exact: true }).click();
    await profile.locator('dd').getByText('广东省-深圳市（区县未提供）', { exact: true }).waitFor();
    await profile.locator('dd').getByText('浙江省-杭州市-西湖区', { exact: true }).waitFor();
    assert.match(await profile.locator('dd').getByText('广东省-深圳市（区县未提供）', { exact: true }).getAttribute('title'), /IPPure/);
    await page.screenshot({ path: path.join(output, 'profile-locations.png') });
    await profile.getByRole('button', { name: '关闭', exact: true }).click();
    pass('personal details use the same formatting and keep login and registration addresses and districts separate');
    let release;
    await choose(second); await network().getByText(/9\.9\.9\.9/).waitFor();
    model.held = new Promise(ok => { release = ok; });
    const before = model.requests.length;
    await choose(first); await waitFor(() => model.requests.slice(before).includes('/staff/users/' + uuid(2)));
    await choose(second); await network().getByText(/9\.9\.9\.9/).waitFor();
    release(); model.held = null; await page.waitForTimeout(200);
    assert.match(await network().innerText(), /9\.9\.9\.9.*江苏省-南京市-鼓楼区/);
    assert.doesNotMatch(await network().innerText(), /7\.7\.7\.7/);
    pass('a delayed lookup from the previous conversation cannot replace the current user IP or location');
    await page.evaluate(() => { const chat = window.groupFixture.chat; chat.locked.value = true; });
    await network().waitFor({ state: 'hidden' });
    await page.evaluate(() => { const chat = window.groupFixture.chat; chat.locked.value = false; });
    await network().getByText(/9\.9\.9\.9/).waitFor();
    await page.evaluate(() => { const chat = window.groupFixture.chat; chat.me.value = { ...chat.me.value, internal_staff: false }; });
    await network().waitFor({ state: 'hidden' });
    pass('locking the application or revoking internal-staff status clears the displayed IP immediately');
    model.staff = false;
    const beforeOrdinary = model.requests.length;
    await page.reload(); await page.locator('.conversation-heading h2').getByText('测试联系人', { exact: true }).waitFor();
    assert.equal(await network().count(), 0);
    assert.equal(model.requests.slice(beforeOrdinary).some(p => p.startsWith('/staff/users/')), false);
    pass('ordinary users neither see IP audit data nor request the staff endpoint');
    model.staff = true; model.denied = true;
    await page.reload(); await page.locator('.conversation-heading h2').getByText('测试联系人', { exact: true }).waitFor();
    await waitFor(() => model.requests.at(-1) === '/staff/users/' + uuid(2) || model.requests.includes('/staff/users/' + uuid(2)));
    await page.waitForTimeout(150); assert.equal(await network().count(), 0);
    assert.equal(model.requests.some(p => p.startsWith('/public-users/')), false);
    pass('a denied staff lookup stays hidden without falling back to public profile discovery');
    model.denied = false; await page.reload(); await network().getByText(/7\.7\.7\.7/).waitFor();
    await page.setViewportSize({ width: 740, height: 560 });
    assert.equal(await page.locator('.chat-head').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({ path: path.join(output, 'chat-header-small.png') });
    pass('IP and location remain readable or truncated with a full tooltip in the minimum PC window without horizontal overflow');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, requests: model.requests }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, output }));
  } finally { await browser?.close(); await server?.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
