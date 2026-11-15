const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sources = require('../pc/web/media-source.js');
const { createMediaDiskCache } = require('../pc/media-disk-cache.cjs');
const vm = require('node:vm');

test('the real chat renderer routes thumbnails through the account cache and opens original content', async () => {
  const source = await fs.readFile(path.join(__dirname, '../pc/web/app.js'), 'utf8');
  const htmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const context = {
    window: { PulseMediaSources: sources }, mediaUrl: value => value,
    desktop: { isDesktop: true, persistentMedia: true }, state: { user: { id: 1 } },
    messageVersionCache: () => new Map(), isDirectChatMessage: () => true,
    isGifMessage: () => false, mediaAutoDownloadEnabled: () => true,
    chatMessageAvatarHtml: () => '', messageReceipts: { html: () => '' }, escapeHtml: htmlEscape,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function cachedMediaUrl('), source.indexOf('\nfunction purgeLocalMedia(')), context);
  vm.runInContext(source.slice(source.indexOf('function messageHtml('), source.indexOf('\nfunction bindMessageActions(')), context);
  const raw = 'https://chat.example.org/api/v2/media-grants/' + 'e'.repeat(64);
  const html = context.messageHtml({id:3,conversation_id:2,sender_id:1,type:'image',body:{url:raw+'/content',thumbnail_url:raw+'/preview',name:'example.jpg'}});
  const attribute = name => new RegExp(' '+name+'="([^"]+)"').exec(html)?.[1].replaceAll('&amp;', '&');
  const thumbnail = sources.parseDisplay(attribute('src'));
  const full = sources.parseDisplay(attribute('data-image-source'));
  assert.deepEqual(thumbnail, {account:1,conversation:2,message:3,source:raw+'/preview',kind:'image'});
  assert.deepEqual(full, {account:1,conversation:2,message:3,source:raw+'/content',kind:'image'});
  context.desktop.persistentMedia = false;
  const webHtml = context.messageHtml({id:3,conversation_id:2,sender_id:1,type:'image',body:{url:raw+'/content',thumbnail_url:raw+'/preview'}});
  assert.ok(webHtml.includes('src="'+raw+'/preview"'));
});

test('protected image previews retain their bytes without exposing the server embedding policy', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-image-preview-'));
  let handler, fetches = 0;
  const profile = {id:'image-fixture',accountId:1,locked:false,session:{protocol:{handle:(_,fn)=>{handler=fn;},unhandle(){}}}};
  const bytes = Buffer.from([255,216,255,219,0,1,2,3]);
  const cache = createMediaDiskCache({directory,fetch:async()=>{fetches++;return new Response(bytes,{headers:{'Content-Type':'image/jpeg','Content-Length':String(bytes.length),'Cross-Origin-Resource-Policy':'same-site'}});}});
  try {
    cache.register(profile, value=>new URL(value).hostname==='chat.example.org'?value:null);
    const raw='https://chat.example.org/api/v2/media-grants/'+'c'.repeat(64)+'/preview';
    const displayed=sources.display(raw,1,2,3,true,'image');
    for(let i=0;i<2;i++){
      const response=await handler(new Request(displayed));
      assert.equal(response.status,200);
      assert.equal(response.headers.get('Content-Type'),'image/jpeg');
      assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),null);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    }
    assert.equal(fetches,1,'a second view should use the verified local bytes');
    assert.equal((await handler(new Request(sources.display(raw,4,2,3,true,'image')))).status,403);
    assert.equal((await handler(new Request(sources.display(raw.replace('chat.example.org','untrusted.example.org'),1,2,3,true,'image')))).status,403);
    assert.equal(fetches,1,'denied account and origin must not reach the network');
  } finally {await cache.clear();cache.unregister(profile);await fs.rm(directory,{recursive:true,force:true});}
});

test('the desktop viewer resolves original media and discards results after an account change', async () => {
  const source = await fs.readFile(path.join(__dirname, '../pc/web/image-viewer.js'), 'utf8');
  const prefix='https://chat.example.org/api/v2/media-grants/';
  const preview=sources.display(prefix+'a'.repeat(64)+'/preview',1,2,3,true,'image');
  const original=sources.display(prefix+'a'.repeat(64)+'/content',1,2,3,true,'image');
  const renewed=sources.display(prefix+'b'.repeat(64)+'/content',1,2,3,true,'image');
  const opened=[];let scope='first',resume;
  const origin={isConnected:true,getAttribute:name=>name==='data-image-source'?original:null,closest:()=>({dataset:{conversationId:'2',messageId:'3'}})};
  const context={window:{PulseMediaSources:sources,addEventListener(){}},document:{body:{},baseURI:'pulse-app://client/index.html',addEventListener(){}},URL,
    crypto:{randomUUID:()=> 'fixture'},MutationObserver:class{observe(){}disconnect(){}},console};
  vm.runInNewContext(source,context);
  let selected;
  const viewer=context.window.PulseImageViewer.create({listen:false,context:()=>({allowed:true,key:scope,accountId:1}),
    resolveSource:url=>{selected=url;return new Promise(resolve=>{resume=resolve;});},openWindow:value=>{opened.push(value);}});
  viewer.open(origin,{currentSrc:preview});
  assert.equal(selected,original,'the thumbnail source must not become the original viewer source');
  resume(renewed);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(opened.length,1);
  assert.equal(opened[0].url,renewed);
  assert.equal(opened[0].conversationId,2);
  viewer.open(origin,{currentSrc:preview});scope='other-account';resume(renewed);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(opened.length,1,'a completed grant request must not open the previous account image');
  viewer.close();
});

test('opaque Go video and audio grants retain their media types through the desktop cache', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-go-media-review-'));
  let handler;
  const profile = { id: 'fixture-profile', accountId: 1, locked: false, session: { protocol: {
    handle: (_, callback) => { handler = callback; }, unhandle: () => {},
  } } };
  let kind;
  const bytes = Buffer.from('isolated-media-fixture');
  const cache = createMediaDiskCache({ directory, fetch: async () => new Response(bytes, {
    headers: { 'Content-Type': kind === 'audio' ? 'audio/mp4' : 'video/mp4', 'Content-Length': String(bytes.length) },
  }) });
  try {
    assert.equal(cache.register(profile, value => value), true);
    for (kind of ['video', 'audio']) {
      const url = 'https://chat.example.org/api/v2/media-grants/' + (kind === 'audio' ? 'a' : 'b').repeat(64) + '/content';
      const displayed = sources.display(url, 1, 2, kind === 'audio' ? 4 : 3, true, kind);
      assert.equal(sources.isImage(displayed), false);
      const response = await handler(new Request(displayed));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Content-Type'), kind === 'audio' ? 'audio/mp4' : 'video/mp4');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      const range = await handler(new Request(displayed, { headers: { Range: 'bytes=2-6' } }));
      assert.equal(range.status, 206);
      assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2, 7));
    }
  } finally {
    await cache.clear();
    cache.unregister(profile);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('desktop media classification does not accept malformed type hints', () => {
  const raw = 'https://chat.example.org/api/v2/media-grants/' + 'd'.repeat(64) + '/content';
  const displayed = sources.display(raw, 1, 2, 3, true, 'image');
  assert.equal(sources.isImage(displayed), true);
  assert.equal(sources.parseDisplay(displayed + '&kind=video'), null);
});
