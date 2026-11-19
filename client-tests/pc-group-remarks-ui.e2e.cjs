// Shipping PC page and Go adapter; all accounts, messages and writes are local fixtures.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), output = path.resolve(process.argv[2] || '.local/group-message-remarks-20261119/ui');
const baseline = process.argv.includes('--baseline');
const uuid = n => n.toString(16).padStart(8, '0') + '-abcd-4abc-8abc-0123456789ab';
const me = uuid(1), peer = uuid(1108), stranger = uuid(9000), owner = uuid(9001), group = uuid(100), otherGroup = uuid(101);
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname), file = path.resolve(root, '.' + relative);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  const source = baseline && relative === '/pc/web/app.js' ? path.join(root, '.local/group-message-remarks-20261119/baseline/pc/web/app.js') : file;
  fs.readFile(source, (error, bytes) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
    res.end(bytes);
  });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : {}) });
  const checks = [], errors = [], requests = [], contexts = [];
  const model = { failNames: true, remark: '我设置的好友备注', version: 1 };
  const check = (name, passed) => { checks.push({ name, passed }); assert.equal(passed, true, name); };
  const message = (id, sender = peer, cid = group) => ({ id: uuid(10000 + id + (cid === otherGroup ? 1000 : 0)), conversation_id: cid, sender_id: sender,
    sender: { id: sender, name: sender === peer ? '好友公开网名' : sender === me ? '当前用户昵称' : '非好友网名' }, kind: 'text', body: '群消息内容 ' + id,
    content: {}, seq: String(id), event_seq: String(id), version: '1', created_at: '2026-11-19T00:00:00Z' });
  const history = cid => cid === group ? Array.from({ length: 25 }, (_, i) => message(i + 1, i === 23 ? stranger : i === 24 ? me : peer)) : [message(1, peer, cid)];
  const row = cid => ({ id: cid, kind: 'group', title: cid === group ? '群备注测试' : '另一个群', my_role: 'member', owner_id: owner, can_send: true,
    message_seq: cid === group ? '25' : '1', event_seq: cid === group ? '25' : '1', visible_from_seq: '1', membership_version: '1', preference_version: '1',
    updated_at: '2026-11-19T00:00:00Z', unread_count: '0', last_message: history(cid).at(-1), state: { clear_seq: '0', read_seq: '25', delivered_seq: '25', personal_seq: '0', version: '1' } });
  const namesRequests = token => requests.filter(item => item.token === token && item.p === '/client/friend-page');
  async function fixture(token) {
    const context = await browser.newContext({ viewport: { width: 1140, height: 780 } }); contexts.push(context);
    const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
    await page.clock.install();
    await page.addInitScript(({ base, token }) => {
      window.pulseDesktop = { isDesktop: true, production: false, apiBaseUrl: base, windowKind: 'account' };
      localStorage.setItem('pulse_go_v2:' + encodeURIComponent(base) + ':token', token);
    }, { base: origin + '/api/v2', token });
    await page.route('**/go-realtime.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.PulseGoRealtime={connect:async()=>({close(){}})};' }));
    await page.route('**/api/v2/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.replace('/api/v2', ''), input = req.postDataJSON();
      requests.push({ token, p, method: req.method(), query: url.search, input });
      const privateRemark = () => token === 'viewer-a' ? model.remark : '另一个账号的备注';
      const profile = () => ({ id: peer, account: 'friend', nickname: '好友公开网名', is_contact: true, remark: privateRemark(), contact_version: String(model.version), version: '1' });
      let data = { items: [] }, status = 200;
      if (p === '/me' || p === '/me/profile') data = { id: token === 'viewer-a' ? me : uuid(2), account: token, nickname: '当前用户昵称', internal_staff: false, version: '1' };
      else if (p === '/client/update') data = { required: false };
      else if (p === '/client/config') data = { releases: {}, display: {}, registration: {} };
      else if (p === '/client/friend-page') {
        if (token === 'viewer-a' && model.failNames) { status = 503; data = { error: { code: 'unavailable' } }; }
        else {
          const page = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('size') || 100);
          const all = Array.from({ length: 112 }, (_, i) => ({ id: uuid(1000 + i), account: 'friend' + i, nickname: '好友公开网名', remark: i === 108 ? privateRemark() : '', is_contact: true }));
          data = { items: all.slice((page - 1) * size, page * size), page, size, total: all.length };
        }
      } else if (p === '/client/conversation-page' || p === '/conversations') data = { items: [row(group), row(otherGroup)], total: 2, page: 1, size: 30 };
      else if (p === '/client/conversation-updates') data = { items: input.conversation_ids.map(row), removed_ids: [], incremental: true };
      else if (p.startsWith('/groups/')) {
        if (p.endsWith('/member-profiles')) data = { items: [{ id: owner, nickname: '群主', role: 'owner' }], next_after: '', members_visibility: 'managers', search_scope: 'friends', query: '' };
        else data = { ...row(p.split('/')[2]), status: 'active', member_count: 200, member_limit: 500, members_visibility: 'managers', block_member_friend_requests: false };
      } else if (p === '/profiles/' + peer) data = profile();
      else if (p === '/friends/' + peer + '/metadata') {
        assert.equal(input.expected_version, String(model.version)); model.remark = input.remark; model.version++; data = { version: String(model.version) };
      } else if (p.startsWith('/conversations/')) {
        const cid = p.split('/')[2], count = cid === group ? '25' : '1';
        if (p.endsWith('/history')) data = { items: history(cid), membership_version: '1', snapshot_max_seq: count, next_after_seq: count, next_before_seq: '1', visible_from_seq: '1', clear_seq: '0', has_more: false };
        else if (p.endsWith('/personal-sync')) data = { events: [], snapshot_max_seq: '0', next_after_seq: '0', has_more: false };
        else if (p.endsWith('/sync')) data = { events: [], membership_version: '1', snapshot_max_seq: count, next_after_seq: count, visible_from_seq: '1', has_more: false };
        else if (p.split('/').length === 3 || p.endsWith('/open')) data = row(cid);
      }
      try { await route.fulfill({ status, json: data }); } catch (error) { if (!page.isClosed()) throw error; }
    });
    await page.goto(origin + '/pc/web/index.html'); await page.waitForFunction(() => state.conversations.length === 2 && !state.conversationListLoad);
    const open = async cid => { await page.evaluate(id => openConversation(GO.local('conversation', id), { focusInput: false }), cid); await page.waitForSelector('.group-message-sender'); };
    await open(group);
    return { page, open };
  }
  try {
    const { page, open } = await fixture('viewer-a');
    const label = '[data-message-id="1"] > .group-message-sender';
    check('an unavailable private directory uses the public name without hiding the message', await page.locator(label).textContent() === '好友公开网名');
    await page.fill('#message-input', '输入中的消息保持不变');
    await page.evaluate(() => { window.remarkMessages = document.getElementById('messages'); window.remarkRow = document.querySelector('[data-message-id="8"]'); });
    const failedReads = namesRequests('viewer-a').length; await page.clock.fastForward(2000); await page.waitForTimeout(30);
    check('a failed directory request has a backoff instead of retrying on each message or frame', namesRequests('viewer-a').length === failedReads);
    await page.locator('#messages').hover(); await page.mouse.wheel(0, -700); await page.clock.runFor(100); await page.waitForTimeout(150);
    await page.evaluate(() => { window.remarkScroll = remarkMessages.scrollTop; });
    model.failNames = false; await page.clock.fastForward(8000); await page.waitForTimeout(100);
    if (baseline) {
      const reproduced = await page.locator(label).textContent() === '好友公开网名'; assert.equal(reproduced, true);
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ reproduced, reason: 'The active group never retries a failed initial remark read', checks, requests, errors }, null, 2)); return;
    }
    await page.waitForFunction(() => document.querySelector('[data-message-id="1"] > .group-message-sender')?.textContent === '我设置的好友备注');
    check('the active group automatically recovers its private remarks without reopening the conversation', await page.locator(label).textContent() === model.remark);
    check('friend remarks beyond the first hundred contacts are loaded', namesRequests('viewer-a').some(item => new URLSearchParams(item.query).get('page') === '2'));
    check('every existing message from the same friend uses the viewing account remark', await page.locator('.group-message-sender').evaluateAll(nodes => nodes.slice(0, 23).every(node => node.textContent === '我设置的好友备注')));
    check('nonfriends and the current user retain their respective public names', await page.locator('[data-message-id="24"] > .group-message-sender').textContent() === '非好友网名' && await page.locator('[data-message-id="25"] > .group-message-sender').textContent() === '当前用户昵称');
    const retained = await page.evaluate(() => ({ list: remarkMessages === document.getElementById('messages'), row: remarkRow === document.querySelector('[data-message-id="8"]'), before: remarkScroll, after: remarkMessages.scrollTop, draft: document.getElementById('message-input').value }));
    fs.writeFileSync(path.join(output, 'retained-view.json'), JSON.stringify(retained, null, 2));
    check('the background name update retains the conversation, message nodes, scroll and unsent draft', retained.list && retained.row && Math.abs(retained.before - retained.after) <= 1 && retained.draft === '输入中的消息保持不变');
    check('avatar action labels use the same private remark', await page.locator('[data-group-avatar-message="1"]').getAttribute('title') === model.remark);
    const completedReads = namesRequests('viewer-a').length; await page.clock.fastForward(30000); await page.waitForTimeout(50);
    check('successful directory reads remain cached during repeated foreground ticks', namesRequests('viewer-a').length === completedReads);
    check('remark refreshes do not query individual member profiles or avatar grants', !requests.some(item => item.p.startsWith('/profiles/') || item.p.startsWith('/media/')));
    model.remark = '从另一台设备更新的备注'; await page.clock.fastForward(65000); await page.waitForFunction(() => document.querySelector('[data-message-id="1"] > .group-message-sender')?.textContent === '从另一台设备更新的备注');
    check('remarks changed elsewhere eventually refresh while staying in the same group', await page.locator(label).textContent() === model.remark);
    await page.evaluate(id => openContactProfile(GO.local('user', id), state.active.id), peer); await page.waitForSelector('#profile-remark:not([disabled])');
    await page.fill('#profile-remark', '群里修改的新备注'); await page.locator('#profile-remark').blur(); await page.waitForFunction(() => document.getElementById('profile-feedback')?.textContent.includes('备注已保存'));
    check('editing the real friend profile updates already visible group authors immediately', await page.locator(label).textContent() === '群里修改的新备注');
    await page.fill('#profile-remark', ''); await page.locator('#profile-remark').blur(); await page.waitForFunction(() => document.querySelector('[data-message-id="1"] > .group-message-sender')?.textContent === '好友公开网名');
    check('clearing a remark restores the public nickname for existing messages', await page.locator(label).textContent() === '好友公开网名');
    await page.fill('#profile-remark', '<img src=x onerror=alert(1)> 我的备注'); await page.locator('#profile-remark').blur(); await page.waitForFunction(() => document.getElementById('profile-feedback')?.textContent.includes('备注已保存'));
    check('a remark is rendered as text and cannot insert message markup', await page.locator(label).textContent() === model.remark && await page.locator(label + ' img').count() === 0);
    await page.fill('#profile-remark', '只属于我的好友备注'); await page.locator('#profile-remark').blur(); await page.waitForFunction(() => document.getElementById('profile-feedback')?.textContent.includes('备注已保存')); await page.evaluate(() => closeFeatureModal());
    await open(otherGroup); check('the same friend uses the private remark in another group', await page.locator(label).textContent() === model.remark);
    await open(group); check('returning to an existing group retains the remark instead of the original message name', await page.locator(label).textContent() === model.remark);
    await page.evaluate(() => { const first = visibleConversationMessages()[0]; handleSocketPacket({ type: 'message.new', data: { ...first, id: 26, body: { text: '新的群消息', _go_wire_id: '0000aaaa-abcd-4abc-8abc-0123456789ab', _go_version: '1' } } }); });
    await page.waitForSelector('[data-message-id="26"] > .group-message-sender');
    check('new incoming group messages use the same viewer remark', await page.locator('[data-message-id="26"] > .group-message-sender').textContent() === model.remark);
    check('private remarks never overwrite the public sender name in shared message data', await page.evaluate(() => visibleConversationMessages().filter(item => item.sender_name === '好友公开网名').every(item => item.sender_nickname === '好友公开网名')));
    const hiddenReads = namesRequests('viewer-a').length; await page.evaluate(() => { state.desktopAccountVisible = false; }); await page.clock.fastForward(65000); await page.waitForTimeout(40);
    check('a hidden account does not poll for group remarks', namesRequests('viewer-a').length === hiddenReads); await page.evaluate(() => { state.desktopAccountVisible = true; });
    const other = await fixture('viewer-b'); await other.page.waitForFunction(() => document.querySelector('[data-message-id="1"] > .group-message-sender')?.textContent === '另一个账号的备注');
    check('two viewing accounts see their own distinct remarks for the same group author', await other.page.locator(label).textContent() === '另一个账号的备注' && await page.locator(label).textContent() === '只属于我的好友备注');
    await page.screenshot({ path: path.join(output, 'group-remarks.png') }); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: checks.length, checks, errors, requests, scope: 'Production PC renderer with simulated HTTP failures and incoming events; no live account used' }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, output }));
  } finally { for (const context of contexts) await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
