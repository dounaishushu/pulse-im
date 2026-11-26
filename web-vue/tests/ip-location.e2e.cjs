// Real Vue workspace and Go-v2 adapter against isolated HTTP fixtures.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = path.resolve(process.env.PULSE_GROUP_TEST_OUTPUT || path.join(repo, '.local/ip-location-ui'));
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';
const self = uuid(1), first = uuid(9000), second = uuid(9001);
const model = { staff: true, denied: false, held: null, online: true, hidePresence: false, longProfile: false, requests: [], profileQueries: [] };
const person = n => ({ id: uuid(n), account: model.longProfile ? 'account' + 'x'.repeat(90) : 'peer' + n, nickname: model.longProfile ? '较长的联系人昵称'.repeat(6) : n === 1 ? '内部人员' : n === 2 ? '测试联系人' : '另一位联系人', public_id: model.longProfile ? 'ID' + 'y'.repeat(128) : 'ID' + n, avatar_id: '', is_contact: n !== 1, internal_staff: n === 1 && model.staff, online: n === 2 && model.online, last_seen: model.hidePresence ? null : '2026-11-21T21:22:32Z', version: '1', contact_version: '1' });
const summary = (id, peer) => ({ id, kind: 'direct', title: person(peer).nickname, peer_id: uuid(peer), peer_name: person(peer).nickname, my_role: 'member', membership_version: '1', preference_version: '1', can_send: true, visible_from_seq: '1', message_seq: '0', event_seq: '0', unread_count: '0', updated_at: '2026-11-21T21:22:32Z', state: { clear_seq: '0', read_seq: '0', delivered_seq: '0', personal_seq: '0', version: '1' } });
const rows = () => [summary(first, 2), summary(second, 3)];
const location = (province, city, district = '') => ({ country: '中国', province, city, district, source: 'ippure', reported: true });
const details = n => model.offline ? {
  id: uuid(n), nickname: person(n).nickname, public_id: 'ID' + n,
  registration_ip: model.missingRegistration ? '' : '117.5.147.45', registration_ip_location_status: model.missingRegistration ? 'no_ip' : 'offline',
  registration_ip_location_detail: model.missingRegistration ? null : { country: 'Viet Nam', province: 'Hanoi', city: 'Hanoi', district: '', source: 'offline', reported: false, database_version: 'ip2region v3.19.0' },
  logins: [{ ip: '223.67.221.190', created_at: '2026-11-21T15:35:26Z', platform: 'web', device_name: 'Web', location_status: 'offline',
    location_detail: { country: '中国', province: '江苏省', city: '连云港市', district: '', source: 'offline', reported: false, database_version: 'ip2region v3.19.0' } }],
} : ({ id: uuid(n), nickname: person(n).nickname, public_id: 'ID' + n, registration_ip: '8.8.8.8', registration_ip_location_detail: location('浙江省', '杭州市', '西湖区'), registration_ip_location_status: 'reported',
  logins: [{ ip: n === 2 ? '7.7.7.7' : '9.9.9.9', created_at: '2026-11-21T15:35:26Z', platform: 'android', device_name: model.longProfile ? '测试设备' + 'z'.repeat(90) : '测试手机', location_detail: n === 2 ? location('广东省', '深圳市', model.longProfile ? '较长的区县名称'.repeat(12) : '') : location('江苏省', '南京市', '鼓楼区'), location_status: 'reported' }] });
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
  await page.addInitScript(() => {
    window.profileCopies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.profileCopies.push(value); } } });
  });
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
    } else if (/^\/profiles\/[^/]+$/.test(p)) { model.profileQueries.push({ path: p, query: url.search }); data = person(Number(p.split('/').at(-1).slice(0, 8))); }
    else if (p.endsWith('/common-groups')) data = { items: [] };
    else if (p.endsWith('/unread')) data = { count: '0', truncated: false };
    else if (p === '/conversations/direct' && method === 'POST') { assert.equal(request.postDataJSON().peer_id, uuid(2)); data = { id: first }; }
    else if (/\/(read|delivered)$/.test(p)) data = { version: '1', reminder: false };
    else if (p.endsWith('/history')) data = { items: [], membership_version: '1', snapshot_max_seq: '0', next_after_seq: '0', next_before_seq: '0', visible_from_seq: '1', clear_seq: '0', has_more: false };
    else if (/\/(personal-sync|sync)$/.test(p)) data = { items: [], events: [], membership_version: '1', snapshot_max_seq: '0', next_after_seq: '0', visible_from_seq: '1', has_more: false };
    else if (/^\/conversations\/[^/]+$/.test(p)) data = rows().find(row => row.id === p.split('/').at(-1));
    await route.fulfill({ status, json: data });
  });
  const network = () => page.locator('.conversation-peer-network');
  const headerAvatar = () => page.locator('.conversation-profile-avatar');
  const choose = id => page.evaluate(async id => { const { chat, client } = window.groupFixture; await chat.choose(client.local('conversation', id)); }, id);
  try {
    await page.goto(origin + '/__ip-location-test');
    await network().getByText('IP：7.7.7.7 · 归属地：中国-广东省-深圳市', { exact: true }).waitFor();
    assert.match(await network().getAttribute('title'), /最近成功登录.*IPPure/s);
    assert.equal(model.requests.filter(p => p.startsWith('/staff/users/')).length, 1);
    pass('the authorized direct-chat header displays the latest login IP and actual IPPure province/city without inventing a district');
    await headerAvatar().click();
    const profile = page.getByRole('dialog', { name: '个人资料', exact: true });
    const audit = () => profile.getByRole('region', { name: '登录与注册信息', exact: true });
    await audit().waitFor();
    await profile.getByRole('heading', { name: '测试联系人', exact: true }).waitFor();
    assert.deepEqual(model.profileQueries, [{ path: '/profiles/' + uuid(2), query: '' }]);
    assert.equal(model.requests.filter(p => p === '/conversations/direct').length, 0);
    pass('clicking the direct-chat header avatar opens that peer profile through the existing private-profile permission path without creating a chat');
    await profile.locator('dd').getByText('中国-广东省-深圳市', { exact: true }).waitFor();
    await profile.locator('dd').getByText('中国-浙江省-杭州市', { exact: true }).waitFor();
    assert.match(await profile.locator('dd').filter({ hasText: '中国-广东省-深圳市' }).getAttribute('title'), /IPPure/);
    await page.screenshot({ path: path.join(output, 'profile-locations.png') });
    assert.deepEqual(await audit().locator('dt').allTextContents(), ['登录设备', '注册 IP 地址', '注册归属地', '登录 IP 地址', '登录归属地', '最近登录']);
    assert.equal(await audit().getByText('安卓 · 测试手机', { exact: true }).count(), 1);
    assert.equal(await profile.locator('.contact-profile-presence[data-state="online"]').textContent(), '在线');
    const layout = await profile.evaluate(el => {
      const box = selector => el.querySelector(selector).getBoundingClientRect();
      return { head: box('.contact-profile-head').bottom, remark: box('input[aria-label="备注"]').top,
        identities: box('.contact-profile-details').top, group: box('input[aria-label="好友分组"]').top,
        audit: box('.contact-audit').top, button: { width: box('.contact-profile-actions button').width }, footer: { width: box('.vue-dialog-footer').width },
        rightAligned: [...el.querySelectorAll('.contact-profile-identity')].every(dd => getComputedStyle(dd).justifyContent === 'flex-end') };
    });
    assert.ok(layout.head < layout.remark && layout.remark < layout.identities && layout.identities < layout.group && layout.group < layout.audit);
    assert.equal(layout.rightAligned, true);
    assert.ok(Math.abs(layout.button.width - layout.footer.width + 24) < 2);
    assert.equal(await profile.getByRole('button', { name: '发送申请', exact: true }).count(), 0);
    pass('the profile follows the reference order, places actual presence beside the name, expands staff details and keeps a full-width primary footer');
    for (const name of ['复制账号', '复制用户 ID', '复制注册 IP 地址', '复制登录 IP 地址']) await profile.getByRole('button', { name, exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.profileCopies), ['peer2', 'ID2', '8.8.8.8', '7.7.7.7']);
    await profile.getByText('已复制登录 IP 地址', { exact: true }).waitFor();
    pass('account, public ID, registration IP and login IP copy the exact respective values without touching the operating-system clipboard in tests');
    await page.evaluate(() => { window.groupFixture.chat.locked.value = true; });
    assert.equal(await headerAvatar().isDisabled(), true);
    assert.equal(await audit().count(), 0);
    assert.equal(await profile.getByRole('button', { name: '复制登录 IP 地址', exact: true }).count(), 0);
    assert.equal(await profile.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true);
    await page.evaluate(() => { window.groupFixture.chat.locked.value = false; window.groupFixture.chat.me.value = { ...window.groupFixture.chat.me.value, internal_staff: false }; });
    assert.equal(await audit().count(), 0);
    await page.evaluate(() => { window.groupFixture.chat.me.value = { ...window.groupFixture.chat.me.value, internal_staff: true }; });
    await profile.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await headerAvatar().evaluate(el => document.activeElement === el), true);
    await headerAvatar().press('Enter'); await audit().waitFor();
    await profile.getByRole('heading', { name: '测试联系人', exact: true }).waitFor();
    await profile.press('Escape'); await profile.waitFor({ state: 'hidden' });
    assert.equal(await headerAvatar().evaluate(el => document.activeElement === el), true);
    pass('the avatar supports keyboard Enter, restores focus when the profile closes and is disabled while the app is locked');
    model.online = false;
    await page.getByRole('button', { name: '资料', exact: true }).click();
    await profile.locator('.contact-profile-presence[data-state="offline"]').waitFor();
    assert.match(await profile.locator('.contact-profile-presence').getAttribute('title'), /最近在线/);
    await profile.getByRole('button', { name: '关闭', exact: true }).click();
    model.hidePresence = true;
    await page.getByRole('button', { name: '资料', exact: true }).click();
    await profile.locator('.contact-profile-presence[data-state="hidden"]').getByText('最近上线已隐藏', { exact: true }).waitFor();
    assert.equal(await profile.locator('.contact-profile-presence[data-state="online"], .contact-profile-presence[data-state="offline"]').count(), 0);
    await profile.getByRole('button', { name: '关闭', exact: true }).click();
    model.hidePresence = false; model.online = true;
    pass('the profile respects offline and hidden-presence states and removes all staff fields and IP copy actions immediately on lock or role revocation');
    pass('personal details use country-region-city consistently and keep login and registration addresses separate');
    let release;
    await choose(second); await network().getByText(/9\.9\.9\.9/).waitFor();
    await headerAvatar().press('Space'); await audit().waitFor();
    await profile.getByRole('heading', { name: '另一位联系人', exact: true }).waitFor();
    assert.deepEqual(model.profileQueries.at(-1), { path: '/profiles/' + uuid(3), query: '' });
    assert.equal(await audit().getByText('9.9.9.9', { exact: true }).count(), 1);
    await profile.getByRole('button', { name: '关闭', exact: true }).click();
    pass('after switching conversations the keyboard Space action opens the new peer profile and never reuses the previous user or a group/card context');
    model.held = new Promise(ok => { release = ok; });
    const before = model.requests.length;
    await choose(first); await waitFor(() => model.requests.slice(before).includes('/staff/users/' + uuid(2)));
    await choose(second); await network().getByText(/9\.9\.9\.9/).waitFor();
    release(); model.held = null; await page.waitForTimeout(200);
    assert.match(await network().innerText(), /9\.9\.9\.9.*中国-江苏省-南京市/);
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
    await headerAvatar().click();
    await profile.getByRole('textbox', { name: '备注', exact: true }).waitFor();
    await waitFor(async () => await profile.getByRole('textbox', { name: '备注', exact: true }).isEnabled());
    assert.equal(await audit().count(), 0);
    assert.equal(await profile.getByRole('button', { name: /复制.*IP 地址/ }).count(), 0);
    assert.equal(model.requests.slice(beforeOrdinary).some(p => p.startsWith('/staff/users/')), false);
    assert.doesNotMatch(await profile.innerText(), /7\.7\.7\.7|8\.8\.8\.8|登录设备|最近登录/);
    await profile.getByRole('button', { name: '关闭', exact: true }).click();
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
    model.longProfile = true;
    await headerAvatar().click(); await audit().waitFor();
    const primary = profile.getByRole('button', { name: '发送消息', exact: true });
    const beforeScroll = await primary.boundingBox();
    await profile.locator('.vue-dialog-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const afterScroll = await primary.boundingBox(), bounds = await profile.boundingBox();
    assert.deepEqual(afterScroll, beforeScroll);
    assert.ok(bounds.width <= 716 && bounds.height <= 536 && afterScroll.y + afterScroll.height <= 548);
    assert.equal(await profile.evaluate(el => el.scrollWidth <= el.clientWidth && el.querySelector('.vue-dialog-body').scrollWidth <= el.querySelector('.vue-dialog-body').clientWidth), true);
    await page.screenshot({ path: path.join(output, 'profile-small-window-long-values.png') });
    pass('long names, IDs, devices and district strings wrap inside the minimum PC window while the primary action remains fixed and reachable');
    await primary.click(); await profile.waitFor({ state: 'hidden' });
    assert.equal(model.requests.filter(p => p === '/conversations/direct').length, 1);
    pass('the relocated primary action still opens the correct direct conversation and closes the profile');
    model.longProfile = false; model.offline = true;
    await page.setViewportSize({ width: 1180, height: 800 });
    await choose(second); await choose(first);
    await network().getByText('IP：223.67.221.190 · 归属地：中国-江苏省-连云港市', { exact: true }).waitFor();
    assert.match(await network().getAttribute('title'), /离线 IP 库.*ip2region v3\.19\.0/);
    await headerAvatar().click(); await audit().waitFor();
    await audit().getByText('Web', { exact: true }).waitFor();
    await audit().getByText('中国-江苏省-连云港市', { exact: true }).waitFor();
    await audit().getByText('Viet Nam-Hanoi-Hanoi', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'offline-profile-and-header.png') });
    pass('legacy Web and historical registration addresses display offline province/city consistently in the actual header and profile, with visible source and no invented district');
    await profile.getByRole('button', { name: '关闭', exact: true }).click();
    model.missingRegistration = true;
    await headerAvatar().click(); await audit().waitFor();
    await audit().getByText('中国-江苏省-连云港市', { exact: true }).waitFor();
    const registration = await audit().evaluate(el => [...el.querySelectorAll('dt')].filter(dt => /^注册/.test(dt.textContent)).map(dt => dt.nextElementSibling.textContent.trim()));
    assert.deepEqual(registration, ['暂无记录', '暂无记录']);
    await profile.getByRole('button', { name: '关闭', exact: true }).click();
    pass('an absent registration address stays absent and is never copied from the known login IP');
    model.offline = false;
    await choose(second); await choose(first);
    await network().getByText('IP：7.7.7.7 · 归属地：中国-广东省-深圳市', { exact: true }).waitFor();
    assert.match(await network().getAttribute('title'), /IPPure/);
    assert.doesNotMatch(await network().innerText(), /离线库/);
    pass('later IPPure data replaces the fallback in the conversation view without retaining an offline source label');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, requests: model.requests, profileQueries: model.profileQueries }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, output }));
  } finally { await browser?.close(); await server?.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
