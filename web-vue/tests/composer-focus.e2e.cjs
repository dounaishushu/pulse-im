// Real keyboard events; never refocus the editor between sending and typing.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = process.env.PULSE_COMPOSER_FOCUS_TEST_OUTPUT || path.join(repo, '.local/composer-focus-ui');
const checks = [], errors = [];
let server, browser, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
async function waitFor(test) {
  for (let n = 0; n < 200; n++) {
    if (await test()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('condition did not become true');
}
(async () => {
  fs.mkdirSync(output, { recursive: true }); process.chdir(root);
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(output, 'vite-cache'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
    plugins: [{ name: 'composer-focus-fixture', configureServer(vite) {
      vite.middlewares.use('/__composer-focus', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/composer-focus-fixture.ts"></script></html>');
      });
    } }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
  page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
  // A controllable renderer blur models the platform-dependent failure during
  // document replacement. Unarmed cases use normal browser focus behavior.
  await page.addInitScript(() => {
    localStorage.clear();
    const remove = Node.prototype.removeChild;
    window.focusDrops = 0;
    Node.prototype.removeChild = function(child) {
      const editor = document.getElementById('message-input');
      const drop = window.dropEditorFocus && editor?.contains(this) && document.activeElement === editor;
      const result = remove.call(this, child);
      if (drop) {
        window.dropEditorFocus = false;
        window.focusDrops++;
        editor.blur();
      }
      return result;
    };
  });
  await page.route('**/api/v2/**', route => route.abort('blockedbyclient'));
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  const editor = page.getByRole('textbox', { name: '输入消息', exact: true });
  const other = page.getByRole('textbox', { name: '其他输入框', exact: true });
  const sent = () => page.evaluate(() => window.focusFixture.sent.length);
  const focused = () => editor.evaluate(element => document.activeElement === element);
  const cleared = () => waitFor(async () => (await editor.textContent()) === '');
  const fresh = async () => {
    await page.goto(origin + '/__composer-focus');
    await editor.waitFor();
    await page.evaluate(() => {
      localStorage.removeItem('pulse_setting_send_ctrl_enter');
      window.dispatchEvent(new Event('pulse:preferences'));
    });
  };
  try {
    await fresh();
    await editor.click();
    for (const text of ['first', 'second', '连续输入中文']) {
      await page.keyboard.insertText(text);
      assert.equal(await editor.textContent(), text);
      await page.keyboard.press('Enter');
      await cleared();
      assert.equal(await focused(), true, 'Enter must leave the editor focused');
    }
    assert.equal(await sent(), 3);
    assert.deepEqual(await page.evaluate(() => window.focusFixture.sent.map(item => item.body.text)), ['first', 'second', '连续输入中文']);
    pass('three consecutive Enter sends accept the next message immediately without clicking the editor');

    await page.keyboard.type('renderer focus regression');
    await page.evaluate(() => { window.dropEditorFocus = true; });
    await page.keyboard.press('Enter');
    await cleared();
    assert.equal(await page.evaluate(() => window.focusDrops), 1);
    assert.equal(await focused(), true, 'clearing a focused editor must recover a renderer blur');
    await page.keyboard.type('next');
    assert.equal(await editor.textContent(), 'next');
    pass('a renderer blur while clearing sent content restores both keyboard focus and the caret');

    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line two');
    assert.equal(await sent(), 4);
    await page.keyboard.press('Enter');
    await cleared();
    assert.equal(await page.evaluate(() => window.focusFixture.sent.at(-1).body.text), 'next\nline two');
    assert.equal(await focused(), true);
    pass('Shift+Enter inserts a newline and Enter sends the multiline draft while retaining focus');

    await page.evaluate(() => { localStorage.setItem('pulse_setting_send_ctrl_enter', '1'); window.dispatchEvent(new Event('pulse:preferences')); });
    await page.keyboard.type('ctrl mode');
    await page.keyboard.press('Enter');
    assert.equal(await sent(), 5);
    await page.keyboard.type('next line');
    await page.keyboard.press('Control+Enter');
    await cleared();
    assert.equal(await focused(), true);
    await page.keyboard.type('still typing');
    assert.equal(await editor.textContent(), 'still typing');
    pass('Ctrl+Enter mode preserves Enter newlines and allows continued typing after sending');

    await fresh(); await editor.click();
    await page.keyboard.insertText('中文输入法');
    const count = await sent();
    await editor.dispatchEvent('compositionstart');
    await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
    assert.equal(await sent(), count);
    await editor.dispatchEvent('compositionend', { data: '中文输入法' });
    await page.waitForTimeout(30);
    await page.keyboard.press('Enter'); await cleared();
    assert.equal(await sent(), count + 1);
    assert.equal(await focused(), true);
    pass('composition confirmation does not send, and a later Enter sends without losing focus');

    await page.evaluate(() => window.focusFixture.delayNext());
    await page.keyboard.type('delayed'); await page.keyboard.press('Enter');
    await waitFor(async () => (await sent()) === count + 2);
    await other.click();
    await page.keyboard.type('outside');
    await page.evaluate(() => window.focusFixture.finish()); await cleared();
    assert.equal(await other.evaluate(element => document.activeElement === element), true);
    await page.keyboard.type(' stays here');
    assert.equal(await other.inputValue(), 'outside stays here');
    pass('an asynchronous send finishing after another input was selected does not steal focus');

    await editor.click(); await page.keyboard.type('original');
    await page.evaluate(() => window.focusFixture.delayNext());
    await page.keyboard.press('Enter'); await page.keyboard.type(' continued');
    await page.evaluate(() => window.focusFixture.finish());
    await page.waitForTimeout(30);
    assert.equal(await editor.textContent(), 'original continued');
    assert.equal(await focused(), true);
    pass('finishing a delayed send preserves text typed while enqueueing');

    await fresh(); await editor.click();
    await page.keyboard.type('keep failed draft');
    await page.evaluate(() => window.focusFixture.delayNext());
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.focusFixture.finish('enqueue failed'));
    await page.getByRole('alert').filter({ hasText: 'enqueue failed' }).waitFor();
    assert.equal(await editor.textContent(), 'keep failed draft');
    assert.equal(await focused(), true);
    await page.keyboard.type(' retry');
    assert.equal(await editor.textContent(), 'keep failed draft retry');
    pass('an enqueue failure preserves the draft and immediate keyboard input');

    await fresh(); await editor.click(); await page.keyboard.type('locking');
    await page.evaluate(() => window.focusFixture.delayNext());
    await page.keyboard.press('Enter');
    await page.evaluate(() => { window.focusFixture.chat.locked.value = true; });
    await waitFor(async () => (await editor.getAttribute('contenteditable')) === 'false');
    await other.click();
    await page.evaluate(() => window.focusFixture.finish()); await cleared();
    assert.equal(await other.evaluate(element => document.activeElement === element), true);
    assert.equal(await editor.getAttribute('contenteditable'), 'false');
    pass('locking during an asynchronous send keeps the editor disabled and does not take focus');

    await fresh(); await other.click();
    await page.evaluate(() => { window.focusFixture.chat.active.value = { id: 9002, type: 'group', my_role: 'member', can_send: true }; });
    assert.equal(await other.evaluate(element => document.activeElement === element), true);
    await editor.click(); await page.keyboard.type('group message');
    await page.keyboard.press('Enter'); await cleared();
    assert.equal(await focused(), true);
    await page.keyboard.type('group next');
    assert.equal(await editor.textContent(), 'group next');
    pass('restoring a group draft preserves external focus, then group Enter sends retain editor focus');

    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: checks.length, checks, errors, native_webview_tested: false, renderer_blur_simulated: true }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, output }));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2));
    throw error;
  } finally { await browser?.close(); await server?.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
