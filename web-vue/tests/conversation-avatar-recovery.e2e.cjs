// Real avatar rendering and IntersectionObserver; no production services.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const web = path.resolve(__dirname, '..'), repo = path.dirname(web);
const output = path.resolve(process.env.PULSE_AVATAR_TEST_OUTPUT || path.join(repo, '.local/avatar-recovery-ui'));
const checks = [], errors = [];
const fixture = `
import { createApp, defineComponent, h, provide, shallowRef } from 'vue';
import ConversationRow from '/src/features/chat/ConversationRow.vue';
import { chatKey } from '/src/composables/useChat';
import platform from 'virtual:pulse-platform';
const params = new URLSearchParams(location.search);
const old = location.origin + '/__expired-avatar.svg', fresh = location.origin + '/__fresh-avatar.svg';
const row = shallowRef({ id: 1, name: '头像恢复检查', type: 'direct', avatar_url: old, avatar_id: '00000002-eeee-4eee-8eee-eeeeeeeeeeee' });
const state = { calls: 0, row, visible: [], forces: [] };
platform.mediaSource = source => params.has('filtered') && source === old ? '' : source;
createApp(defineComponent({ setup() {
  provide(chatKey, { client: { token: 'test', mediaGrant: async (_id, _token, _signal, force) => {
    state.calls++;
    state.forces.push(force);
    if (params.has('slow')) await new Promise(resolve => setTimeout(resolve, 400));
    if (params.has('status')) throw Object.assign(Error('grant unavailable'), { status: Number(params.get('status')) });
    return params.has('filtered') && !force ? old : fresh;
  } }, conversationName: row => row.name });
  window.avatarRecovery = state;
  return () => h('div', { style: 'height:100vh;padding:12px;' }, [h('div', { id: 'scroller', style: 'height:120px;overflow:auto;width:320px;' }, [
    h(ConversationRow, { row: row.value, selected: false }), h('div', { style: 'height:1800px;' }),
  ])]);
} })).mount('#app');
`;

(async () => {
  fs.mkdirSync(output, { recursive: true });
  process.chdir(web);
  const { createServer } = await import(pathToFileURL(path.join(web, 'node_modules/vite/dist/node/index.js')).href);
  const server = await createServer({ root: web, configFile: path.join(web, 'vite.config.ts'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
    plugins: [{ name: 'avatar-recovery-test', resolveId(id) { if (id === '/__avatar-recovery.ts') return '\0avatar-recovery-test'; },
      load(id) { if (id === '\0avatar-recovery-test') return fixture; },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        const p = new URL(req.url, 'http://local').pathname;
        if (p === '/__avatar-recovery-test') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end('<!doctype html><meta charset="utf-8"><div id="app"></div><script type="module" src="/__avatar-recovery.ts"></script>');
        } else if (p === '/__expired-avatar.svg') { res.statusCode = 410; res.end(); }
        else if (p === '/__fresh-avatar.svg') {
          res.setHeader('Content-Type', 'image/svg+xml');
          res.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#87b5d2"/></svg>');
        } else next();
      }); },
    }],
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  let page;
  async function open(query = '') {
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    page.setDefaultTimeout(5000);
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      const RealObserver = window.IntersectionObserver;
      window.IntersectionObserver = class extends RealObserver {
        constructor(callback, options) { super((entries, observer) => {
          for (const entry of entries) window.avatarRecovery?.visible.push(entry.isIntersecting);
          callback(entries, observer);
        }, options); }
      };
    });
    await page.goto(origin + '/__avatar-recovery-test' + query);
    await page.waitForFunction(() => window.avatarRecovery?.visible.includes(true));
  }
  async function scroll(visible) {
    await page.locator('#scroller').evaluate((el, shown) => { el.scrollTop = shown ? 0 : 700; }, visible);
    await page.waitForFunction(shown => window.avatarRecovery.visible.at(-1) === shown, visible);
  }
  async function loaded() { await page.waitForFunction(() => document.querySelector('.avatar img')?.naturalWidth > 0); }
  function pass(name) { checks.push(name); console.log('PASS ' + name); }
  try {
    await open();
    await page.waitForFunction(() => document.querySelector('.avatar') && !document.querySelector('.avatar img'));
    await scroll(false); await page.waitForTimeout(1100);
    assert.equal(await page.evaluate(() => window.avatarRecovery.calls), 0);
    await scroll(true); await loaded();
    assert.equal(await page.evaluate(() => window.avatarRecovery.calls), 1);
    await page.screenshot({ path: path.join(output, 'scroll-retry-recovered.png') });
    pass('a pending renewal resumes after scrolling offscreen without consuming its retry while hidden');
    await page.close();

    await open('?filtered=1'); await loaded();
    assert.equal(await page.evaluate(() => window.avatarRecovery.calls), 1);
    assert.deepEqual(await page.evaluate(() => window.avatarRecovery.forces), [true]);
    await page.waitForTimeout(1100);
    assert.equal(await page.evaluate(() => window.avatarRecovery.calls), 1);
    await page.screenshot({ path: path.join(output, 'filtered-source-recovered.png') });
    pass('a platform-filtered old source is renewed by media ID once');
    await page.close();

    await open('?slow=1');
    await page.waitForFunction(() => window.avatarRecovery.calls === 1);
    await scroll(false); await page.waitForTimeout(500); await scroll(true); await loaded();
    assert.equal(await page.evaluate(() => window.avatarRecovery.calls), 2);
    await page.waitForTimeout(1100);
    assert.equal(await page.evaluate(() => window.avatarRecovery.calls), 2);
    pass('an interrupted in-flight renewal resumes when visible and stops after loading');
    await page.close();

    for (const status of [401, 403, 404, 503]) {
      await open('?filtered=1&status=' + status);
      const expected = status === 503 ? 2 : 1;
      await page.waitForFunction(n => window.avatarRecovery.calls === n, expected);
      await page.waitForTimeout(1100);
      for (let i = 0; i < 2; i++) { await scroll(false); await scroll(true); }
      await page.waitForTimeout(1100);
      assert.equal(await page.evaluate(() => window.avatarRecovery.calls), expected);
      assert.equal(await page.locator('.avatar img').count(), 0);
      pass(status + ' grants stay bounded across repeated scrolling with no unauthenticated fallback');
      await page.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'recovery-results.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, output }));
  } catch (error) {
    await page?.screenshot({ path: path.join(output, 'recovery-failure.png') }).catch(() => {});
    throw error;
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
