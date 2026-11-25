// Real workspace, Go adapter and notification settings; synthetic accounts/HTTP only.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = process.env.PULSE_MUTED_UNREAD_TEST_OUTPUT || path.join(repo, '.local/muted-unread-ui');
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';
const models = [
  { n: 9000, kind: 'group', title: '正常群聊', unread: 7 },
  { n: 10100, kind: 'direct', peer: 100, title: '私聊甲', unread: 3 },
  { n: 10004, kind: 'direct', peer: 4, title: '私聊乙', unread: 2 },
  { n: 9001, kind: 'group', title: '已关闭通知的群聊', unread: 40, muted: true },
  { n: 10101, kind: 'direct', peer: 101, title: '已关闭通知的私聊', unread: 30, muted: true },
  { n: 9002, kind: 'channel', title: '已关闭通知的频道', unread: 20, muted: true },
  { n: 10102, kind: 'direct', peer: 102, title: '已隐藏的私聊', unread: 50, hidden: true },
].map(row => ({ muted: false, preference: 1, ...row }));
const summary = row => ({ id: uuid(row.n), kind: row.kind, title: row.title, peer_id: row.peer ? uuid(row.peer) : undefined,
  peer_name: row.title, my_role: 'owner', can_send: true, owner_id: uuid(1), member_count: 2, member_limit: 500,
  muted_notifications: row.muted, hidden: row.hidden, membership_version: '1', preference_version: String(row.preference),
  visible_from_seq: '1', message_seq: '0', event_seq: '0', unread_count: String(row.unread), updated_at: '2026-11-25T12:00:00Z',
  state: { clear_seq: '0', read_seq: '0', delivered_seq: '0', personal_seq: '0', version: '1' } });
const checks = [], errors = [], requests = [];
let server, browser, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
(async () => {
  fs.mkdirSync(output, { recursive: true }); process.chdir(root);
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', cacheDir: path.join(output, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
    plugins: [{ name: 'muted-unread-fixture', configureServer(vite) {
      vite.middlewares.use('/__muted-unread', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/group-chat-fixture.ts"></script></html>');
      });
    } }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1180, height: 900 } }); page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('pulse_setting_unread_include_muted', '1'); });
  await page.route('**/api/v2/**', async route => {
    const request = route.request(), p = new URL(request.url()).pathname.replace('/api/v2', ''), body = request.postDataJSON();
    requests.push({ path: p, method: request.method(), body });
    const match = p.match(/^\/(conversations|groups)\/([^/]+)(.*)$/), row = match && models.find(item => uuid(item.n) === match[2]);
    let data = { items: [] };
    if (p === '/me' || p === '/me/profile') data = { id: uuid(1), user_id: uuid(1), account: 'unread-self', nickname: '我', version: '1', internal_staff: true };
    else if (p === '/client/config') data = { registration: {}, display: {}, releases: {} };
    else if (p === '/client/update') data = { required: false };
    else if (p === '/client/conversation-page' || p === '/conversations') data = { items: models.map(summary), total: models.length, page: 1, size: 100 };
    else if (p === '/client/conversation-updates') data = { items: models.filter(item => body.conversation_ids.includes(uuid(item.n))).map(summary), removed_ids: [], incremental: true };
    else if (p === '/client/friend-page') data = { items: [], total: 0, page: 1, size: 100 };
    else if (row && match[3] === '/preferences') {
      assert.equal(request.method(), 'PATCH'); assert.equal(body.expected_version, String(row.preference));
      assert.deepEqual(Object.keys(body).sort(), ['expected_version', 'muted_notifications']);
      row.muted = body.muted_notifications; row.preference++; data = summary(row);
    }
    else if (row && (!match[3] || match[3] === '/open')) data = summary(row);
    else if (p.endsWith('/member-profiles')) data = { items: [1, 2].map(n => ({ id: uuid(n), account: 'test' + n, nickname: '用户' + n, role: n === 1 ? 'owner' : 'member' })), next_after: '', query: '', search_scope: 'group', members_visibility: 'all' };
    else if (p.endsWith('/history')) data = { items: [], membership_version: '1', snapshot_max_seq: '0', next_after_seq: '0', next_before_seq: '0', visible_from_seq: '1', clear_seq: '0', has_more: false };
    else if (p.endsWith('/sync') || p.endsWith('/personal-sync')) data = { events: [], membership_version: '1', snapshot_max_seq: '0', next_after_seq: '0', visible_from_seq: '1', clear_seq: '0', has_more: false };
    else if (p.endsWith('/unread')) data = { count: String(row?.unread || 0), truncated: false };
    else if (/\/(read|delivered)$/.test(p)) data = { version: '1', reminder: false };
    await route.fulfill({ json: data }).catch(() => {});
  });
  const fresh = async () => {
    await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__muted-unread');
    await page.waitForFunction(() => window.groupFixture?.chat.active.value && !window.groupFixture.chat.loading.value);
    assert.equal(await page.evaluate(() => window.groupFixture.chat.openingError.value), '');
    await page.evaluate(() => { window.groupFixture.detached.value = false; });
    await page.getByRole('button', { name: '消息', exact: true }).waitFor();
  };
  const allBadge = () => page.getByRole('navigation', { name: '会话分类', exact: true }).getByRole('button', { name: /^全部/ }).locator('.unread');
  const railBadge = () => page.getByRole('button', { name: '消息', exact: true }).locator('.unread');
  const total = async expected => {
    await page.waitForFunction(n => window.groupFixture.chat.totalUnread.value === n, expected);
    for (const badge of [allBadge(), railBadge()]) {
      if (expected) assert.equal(await badge.textContent(), String(expected));
      else assert.equal(await badge.count(), 0);
    }
  };
  const reloadDirectory = () => page.evaluate(() => window.groupFixture.chat.loadDirectory());
  const conversationRow = async n => {
    const local = await page.evaluate(id => window.groupFixture.client.local('conversation', id), uuid(n));
    return page.locator(`.conversation-row[data-conversation-id="${local}"]`);
  };
  const mute = async (n, value) => {
    const row = await conversationRow(n); await row.click({ button: 'right' });
    await page.getByRole('group', { name: '会话操作', exact: true }).getByRole('button', { name: value ? '关闭消息通知' : '开启消息通知', exact: true }).click();
    await page.waitForFunction(({ id, muted }) => window.groupFixture.chat.conversations.value.find(c => c._go_wire_id === id)?.notifications_muted === muted, { id: uuid(n), muted: value });
  };
  const preference = async (key, value) => page.evaluate(({ key, value }) => {
    if (value === null) localStorage.removeItem('pulse_setting_' + key);
    else localStorage.setItem('pulse_setting_' + key, value);
    window.dispatchEvent(new Event('pulse:preferences'));
  }, { key, value });
  try {
    await fresh(); await total(12);
    pass('existing muted private chats, groups, channels and hidden conversations are excluded from both totals even with the old include-muted preference enabled');
    await mute(10100, true); await total(9);
    assert.equal(models[1].unread, 3);
    pass('right-click disabling private-chat notifications immediately removes its unread contribution without marking it read');
    await mute(9000, true); await total(2);
    assert.equal(await (await conversationRow(9000)).locator('.unread').count(), 0);
    pass('right-click disabling group notifications follows the same rule; only the remaining unmuted private chat contributes');
    const readBefore = requests.filter(r => /\/(read|delivered)$/.test(r.path)).length;
    models[0].unread = 12; models[1].unread = 8;
    await reloadDirectory(); await total(2);
    const stored = await page.evaluate(() => window.groupFixture.chat.conversations.value.map(row => [row._go_wire_id, row.unread_count]));
    assert.equal(new Map(stored).get(uuid(9000)), 12); assert.equal(new Map(stored).get(uuid(10100)), 8);
    assert.equal(requests.filter(r => /\/(read|delivered)$/.test(r.path)).length, readBefore);
    pass('new messages in muted groups and private chats preserve actual unread data without increasing totals or sending read acknowledgements');
    for (const value of [null, '0', '1']) { await preference('unread_include_muted', value); await total(2); }
    pass('absent, disabled and enabled legacy include-muted values all use the same notification-switch rule');
    await fresh(); await total(2);
    pass('restarting the workspace restores the exclusion for already-muted conversations without a data migration');
    await preference('unread_message_count', '0'); await total(1);
    pass('conversation-count mode counts only unmuted conversations with unread messages');
    await mute(10100, false); await total(2);
    assert.equal(new Map(stored).get(uuid(10100)), 8);
    pass('enabling private-chat notifications restores its accumulated unread contribution in conversation-count mode');
    await mute(9000, false); await total(3);
    pass('enabling group notifications restores its contribution while unrelated muted conversations remain excluded');
    await page.evaluate(() => { window.groupFixture.chat.panel.value = 'settings'; });
    await page.getByRole('navigation', { name: '设置分类', exact: true }).getByRole('button', { name: '通知', exact: true }).click();
    assert.equal(await page.getByRole('checkbox', { name: '包含已关闭通知的私聊', exact: true }).count(), 0);
    await page.getByRole('checkbox', { name: '按消息数统计未读', exact: true }).check(); await total(22);
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    pass('notification settings remove the contradictory include-muted option while the message/conversation count switch still works');
    await mute(9000, true); await mute(10100, true); await mute(10004, true); await total(0);
    await page.screenshot({ path: path.join(output, 'all-muted-no-total.png') });
    pass('when all unread conversations have notifications disabled, both All and Messages badges disappear');
    models[2].unread = 0; await mute(10004, false); await total(0);
    await preference('unread_message_count', '0'); await total(0);
    pass('an unmuted conversation with zero unread messages is not added in either count mode');
    models[2].unread = 2; await reloadDirectory(); await total(1);
    await page.evaluate(() => { localStorage.setItem('pulse_setting_unread_include_muted', '1'); window.dispatchEvent(new StorageEvent('storage', { key: 'pulse_setting_unread_include_muted', newValue: '1' })); });
    await total(1);
    pass('a preference storage event from another window cannot reintroduce muted conversations');
    await preference('unread_message_count', '1'); await total(2);
    await page.screenshot({ path: path.join(output, 'only-unmuted-counted.png') });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: true, checks, errors, production_requests: 0, read_requests: requests.filter(r => /\/(read|delivered)$/.test(r.path)), preferences: requests.filter(r => r.path.endsWith('/preferences')) }, null, 2));
  } catch (error) { await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
  finally { await browser?.close(); await server?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
