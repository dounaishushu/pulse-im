// Run the shipping PC startup against isolated responses; no production requests.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), output = process.argv[2] || path.join(root, '.local/artifacts/pc-startup-version');
fs.mkdirSync(output, { recursive: true });
const uid = '11111111-1111-4111-8111-111111111111', peer = '22222222-2222-4222-8222-222222222222', cid = '33333333-3333-4333-8333-333333333333';
const wire = n => '44444444-4444-4444-8444-' + String(n).padStart(12, '0');
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream'); res.end(data);
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, browser = await chromium.launch({ headless: true, executablePath: process.env.PULSE_BROWSER_EXECUTABLE }), results = [];
  try {
    for (const kind of ['account', 'conversation']) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 760 } }), errors = [], checks = [];
      page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
      let mode = 'held', versionCalls = 0, historyCalls = 0, writes = 0, release;
      const paths = [];
      const held = new Promise(resolve => release = resolve);
      const info = () => ({ id: cid, kind: 'group', title: '启动超时验证群', my_role: 'owner', membership_version: '1', preference_version: '1', state: { clear_seq: '0', read_seq: '0', delivered_seq: '0', version: '1' }, visible_from_seq: '1', message_seq: '2', unread_count: '0', can_send: true, member_count: 245, updated_at: '2026-11-17T00:00:00Z' });
      const items = [1, 2].map(n => ({ id: wire(n), conversation_id: cid, sender_id: peer, seq: String(n), version: '1', kind: 'text', body: '版本检查超时后仍保留的消息 ' + n, content: {}, request_id: 'fixture-' + n, sender: { name: '成员' }, created_at: '2026-11-17T00:00:00Z', updated_at: '2026-11-17T00:00:00Z' }));
      await page.addInitScript(({ base, kind, cid }) => {
        const scope = 'pulse_go_v2:' + encodeURIComponent(base) + ':', localCid = Number.parseInt(cid.replaceAll('-', '').slice(0, 13), 16) + 1;
        window.PULSE_API_BASE = base;
        window.pulseDesktop = { isDesktop: true, production: false, apiBaseUrl: base, appVersion: '2.4.170', windowKind: kind, conversationId: kind === 'conversation' ? localCid : 0 };
        localStorage.setItem(scope + 'token', 'fixture-session');
        localStorage.setItem(scope + 'id:conversation:' + localCid, cid);
      }, { base: origin + '/api/v2', kind, cid });
      await page.route('**/go-realtime.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.PulseGoRealtime={connect:async options=>{window.__fixturePacket=options.onPacket;return {close(){}}}};' }));
      await page.route('**/api/v2/**', async route => {
        const request = route.request(), p = new URL(request.url()).pathname.replace('/api/v2', ''); let result = {};
        paths.push(p);
        if (p === '/client/update') {
          versionCalls++;
          assert.equal(request.headers().authorization, undefined);
          if (mode === 'held') { await held; try { await route.fulfill({ json: { required: false } }); } catch {} return; }
          result = mode === 'required' ? { required: true, minimum_version: '2.5.0', latest_version: '2.5.0', url: 'https://downloads.example.org/client.exe', notes: '测试服务器要求升级' } : { required: false };
        }
        else if (p === '/me' || p === '/me/profile') result = { id: uid, user_id: uid, account: 'fixture', nickname: '自己', version: '1' };
        else if (p === '/client/config') result = { releases: { pc: { latest: '2.4.170', minimum: '1.0.0' } }, registration: {}, display: { show_group_count: true } };
        else if (p === '/conversations' || p === '/client/conversation-page') result = { items: [info()], total: 1, page: 1, size: 30 };
        else if (p === '/client/conversation-updates') result = { items: [info()], removed_ids: [], incremental: true };
        else if (p === '/conversations/' + cid || p === '/conversations/' + cid + '/open') result = info();
        else if (p === '/groups/' + cid) result = { ...info(), owner_id: uid, member_limit: 500 };
        else if (p.endsWith('/history')) { historyCalls++; result = { items: [...items].reverse(), membership_version: '1', snapshot_max_seq: '2', next_after_seq: '0', has_more: false, visible_from_seq: '1', clear_seq: '0' }; }
        else if (p.endsWith('/read') || p.endsWith('/delivered')) result = { read_seq: '2', delivered_seq: '2', clear_seq: '0', version: '1' };
        else if (p.endsWith('/unread')) result = { count: 0, truncated: false };
        else if (p === '/auth/captcha') result = { id: 'fixture', image: '', expires_in: 120 };
        else if (p.endsWith('/messages') && request.method() === 'POST') { writes++; await route.fulfill({ status: 500, json: { error: { code: 'unexpected_fixture_write' } } }); return; }
        else result = { items: [] };
        await route.fulfill({ json: result });
      });
      const started = Date.now(); await page.goto(origin + '/pc/web/index.html');
      await page.waitForFunction(() => state.user && state.conversations.length === 1).catch(async error => {
        const detail = { kind, errors, paths, page: await page.evaluate(() => ({ body: document.body.innerText.slice(0, 2500), authenticated: typeof state !== 'undefined' && Boolean(state.user), hasToken: typeof state !== 'undefined' && Boolean(state.token) })) };
        fs.writeFileSync(path.join(output, 'startup-failure.json'), JSON.stringify(detail, null, 2));
        console.error(JSON.stringify(detail)); throw error;
      });
      const startupMs = Date.now() - started;
      assert.ok(startupMs < 4000, 'startup waited for the held update endpoint: ' + startupMs);
      checks.push('saved-session authentication and shell load while version discovery is pending');
      if (kind === 'account') await page.evaluate(cid => openConversation(GO.local('conversation', cid), { focusInput: false }), cid);
      await page.waitForSelector('#messages [data-message-id="2"]');
      await page.fill('#message-input', '保留草稿，等待版本检查超时');
      await page.evaluate(() => { window.__savedMessage = document.querySelector('#messages [data-message-id="2"]'); window.__savedComposer = document.querySelector('#message-input'); });
      checks.push('existing group messages and editable composer appear before version response');
      // Exercise the actual shipping 10-second AbortSignal deadline.
      await page.waitForFunction(() => clientUpdateCheck.failures === 1, null, { timeout: 14000 });
      assert.equal(await page.evaluate(() => __savedMessage === document.querySelector('#messages [data-message-id="2"]') && __savedComposer === document.querySelector('#message-input')), true);
      assert.equal(await page.inputValue('#message-input'), '保留草稿，等待版本检查超时');
      assert.equal(await page.evaluate(() => state.token === 'fixture-session' && localStorage.getItem(GO.tokenKey) === state.token), true);
      assert.equal(await page.getByText('暂时无法加载聊天', { exact: true }).count(), 0);
      checks.push('the real timeout retains message nodes, draft and saved session without an error page');
      await page.screenshot({ path: path.join(output, kind + '-after-timeout.png') });
      mode = 'optional'; release(); await page.evaluate(() => dispatchEvent(new Event('online')));
      await page.waitForFunction(() => clientUpdateCheck.failures === 0 && !clientUpdateCheck.flight);
      assert.equal(versionCalls, 2); assert.equal(historyCalls, 1);
      assert.equal(await page.evaluate(() => __savedMessage.isConnected && __savedComposer.isConnected), true);
      checks.push('network recovery retries the version request without rebuilding or rereading chat history');
      mode = 'required'; await page.evaluate(() => dispatchEvent(new Event('online')));
      await page.getByText('需要更新客户端', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => state.updateRequired), true);
      assert.equal(await page.locator('#required-update-download').count(), 1);
      const blocked = await page.evaluate(async () => { try { await api('/messages', { method: 'POST', body: '{}' }); return false; } catch (error) { return error.message === '请先更新客户端'; } });
      assert.equal(blocked, true); assert.equal(writes, 0);
      checks.push('an explicit upgrade decision replaces chat and blocks Go writes before any request');
      await page.screenshot({ path: path.join(output, kind + '-required-update.png') });
      assert.deepEqual(errors, []);
      results.push({ kind, startupMs, versionCalls, historyCalls, checks }); await page.close();
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
