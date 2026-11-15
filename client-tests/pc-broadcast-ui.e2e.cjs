// Exercise the real dialog with controlled delivery promises; no messages leave this fixture.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = process.argv[2] || path.join(root, '.local/artifacts/pc-broadcast-ui');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  async function fixture() {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error); });
    await page.route('**/*', route => route.abort());
    await page.route('http://127.0.0.1/broadcast-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><button id="open">群发消息</button><input id="outside" aria-label="聊天输入框"></body></html>' }));
    await page.goto('http://127.0.0.1/broadcast-fixture');
    await page.addStyleTag({ content: 'body{font:14px "Microsoft YaHei",sans-serif;background:#eaf3e7}.modal-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0005;box-sizing:border-box}' });
    await page.addStyleTag({ path: path.join(root, 'pc/web/broadcast-assistant.css') });
    await page.addScriptTag({ path: path.join(root, 'pc/web/broadcast-assistant.js') });
    await page.evaluate(() => {
      window.fixtureAccount = { token: 'fixture-token', userId: 1, internalStaff: true, blocked: false };
      window.calls = []; window.uploads = []; window.sentCallbacks = 0; window.revokedCallbacks = 0;
      window.revokedPreviews = [];
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => { revokedPreviews.push(url); revoke(url); };
      function pending(list, details, signal) {
        return new Promise((resolve, reject) => {
          const call = { ...details, aborted: false, settled: false };
          const abort = () => { call.aborted = true; call.finish(null, new DOMException('已停止', 'AbortError')); };
          call.finish = (result = { complete: true }, error) => {
            if (call.settled) return;
            call.settled = true; signal.removeEventListener('abort', abort);
            if (error) reject(Object.assign(new Error(error.message || '请求失败'), error));
            else resolve(result);
          };
          list.push(call);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      window.assistant = PulseBroadcastAssistant.create({
        getAccount: () => fixtureAccount,
        request: (url, options) => {
          if (url.startsWith('/internal/broadcast/targets?')) {
            const type = new URLSearchParams(url.split('?')[1]).get('type');
            return Promise.resolve({ items: type === 'friend' ? Array.from({ length: 9 }, (_, index) => ({ id: index + 1, type, name: '测试好友 ' + (index + 1), username: 'fixture' + (index + 1) })) : [], total: type === 'friend' ? 9 : 0, snapshot_max_id: '11111111-1111-4111-8111-111111111111', has_more: false });
          }
          if (url !== '/internal/broadcast/send') throw new Error('Unexpected request: ' + url);
          return pending(calls, { body: JSON.parse(options.body), token: options.authToken }, options.signal);
        },
        upload: (kind, file, token, signal) => pending(uploads, { kind, name: file.name, token }, signal),
        mediaUrl: value => value,
        onSent: () => sentCallbacks++,
        onPermissionRevoked: () => { revokedCallbacks++; fixtureAccount.internalStaff = false; },
      });
      document.querySelector('#open').onclick = () => assistant.open();
      window.escapePrevented = [];
      document.addEventListener('keydown', event => { if (event.key === 'Escape') escapePrevented.push(event.defaultPrevented); });
    });
    await page.click('#open');
    await page.waitForFunction(() => document.querySelectorAll('[data-broadcast-target]').length === 9 && !document.querySelector('[data-broadcast-all]').disabled);
    await page.check('[data-broadcast-all]');
    await page.uncheck('[data-broadcast-target="friend:9"]');
    await page.fill('[data-broadcast-text]', '后台群发测试');
    return { page, errors };
  }
  async function send(page) {
    await page.click('[data-broadcast-send]');
    await page.waitForFunction(() => calls.length > 0 || uploads.length > 0);
  }
  async function finishTargets(page, start = 0) {
    for (let index = start; index < 8; index++) {
      await page.waitForFunction(index => calls.length > index, index);
      await page.evaluate(index => calls[index].finish(), index);
    }
    await page.waitForFunction(() => sentCallbacks === 1);
    const sent = await page.evaluate(() => calls.map(call => ({ id: call.body.target.id, requestId: call.body.request_id, messages: call.body.messages, token: call.token, aborted: call.aborted })));
    assert.deepEqual(sent.map(call => call.id), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(new Set(sent.map(call => call.requestId)).size, 1);
    assert.ok(sent.every(call => call.token === 'fixture-token' && !call.aborted));
    assert.ok(sent.every(call => call.messages[0].body.text === '后台群发测试'));
    return sent;
  }
  async function record(name, fixture, extra = {}) {
    assert.deepEqual(fixture.errors, []);
    results.push({ name, passed: true, ...extra });
    await fixture.page.close();
  }
  try {
    // Close immediately, continue delivery, reopen in flight, and close again.
    let f = await fixture(), page = f.page;
    await send(page);
    await page.click('[data-broadcast-close]');
    assert.equal(await page.locator('#broadcast-modal').count(), 0);
    assert.equal(await page.evaluate(() => calls[0].aborted), false);
    await page.evaluate(() => calls[0].finish());
    await page.waitForFunction(() => calls.length === 2);
    await page.focus('#outside'); await page.keyboard.press('Escape'); await page.keyboard.type('仍可聊天');
    assert.equal(await page.inputValue('#outside'), '仍可聊天');
    assert.deepEqual(await page.evaluate(() => escapePrevented), [false]);
    await page.click('#open');
    assert.equal(await page.locator('[data-broadcast-send]').isDisabled(), true);
    assert.equal(await page.locator('[data-broadcast-target="friend:1"]').locator('..').locator('small').innerText(), '已发送');
    assert.equal(await page.inputValue('[data-broadcast-text]'), '后台群发测试');
    await page.click('[data-broadcast-close]');
    const sent = await finishTargets(page, 1);
    await page.click('#open');
    assert.match(await page.locator('[data-broadcast-status]').innerText(), /群发完成，已发送至 8 个目标/);
    assert.equal(await page.inputValue('[data-broadcast-text]'), '');
    assert.equal(await page.locator('.broadcast-target small').allTextContents().then(items => items.filter(item => item === '已发送').length), 8);
    await page.screenshot({ path: path.join(output, 'closed-dialog-delivery-completed.png') });
    await record('close and reopen continues exactly eight selected recipients once', f, { targets: sent.map(call => call.id) });

    // Closing while an attachment is still uploading must preserve that upload.
    f = await fixture(); page = f.page;
    await page.setInputFiles('[data-broadcast-file="image"]', { name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZV8AAAAASUVORK5CYII=', 'base64') });
    await send(page); await page.waitForFunction(() => uploads.length === 1);
    await page.click('[data-broadcast-close]');
    assert.deepEqual(await page.evaluate(() => ({ aborted: uploads[0].aborted, revoked: revokedPreviews.length, targets: calls.length })), { aborted: false, revoked: 0, targets: 0 });
    await page.evaluate(() => uploads[0].finish({ url: 'pulse-media:22222222-2222-4222-8222-222222222222', mime: 'image/png', size: 68 }));
    const mediaSent = await finishTargets(page);
    assert.ok(mediaSent.every(call => call.messages.length === 2 && call.messages[1].type === 'image'));
    assert.equal(await page.evaluate(() => revokedPreviews.length), 1);
    await record('closing during upload preserves the attachment and all recipients', f);

    for (const method of ['escape', 'backdrop']) {
      f = await fixture(); page = f.page;
      await send(page);
      if (method === 'escape') await page.keyboard.press('Escape');
      else await page.locator('#broadcast-modal').click({ position: { x: 2, y: 2 } });
      assert.equal(await page.locator('#broadcast-modal').count(), 0);
      await finishTargets(page);
      await record(method + ' dismisses the window without stopping delivery', f);
    }

    // Explicit cancellation remains distinct from closing the window.
    f = await fixture(); page = f.page;
    await send(page); await page.click('[data-broadcast-cancel]');
    await page.waitForFunction(() => calls[0].aborted && document.querySelector('[data-broadcast-send]').textContent === '继续发送');
    assert.equal(await page.evaluate(() => calls.length), 1);
    assert.match(await page.locator('[data-broadcast-status]').innerText(), /已停止群发/);
    await page.click('[data-broadcast-send]');
    await page.waitForFunction(() => calls.length === 2);
    assert.equal(await page.evaluate(() => calls[0].body.request_id === calls[1].body.request_id), true);
    await page.evaluate(() => assistant.close());
    await record('explicit stop cancels and retry keeps the idempotency key', f);

    f = await fixture(); page = f.page;
    await send(page); await page.click('[data-broadcast-close]');
    await page.evaluate(() => { assistant.close(); fixtureAccount.token = ''; fixtureAccount.userId = 0; });
    await page.waitForFunction(() => calls[0].aborted);
    assert.equal(await page.evaluate(() => calls.length), 1);
    await record('account teardown aborts a hidden job', f);

    for (const change of ['account', 'permission']) {
      f = await fixture(); page = f.page;
      await send(page); await page.click('[data-broadcast-close]');
      await page.evaluate(change => {
        if (change === 'account') { fixtureAccount.token = 'different-token'; fixtureAccount.userId = 2; calls[0].finish(); }
        else calls[0].finish(null, { status: 403, code: 'INTERNAL_STAFF_REQUIRED', message: '权限已撤销' });
      }, change);
      // Flush the send promise and its continuation before checking subsequent targets.
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
      assert.equal(await page.evaluate(() => calls.length), 1);
      if (change === 'permission') assert.equal(await page.evaluate(() => revokedCallbacks), 1);
      await record(change + ' change prevents further background recipients', f);
    }

    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: results.length, results }, null, 2));
    console.log(JSON.stringify({ passed: results.length, output, results }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
