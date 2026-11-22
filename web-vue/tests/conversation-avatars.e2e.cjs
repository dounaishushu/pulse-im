// Real conversation rows/header, useChat and Go adapter; all HTTP data is local.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = path.resolve(process.env.PULSE_AVATAR_TEST_OUTPUT || path.join(repo, '.local/conversation-avatars-ui'));
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';
const gid = uuid(9000), media = n => uuid(30000 + n), cid = n => uuid(10000 + n);
const checks = [], errors = [], scenarios = [];
let server, browser, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function readyImage(locator) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await locator.count() && await locator.evaluate(img => img.complete && img.naturalWidth > 0)) return;
    await wait(40);
  }
  assert.fail('avatar did not finish loading: ' + locator);
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  process.chdir(root);
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
    plugins: [{ name: 'conversation-avatars-fixture', configureServer(vite) {
      vite.middlewares.use('/__conversation-avatars-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/group-chat-fixture.ts"></script></html>');
      });
    } }],
  });
  await server.listen();
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });

  async function setup(options = {}) {
    const model = { count: 40, expired: false, denied: new Set(), groupAvatar: '', ...options,
      requests: [], issued: new Map(), nonce: 0, active: 0, maxActive: 0 };
    scenarios.push(model);
    const rows = () => [summary(gid, 0), ...Array.from({ length: model.count }, (_, i) => summary(cid(i + 2), i + 2)), summary(cid(99), 99)];
    function summary(id, n) {
      return { id, kind: n ? 'direct' : 'group', title: n ? '' : '头像测试群',
        peer_id: n ? uuid(n) : undefined, peer_name: n ? '联系人' + n : undefined,
        avatar_id: n === 99 ? '' : n ? media(n) : model.groupAvatar, my_role: 'owner',
        can_send: true, membership_version: '1', preference_version: '1', message_seq: '0', event_seq: '0',
        unread_count: '0', visible_from_seq: '1', member_count: 0, updated_at: '2026-11-23T00:00:00Z',
        state: { clear_seq: '0', read_seq: '0', delivered_seq: '0', personal_seq: '0', version: '1' } };
    }
    function grant(id, fresh) {
      const key = (++model.nonce).toString(16).padStart(64, '0');
      model.issued.set(key, { id, fresh });
      return { content_path: '/api/v2/media-grants/' + key + '/content', expires_in: 120 };
    }
    const context = await browser.newContext({ viewport: { width: 1180, height: 800 } });
    page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v2/**', async route => {
      const request = route.request(), url = new URL(request.url()), p = url.pathname.replace('/api/v2', '');
      const body = request.postDataJSON(), method = request.method();
      model.requests.push({ path: p, method });
      let data = { items: [] }, status = 200;
      if (p === '/me' || p === '/me/profile') data = { id: uuid(1), user_id: uuid(1), account: 'self', nickname: '自己', avatar_id: '', version: '1', internal_staff: false };
      else if (p === '/client/update') data = { required: false };
      else if (p.endsWith('/unread')) data = { count: '0', truncated: false };
      else if (p === '/client/conversation-page') data = { items: rows(), page: 1, size: 100, total: rows().length };
      else if (p === '/client/conversation-updates') data = { items: rows().filter(row => body.conversation_ids.includes(row.id)), removed_ids: [], incremental: true };
      else if (p === '/client/conversation-presence') data = { items: [], removed_ids: [] };
      else if (p === '/media/grants') data = { items: body.media_ids.map(id => model.denied.has(id)
        ? { id, error: { code: 'forbidden', status: 403 } } : { id, access: grant(id, false) }) };
      else if (/^\/media\/[^/]+\/grants$/.test(p)) {
        const id = p.split('/')[2];
        model.active++; model.maxActive = Math.max(model.maxActive, model.active);
        await wait(120); model.active--;
        if (model.denied.has(id)) { status = 403; data = { error: { code: 'forbidden' } }; }
        else data = grant(id, true);
      } else if (p.startsWith('/media-grants/')) {
        const access = model.issued.get(p.split('/')[2]);
        if (!access || model.denied.has(access.id) || (model.expired && !access.fresh)) {
          await route.fulfill({ status: 410, body: '' }); return;
        }
        const color = Number(access.id.slice(0, 8)) % 2 ? '#87b5d2' : '#c6a4b9';
        await route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/><ellipse cx="32" cy="64" rx="24" ry="28" fill="#354b66"/><ellipse cx="32" cy="25" rx="13" ry="18" fill="#43332e"/><ellipse cx="32" cy="27" rx="9" ry="13" fill="#f5d5be"/></svg>` }); return;
      } else if (p === '/groups/' + gid) data = { ...summary(gid, 0), owner_id: uuid(1), member_limit: 1000, public_id: '12345678', block_member_friend_requests: false };
      else if (p === '/groups/' + gid + '/member-profiles') data = { items: [], next_after: '', query: url.searchParams.get('q') || '', search_scope: 'group', members_visibility: 'all' };
      else if (/^\/conversations\/[^/]+$/.test(p)) data = rows().find(row => row.id === p.split('/')[2]);
      else if (p.endsWith('/history')) data = { items: [], membership_version: '1', snapshot_max_seq: '0', next_after_seq: '0', next_before_seq: '0', visible_from_seq: '1', clear_seq: '0', has_more: false };
      else if (p.endsWith('/sync')) data = { events: [], membership_version: '1', snapshot_max_seq: '0', next_after_seq: '0', visible_from_seq: '1', has_more: false };
      else if (p.endsWith('/personal-sync')) data = { events: [], snapshot_max_seq: '0', next_after_seq: '0', has_more: false };
      else if (/\/(read|delivered)$/.test(p)) data = { version: '1', reminder: false };
      else if (method !== 'GET' && p !== '/client/network-observation') { status = 404; data = { error: { code: 'not_found' } }; }
      await route.fulfill({ status, json: data });
    });
    await page.goto(origin + '/__conversation-avatars-test');
    await page.waitForFunction(() => window.groupFixture?.chat.active.value?.name === '头像测试群' && !window.groupFixture.chat.loading.value);
    await page.evaluate(() => { const f = window.groupFixture; f.platform.name = 'pc'; f.directory.value = true; });
    const ids = await page.evaluate(() => window.groupFixture.chat.conversations.value.map(row => ({ id: row.id, peer: row.peer_user_id && window.groupFixture.client.wire('user', row.peer_user_id) })));
    const rowFor = n => page.locator(`.fixture-conversations [data-conversation-id="${ids.find(row => row.peer === uuid(n)).id}"]`);
    return { model, rowFor, context };
  }

  try {
    let scenario = await setup({ expired: true });
    let { model, rowFor } = scenario;
    await readyImage(rowFor(2).locator('img'));
    assert.ok(model.requests.some(row => row.path === '/media/' + media(2) + '/grants'));
    assert.ok(model.maxActive <= 4);
    assert.ok(model.requests.filter(row => /^\/media\/[^/]+\/grants$/.test(row.path)).length < model.count / 2);
    pass('expired conversation-list avatar URLs renew automatically for visible rows with at most four grant requests active');
    await rowFor(2).click();
    await readyImage(page.locator('.conversation-heading img'));
    await readyImage(rowFor(2).locator('img'));
    assert.equal(await rowFor(2).locator('img').getAttribute('src'), await page.locator('.conversation-heading img').getAttribute('src'));
    pass('opening a direct conversation displays the same renewed avatar in the retained list row and header');
    await page.locator('#message-input').fill('头像恢复时保留的草稿');
    await rowFor(2).evaluate(el => { window.avatarRow = el; window.avatarImage = el.querySelector('img'); });
    const before = model.requests.length;
    await page.evaluate(() => {
      const f = window.groupFixture;
      f.chat.conversations.value = f.chat.conversations.value.map(row => ({ ...row, unread_count: row.unread_count + 1 }));
    });
    await wait(1100);
    assert.ok(await rowFor(2).evaluate(el => el === window.avatarRow && el.querySelector('img') === window.avatarImage && el.querySelector('img').naturalWidth > 0));
    assert.equal(model.requests.slice(before).filter(row => row.path === '/media/' + media(2) + '/grants').length, 0);
    assert.equal(await page.locator('#message-input').innerText(), '头像恢复时保留的草稿');
    pass('unread refreshes retain repaired avatar nodes and drafts without downgrading to expired URLs or fetching another grant');
    await page.screenshot({ path: path.join(output, 'list-and-header-recovered.png') });
    await scenario.context.close();

    scenario = await setup({ count: 2, denied: new Set([media(2)]) });
    ({ model, rowFor } = scenario);
    await rowFor(2).waitFor(); await wait(1200);
    assert.equal(await rowFor(2).locator('img').count(), 0);
    assert.ok(model.requests.filter(row => row.path === '/media/' + media(2) + '/grants').length <= 1);
    await wait(1100);
    assert.equal(await rowFor(2).locator('img').count(), 0);
    pass('forbidden avatars remain placeholders with no retry loop or unauthenticated fallback');
    await rowFor(2).click();
    await page.waitForFunction(() => window.groupFixture.chat.active.value?.type === 'direct' && !window.groupFixture.chat.loading.value);
    await page.locator('#message-input').fill('缺失头像恢复后保留草稿');
    const historyReads = model.requests.filter(row => row.path.endsWith('/history')).length;
    model.denied.clear();
    await page.evaluate(async id => {
      const f = window.groupFixture, source = await f.client.mediaGrant(id, f.client.token, undefined, true);
      f.chat.active.value = { ...f.chat.active.value, avatar_url: source };
    }, media(2));
    await readyImage(page.locator('.conversation-heading img'));
    await readyImage(rowFor(2).locator('img'));
    assert.equal(await rowFor(2).locator('img').getAttribute('src'), await page.locator('.conversation-heading img').getAttribute('src'));
    assert.equal(model.requests.filter(row => row.path.endsWith('/history')).length, historyReads);
    assert.equal(await page.locator('#message-input').innerText(), '缺失头像恢复后保留草稿');
    pass('a successful header avatar heals a list row that has only a media ID, preserving the open chat and draft');
    await rowFor(99).scrollIntoViewIfNeeded();
    assert.equal(await rowFor(99).locator('img').count(), 0);
    assert.ok((await rowFor(99).locator('.avatar').innerText()).trim());
    pass('users without an uploaded avatar keep their normal initial placeholder');
    await page.screenshot({ path: path.join(output, 'missing-avatar-repaired.png') });
    await scenario.context.close();

    scenario = await setup({ count: 1, groupAvatar: media(9000), expired: true });
    await readyImage(page.locator('.conversation-heading img'));
    assert.equal(scenario.model.requests.filter(row => row.path === '/media/' + media(9000) + '/grants').length, 1);
    pass('group header avatars also recover from an expired image URL using one bounded renewal');
    await scenario.context.close();
    assert.deepEqual(errors, []);
    const requests = scenarios.map(model => ({ maxActive: model.maxActive, requests: model.requests }));
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, scenarios: requests }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, output }));
  } catch (error) {
    await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, checks }, null, 2));
    throw error;
  } finally { await browser?.close(); await server?.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
