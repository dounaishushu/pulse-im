// Exercise the shipping PC profile and force-add flow against isolated HTTP fixtures.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), output = path.resolve(process.argv[2] || path.join(root, '.local/artifacts/pc-contact-remarks'));
const switchBaseline = process.argv.includes('--switch-baseline');
const baseline = process.argv.includes('--baseline') || switchBaseline; fs.mkdirSync(output, { recursive: true });
const uid = '11111111-1111-4111-8111-111111111111', peer = '22222222-2222-4222-8222-222222222222', cid = '33333333-3333-4333-8333-333333333333', mid = '44444444-4444-4444-8444-444444444444';
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, bytes) => { if (error) { res.writeHead(404).end(); return; } res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream'); res.end(bytes); });
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, browser = await chromium.launch({ headless: true, executablePath: process.env.PULSE_BROWSER_EXECUTABLE });
  const results = [], errors = [];
  const check = (name, passed) => { results.push({ name, passed }); if (!baseline) assert.equal(passed, true, name); };
  async function fixture({ staff = true, friend = false, stale = 0, avatar = false, chats = false, deferredNames = false } = {}) {
    const model = { staff, friend, stale, avatar, remark: chats ? '11/18 河南 男26' : '', version: 0, forceCalls: 0, profileCalls: 0, grants: 0, writes: [], forceDenied: false, holdProfile: null, holdForce: null, holdWrite: null, unavailableAfter: Infinity };
    const otherPeer = '55555555-5555-4555-8555-555555555555', otherChat = '66666666-6666-4666-8666-666666666666';
    if (deferredNames) model.holdNames = new Promise(resolve => { model.releaseNames = resolve; });
    const page = await browser.newPage({ viewport: { width: 1120, height: 850 } }); page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ base }) => {
      window.PULSE_API_BASE = base;
      window.pulseDesktop = { isDesktop: true, production: false, apiBaseUrl: base, appVersion: '2.4.173' };
      localStorage.setItem('pulse_go_v2:' + encodeURIComponent(base) + ':token', 'fixture');
    }, { base: origin + '/api/v2' });
    await page.route('**/go-realtime.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.PulseGoRealtime={connect:async()=>({close(){}})};' }));
    await page.route('**/api/v2/**', async route => {
      const request = route.request(), url = new URL(request.url()), p = url.pathname.replace('/api/v2', ''); let data = {};
      const profile = () => ({ id: peer, account: 'peer', nickname: chats ? 'AA1' : '测试好友', is_contact: model.friend, remark: model.remark, group_name: '工作', contact_version: String(model.version), version: '1', ...(model.avatar ? { avatar_id: mid } : {}) });
      const conversation = id => ({ id, kind: 'direct', peer_id: id === cid ? peer : otherPeer, peer_name: id === cid ? 'AA1' : '另一位好友', my_role: 'member', can_send: true, temporary: false,
        message_seq: '0', event_seq: '0', membership_version: '1', visible_from_seq: '1', preference_version: '1', unread_count: '0', updated_at: '2026-11-18T00:00:00Z',
        state: { clear_seq: '0', read_seq: '0', delivered_seq: '0', personal_seq: '0', version: '1' } });
      if (p === '/client/update') data = { required: false };
      else if (p === '/client/config') data = { releases: {}, display: {}, registration: {} };
      else if (p === '/me' || p === '/me/profile') data = { id: uid, account: 'staff', nickname: '当前账号', internal_staff: model.staff, version: '1' };
      else if (p === '/client/conversation-page' || p === '/conversations') data = { items: chats ? [conversation(cid), conversation(otherChat)] : [], total: chats ? 2 : 0, page: 1, size: 30 };
      else if (chats && (p === '/conversations/' + cid || p === '/conversations/' + otherChat || p === '/conversations/' + cid + '/open' || p === '/conversations/' + otherChat + '/open')) data = conversation(p.split('/')[2]);
      else if (chats && p === '/client/conversation-updates') data = { incremental: true, items: request.postDataJSON().conversation_ids.map(conversation), removed_ids: [] };
      else if (chats && p.endsWith('/history')) data = { items: [], membership_version: '1', snapshot_max_seq: '0', next_after_seq: '0', next_before_seq: '0', has_more: false, visible_from_seq: '1', clear_seq: '0' };
      else if (chats && p.endsWith('/personal-sync')) data = { events: [], snapshot_max_seq: '0', next_after_seq: '0', has_more: false };
      else if (chats && p.endsWith('/sync')) data = { events: [], membership_version: '1', snapshot_max_seq: '0', next_after_seq: '0', visible_from_seq: '1', has_more: false };
      else if (p === '/client/friend-page') {
        data = { items: model.friend ? [profile()] : [], total: model.friend ? 1 : 0, page: Number(url.searchParams.get('page') || 1), size: Number(url.searchParams.get('size') || 100) };
        if (model.holdNames) await model.holdNames;
      }
      else if (p === '/profiles/' + peer) {
        model.profileCalls++; const captured = profile();
        if (model.profileCalls > model.unavailableAfter) { await route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } }); return; }
        if (model.stale-- > 0) captured.is_contact = false;
        if (model.holdProfile) await model.holdProfile;
        data = captured;
      } else if (p === '/staff/users/' + peer) data = { id: peer, nickname: '测试好友', logins: [], registration_ip: '127.0.0.1' };
      else if (p === '/blocks') data = { items: [] };
      else if (p === '/friends/direct-add') {
        model.forceCalls++; if (model.holdForce) await model.holdForce;
        if (model.forceDenied) { await route.fulfill({ status: 403, json: { error: { code: 'forbidden' } } }); return; }
        model.friend = true; data = { conversation_id: cid };
      } else if (p === '/friends/' + peer + '/metadata') {
        const input = request.postDataJSON();
        if (model.holdWrite) await model.holdWrite;
        if (!model.friend) { await route.fulfill({ status: 403, json: { error: { code: 'forbidden' } } }); return; }
        assert.equal(input.expected_version, String(model.version)); assert.equal(input.group_name, '工作');
        model.writes.push(input); model.remark = input.remark; model.version++; data = { version: String(model.version) };
      } else if (p.includes('/media/')) { model.grants++; await route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } }); return; }
      else data = { items: [] };
      try { await route.fulfill({ json: data }); } catch (error) { if (!page.isClosed() && !/Target.*closed/.test(error.message)) throw error; }
    });
    await page.goto(origin + '/pc/web/index.html'); await page.waitForFunction(() => state.user && state.token === 'fixture');
    async function open() { await page.evaluate(peer => { window.__peer = GO.local('user', peer); void openContactProfile(__peer); }, peer); await page.waitForSelector('#profile-remark'); }
    async function chat(id = cid) { await page.evaluate(async id => { await openConversation(GO.local('conversation', id), { focusInput: false }); }, id); await page.waitForFunction(() => !state.initialHistory); }
    return { page, model, open, chat, otherChat };
  }
  try {
    if (!baseline || switchBaseline) {
      let switched = await fixture({ friend: true, chats: true });
      await switched.page.waitForFunction(() => contactNames.resolve(GO.local('user', '22222222-2222-4222-8222-222222222222'), '') === '11/18 河南 男26');
      await switched.chat();
      check('opening a direct chat uses the same saved remark as its conversation row', await switched.page.locator('#chat-title').textContent() === switched.model.remark);
      await switched.chat(switched.otherChat); await switched.chat();
      check('switching away and back never restores the raw nickname over a saved remark', await switched.page.locator('#chat-title').textContent() === switched.model.remark);
      await switched.page.screenshot({ path: path.join(output, switchBaseline ? 'switch-before.png' : 'switch-after.png') });
      if (!switchBaseline) {
        await switched.page.click('#chat-avatar'); await switched.page.waitForSelector('#profile-remark');
        check('the real header opens an editable confirmed friend profile after a chat switch', await switched.page.locator('#profile-remark').isEditable());
        let releaseWrite; switched.model.holdWrite = new Promise(resolve => { releaseWrite = resolve; });
        await switched.page.fill('#profile-remark', '切换后保留的新备注');
        const submitted = switched.page.waitForRequest(request => request.url().endsWith('/metadata') && request.method() === 'PUT');
        await switched.page.press('#profile-remark', 'Enter'); await submitted;
        await switched.chat(switched.otherChat); releaseWrite(); switched.model.holdWrite = null;
        await switched.page.waitForFunction(() => contactNames.resolve(GO.local('user', '22222222-2222-4222-8222-222222222222'), '') === '切换后保留的新备注');
        check('a save finishing after navigation updates only its own peer and preserves the current chat title', switched.model.writes.length === 1 && await switched.page.locator('#chat-title').textContent() === '另一位好友');
        await switched.chat();
        check('returning after a pending save retains the confirmed remark', await switched.page.locator('#chat-title').textContent() === '切换后保留的新备注');
        await switched.page.evaluate(async () => { await loadConversations(); });
        check('a fresh conversation snapshot cannot overwrite the confirmed remark with the public nickname', await switched.page.locator('#chat-title').textContent() === '切换后保留的新备注');
        await switched.page.click('#chat-avatar'); await switched.page.waitForSelector('#profile-remark');
        await switched.page.fill('#profile-remark', ''); await switched.page.press('#profile-remark', 'Enter');
        await switched.page.waitForFunction(() => document.querySelector('#profile-feedback').textContent.includes('备注已保存'));
        check('clearing a remark restores the public nickname in the active title and conversation list', await switched.page.locator('#chat-title').textContent() === 'AA1'
          && await switched.page.locator('.conversation.active .conversation-copy strong').textContent() === 'AA1');
        await switched.page.evaluate(() => closeFeatureModal()); await switched.chat(switched.otherChat); await switched.chat();
        check('a cleared remark stays cleared across later chat switches', await switched.page.locator('#chat-title').textContent() === 'AA1');
      }
      await switched.page.close();
      switched = await fixture({ friend: true, chats: true, deferredNames: true }); await switched.chat();
      check('before contact metadata arrives the direct header safely uses the public nickname', await switched.page.locator('#chat-title').textContent() === 'AA1');
      await switched.page.fill('#message-input', '正在输入的消息不能被备注刷新清空');
      await switched.page.evaluate(() => window.remarkRefreshMessages = document.getElementById('messages'));
      switched.model.releaseNames(); switched.model.holdNames = null;
      await switched.page.waitForFunction(() => contactNames.resolve(GO.local('user', '22222222-2222-4222-8222-222222222222'), '') === '11/18 河南 男26');
      check('late contact metadata refreshes the active header without reopening the chat', await switched.page.locator('#chat-title').textContent() === switched.model.remark);
      check('updating the header preserves the chat view and unsent draft', await switched.page.evaluate(() => remarkRefreshMessages === document.getElementById('messages'))
        && await switched.page.inputValue('#message-input') === '正在输入的消息不能被备注刷新清空');
      await switched.page.close();
      if (switchBaseline) {
        const report = { reproduced: results.some(r => !r.passed), results, errors };
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); return;
      }
    }
    let f = await fixture({ friend: true, stale: 1 }); await f.open();
    if (!baseline) await f.page.waitForFunction(() => !document.querySelector('#profile-remark').disabled);
    check('a fresh relationship check enables a stale readonly profile', !(await f.page.locator('#profile-remark').isDisabled()));
    check('relationship verification reads the server again', f.model.profileCalls >= 2);
    await f.page.screenshot({ path: path.join(output, 'relationship-' + (baseline ? 'before' : 'after') + '.png') }); await f.page.close();
    if (baseline) {
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ reproduced: results.some(r => !r.passed), results, errors }, null, 2));
      console.log(JSON.stringify({ reproduced: results.some(r => !r.passed), results, errors })); return;
    }
    f = await fixture(); await f.open();
    await f.page.waitForSelector('#profile-add-contact');
    check('an unconfirmed nonfriend remains readonly until an authorized add', await f.page.locator('#profile-remark').isDisabled() && f.model.forceCalls === 0);
    await f.page.click('#profile-add-contact'); await f.page.waitForFunction(() => !document.querySelector('#profile-remark').disabled);
    check('staff can establish the missing friendship inside the same profile', f.model.forceCalls === 1 && await f.page.locator('#profile-remark').isEditable());
    await f.page.fill('#profile-remark', '强加后的备注'); await f.page.press('#profile-remark', 'Enter');
    await f.page.waitForFunction(() => document.querySelector('#profile-feedback').textContent.includes('备注已保存'));
    check('the new friend remark is saved with its current metadata version', f.model.remark === '强加后的备注' && f.model.writes.length === 1 && f.model.writes[0].expected_version === '0');
    check('confirmed remarks update the account name controller', await f.page.evaluate(() => contactNames.resolve(__peer, '') === '强加后的备注'));
    await f.page.screenshot({ path: path.join(output, 'staff-add-and-remark.png') });
    await f.page.evaluate(() => closeFeatureModal()); await f.open();
    check('reopening retains the saved remark and editable state', await f.page.inputValue('#profile-remark') === '强加后的备注' && await f.page.locator('#profile-remark').isEditable());
    await f.page.close();
    f = await fixture(); await f.open(); f.model.friend = true;
    await f.page.click('#profile-refresh-contact'); await f.page.waitForFunction(() => !document.querySelector('#profile-remark').disabled);
    check('manual refresh reflects an external force-add without another write', f.model.forceCalls === 0 && await f.page.locator('#profile-remark').isEditable()); await f.page.close();
    f = await fixture(); await f.open(); await f.page.waitForFunction(() => !document.querySelector('#profile-refresh-contact').disabled);
    f.model.friend = true; await f.page.evaluate(() => handleSocketPacket({ type: 'notification.updated' }));
    await f.page.waitForFunction(() => !document.querySelector('#profile-remark').disabled);
    check('friend notifications refresh a readonly profile in place', f.model.forceCalls === 0 && await f.page.locator('#profile-remark').isEditable()); await f.page.close();
    f = await fixture(); f.model.forceDenied = true; await f.open(); await f.page.click('#profile-add-contact');
    await f.page.waitForFunction(() => document.querySelector('#profile-feedback').textContent.includes('没有操作权限'));
    check('a denied staff add never enables or saves the remark', await f.page.locator('#profile-remark').isDisabled() && f.model.writes.length === 0); await f.page.close();
    f = await fixture({ staff: false }); await f.open();
    check('ordinary users do not receive the staff force-add control', await f.page.locator('#profile-add-contact').count() === 0 && await f.page.locator('#profile-remark').isDisabled()); await f.page.close();
    f = await fixture(); f.model.unavailableAfter = 1; await f.open();
    await f.page.waitForFunction(() => document.querySelector('[data-profile-relationship-status]').textContent.includes('确认失败'));
    check('a failed check stays readonly and provides a retry', await f.page.locator('#profile-remark').isDisabled() && await f.page.locator('#profile-refresh-contact').isEnabled());
    f.model.unavailableAfter = Infinity; f.model.friend = true; await f.page.click('#profile-refresh-contact');
    await f.page.waitForFunction(() => !document.querySelector('#profile-remark').disabled);
    check('retry confirms the actual friend without force-adding again', f.model.forceCalls === 0 && await f.page.locator('#profile-remark').isEditable()); await f.page.close();
    f = await fixture(); await f.open(); await f.page.waitForFunction(() => !document.querySelector('#profile-refresh-contact').disabled);
    let releaseCheck; f.model.holdProfile = new Promise(resolve => { releaseCheck = resolve; });
    const previousReads = f.model.profileCalls; await f.page.click('#profile-refresh-contact');
    await f.page.waitForFunction(() => document.querySelector('#profile-refresh-contact').disabled);
    const added = f.page.waitForResponse(response => response.url().endsWith('/friends/direct-add') && response.status() === 200);
    await f.page.click('#profile-add-contact'); await added;
    releaseCheck(); f.model.holdProfile = null;
    await f.page.waitForFunction(() => !document.querySelector('#profile-remark').disabled);
    check('an old readonly response cannot supersede the force-add confirmation', f.model.forceCalls === 1 && f.model.profileCalls >= previousReads + 2); await f.page.close();
    f = await fixture({ friend: true }); await f.open(); f.model.avatar = true;
    await f.page.fill('#profile-remark', '头像失败也能备注'); await f.page.press('#profile-remark', 'Enter');
    await f.page.waitForFunction(() => document.querySelector('#profile-feedback').textContent.includes('备注已保存'));
    check('saving a remark never waits on the unrelated avatar grant', f.model.remark === '头像失败也能备注' && f.model.grants === 0); await f.page.close();
    f = await fixture(); await f.open(); await f.page.waitForFunction(() => !document.querySelector('#profile-refresh-contact').disabled);
    let release; f.model.holdForce = new Promise(resolve => { release = resolve; });
    await f.page.click('#profile-add-contact'); await f.page.waitForFunction(() => document.querySelector('#profile-add-contact').disabled);
    await f.page.evaluate(() => { closeFeatureModal(); state.token = 'replacement'; GO.session(state.token); }); release();
    await f.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    check('a late add response cannot reopen a profile or write under another account', await f.page.locator('[data-contact-profile]').count() === 0 && f.model.writes.length === 0); await f.page.close();
    // Use the actual existing search-result capture handler, not a mock force-add helper.
    f = await fixture();
    await f.page.evaluate(peer => {
      const id = GO.local('user', peer);
      document.body.insertAdjacentHTML('beforeend', `<div data-feature-modal class="modal-backdrop feature-modal"><section class="feature-card"><div class="contact-search-user"><button data-add-contact="${id}">加好友</button></div></section></div>`);
    }, peer);
    await f.page.click('[data-add-contact]'); await f.page.waitForSelector('#profile-remark');
    check('the existing search force-add opens an editable confirmed friend profile', f.model.forceCalls === 1 && await f.page.locator('#profile-remark').isEditable()); await f.page.close();
    assert.deepEqual(errors, []);
    const report = { passed: results.length, results, errors }; fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
