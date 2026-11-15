// Test shipping renderers against a local Go fixture, including delayed snapshots.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), output = process.argv[2] || path.join(root, '.local/artifacts/message-scroll-ui');
fs.mkdirSync(output, { recursive: true });
const uid = '11111111-1111-4111-8111-111111111111', peer = '22222222-2222-4222-8222-222222222222', cid = '33333333-3333-4333-8333-333333333333';
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, browser = await chromium.launch({ headless: true }), results = [];
  async function bottom(page) {
    await page.waitForFunction(() => { const box = document.querySelector('#messages'); return box.scrollHeight - box.scrollTop - box.clientHeight <= 3; });
  }
  async function readEarlier(page) {
    await page.locator('#messages').dispatchEvent('wheel', { deltaY: -300 });
    await page.evaluate(() => { const box = document.querySelector('#messages'); box.scrollTop = Math.max(80, (box.scrollHeight - box.clientHeight) / 3); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(await page.evaluate(() => { const box = document.querySelector('#messages'); return box.scrollHeight - box.scrollTop - box.clientHeight > 200; }));
  }
  try {
    for (const platform of ['pc', 'web']) for (const kind of ['direct', 'group']) {
      const page = await browser.newPage({ viewport: platform === 'pc' ? { width: 1100, height: 760 } : { width: 720, height: 900 } });
      page.setDefaultTimeout(10000);
      const errors = [], unknown = [], checks = [];
      let releaseSync, syncStarted, held = false, sendCount = 0;
      const sentBodies = [];
      const makeMessage = (seq, mine = false, text = '历史消息 ' + seq) => ({ id: '44444444-4444-4444-8444-' + String(seq).padStart(12, '0'), conversation_id: cid, sender_id: mine ? uid : peer, seq: String(seq), version: '1', kind: 'text', body: text, content: {}, created_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z', sender: { name: mine ? '自己' : '好友' } });
      const messages = Array.from({ length: 65 }, (_, i) => makeMessage(i + 1));
      const row = () => ({ id: cid, kind, title: kind === 'group' ? '滚动测试群' : '测试好友', peer: { id: peer, name: '测试好友' }, my_role: kind === 'group' ? 'member' : 'owner', membership_version: '1', preference_version: '1', state: { clear_seq: '0', read_seq: '0', delivered_seq: '0', version: '1' }, visible_from_seq: '1', message_seq: String(messages.length), unread_count: '0', can_send: true, member_count: 2, updated_at: '2026-11-16T00:00:00Z' });
      page.on('pageerror', error => { errors.push(error.message); console.error(platform, kind, error); });
      await page.addInitScript(({ base, desktop }) => { window.PULSE_API_BASE = base; window.pulseDesktop = { isDesktop: desktop, production: false, apiBaseUrl: base, windowKind: 'account' }; }, { base: origin + '/api/v2', desktop: platform === 'pc' });
      await page.route('**/go-realtime.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.PulseGoRealtime={connect:async options=>{window.__onPacket=options.onPacket;return {close(){}}}};' }));
      await page.route('**/api/v2/**', async route => {
        const request = route.request(), url = new URL(request.url()), p = url.pathname.replace('/api/v2', ''), body = request.postDataJSON();
        let result = {};
        if (p === '/conversations' || p === '/client/conversation-page') result = { items: [row()], total: 1, page: 1, size: 30 };
        else if (p === '/conversations/' + cid || p === '/conversations/' + cid + '/open') result = row();
        else if (p === '/groups/' + cid) result = { ...row(), owner_id: uid, member_limit: 500 };
        else if (p.endsWith('/search-members')) result = { items: [{ id: peer, nickname: '呆萌萌', account: 'wenwen3', public_id: '123456', role: 'member' }], can_search: true, can_mention_all: false, next_after: '' };
        else if (p.endsWith('/history')) {
          const asc = url.searchParams.get('order') === 'asc', before = Number(url.searchParams.get('before_seq') || Infinity), after = Number(url.searchParams.get('after_seq') || 0), floor = Number(url.searchParams.get('floor_seq') || 1), limit = Number(url.searchParams.get('limit') || 50);
          const snapshot = Number(url.searchParams.get('snapshot_max_seq') || messages.length);
          let items = messages.filter(m => Number(m.seq) >= floor && Number(m.seq) > after && Number(m.seq) <= before && Number(m.seq) <= snapshot);
          if (!asc) items = items.toReversed();
          const hasMore = items.length > limit; items = items.slice(0, limit);
          result = { items, membership_version: '1', snapshot_max_seq: String(snapshot), next_after_seq: String(items.at(-1)?.seq || after), next_before_seq: String(items.at(-1)?.seq || 0), visible_from_seq: '1', clear_seq: '0', has_more: hasMore };
          if (asc && held) { held = false; syncStarted?.(); await new Promise(resolve => { releaseSync = resolve; }); }
        } else if (p === '/conversations/' + cid + '/messages' && request.method() === 'POST') {
          sendCount++; sentBodies.push(body);
          let message = messages.find(item => item.request_id === body.request_id);
          if (!message) { message = makeMessage(messages.length + 1, true, body.body); message.request_id = body.request_id; messages.push(message); }
          result = { message };
        } else if (p.endsWith('/read') || p.endsWith('/delivered')) result = { user_id: uid, read_seq: body?.seq || '0', delivered_seq: body?.seq || '0', clear_seq: '0', version: '1' };
        else if (p === '/me') result = { user_id: uid, id: uid, account: 'fixture', name: '自己', nickname: '自己' };
        else if (p === '/client/config') result = { releases: { pc: { latest: '2.4.163', minimum: '1.0.0' } }, registration: {}, display: { show_group_count: true } };
        else if (p === '/auth/captcha') result = { id: 'fixture', image: '', expires_in: 120 };
        else if (/contacts|folders|pins|invitation|requests|blocks|tasks|announcements|routes|notifications|friend-page|member-profiles|receipts/.test(p)) result = { items: [] };
        else unknown.push(p);
        await route.fulfill({ json: result });
      });
      await page.goto(origin + (platform === 'pc' ? '/pc/web/index.html' : '/web/index.html'));
      await page.waitForFunction(() => typeof renderShell === 'function' && !!window.PulseGoUI);
      await page.evaluate(async ({ uid, cid }) => {
        GO.session('fixture-token'); state.token = 'fixture-token'; state.user = { id: GO.local('user', uid), nickname: '自己', account: 'fixture' }; state.page = 'messages';
        renderShell(); await loadConversations(); await openConversation(GO.local('conversation', cid), { focusInput: false }); connectSocket();
      }, { uid, cid });
      await page.waitForSelector('#messages [data-message-id="65"]'); await bottom(page); checks.push('initial history reaches bottom');

      await readEarlier(page);
      messages.push(makeMessage(66));
      await page.evaluate(cid => window.__onPacket({ type: 'conversation.changed', conversation_id: cid }), cid);
      await page.waitForSelector('#messages [data-message-id="66"]'); await bottom(page); checks.push('incoming message follows latest from earlier history');

      await readEarlier(page);
      const before = await page.locator('#messages').evaluate(box => box.scrollTop);
      await page.evaluate(cid => window.__onPacket({ type: 'conversation.changed', conversation_id: cid }), cid);
      await page.waitForTimeout(250);
      assert.ok(Math.abs(await page.locator('#messages').evaluate(box => box.scrollTop) - before) < 3); checks.push('metadata refresh preserves a reader position');

      await page.locator('#messages').dispatchEvent('wheel', { deltaY: -300 });
      const historyAnchor = await page.evaluate(() => {
        const box = document.querySelector('#messages'); box.scrollTop = 0;
        const row = box.querySelector('[data-message-id="16"]');
        return row.getBoundingClientRect().top - box.getBoundingClientRect().top;
      });
      await page.waitForSelector('#messages [data-message-id="1"]', { state: 'attached' });
      await page.waitForTimeout(100);
      const afterHistory = await page.evaluate(() => ({ offset: document.querySelector('[data-message-id="16"]').getBoundingClientRect().top - document.querySelector('#messages').getBoundingClientRect().top, top: document.querySelector('#messages').scrollTop }));
      assert.ok(Math.abs(afterHistory.offset - historyAnchor) < 4, JSON.stringify({ platform, kind, historyAnchor, afterHistory }));
      checks.push('loading older messages preserves the visible history anchor');

      // Begin a snapshot at the old position, then send before it returns.
      await readEarlier(page); held = true;
      const started = new Promise(resolve => { syncStarted = resolve; });
      await page.evaluate(cid => window.__onPacket({ type: 'conversation.changed', conversation_id: cid }), cid);
      await started;
      await page.fill('#message-input', '自己发送后应到最新消息'); await page.locator('#composer').evaluate(form => form.requestSubmit());
      await page.waitForSelector('#messages [data-message-id="67"]').catch(async error => {
        console.error({ platform, kind, sendCount, unknown, draft: await page.locator('#message-input').inputValue(), pending: await page.locator('[data-outbox-id]').allTextContents() });
        await page.screenshot({ path: path.join(output, 'send-failure.png') });
        releaseSync?.(); throw error;
      }); await bottom(page);
      releaseSync();
      await page.waitForTimeout(300); await bottom(page);
      assert.equal(await page.locator('#messages [data-message-id="67"]').count(), 1);
      assert.equal(sendCount, 1); checks.push('own send survives a late snapshot without losing or repeating its message');

      if (kind === 'group') {
        await page.fill('#message-input', '@萌');
        await page.waitForSelector('.group-mention-row');
        assert.equal(await page.locator('.group-mention-row small').count(), 0);
        await page.click('.group-mention-row');
        assert.equal(await page.inputValue('#message-input'), '@呆萌萌 ');
        await page.locator('#composer').evaluate(form => form.requestSubmit());
        await page.waitForSelector('#messages [data-message-id="68"]'); await bottom(page);
        assert.deepEqual(sentBodies.at(-1).mentions, [peer]);
        checks.push('ordinary member fuzzy mention hides accounts and sends the selected wire identity');
      }

      // Model a photo whose measured height becomes available after rendering.
      await page.evaluate(() => {
        const row = document.querySelector('#messages').lastElementChild;
        const media = document.createElement('div'); media.id = 'late-media'; media.style.height = '10px'; row.append(media);
      });
      await bottom(page);
      await page.evaluate(() => { document.querySelector('#late-media').style.height = '420px'; });
      await bottom(page); checks.push('late media sizing stays at bottom');
      await page.setViewportSize(platform === 'pc' ? { width: 1100, height: 520 } : { width: 720, height: 580 });
      await bottom(page); checks.push('keyboard-sized viewport resize stays at bottom');

      await page.evaluate(() => {
        const box = document.querySelector('#messages'), html = box.innerHTML;
        box.innerHTML = ''; box.innerHTML = html;
      });
      await bottom(page); checks.push('temporary row shrink does not cancel following');
      await readEarlier(page); const heldTop = await page.locator('#messages').evaluate(box => box.scrollTop);
      await page.evaluate(() => { document.querySelector('#late-media').style.height = '600px'; });
      await page.waitForTimeout(100);
      assert.ok(Math.abs(await page.locator('#messages').evaluate(box => box.scrollTop) - heldTop) < 3); checks.push('scrolling up pauses following until another new message');

      await page.screenshot({ path: path.join(output, platform + '-' + kind + '.png') });
      assert.deepEqual(errors, []); assert.deepEqual(unknown, []);
      results.push({ platform, kind, checks }); await page.close();
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ cases: results.length, checks: results.reduce((n, row) => n + row.checks.length, 0), results }, null, 2));
    console.log(JSON.stringify({ cases: results.length, results, output }, null, 2));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
