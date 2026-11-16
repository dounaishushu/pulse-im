const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), output = process.argv[2] || path.join(root, '.local/artifacts/pc-avatar-recovery');
const baseline = process.argv.includes('--baseline'); fs.mkdirSync(output, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/pc/web/avatar-sizing.css"><style>body{font:16px sans-serif;padding:24px}.conversation{display:flex;gap:12px;padding:14px;width:300px;align-items:center;border:1px solid #ddd;background:white}.avatar,.desktop-avatar{display:inline-grid;place-items:center;width:44px;height:44px;border-radius:50%;background:#d79c68}.avatar img,.desktop-avatar img{width:44px;height:44px;object-fit:cover;border-radius:50%}#header{margin:24px}</style></head><body><div id="rows"></div><div id="header"></div><script src="/pc/web/media-identity.js"></script><script src="/pc/web/avatar-source.js"></script><script src="/pc/web/message-view.js"></script><script src="/pc/web/avatar-loader.js"></script></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/fixture') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); return; }
  if (url.pathname === '/good.png' || url.pathname.includes('/' + 'b'.repeat(64) + '/')) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(png); return; }
  if (url.pathname.startsWith('/api/v2/media-grants/')) { res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); return; }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, bytes) => { if (error) { res.writeHead(404).end(); return; } res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream'); res.end(bytes); });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, browser = await chromium.launch({ headless: true, executablePath: process.env.PULSE_BROWSER_EXECUTABLE }), checks = [], errors = [];
  const check = (name, passed) => { checks.push({ name, passed }); if (!baseline) assert.equal(passed, true, name); };
  async function setup(mode = 'deny') {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } }); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/fixture');
    await page.evaluate(({ origin, mode }) => {
      window.__origin = origin; window.__mode = mode; window.__calls = 0; window.__owner = { base: origin + '/api/v2', token: 'fixture', userId: 1 };
      window.__old = origin + '/api/v2/media-grants/' + 'a'.repeat(64) + '/content';
      window.__fresh = origin + '/api/v2/media-grants/' + 'b'.repeat(64) + '/content';
      window.__newExpired = origin + '/api/v2/media-grants/' + 'c'.repeat(64) + '/content';
      for (const source of [__old, __fresh, __newExpired]) PulseMediaIdentity.remember(source, '55555555-5555-4555-8555-555555555555');
      window.__render = (source = __old, label = '列表联系人') => PulseMessageView.render(document.querySelector('#rows'), `<button class="conversation" data-id="7"><span class="avatar"><img src="${source}" alt=""></span><strong>${label}</strong></button>`, 'fixture');
      window.__loader = PulseAvatarLoader.create({ context: () => __owner, timeout: 500, retryDelays: [10, 20], cooldown: 30000,
        mediaPath: source => PulseAvatarSources.mediaId(source) ? '/media/55555555-5555-4555-8555-555555555555/preview' : '', report() {},
        request: async (path, account, signal) => {
          __calls++; window.__lastAccount = account.userId;
          if (__mode === 'held') await new Promise(resolve => window.__release = resolve);
          if (__mode === 'deny') return new Response('', { status: 403 });
          if (__mode === 'transient' && __calls === 1) return new Response('', { status: 503 });
          return fetch(origin + '/good.png', { signal });
        },
      });
      __render();
    }, { origin, mode });
    return page;
  }
  try {
    {
      const page = await setup(); await page.waitForFunction(() => document.querySelector('#rows img')?.dataset.avatarLoadState === 'failed');
      check('an inaccessible avatar uses the existing initial placeholder', await page.locator('#rows .avatar').getAttribute('data-avatar-load-placeholder') === '列');
      await page.evaluate(() => { window.__image = document.querySelector('#rows img'); __render(__old, '列表联系人 · 新消息'); }); await page.waitForTimeout(30);
      check('a stable row refresh retains the failed-avatar placeholder instead of exposing a broken image', await page.evaluate(() => __image === document.querySelector('#rows img') && getComputedStyle(__image).visibility === 'hidden' && __image.parentElement.hasAttribute('data-avatar-load-placeholder')));
      await page.screenshot({ path: path.join(output, 'failed-avatar-after-row-refresh.png') });
      await page.evaluate(() => { __mode = 'ready'; document.querySelector('#header').innerHTML = `<span class="desktop-avatar"><img src="${__fresh}" alt=""></span><strong>同一联系人的聊天顶部</strong>`; });
      await page.waitForFunction(() => document.querySelector('#header img')?.naturalWidth > 0); await page.waitForTimeout(250);
      check('a newly loaded header avatar repairs the stale failed list avatar of the same media and account', await page.locator('#rows img').evaluate(img => img.naturalWidth > 0 && getComputedStyle(img).visibility !== 'hidden'));
      check('a successful header capability does not trigger an extra authenticated image download', await page.evaluate(() => __calls === 1));
      await page.evaluate(() => { window.__repaired = document.querySelector('#rows img'); window.__repairedSource = __repaired.getAttribute('src'); __render(__old, '列表联系人 · 再次刷新'); }); await page.waitForTimeout(40);
      check('old list markup cannot downgrade a repaired avatar to its expired source', await page.evaluate(() => document.querySelector('#rows img') === __repaired && __repaired.naturalWidth > 0 && __repaired.getAttribute('src') === __repairedSource && __calls === 1));
      await page.screenshot({ path: path.join(output, 'same-contact-header-and-list.png') }); await page.close();
    }
    {
      const page = await setup(); await page.waitForFunction(() => document.querySelector('#rows img')?.dataset.avatarLoadState === 'failed');
      await page.evaluate(() => { __mode = 'ready'; __render(__newExpired); }); await page.waitForTimeout(300);
      check('a fresh source can retry a prior denial when its direct image request also fails', await page.locator('#rows img').evaluate(img => img.naturalWidth > 0 && getComputedStyle(img).visibility !== 'hidden'));
      check('a changed source starts only one new recovery request', await page.evaluate(() => __calls === 2)); await page.close();
    }
    {
      const page = await setup('transient'); await page.waitForFunction(() => document.querySelector('#rows img')?.naturalWidth > 0);
      check('transient service errors retry within the existing bounded queue', await page.evaluate(() => __calls === 2));
      const before = await page.locator('#rows img').getAttribute('src');
      await page.evaluate(() => { window.__image = document.querySelector('#rows img'); __render(__old, '列表联系人 · 已读'); }); await page.waitForTimeout(40);
      check('row changes retain the recovered image node and decoded bytes', await page.evaluate(before => document.querySelector('#rows img') === __image && __image.getAttribute('src') === before && __image.naturalWidth > 0 && __calls === 2, before));
      await page.close();
    }
    {
      const page = await setup(); await page.waitForFunction(() => document.querySelector('#rows img')?.dataset.avatarLoadState === 'failed');
      await page.evaluate(() => { for (let i = 0; i < 6; i++) { __render(); dispatchEvent(new Event('online')); } }); await page.waitForTimeout(80);
      check('an unchanged access denial cannot become a hot recovery loop', await page.evaluate(() => __calls === 1));
      await page.evaluate(() => {
        window.__owner = { ...__owner, token: 'different-account', userId: 2 };
        document.querySelector('#header').innerHTML = `<span class="desktop-avatar"><img src="${__fresh}" alt=""></span>`;
      }); await page.waitForFunction(() => document.querySelector('#header img')?.naturalWidth > 0); await page.waitForTimeout(80);
      check('header success in another account cannot promote the previous account image', await page.locator('#rows img').evaluate(img => !img.naturalWidth)); await page.close();
    }
    {
      const page = await setup(); await page.waitForFunction(() => document.querySelector('#rows img')?.dataset.avatarLoadState === 'failed');
      await page.evaluate(() => { PulseMediaIdentity.remember(__fresh, '66666666-6666-4666-8666-666666666666'); document.querySelector('#header').innerHTML = `<span class="desktop-avatar"><img src="${__fresh}" alt=""></span>`; });
      await page.waitForFunction(() => document.querySelector('#header img')?.naturalWidth > 0); await page.waitForTimeout(80);
      check('a different media ID cannot repair or replace another contact avatar', await page.locator('#rows img').evaluate(img => !img.naturalWidth)); await page.close();
    }
    {
      const page = await setup('held'); await page.waitForFunction(() => !!window.__release);
      await page.evaluate(() => { __owner = { ...__owner, token: 'new-account', userId: 2 }; __loader.clear(); __mode = 'ready'; __release(); }); await page.waitForTimeout(150);
      check('a late image response cannot paint after an account change', await page.locator('#rows img').evaluate(img => !img.naturalWidth)); await page.close();
    }
    if (!baseline) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 760 } }); page.on('pageerror', error => errors.push(error.message));
      const uid = '11111111-1111-4111-8111-111111111111', peer = '22222222-2222-4222-8222-222222222222', cid = '33333333-3333-4333-8333-333333333333', mid = '55555555-5555-4555-8555-555555555555';
      let avatarReads = 0, historyReads = 0;
      const row = () => ({ id: cid, kind: 'direct', title: '', peer_id: peer, peer_name: '头像恢复验证好友', avatar_id: mid, membership_version: '1', preference_version: '1', state: { read_seq: '0', delivered_seq: '0', clear_seq: '0', version: '1' }, visible_from_seq: '1', message_seq: '1', unread_count: '0', can_send: true, updated_at: '2026-11-17T00:00:00Z' });
      await page.addInitScript(base => { window.PULSE_API_BASE = base; window.pulseDesktop = { isDesktop: true, production: false, apiBaseUrl: base, appVersion: '2.4.171', windowKind: 'account' }; localStorage.setItem('pulse_go_v2:' + encodeURIComponent(base) + ':token', 'fixture-session'); }, origin + '/api/v2');
      await page.route('**/go-realtime.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.PulseGoRealtime={connect:async()=>({close(){}})};' }));
      await page.route('**/api/v2/**', async route => {
        const request = route.request(), p = new URL(request.url()).pathname.replace('/api/v2', ''); let data = {};
        if (p === '/client/update') data = { required: false };
        else if (p === '/client/config') data = { releases: {}, registration: {}, display: {} };
        else if (p === '/me/profile') data = { id: uid, account: 'fixture', nickname: '自己', version: '1' };
        else if (p === '/me') data = { id: uid };
        else if (p === '/client/conversation-page' || p === '/conversations') data = { items: [row()], total: 1 };
        else if (p === '/client/conversation-updates') data = { items: [row()], removed_ids: [], incremental: true };
        else if (p === '/conversations/' + cid || p === '/conversations/' + cid + '/open') data = row();
        else if (p === '/media/grants') data = { items: [{ id: mid, access: { content_path: '/api/v2/media-grants/' + 'a'.repeat(64) + '/content', expires_in: 120 } }] };
        else if (p === '/media/' + mid + '/grants') data = { content_path: '/api/v2/media-grants/' + 'b'.repeat(64) + '/content', expires_in: 120 };
        else if (p.startsWith('/media-grants/')) { await route.fulfill({ status: p.includes('b'.repeat(64)) ? 200 : 403, contentType: 'image/png', body: p.includes('b'.repeat(64)) ? png : Buffer.alloc(0) }); return; }
        else if (p === '/media/' + mid + '/preview') { avatarReads++; await route.fulfill({ status: 403, json: { error: { code: 'forbidden' } } }); return; }
        else if (p.endsWith('/history')) { historyReads++; data = { items: [{ id: '44444444-4444-4444-8444-000000000001', conversation_id: cid, sender_id: peer, seq: '1', version: '1', kind: 'text', body: '原有聊天内容', content: {}, request_id: 'fixture-message', sender: { name: '好友' }, created_at: '2026-11-17T00:00:00Z', updated_at: '2026-11-17T00:00:00Z' }], membership_version: '1', snapshot_max_seq: '1', next_after_seq: '0', has_more: false, clear_seq: '0', visible_from_seq: '1' }; }
        else if (p.endsWith('/read') || p.endsWith('/delivered')) data = { read_seq: '1', delivered_seq: '1', clear_seq: '0', version: '1' };
        else if (p.endsWith('/unread')) data = { count: 0, truncated: false };
        else data = { items: [] };
        await route.fulfill({ json: data });
      });
      await page.goto(origin + '/pc/web/index.html');
      await page.waitForFunction(() => state.user && document.querySelector('.conversation .avatar img')?.dataset.avatarLoadState === 'failed');
      await page.evaluate(() => { window.__listImage = document.querySelector('.conversation .avatar img'); state.conversations[0].unread_count = 2; renderConversationList(); });
      check('the full PC conversation list keeps its placeholder after an unread refresh', await page.evaluate(() => document.querySelector('.conversation .avatar img') === __listImage && getComputedStyle(__listImage).visibility === 'hidden'));
      await page.evaluate(cid => openConversation(GO.local('conversation', cid), { focusInput: false }), cid);
      await page.fill('#message-input', '保留头像恢复时的草稿');
      await page.evaluate(async mid => { const source = await GO.mediaGrant(mid, state.token, undefined, true); state.active = { ...state.active, avatar_url: source }; renderDesktopChatHeader(state.active); }, mid);
      await page.waitForFunction(() => document.querySelector('#chat-avatar img')?.naturalWidth > 0 && document.querySelector('.conversation .avatar img')?.naturalWidth > 0);
      check('the full PC header and retained list recover together from a renewed Go media capability', await page.evaluate(() => document.querySelector('.conversation .avatar img') === __listImage && getComputedStyle(__listImage).visibility !== 'hidden'));
      check('avatar repair leaves the actual chat and draft intact without rereading history', historyReads === 1 && avatarReads === 1 && await page.inputValue('#message-input') === '保留头像恢复时的草稿');
      await page.screenshot({ path: path.join(output, 'pc-contact-avatar-repaired.png') }); await page.close();
    }
    check('the shipping recovery scripts have no unhandled browser errors', errors.length === 0);
    const result = { passed: checks.filter(item => item.passed).length, total: checks.length, checks, errors };
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
