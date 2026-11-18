const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || '.local/artifacts/message-render-work');
const uid = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const cid = '33333333-3333-4333-8333-333333333333';
const wire = n => '44444444-4444-4444-8444-' + String(n).padStart(12, '0');
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});
(async () => {
  fs.mkdirSync(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : {}) });
  const results = [];
  try {
    for (const platform of ['pc', 'web']) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      const message = n => ({ id: wire(n), conversation_id: cid, sender_id: peer, seq: String(n), version: '1', kind: 'text', body: '消息 ' + n, content: {}, sender: { name: '好友' }, created_at: '2026-11-18T00:00:00Z' });
      const row = { id: cid, kind: 'group', title: '渲染验收', my_role: 'owner', membership_version: '1', preference_version: '1', event_seq: '2', state: { clear_seq: '0', read_seq: '0', delivered_seq: '0', personal_seq: '0', version: '1' }, visible_from_seq: '1', message_seq: '2', unread_count: '0', can_send: true, member_count: 2, last_message: message(2), updated_at: '2026-11-18T00:00:00Z' };
      await page.addInitScript(({ base, desktop }) => {
        window.PULSE_API_BASE = base;
        window.pulseDesktop = { isDesktop: desktop, production: false, apiBaseUrl: base, windowKind: 'account' };
      }, { base: origin + '/api/v2', desktop: platform === 'pc' });
      await page.route('**/go-realtime.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.PulseGoRealtime={connect:async()=>({close(){}})};' }));
      await page.route('**/api/v2/**', route => {
        const p = new URL(route.request().url()).pathname.replace('/api/v2', '');
        let value = { items: [] };
        if (p === '/client/conversation-page') value = { items: [row], total: 1, page: 1, size: 30 };
        else if (p === '/client/conversation-updates') value = { items: [row], removed_ids: [], incremental: true };
        else if (p === '/conversations/' + cid || p === '/conversations/' + cid + '/open') value = row;
        else if (p === '/groups/' + cid) value = { ...row, owner_id: uid, member_limit: 500 };
        else if (p.endsWith('/history')) value = { items: [message(2), message(1)], membership_version: '1', snapshot_max_seq: '2', next_after_seq: '0', has_more: false, visible_from_seq: '1', clear_seq: '0' };
        else if (p.endsWith('/personal-sync')) value = { events: [], snapshot_max_seq: '0', next_after_seq: '0', has_more: false };
        else if (p.endsWith('/sync')) value = { events: [], membership_version: '1', visible_from_seq: '1', snapshot_max_seq: '2', next_after_seq: '2', has_more: false };
        else if (p === '/me') value = { id: uid, user_id: uid, account: 'fixture', nickname: '自己' };
        else if (p === '/client/config') value = { protocol: 'pulse-v2', releases: {}, registration: {}, display: { show_group_count: true }, routes: [] };
        else if (p === '/client/update') value = { required: false };
        else if (p.endsWith('/unread')) value = { count: 0, truncated: false };
        else if (p.endsWith('/read') || p.endsWith('/delivered')) value = { read_seq: '2', delivered_seq: '2', clear_seq: '0', version: '1' };
        else if (p === '/auth/captcha') value = { id: 'fixture', image: '', expires_in: 120 };
        return route.fulfill({ json: value });
      });
      await page.goto(origin + (platform === 'pc' ? '/pc/web/index.html' : '/web/index.html'));
      await page.waitForFunction(() => !!window.PulseGoUI);
      await page.evaluate(async uid => {
        GO.session('fixture'); state.token = 'fixture'; state.user = { id: GO.local('user', uid), nickname: '自己' };
        state.page = 'messages'; renderShell(); await loadConversations();
      }, uid);
      await page.evaluate(cid => openConversation(GO.local('conversation', cid), { focusInput: false }), cid);
      await page.waitForFunction(() => !state.initialHistory);
      const samples = [];
      for (const count of [400, 2000]) {
        const sample = await page.evaluate(count => {
          const seed = visibleConversationMessages().find(message => message.type === 'text');
          state.messageVersions = new Map(); syncPulseMessageCache().clear();
          const rows = Array.from({ length: count }, (_, i) => ({ ...seed, id: i + 1, body: { ...seed.body, text: '消息 ' + (i + 1), _go_wire_id: '44444444-4444-4444-8444-' + String(i + 1).padStart(12, '0') } }));
          renderConversationMessages(initialSnapshotMessages(rows)); bindMessageActions();
          const query = Element.prototype.querySelectorAll;
          let scans = 0, visited = 0;
          Element.prototype.querySelectorAll = function (selector) {
            const result = query.call(this, selector);
            if (this.id === 'messages' && selector === '.bubble[data-message-id]') { scans++; visited += result.length; }
            return result;
          };
          const started = performance.now();
          try {
            rows[rows.length - 1].body.text += ' 更新';
            renderConversationMessages(initialSnapshotMessages(rows)); bindMessageActions();
            return { count, scans, visited, durationMS: Math.round(performance.now() - started) };
          } finally { Element.prototype.querySelectorAll = query; }
        }, count);
        samples.push(sample);
        assert.ok(sample.scans <= 1, `${platform}: ${sample.count} 条消息触发 ${sample.scans} 次全列表扫描`);
        assert.ok(sample.visited <= count);
      }
      // Exercise the actual menu and delegated selection handlers after a large render.
      await page.locator('.bubble[data-message-id="2000"]').click({ button: 'right' });
      await page.getByRole('menuitem', { name: '选择此消息', exact: true }).click();
      assert.equal(await page.locator('[data-selection-count]').textContent(), '已选择 1 条消息');
      await page.locator('[data-message-select="1999"]').click();
      assert.equal(await page.locator('[data-selection-count]').textContent(), '已选择 2 条消息');
      await page.evaluate(() => { renderConversationMessages(visibleConversationMessages()); bindMessageActions(); });
      assert.equal(await page.locator('.message-is-selected').count(), 2);
      await page.locator('[data-selection-cancel]').click();
      assert.equal(await page.locator('[data-message-select]').count(), 0);
      await page.locator('.bubble[data-message-id="2000"]').click({ button: 'right' });
      await page.getByRole('menuitem', { name: '选择此消息', exact: true }).click();
      await page.evaluate(() => { state.token = 'different-account'; PulseMessageActions.activate(); });
      assert.equal(await page.locator('[data-message-select]').count(), 0);
      assert.equal(await page.locator('.message-is-selected').count(), 0);
      assert.deepEqual(errors, []);
      results.push({ platform, samples, selectionAndAccountIsolation: 'passed' });
      await page.close();
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
