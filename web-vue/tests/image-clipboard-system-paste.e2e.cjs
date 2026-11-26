// Read-only OS clipboard probe. A separate authorized controller seeds/restores
// the clipboard; this test uses a genuine Ctrl+V in the production composer.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const expectedFile = process.env.PULSE_CLIPBOARD_EXPECTED_PNG;
const output = process.env.PULSE_CLIPBOARD_PASTE_OUTPUT;
assert(expectedFile && output, 'explicit expected PNG and output directory are required');
const name = process.env.PULSE_CLIPBOARD_COLOR_CASE || 'selected';
let server, browser;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(output, 'vite-cache'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } }, plugins: [{
      name: 'real-clipboard-color-paste', configureServer(vite) {
        vite.middlewares.use('/__colors', (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/composer-images-fixture.ts"></script></html>');
        });
      },
    }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--window-position=-32000,-32000'] });
  const page = await browser.newPage({ viewport: { width: 1180, height: 800 } }), errors = [];
  page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/v2/**', route => route.fulfill({ json: { items: [] } }));
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__colors');
  const input = page.getByRole('textbox', { name: '输入消息', exact: true }); await input.waitFor();
  await page.evaluate(() => {
    window.clipboardPixelDigest = async img => {
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth || img.width; canvas.height = img.naturalHeight || img.height;
      const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
      return { width: canvas.width, height: canvas.height, sha256 };
    };
    document.addEventListener('paste', async event => {
      const file = event.clipboardData.files[0];
      if (file) {
        const image = await createImageBitmap(file);
        try { window.clipboardSourcePixels = await window.clipboardPixelDigest(image); }
        finally { image.close(); }
      }
    }, true);
  });
  await input.focus(); const start = Date.now(); await page.keyboard.press('Control+V');
  const thumb = page.getByRole('button', { name: /^预览 / }).first(); await thumb.waitFor();
  const elapsed = Date.now() - start;
  await page.waitForFunction(() => !!window.clipboardSourcePixels);
  const expected = await page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode(); return window.clipboardPixelDigest(image);
  }, 'data:image/png;base64,' + fs.readFileSync(expectedFile).toString('base64'));
  assert.deepEqual(await page.evaluate(() => window.clipboardSourcePixels), expected, 'OS clipboard file must retain every pixel and original resolution');
  await thumb.click(); const preview = page.getByRole('dialog', { name: '图片预览', exact: true }); await preview.waitFor();
  const full = await preview.locator('img').evaluate(async image => { await image.decode(); return window.clipboardPixelDigest(image); });
  assert.deepEqual(full, expected, 'composer full preview must retain every pixel and original resolution');
  assert.equal(await page.evaluate(() => window.composerFixture.sent.value.length), 0); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'paste-' + name + '.png') });
  const result = { passed: true, case: name, real_windows_clipboard: true, real_keyboard_paste: true, actual_vue_composer: true,
    width: full.width, height: full.height, pixels_compared: full.width * full.height, full_preview_matches: true, paste_thumbnail_ms: elapsed, production_messages_sent: 0 };
  fs.writeFileSync(path.join(output, 'paste-' + name + '.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await server?.close(); });
