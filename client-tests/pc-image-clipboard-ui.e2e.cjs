// Run with pc/node_modules/electron/dist/electron.exe. Production message menu,
// preload, IPC, media cache, and native decoding; clipboard writes are captured
// in memory so the user's operating-system clipboard is never changed.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const { app, BrowserWindow, nativeImage, protocol } = electron;
const { createWindowManager } = require('../pc/window-manager.cjs');
const { createMediaDiskCache } = require('../pc/media-disk-cache.cjs');
const sources = require('../pc/web/media-source.js');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || '.local/pc-image-clipboard-ui');
const fixture = path.join(output, 'fixture');
fs.mkdirSync(path.join(fixture, 'web'), { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(output, 'user-data-')));
protocol.registerSchemesAsPrivileged(['pulse-app', 'pulse-media'].map(scheme => ({ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } })));
for (const file of ['image-clipboard.js', 'message-actions.js', 'message-actions.css', 'media-source.js', 'media-identity.js', 'chat-typography.js', 'media-lifecycle.js', 'history-window.js', 'history-window.css', 'history-window.html']) fs.copyFileSync(path.join(root, 'pc/web', file), path.join(fixture, 'web', file));
for (const file of ['error.txt', 'results.json']) fs.rmSync(path.join(output, file), { force: true });
fs.copyFileSync(path.join(root, 'pc/preload.js'), path.join(fixture, 'preload.js'));
fs.writeFileSync(path.join(fixture, 'web/index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="message-actions.css"><style>body{font:16px sans-serif;margin:20px}.bubble{height:180px;margin:20px;padding:10px;background:#edf0f4;width:500px}.message-image{width:150px;height:150px}#messages{height:620px;overflow:auto}</style><header id="chat-head">图片复制测试</header><div id="messages"></div><form id="composer"><textarea id="message-input"></textarea></form><script src="media-identity.js"></script><script src="media-source.js"></script><script src="image-clipboard.js"></script><script src="fixture.js"></script><script src="message-actions.js"></script><script src="init.js"></script>');
let manager, cache, exitCode = 0, server;
process.on('uncaughtException', error => { fs.writeFileSync(path.join(output, 'uncaught.txt'), error.stack); app.exit(1); });
process.on('unhandledRejection', error => { fs.writeFileSync(path.join(output, 'unhandled.txt'), String(error?.stack || error)); app.exit(1); });
const checks = [], captures = [], requests = [], rendererErrors = [], decodes = [];
const check = (name, passed = true) => { assert.equal(passed, true, name); checks.push(name); fs.writeFileSync(path.join(output, 'progress.json'), JSON.stringify(checks, null, 2)); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test) { const end = Date.now() + 6000; while (!await test()) { assert.ok(Date.now() < end, 'Image copy did not settle'); await wait(20); } }

app.whenReady().then(async () => {
  let held = null, hold = false;
  try {
    const red = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG();
    const green = nativeImage.createFromBitmap(Buffer.from([0, 255, 0, 255]), { width: 1, height: 1 }).toJPEG(100);
    const greenPixels = nativeImage.createFromBuffer(green).toBitmap().toString('hex');
    server = http.createServer((req, res) => {
      requests.push(req.url);
      if (req.url.includes('/media-grants/')) {
        const send = () => { const jpeg = req.url.includes('b'.repeat(64)), bytes = jpeg ? green : red; res.writeHead(200, { 'Content-Type': jpeg ? 'image/jpeg' : 'image/png', 'Content-Length': bytes.length }); res.end(bytes); };
        if (hold) held = send; else send();
      } else res.writeHead(404).end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const fixtureSource = `
      window.fixture={grants:[],notices:[],completed:[]};
      window.state={token:'isolated-token',user:{id:1,internal_staff:true},active:{id:2,type:'direct',can_publish:true},page:'messages',historyEpoch:1};
      window.desktop=window.pulseDesktop; window.API=${JSON.stringify(origin + '/api/v2')};
      window.escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.messageVersionCache=()=>new Map(); window.canEditMessage=()=>false;
      window.api=async()=>({items:[]}); window.toast=text=>fixture.notices.push(text);
      window.cachedMediaUrl=(message,url)=>PulseMediaSources.display(url,1,message.conversation_id,message.id,true,'image');
      window.GO={mediaGrant:async(id,token)=>{fixture.grants.push({id,token});return ${JSON.stringify(origin)}+'/api/v2/media-grants/'+(id==='first'?'a':'b').repeat(64)+'/content';}};
      window.imageClipboard=PulseImageClipboard.create({context:()=>({key:JSON.stringify([state.token,state.active.id,state.historyEpoch]),accountId:state.user.id,allowed:true}),write:async value=>{const result=await pulseDesktop.copyImage(value);fixture.completed.push(value.phase);return result;}});
      window.messageHtml=m=>'<article class="bubble image-message" data-message-id="'+m.id+'" data-conversation-id="2"><button class="classic-image-media"><img class="message-image" loading="lazy" alt="尚未加载的缩略图"></button></article>';
      window.bindMessageActions=()=>{};window.restoreRecoveryScroll=()=>{};window.updateDesktopChat=()=>{};
      window.openConversation=id=>{state.active={...state.active,id};};window.switchPage=p=>{state.page=p;};window.renderShell=()=>{};
      window.handleSocketPacket=()=>{};window.updateInternalMessage=()=>{};
      window.fixtureMessages=[{id:3,conversation_id:2,sender_id:4,type:'image',status:'sent',created_at:'2026-11-25 10:26:00',body:{url:'expired-original',_go_media_id:'first'}},{id:4,conversation_id:2,sender_id:4,type:'image',status:'sent',created_at:'2026-11-25 10:27:00',body:{url:'expired-original',_go_media_id:'second'}}];
      window.openMenu=id=>{document.querySelector('[data-message-id="'+id+'"] img').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:150}));};
      window.clickCopy=()=>document.querySelector('[data-action="copy-image"]').click();
      window.addEventListener('error',event=>fixture.error=event.message);
    `;
    fs.writeFileSync(path.join(fixture, 'web/fixture.js'), fixtureSource);
    fs.writeFileSync(path.join(fixture, 'web/init.js'), 'document.getElementById("messages").innerHTML=fixtureMessages.map(messageHtml).join("");bindMessageActions();');
    cache = createMediaDiskCache({ directory: path.join(output, 'media-cache'), fetch: (profile, url, options) => profile.session.fetch(url, options) });
    manager = createWindowManager({ electron: { ...electron, nativeImage: { ...nativeImage, createFromBuffer(bytes) { decodes.push(bytes.length); return nativeImage.createFromBuffer(bytes); } }, clipboard: { writeImage: image => captures.push({ pixels: image.toBitmap().toString('hex'), size: image.getSize() }) } }, directory: fixture,
      runtimeConfig: { apiBaseUrl: origin + '/api/v2', websocketUrl: origin.replace('http', 'ws') + '/api/v2/realtime', webUrl: pathToFileURL(path.join(fixture, 'web/index.html')).href, production: false },
      appVersion: 'image-copy-fixture', services: { mediaDiskCache: cache },
      createBrowserWindow: options => { const window = new BrowserWindow({ ...options, show: false }); window.show = () => {}; window.focus = () => {}; return window; } });
    manager.createMainWindow(); const record = manager.windows()[0]; record.profile.accountId = 1;
    record.webContents.on('console-message', (_event, details) => { if (details.level === 'error') rendererErrors.push(details.message); });
    await record.ready;
    const run = async code => {
      let timer;
      try { return await Promise.race([record.webContents.executeJavaScript(code), new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error('Renderer operation timed out: ' + code.slice(0, 120))), 6000); })]); }
      finally { clearTimeout(timer); }
    };
    await until(() => run('Boolean(window.openMenu && document.querySelector("[data-message-id]"))'));
    check('the message image is not decoded and has never opened a preview', await run('document.querySelector("img.message-image").naturalWidth===0 && !document.querySelector(".image-viewer-backdrop")'));
    check('copying feedback appears immediately after clicking copy', await run('openMenu(3);clickCopy();document.getElementById("message-action-toast")?.textContent==="正在复制图片…"'));
    await until(() => captures.length === 1);
    await until(() => run('document.getElementById("message-action-toast")?.textContent==="已复制图片"'));
    check('right-click copies the first original without opening or loading its thumbnail', captures[0].pixels === '0000ffff');
    check('copy resolves a current grant and fetches content rather than preview', requests.length === 1 && requests[0].endsWith('/content'));
    await record.webContents.setZoomFactor(1.5); await run('document.documentElement.style.zoom="1.25";openMenu(4);clickCopy()'); await until(() => captures.length === 2);
    check('a JPEG at non-default browser and interface zoom copies its own pixels', captures[1].pixels === greenPixels);
    await run('openMenu(3);clickCopy()'); await until(() => captures.length === 3);
    check('copying the first image again does not reuse the previously copied image', captures[2].pixels === '0000ffff');
    check('repeated original copies reuse the verified local media bytes', requests.length === 2);
    const decodedBefore = decodes.length;
    const cachedOriginal = sources.display(origin + '/api/v2/media-grants/' + 'a'.repeat(64) + '/content', 1, 2, 3, true, 'image');
    const reused = await run(`(async()=>{const result=await pulseDesktop.copyImage(${JSON.stringify({ phase: 'prepare', accountId: 1, conversationId: 2, messageId: 3, url: cachedOriginal })});await pulseDesktop.copyImage({phase:'cancel',accountId:1,ticket:result.ticket});return !!result.ticket;})()`);
    check('a repeated original reuses native decoded pixels after a verified cache read', reused && decodes.length === decodedBefore && requests.length === 2);
    assert.equal(await run('fixture.error||""'), '');

    // Use a new message identity to force an uncached read, then leave the chat.
    hold = true;
    await run('fixtureMessages[0].id=5;document.getElementById("messages").innerHTML=fixtureMessages.map(messageHtml).join("");bindMessageActions();openMenu(5);clickCopy()');
    await until(() => Boolean(held));
    check('copying feedback remains visible while the original download is pending', await run('document.getElementById("message-action-toast")?.textContent==="正在复制图片…"'));
    await run('state.historyEpoch++;openConversation(9)');
    check('conversation navigation removes feedback from the previous copy', await run('!document.getElementById("message-action-toast")'));
    hold = false; held(); held = null;
    await until(() => run('fixture.completed.includes("cancel")'));
    check('leaving the conversation while a copy downloads preserves the existing clipboard', captures.length === 3);
    await run('pulseDesktop.syncSessionState({accountId:1,locked:true})'); await until(() => record.profile.locked);
    const locked = await run('pulseDesktop.copyImage({phase:"prepare",accountId:1,conversationId:2,messageId:3,url:"'+origin+'/api/v2/media-grants/'+ 'a'.repeat(64)+'/content"}).then(()=>false,()=>true)');
    check('the main process rejects copying from a locked account', locked);
    await run('pulseDesktop.syncSessionState({accountId:1,locked:false})'); await until(() => !record.profile.locked);
    const other = sources.display(origin + '/api/v2/media-grants/' + 'a'.repeat(64) + '/content', 8, 2, 3, true, 'image');
    const foreign = await run(`pulseDesktop.copyImage(${JSON.stringify({ phase: 'prepare', accountId: 1, conversationId: 2, messageId: 3, url: other })}).then(()=>false,()=>true)`);
    check('the main process rejects another account media-cache source', foreign);
    const untrusted = await run(`pulseDesktop.copyImage(${JSON.stringify({ phase: 'prepare', accountId: 1, conversationId: 2, messageId: 3, url: 'http://127.0.0.1:9/api/v2/media-grants/' + 'a'.repeat(64) + '/content' })}).then(()=>false,()=>true)`);
    check('the main process rejects image origins outside the verified routes', untrusted);
    await run('state.active.id=2;state.historyEpoch++;fixtureMessages=[{id:3,conversation_id:2,sender_id:4,type:"image",status:"sent",body:{url:"expired-original",_go_media_id:"first"}},{id:4,conversation_id:2,sender_id:4,type:"image",status:"sent",body:{url:"expired-original",_go_media_id:"second"}}];document.getElementById("messages").innerHTML=fixtureMessages.map(messageHtml).join("");bindMessageActions();');
    await run(`GO.mediaGrant=id=>id==='first'?new Promise((resolve,reject)=>{window.rejectOldCopy=reject;}):Promise.resolve(${JSON.stringify(origin+'/api/v2/media-grants/'+'b'.repeat(64)+'/content')});openMenu(3);clickCopy();openMenu(4);clickCopy();`);
    await until(() => captures.length === 4);
    await until(() => run('document.getElementById("message-action-toast")?.textContent==="已复制图片"'));
    await run('rejectOldCopy(Error("旧请求失败，不应覆盖新提示"))');
    check('an older failed copy cannot replace the latest successful feedback', await run('document.getElementById("message-action-toast")?.textContent==="已复制图片"'));
    check('continuous copies still select the latest correct image', captures[3].pixels === greenPixels);
    await run('pulseDesktop.publishMessageRecall({accountId:1,conversationId:2,messageId:4})');
    const recalledURL = sources.display(origin + '/api/v2/media-grants/' + 'b'.repeat(64) + '/content', 1, 2, 4, true, 'image');
    const recalled = await run(`pulseDesktop.copyImage(${JSON.stringify({ phase: 'prepare', accountId: 1, conversationId: 2, messageId: 4, url: recalledURL })}).then(()=>false,()=>true)`);
    check('a recalled message cannot reuse its recently copied decoded image', recalled && captures.length === 4);
    await run('GO.mediaGrant=async()=>{throw Error("模拟图片下载失败")};openMenu(3);clickCopy();');
    await until(() => run('document.getElementById("message-action-toast")?.textContent==="模拟图片下载失败"'));
    check('a failed copy replaces progress with its error and preserves the existing clipboard', captures.length === 4);
    assert.deepEqual(rendererErrors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: true, electron: process.versions.electron, checks, captures, requests, rendererErrors, native_decode_count: decodes.length, os_clipboard_modified: false }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
  } catch (error) { exitCode = 1; fs.writeFileSync(path.join(output, 'error.txt'), error.stack); console.error(error); }
  finally { held?.(); manager?.destroyAll(); await cache?.clear(); server?.closeAllConnections(); server?.close(); app.exit(exitCode); }
});
