// Actual Vue workspace, message list, media renderer and Go adapter; synthetic data only.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = process.env.PULSE_IMAGE_LAYOUT_TEST_OUTPUT || path.join(repo, '.local/image-message-layout-ui');
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';
const self = uuid(1), gid = uuid(9000), checks = [], errors = [], requests = [];
const summary = { id: gid, kind: 'group', title: '图片消息布局', my_role: 'owner', can_send: true,
  owner_id: self, member_limit: 500, member_count: 2, membership_version: '1',
  visible_from_seq: '1', message_seq: '1', event_seq: '1', unread_count: '0',
  updated_at: '2026-11-25T12:00:00Z',
  state: { clear_seq: '0', read_seq: '0', delivered_seq: '0', personal_seq: '0', version: '1' } };
const scenes = [
  { name: 'portrait', width: 600, height: 1200, mine: false },
  { name: 'landscape', width: 1600, height: 700, mine: true },
  { name: 'very-tall', width: 200, height: 2400, mine: true },
  { name: 'small', width: 80, height: 60, mine: false },
  { name: 'missing-dimensions', width: 700, height: 1400, noDimensions: true, mine: false },
  { name: 'gif', width: 900, height: 450, gif: true, mine: true },
  { name: 'whitespace', width: 600, height: 1200, text: ' \n\t ', mine: true },
];
let server, browser, page, photoGate;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
(async () => {
  fs.mkdirSync(output, { recursive: true }); process.chdir(root);
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    cacheDir: path.join(output, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
    plugins: [{ name: 'image-layout-fixture', enforce: 'pre',
      resolveId: id => id === 'virtual:pulse-platform' ? '\0image-layout-platform' : undefined,
      load: id => id === '\0image-layout-platform' ? `import browser from '/src/platform/browser';
        export default {...browser,archive:{
          openImage:async(...args)=>window.imageLayoutCalls.push({operation:'open',args}),
          copyImage:async(...args)=>window.imageLayoutCalls.push({operation:'copy',args})
        }};` : undefined,
      configureServer(vite) { vite.middlewares.use('/__image-layout', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/group-chat-fixture.ts"></script></html>');
      }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1180, height: 900 } }); page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.imageLayoutCalls = []; });
  await page.route('**/api/v2/**', async route => {
    const request = route.request(), p = new URL(request.url()).pathname.replace('/api/v2', ''), body = request.postDataJSON();
    requests.push({ path: p, body });
    let data = { items: [] };
    if (p === '/me' || p === '/me/profile') data = { id: self, user_id: self, account: 'layout-self', nickname: '我', version: '1', internal_staff: true };
    else if (p === '/client/config') data = { registration: {}, display: {}, releases: {} };
    else if (p === '/client/update') data = { required: false };
    else if (p === '/client/conversation-page' || p === '/conversations') data = { items: [summary], total: 1, page: 1, size: 100 };
    else if (p === '/client/friend-page') data = { items: [], total: 0, page: 1, size: 100 };
    else if (p === '/conversations/' + gid || p === '/conversations/' + gid + '/open' || p === '/groups/' + gid) data = summary;
    else if (p === '/groups/' + gid + '/member-profiles') data = {
      items: [1, 2].map(n => ({ id: uuid(n), account: 'layout-user' + n, nickname: n === 1 ? '我' : '对方', role: n === 1 ? 'owner' : 'member' })),
      next_after: '', query: '', search_scope: 'group', members_visibility: 'all',
    };
    else if (p.endsWith('/history')) data = { items: [], membership_version: '1', snapshot_max_seq: '0', next_after_seq: '0', next_before_seq: '0', visible_from_seq: '1', clear_seq: '0', has_more: false };
    else if (p.endsWith('/sync') || p.endsWith('/personal-sync')) data = { events: [], membership_version: '1', snapshot_max_seq: '0', next_after_seq: '0', visible_from_seq: '1', clear_seq: '0', has_more: false };
    else if (p.endsWith('/unread')) data = { count: '0', truncated: false };
    else if (/\/(read|delivered)$/.test(p)) data = { version: '1', reminder: false };
    else if (p.endsWith('/message-receipts')) data = { items: body.message_ids.map(message_id => ({ message_id, recipient_count: 1, delivered_count: 1, read_count: 1 })) };
    await route.fulfill({ json: data }).catch(() => {});
  });
  await page.route('**/__photo/*', async route => {
    const url = new URL(route.request().url()), width = Number(url.searchParams.get('w')), height = Number(url.searchParams.get('h'));
    if (url.pathname.endsWith('/delayed')) await photoGate;
    await route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#6da4d6"/><path d="M0 0L${width} ${height}M${width} 0L0 ${height}" stroke="#fff" stroke-width="10"/></svg>` });
  });
  const show = async (scene, extras = {}, waitForImage = true) => {
    await page.evaluate(({ scene, extras, wire }) => {
      const { chat } = window.groupFixture;
      const body = { _go_wire_id: wire, url: `/__photo/${scene.name}?w=${scene.width}&h=${scene.height}`,
        name: scene.name + (scene.gif ? '.gif' : '.png'), mime: scene.gif ? 'image/gif' : 'image/png', text: scene.text,
        ...(scene.noDimensions ? {} : { width: scene.width, height: scene.height }), ...extras.body };
      chat.messages.value = [{ id: 101, conversation_id: chat.active.value.id, sender_id: scene.mine ? chat.me.value.id : 2,
        sender_name: '对方', type: 'image', status: 'sent', created_at: '2026-11-25T12:00:00Z', ...extras, body }];
    }, { scene, extras, wire: uuid(20101) });
    const image = page.locator('[data-message-id="101"] .vue-image-button img');
    await image.waitFor(); await image.scrollIntoViewIfNeeded();
    if (waitForImage) await image.evaluate(img => img.complete && img.naturalWidth ? undefined : new Promise(resolve => img.addEventListener('load', resolve, { once: true })));
  };
  const geometry = () => page.locator('[data-message-id="101"]').evaluate(row => {
    const bubble = row.querySelector('.bubble'), image = row.querySelector('.vue-image-button img'), button = image.parentElement;
    const b = bubble.getBoundingClientRect(), i = image.getBoundingClientRect(), c = button.getBoundingClientRect(), style = getComputedStyle(bubble);
    return { width: b.width, height: b.height, imageWidth: i.width, imageHeight: i.height, buttonWidth: c.width, buttonHeight: c.height,
      background: style.backgroundColor, color: style.color, padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      captionCount: bubble.querySelectorAll('.vue-message-text').length };
  });
  try {
    await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__image-layout');
    await page.waitForFunction(() => window.groupFixture?.chat.active.value && !window.groupFixture.chat.loading.value);
    assert.equal(await page.evaluate(() => window.groupFixture.chat.openingError.value), '', JSON.stringify(requests));
    await page.getByText('对方', { exact: true }).waitFor();
    for (const detached of [true, false]) {
      await page.evaluate(value => { window.groupFixture.detached.value = value; }, detached);
      for (const scene of scenes) {
        await show(scene); const g = await geometry();
        assert.equal(g.background, 'rgba(0, 0, 0, 0)', scene.name + ' bubble background');
        assert.deepEqual(g.padding, ['0px', '0px', '0px', '0px']); assert.equal(g.captionCount, 0);
        assert.ok(Math.abs(g.width - g.imageWidth) < 1 && Math.abs(g.height - g.imageHeight) < 1, JSON.stringify(g));
        assert.ok(Math.abs(g.buttonWidth - g.imageWidth) < 1 && Math.abs(g.buttonHeight - g.imageHeight) < 1, JSON.stringify(g));
        assert.ok(Math.abs(g.imageWidth / g.imageHeight - scene.width / scene.height) < 0.01, scene.name + ': ' + JSON.stringify(g));
        assert.ok(g.imageWidth <= Math.min(335, scene.width) + 1 && g.imageHeight <= Math.min(350, scene.height) + 1);
        pass(`${detached ? 'detached' : 'main'} ${scene.name}: image keeps its aspect ratio without bubble background or blank margins`);
      }
      for (const mine of [true, false]) {
        const text = '图片说明：这段文字与图片一起发送。';
        await show({ ...scenes[0], mine, text }); const g = await geometry();
        assert.notEqual(g.background, 'rgba(0, 0, 0, 0)'); assert.ok(g.padding.every(p => parseFloat(p) > 0));
        assert.equal(await page.locator('.bubble .vue-message-text').textContent(), text);
        pass(`${detached ? 'detached' : 'main'} ${mine ? 'outgoing' : 'incoming'} caption: text and image retain their shared colored bubble`);
      }
    }
    await show(scenes[0], { body: { reply_to: { id: 99, sender_id: 2, sender_name: '对方', text: '引用原文' } } });
    assert.notEqual((await geometry()).background, 'rgba(0, 0, 0, 0)');
    assert.match(await page.locator('.bubble blockquote').textContent(), /引用原文/);
    pass('an image reply retains its visible quoted text and shared bubble');
    await show(scenes[0]);
    await page.locator('.vue-image-button').click();
    await page.waitForFunction(() => window.imageLayoutCalls.some(c => c.operation === 'open'));
    await page.locator('.vue-image-button').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '复制图片', exact: true }).click();
    await page.getByRole('menu').waitFor({ state: 'detached' });
    const operations = await page.evaluate(() => window.imageLayoutCalls);
    assert.deepEqual(operations.map(c => c.operation), ['open', 'copy']);
    for (const operation of operations) assert.equal(operation.args[2], uuid(20101));
    pass('click preview and right-click copy still target the exact displayed message without opening it first');
    await page.evaluate(() => { const chat = window.groupFixture.chat; chat.messages.value = chat.messages.value.map(m => ({ ...m, status: 'recalled' })); });
    await page.getByText('消息已撤回', { exact: true }).waitFor();
    assert.equal(await page.locator('.bubble.image-bubble').count(), 0);
    assert.equal(await page.locator('.vue-image-button').count(), 0);
    pass('a recalled image returns to its ordinary text notice without exposing the picture');
    let releasePhoto; photoGate = new Promise(resolve => { releasePhoto = resolve; });
    await show({ ...scenes[0], name: 'delayed' }, {}, false);
    const pending = await geometry();
    assert.ok(Math.abs(pending.width - 175) < 1 && Math.abs(pending.height - 350) < 1, JSON.stringify(pending));
    releasePhoto(); await page.locator('.vue-image-button img').evaluate(img => img.complete ? undefined : new Promise(resolve => img.addEventListener('load', resolve, { once: true })));
    const loaded = await geometry();
    assert.ok(Math.abs(pending.width - loaded.width) < 1 && Math.abs(pending.height - loaded.height) < 1);
    pass('known dimensions reserve the same compact frame before and after a delayed image finishes loading');
    await show({ ...scenes[1], text: '[图片]' });
    assert.notEqual((await geometry()).background, 'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('.bubble .vue-message-text').textContent(), '[图片]');
    pass('literal caption text is preserved rather than guessed to be an attachment placeholder');
    await show(scenes[1]); await page.evaluate(() => { document.body.dataset.theme = 'night'; });
    await page.locator('.vue-image-button').hover();
    assert.equal((await geometry()).background, 'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('.vue-image-button').evaluate(button => getComputedStyle(button).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: path.join(output, 'night-image.png') });
    await page.evaluate(() => { delete document.body.dataset.theme; });
    pass('night mode and hovering over a pure outgoing image do not add a colored background');
    await show(scenes[0]); await page.setViewportSize({ width: 610, height: 850 });
    const narrow = await geometry(); assert.equal(narrow.background, 'rgba(0, 0, 0, 0)');
    assert.ok(Math.abs(narrow.width - narrow.imageWidth) < 1 && Math.abs(narrow.imageWidth / narrow.imageHeight - 0.5) < 0.01);
    await page.screenshot({ path: path.join(output, 'narrow-image.png') });
    pass('narrow windows constrain the image without reintroducing padding or distorting it');
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.evaluate(() => { window.groupFixture.detached.value = true; });
    await page.screenshot({ path: path.join(output, 'pure-image.png') });
    await show({ ...scenes[0], mine: true, text: '图片加文字保留气泡背景' });
    await page.screenshot({ path: path.join(output, 'image-with-caption.png') });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: true, checks, errors, production_requests: 0, os_clipboard_modified: false }, null, 2));
  } catch (error) { await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); throw error; }
  finally { await browser?.close(); await server?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
