// Real Vue message menu; native clipboard calls are isolated and controllable.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = process.env.PULSE_IMAGE_COPY_TEST_OUTPUT || path.join(repo, '.local/tauri-image-copy-ui');
const fixture = `
import { createApp, defineComponent, h, provide, ref } from 'vue';
import MessageActions from '/src/features/chat/MessageActions.vue';
import { chatKey } from '/src/composables/useChat';
const calls=[],pending=[],errors=[];let preview=0;
const active=ref({id:21,type:'group',can_manage:false}),locked=ref(false),visible=ref(false),selected=ref();
const messages=[1,2].map(n=>({id:500+n,conversation_id:21,sender_id:12,type:'image',status:'sent',created_at:'2026-11-25T02:00:00Z',body:{_go_wire_id:'0000000'+n+'-1111-4111-8111-111111111111'}}));
const client={token:'isolated-copy-account',wire:()=> '00000021-1111-4111-8111-111111111111'};
const chat={client,active,locked,me:ref({id:10,internal_staff:false}),canSend:ref(true),pins:ref([]),reply:ref(null),selection:ref([]),messageText:()=>'',error:cause=>errors.push(cause.message)};
window.imageCopyFixture={calls,pending,errors,get preview(){return preview;},
 copy(...args){calls.push(args);return new Promise((resolve,reject)=>pending.push({resolve,reject}));},
 open(n){selected.value=messages[n];visible.value=true;},done(n){pending[n].resolve();},fail(n){pending[n].reject(Error('原图下载失败'));},
 conversation(n){active.value={...active.value,id:n};},lock(){locked.value=true;},account(){client.token='another-account';},
 recall(n){messages[n].status='recalled';selected.value={...messages[n]};}};
createApp(defineComponent({setup(){provide(chatKey,chat);return()=>h('main',[
 h('img',{src:'/never-loaded.png',onClick:()=>preview++,'aria-label':'尚未放大的图片'}),
 visible.value&&h(MessageActions,{key:selected.value.id,message:selected.value,point:{x:250,y:100},onClose:()=>visible.value=false})]);}})).mount('#app');
`;
let server, browser, page;
const checks = [], errors = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
(async () => {
  fs.mkdirSync(output, { recursive: true }); process.chdir(root);
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(output, 'vite-cache'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false }, plugins: [{
      name: 'image-copy-fixture', enforce: 'pre',
      resolveId: id => id === 'virtual:image-copy-fixture' ? '\0virtual:image-copy-fixture' : id === 'virtual:pulse-platform' ? '\0image-copy-platform' : undefined,
      load: id => id === '\0virtual:image-copy-fixture' ? fixture : id === '\0image-copy-platform' ? `import browser from '/src/platform/browser';export default {...browser,archive:{copyImage:(...args)=>window.imageCopyFixture.copy(...args)}};` : undefined,
      configureServer(vite) { vite.middlewares.use('/__image-copy', (_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/@id/__x00__virtual:image-copy-fixture"></script></html>'); }); },
    }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1180, height: 800 } }); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v2/**', route => route.abort('blockedbyclient'));
  await page.route('**/never-loaded.png', route => route.abort('blockedbyclient'));
  const fresh = async () => { await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__image-copy'); await page.waitForFunction(() => !!window.imageCopyFixture); };
  const open = n => page.evaluate(n => window.imageCopyFixture.open(n), n);
  const copy = () => page.getByRole('menuitem', { name: '复制图片', exact: true }).click();
  try {
    await fresh(); await open(0); await copy();
    await page.getByRole('menuitem', { name: '正在复制图片…', exact: true }).waitFor();
    assert.equal(await page.getByRole('menuitem', { name: '正在复制图片…', exact: true }).isDisabled(), true);
    const first = await page.evaluate(() => ({calls:window.imageCopyFixture.calls,preview:window.imageCopyFixture.preview,width:document.querySelector('img').naturalWidth}));
    assert.equal(first.preview, 0); assert.equal(first.width, 0);
    assert.deepEqual(first.calls, [['isolated-copy-account', '00000021-1111-4111-8111-111111111111', '00000001-1111-4111-8111-111111111111']]);
    pass('an unloaded image copies by its exact Go message ID without opening a preview and shows immediate progress');
    await page.evaluate(() => window.imageCopyFixture.done(0)); await page.getByRole('menu').waitFor({state:'detached'});
    pass('successful copy closes the menu after native completion');

    await fresh(); await open(0); await copy(); await open(1); await copy();
    await page.evaluate(() => window.imageCopyFixture.done(0));
    await page.getByRole('menuitem', { name: '正在复制图片…', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.imageCopyFixture.calls[1]))[2], '00000002-1111-4111-8111-111111111111');
    await page.evaluate(() => window.imageCopyFixture.done(1)); await page.getByRole('menu').waitFor({state:'detached'});
    pass('a late first copy cannot close or update the second selected image menu');

    for (const change of ['conversation','lock']) {
      await fresh(); await open(0); await copy();
      await page.evaluate(change => change === 'lock' ? window.imageCopyFixture.lock() : window.imageCopyFixture.conversation(99), change);
      await page.getByRole('menu').waitFor({state:'detached'}); await page.evaluate(() => window.imageCopyFixture.fail(0));
      assert.deepEqual(await page.evaluate(() => window.imageCopyFixture.errors), []);
    }
    pass('conversation and account locking clear old progress and suppress late errors');

    await fresh(); await open(0); await copy(); await page.evaluate(() => window.imageCopyFixture.fail(0));
    await page.getByRole('menuitem', { name: '复制图片', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.imageCopyFixture.errors), ['原图下载失败']);
    assert.equal(await page.getByRole('menuitem', { name: '复制图片', exact: true }).isEnabled(), true);
    await page.evaluate(() => window.imageCopyFixture.recall(0));
    await page.getByRole('menuitem', { name: '复制图片', exact: true }).waitFor({state:'detached'});
    pass('a failed download allows retry and recalled images do not offer copying');
    assert.deepEqual(errors, []);
    await page.screenshot({path:path.join(output,'image-copy.png')});
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:true,checks,errors,production_requests:0,os_clipboard_modified:false},null,2));
  } catch(error) { await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{}); throw error; }
  finally { await browser?.close(); await server?.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
