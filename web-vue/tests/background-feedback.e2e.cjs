// Inject real background and foreground failures into the Vue workspace.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = process.env.PULSE_FEEDBACK_TEST_OUTPUT || path.join(repo, '.local/background-feedback-ui');
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';
const self = uuid(1), peer = uuid(2), cid = n => uuid(9000 + n), mid = n => uuid(20000 + n);
const model = { failures: new Map(), calls: [], seq: 1, items: [], title: '后台刷新测试' };
const checks = [], errors = [];
let server, browser, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
async function waitFor(test) {
  for (let n = 0; n < 300; n++) {
    if (await test()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error('condition did not become true');
}
const summary = n => ({ id: cid(n), kind: 'direct', title: model.title, peer_id: peer, peer_name: model.title,
  can_send: true, visible_from_seq: '1', message_seq: String(model.seq), event_seq: String(model.seq), membership_version: '1', unread_count: '0',
  updated_at: '2026-11-24T04:00:00Z', state: { clear_seq: '0', read_seq: '0', delivered_seq: '0', personal_seq: '0', version: '1' } });
const message = (n, body, sender = peer) => ({ id: mid(n), conversation_id: cid(1), seq: String(n), event_seq: String(n),
  sender_id: sender, sender: { name: sender === self ? '我' : model.title }, kind: 'text', body, content: {}, version: '1',
  created_at: '2026-11-24T04:00:00Z', updated_at: '2026-11-24T04:00:00Z' });
model.items = [message(1, '已有消息保留')];
(async () => {
  fs.mkdirSync(output, { recursive: true }); process.chdir(root);
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', cacheDir: path.join(output, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
    plugins: [{ name: 'background-feedback-fixture', configureServer(vite) {
      vite.middlewares.use('/__feedback-test', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/background-feedback-fixture.ts"></script></html>');
      });
    } }],
  });
  await server.listen(); const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1050, height: 740 } }); page.setDefaultTimeout(7000);
  page.on('pageerror', cause => errors.push(cause.message));
  await page.addInitScript(() => { document.hasFocus = () => true; });
  await page.route('**/api/v2/**', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname.replace('/api/v2', ''), body = request.postDataJSON();
    model.calls.push({ path: p, method: request.method(), time: Date.now() });
    const failure = model.failures.get(p);
    if (failure) {
      if (failure.delay) await new Promise(resolve => setTimeout(resolve, failure.delay));
      if (failure.network) await route.abort('failed').catch(() => {});
      else await route.fulfill({ status: failure.status || 500, json: { error: { code: failure.code || 'internal' } } }).catch(() => {});
      return;
    }
    const match = p.match(/^\/conversations\/([^/]+)(.*)$/), c = match ? Number(match[1].slice(0, 8)) - 9000 : 0;
    let data = { items: [] };
    if (p === '/me' || p === '/me/profile') data = { id: self, user_id: self, account: 'me', nickname: '我', version: '1' };
    else if (p === '/client/conversation-page' || p === '/conversations') data = { items: [summary(1), summary(2)], total: 2, page: 1, size: 100 };
    else if (p === '/client/conversation-updates') data = { items: [summary(1), summary(2)].filter(row => body.conversation_ids.includes(row.id)), removed_ids: [], incremental: true };
    else if (p === '/client/friend-page') data = { items: [], total: 0, page: 1, size: 100 };
    else if (p === '/client/config') data = { registration: {}, display: {}, releases: {} };
    else if (p === '/client/update') data = { required: false };
    else if (p === '/notifications') data = { items: [], unread_count: 0 };
    else if (p.endsWith('/unread')) data = { count: '0', truncated: false };
    else if (match && (!match[2] || match[2] === '/open')) data = summary(c);
    else if (match && match[2] === '/history') data = { items: c === 1 ? model.items : [], membership_version: '1', snapshot_max_seq: String(model.seq), next_after_seq: String(model.seq), next_before_seq: '0', visible_from_seq: '1', clear_seq: '0', has_more: false };
    else if (match && match[2] === '/sync') data = { events: [], membership_version: '1', snapshot_max_seq: String(model.seq), next_after_seq: String(model.seq), visible_from_seq: '1', clear_seq: '0', has_more: false };
    else if (match && match[2] === '/personal-sync') data = { events: [], snapshot_max_seq: '0', next_after_seq: '0', has_more: false };
    else if (match && match[2] === '/message-receipts') data = { items: body.message_ids.map(id => ({ message_id: id, recipient_count: 1, delivered_count: 1, read_count: 0 })) };
    else if (match && match[2] === '/messages' && request.method() === 'POST') {
      const sent = message(++model.seq, body.body, self); model.items.push(sent); data = { message: sent };
    } else if (/\/(read|delivered)$/.test(p)) data = { version: '1', reminder: false };
    await route.fulfill({ json: data }).catch(() => {});
  });
  const noToast = async () => {
    assert.equal(await page.locator('.vue-global-feedback').count(), 0, 'automatic failures must not display the generic global toast');
    assert.equal(await page.evaluate(() => window.feedbackFixture.chat.issue.value), '');
  };
  const invoke = name => page.evaluate(async name => { await window.feedbackFixture.chat[name](); }, name);
  const clear = () => page.evaluate(() => { window.feedbackFixture.chat.issue.value = ''; });
  const calls = p => model.calls.filter(row => row.path === p).length;
  const syncPath = '/conversations/' + cid(1) + '/sync', readPath = '/conversations/' + cid(1) + '/read';
  const frame = packet => page.evaluate(packet => window.feedbackFixture.receive(packet), packet);
  try {
    await page.clock.install();
    await page.goto(origin + '/__feedback-test');
    await waitFor(() => page.evaluate(() => window.feedbackFixture?.ready.value));
    await page.getByText('已有消息保留', { exact: true }).waitFor();
    await invoke('sync'); await noToast();
    model.failures.set(syncPath, {}); await invoke('sync');
    await noToast(); assert.equal(await page.getByText('已有消息保留', { exact: true }).count(), 1);
    pass('automatic message-sync failures are silent and preserve existing messages');
    model.failures.set(syncPath, { network: true }); await invoke('sync'); await noToast();
    pass('a dropped network request does not become an unsolicited global toast');
    model.failures.delete(syncPath);
    model.failures.set(readPath, {});
    const read = await page.evaluate(() => window.feedbackFixture.chat.read(1));
    assert.equal(read, false); await noToast();
    model.failures.delete(readPath);
    assert.equal(await page.evaluate(() => window.feedbackFixture.chat.read(1)), true);
    await noToast(); pass('automatic read reporting fails quietly, returns failure and can retry successfully');
    model.failures.set('/client/conversation-updates', {});
    model.failures.set('/client/conversation-page', {});
    const fullBefore = calls('/client/conversation-page');
    await page.evaluate(() => { const f = window.feedbackFixture; f.chat.summary([f.chat.active.value.id]); });
    await waitFor(() => calls('/client/conversation-page') > fullBefore);
    await new Promise(resolve => setTimeout(resolve, 150)); await noToast();
    assert.equal(await page.evaluate(() => window.feedbackFixture.chat.conversations.value.length), 2);
    pass('incremental-directory failures and the fallback full refresh are silent and retain the current list');
    model.failures.set(syncPath, {});
    const reconnectBefore = calls('/client/conversation-page');
    await frame({ type: 'ready' }); await waitFor(() => calls('/client/conversation-page') > reconnectBefore);
    await invoke('sync'); await noToast();
    pass('realtime reconnection refreshes do not raise generic background errors');
    const resumeBefore = calls(syncPath);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => calls(syncPath) > resumeBefore); await invoke('sync'); await noToast();
    pass('returning online retries quietly instead of showing a new global error');
    const periodicBefore = calls(syncPath);
    await page.clock.fastForward(16000);
    await waitFor(() => calls(syncPath) > periodicBefore); await invoke('sync'); await noToast();
    await page.clock.resume();
    pass('the regular 15-second refresh remains silent while the service is unavailable');
    model.failures.clear(); model.title = '自动恢复后的会话';
    await frame({ type: 'ready' });
    await waitFor(() => page.evaluate(() => window.feedbackFixture.chat.active.value?.name === '自动恢复后的会话'));
    await noToast(); await page.screenshot({ path: path.join(output, 'quiet-recovery.png') });
    pass('background refresh recovers and updates the current chat after service returns without manual dismissal');
    await page.evaluate(() => window.feedbackFixture.chat.error(Error('主动操作失败，请重试')));
    await page.getByRole('alert').filter({ hasText: '主动操作失败，请重试' }).waitFor();
    await invoke('refresh');
    assert.equal(await page.locator('.vue-global-feedback').count(), 1, 'a successful background refresh must not dismiss an unrelated action failure');
    await clear(); pass('explicit user-operation feedback stays visible and is not cleared by background success');
    const sendPath = '/conversations/' + cid(1) + '/messages';
    model.failures.set(sendPath, { status: 403, code: 'forbidden' });
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('发送失败必须提示');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await waitFor(async () => await page.locator('.vue-outbox button').filter({ hasText: '重试' }).count() === 1);
    assert.match(await page.locator('.vue-outbox').textContent(), /发送失败必须提示/);
    model.failures.delete(sendPath); await page.locator('.vue-outbox button').filter({ hasText: '重试' }).click();
    await waitFor(async () => await page.locator('.vue-outbox').count() === 0);
    await page.getByText('发送失败必须提示', { exact: true }).waitFor();
    pass('an explicit failed send still shows its error and retry control, and retry succeeds');
    model.failures.set(syncPath, { status: 401, code: 'unauthorized' });
    const invalidBefore = await page.evaluate(() => window.feedbackFixture.invalidations.value);
    await invoke('sync');
    assert.ok(await page.evaluate(() => window.feedbackFixture.invalidations.value) > invalidBefore);
    model.failures.set(syncPath, { status: 426, code: 'client_update_required' });
    await invoke('sync');
    assert.ok(await page.evaluate(() => window.feedbackFixture.failures.some(cause => cause.status === 426)));
    pass('automatic requests still surface expired sessions and mandatory updates through their dedicated handlers');
    model.failures.set(syncPath, { delay: 350 });
    const staleBefore = calls(syncPath);
    const stale = invoke('sync'); await waitFor(() => calls(syncPath) > staleBefore);
    await page.evaluate(async id => { const f = window.feedbackFixture; await f.chat.choose(f.client.local('conversation', id)); }, cid(2));
    await stale; await noToast(); model.failures.clear();
    pass('an old request completing after navigation cannot show an unrelated error in the new chat');
    await page.evaluate(async id => { const f = window.feedbackFixture; await f.chat.choose(f.client.local('conversation', id)); }, cid(1));
    model.failures.set(readPath, { delay: 350, status: 401, code: 'unauthorized' });
    const staleReadBefore = calls(readPath), invalidationsBeforeRead = await page.evaluate(() => window.feedbackFixture.invalidations.value);
    const staleRead = page.evaluate(() => window.feedbackFixture.chat.read(1));
    await waitFor(() => calls(readPath) > staleReadBefore);
    await page.evaluate(async id => { const f = window.feedbackFixture; await f.chat.choose(f.client.local('conversation', id)); }, cid(2));
    assert.equal(await staleRead, false); await noToast();
    assert.equal(await page.evaluate(() => window.feedbackFixture.invalidations.value), invalidationsBeforeRead);
    model.failures.clear();
    pass('a delayed read-report failure from a conversation already closed cannot interrupt the new conversation');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, calls: model.calls }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, output }));
  } catch (cause) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: cause.stack, errors, calls: model.calls }, null, 2));
    throw cause;
  } finally { await browser?.close(); await server?.close(); }
})().catch(cause => { console.error(cause.stack); process.exitCode = 1; });
