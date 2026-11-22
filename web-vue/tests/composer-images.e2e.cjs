// Real Vue editor, thumbnail/preview, Go-v2 upload queue; isolated HTTP only.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = path.resolve(process.env.PULSE_COMPOSER_TEST_OUTPUT || path.join(repo, '.local/composer-images-ui'));
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';
const size52 = Math.round(5.2 * 1024 * 1024), checks = [], errors = [], uploads = [], sent = [];
let server, browser, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [repo] } },
    plugins: [{ name: 'composer-image-fixture', configureServer(vite) {
      vite.middlewares.use('/__composer-images', (_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/composer-images-fixture.ts"></script></html>'); });
    } }],
  });
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
  page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL), urls = new Set();
    URL.createObjectURL = blob => { const url = create(blob); urls.add(url); return url; };
    URL.revokeObjectURL = url => { urls.delete(url); revoke(url); };
    window.imageURLs = urls;
  });
  await page.route('**/api/v2/**', async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname.replace('/api/v2', ''), method = request.method();
    if (p === '/media/uploads') {
      const body = request.postDataJSON(), media = { ...body, id: uuid(100 + uploads.length), status: 'pending', mime: 'image/png', width: 0, height: 0 };
      uploads.push(media); await route.fulfill({ json: media }); return;
    }
    if (/^\/media\/[^/]+\/bytes$/.test(p) && method === 'PUT') {
      const media = uploads.find(m => m.id === p.split('/')[2]), data = request.postDataBuffer();
      assert.equal(data.length, Number(media.bytes));
      assert.equal(data.subarray(1, 4).toString(), 'PNG');
      media.width = data.readUInt32BE(16); media.height = data.readUInt32BE(20);
      if (media.width * media.height > 24_000_000 || Math.max(media.width, media.height) > 12000) {
        media.status = 'failed'; media.error_code = 'image_pixel_limit';
      } else media.status = 'ready';
      await route.fulfill({ json: media }); return;
    }
    if (/^\/conversations\/[^/]+\/messages$/.test(p) && method === 'POST') {
      const body = request.postDataJSON(), media = uploads.find(m => m.id === body.media_id), seq = String(sent.length + 1);
      assert.equal(media.status, 'ready');
      const message = { id: uuid(200 + sent.length), conversation_id: uuid(9000), sender_id: uuid(1), seq, event_seq: seq, version: '1', request_id: body.request_id,
        kind: 'image', content: { media: { id: media.id, filename: media.filename, bytes: media.bytes, mime: media.mime, width: media.width, height: media.height } }, body: body.body || '',
        created_at: '2026-11-22T12:00:00Z', updated_at: '2026-11-22T12:00:00Z' };
      sent.push(message); await route.fulfill({ json: { message, duplicate: false } }); return;
    }
    await route.fulfill({ json: { items: [] } });
  });
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port + '/__composer-images');
  const input = page.getByRole('textbox', { name: '输入消息', exact: true }); await input.waitFor();
  async function drop(name, width, height, padded = false) {
    await page.evaluate(async ({ name, width, height, padded, size52 }) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2878dc'; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, Math.ceil(width / 4), Math.ceil(height / 4));
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const file = new File(padded ? [blob, new Uint8Array(Math.max(0, size52 - blob.size))] : [blob], name, { type: 'image/png' });
      const transfer = new DataTransfer(); transfer.items.add(file);
      document.querySelector('#message-input').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 40, clientY: innerHeight - 110 }));
      canvas.width = canvas.height = 0;
    }, { name, width, height, padded, size52 });
    await page.getByRole('button', { name: '预览 ' + name, exact: true }).waitFor();
  }
  try {
    await input.fill('拖入照片前的文字');
    for (const mime of ['image/jpeg', '']) {
      const name = mime ? '拖入照片.jpg' : '未提供类型的照片.JPG';
      await page.evaluate(async ({ name, mime }) => {
        const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 640;
        const context = canvas.getContext('2d');
        context.fillStyle = '#2784cc'; context.fillRect(0, 0, 960, 640);
        context.fillStyle = '#ffe3ad'; context.fillRect(100, 100, 380, 320);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
        const transfer = new DataTransfer(); transfer.items.add(new File([blob], name, { type: mime }));
        document.querySelector('#message-input').dispatchEvent(new DragEvent('drop', {
          bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 40, clientY: innerHeight - 110,
        }));
        canvas.width = canvas.height = 0;
      }, { name, mime });
      const thumbnail = page.getByRole('button', { name: '预览 ' + name, exact: true });
      await thumbnail.waitFor();
      await thumbnail.locator('img').evaluate(img => img.decode());
      const small = await thumbnail.locator('img').boundingBox();
      assert.ok(small.width <= 156 && small.height <= 94);
      if (mime) await page.screenshot({ path: path.join(output, 'jpeg-composer-thumbnail.png') });
      await thumbnail.click({ button: 'left' });
      const dialog = page.getByRole('dialog', { name: '图片预览', exact: true });
      await dialog.waitFor(); await dialog.locator('img').evaluate(img => img.decode());
      assert.equal(await dialog.locator('img').evaluate(img => img.naturalWidth), 960);
      assert.ok((await dialog.locator('img').boundingBox()).width > small.width);
      if (mime) await page.screenshot({ path: path.join(output, 'jpeg-expanded-preview.png') });
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '移除 ' + name, exact: true }).click();
      await page.waitForFunction(() => window.imageURLs.size === 0);
      assert.equal(await input.textContent(), '拖入照片前的文字');
      assert.equal(uploads.length, 0); assert.equal(sent.length, 0);
    }
    pass('dragged JPEGs, including uppercase extensions and missing MIME types, show decoded composer thumbnails and left-click enlarges them without sending or losing text');
    await input.fill('保留的图片说明');
    await drop('小图.png', 640, 360);
    const thumb = page.getByRole('button', { name: '预览 小图.png', exact: true });
    assert.equal(await thumb.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), true);
    const small = await thumb.locator('img').boundingBox(); assert.ok(small.width <= 160 && small.height <= 94);
    assert.equal(await input.evaluate(element => { const copy = element.cloneNode(true); copy.querySelectorAll('.composer-attachment-node').forEach(node => node.remove()); return copy.textContent; }), '保留的图片说明');
    pass('dragging an image inserts a real bounded thumbnail in the composer and preserves the text draft');
    await thumb.click();
    const dialog = page.getByRole('dialog', { name: '图片预览', exact: true }); await dialog.waitFor();
    await dialog.locator('img').evaluate(img => img.decode());
    assert.ok((await dialog.locator('img').boundingBox()).width > small.width);
    await page.screenshot({ path: path.join(output, 'expanded-image.png') });
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    pass('left-click opens the full local image in a larger dialog; Escape closes it without sending or changing the draft');
    await page.getByRole('button', { name: '移除 小图.png', exact: true }).click();
    assert.match(await input.textContent(), /保留的图片说明/);
    await input.focus(); await page.keyboard.press('Control+z'); await thumb.waitFor();
    pass('removing and undoing an attachment retains text and recreates its preview safely');
    await drop('正常5.2MB.png', 800, 600, true);
    await drop('高分辨率5.2MB.png', 6000, 4200, true);
    const expectedNames = await page.locator('.composer-image-name').allTextContents();
    await page.screenshot({ path: path.join(output, 'composer-thumbnails.png') });
    await page.locator('#composer button.vue-composer-send').click();
    await page.waitForFunction(() => window.composerFixture.sent.value.length === 3);
    assert.equal(uploads.length, 3); assert.equal(sent.length, 3);
    assert.deepEqual(sent.map(m => m.content.media.filename), expectedNames);
    const normal = uploads.find(m => m.filename === '正常5.2MB.png'), large = uploads.find(m => m.filename === '高分辨率5.2MB.png');
    assert.equal(Number(normal.bytes), size52);
    assert.ok(Math.max(large.width, large.height) <= 2560 && Number(large.bytes) < size52);
    assert.equal(await page.locator('.composer-image-card').count(), 0);
    assert.equal(await input.textContent(), '');
    pass('a 5.2 MB image sends at its full admitted size, and an oversized-resolution 5.2 MB image is resized before hashing/uploading; mixed attachments stay ordered');
    await drop('原图超限.png', 6000, 4200, true);
    await page.locator('#composer input[type=checkbox]').check();
    await page.locator('#composer button.vue-composer-send').click();
    await page.getByRole('alert').filter({ hasText: '图片分辨率超过原图限制' }).waitFor();
    assert.equal(sent.length, 3);
    assert.equal(uploads.at(-1).original, true); assert.equal(Number(uploads.at(-1).bytes), size52);
    pass('send-original preserves exact bytes and explains resolution-limit failures without dropping the attachment');
    await page.locator('#composer').getByRole('button', { name: '取消附件', exact: true }).click();
    await page.waitForFunction(() => window.imageURLs.size === 0);
    pass('sending or cancelling attachments releases all thumbnail and full-image object URLs');
    const orientation = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 6000; canvas.height = 4200;
      canvas.getContext('2d').fillStyle='#111';canvas.getContext('2d').fillRect(0,0,6000,4200);
      canvas.getContext('2d').fillStyle='#f00';canvas.getContext('2d').fillRect(0,0,1500,1050);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
      const xmp = new Uint8Array([255,225,0,9,88,77,80,100,97,116,97]);
      let offset=2, frameEnd=0;
      while(offset+4<bytes.length) {
        const length=(bytes[offset+2]<<8)|bytes[offset+3];
        if([0xc0,0xc1,0xc2].includes(bytes[offset+1])) {frameEnd=offset+2+length;break;}
        offset+=2+length;
      }
      if(!frameEnd) throw Error('JPEG fixture has no frame');
      const results=[];
      for(const position of [2,frameEnd]) {
        const file = new File([bytes.slice(0,position),exif,xmp,bytes.slice(position)], 'rotated.jpg', { type:'image/jpeg' });
        const resized = await window.composerFixture.prepareImageUpload(file);
        const image = await createImageBitmap(resized);
        const thumbnail = await createImageBitmap(await window.composerFixture.imageThumbnail(file));
        const check=document.createElement('canvas');check.width=image.width;check.height=image.height;check.getContext('2d').drawImage(image,0,0);
        const pixel=check.getContext('2d').getImageData(Math.floor(image.width*.9),Math.floor(image.height*.1),1,1).data;
        results.push({width:image.width,height:image.height,thumbnailWidth:thumbnail.width,thumbnailHeight:thumbnail.height,redAtTopRight:pixel[0]>200&&pixel[1]<40&&pixel[2]<40});
        check.width=check.height=0;
        image.close();thumbnail.close();
      }
      canvas.width=canvas.height=0; return results;
    });
    for(const result of orientation) {
      assert.ok(Math.abs(result.width / result.height - 4200 / 6000) < 0.01, JSON.stringify(result));
      assert.ok(Math.abs(result.thumbnailWidth / result.thumbnailHeight - 4200 / 6000) < 0.01, JSON.stringify(result));
      assert.equal(result.redAtTopRight,true,JSON.stringify(result));
    }
    pass('EXIF before or after the JPEG frame, including additional XMP metadata, preserves the aspect ratio in thumbnails and resized uploads');
    const guarded = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 13000; canvas.height = 2;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const file = new File([blob], 'transparent.png', { type:'image/png' });
      const resized = await window.composerFixture.prepareImageUpload(file);
      const image = await createImageBitmap(resized); const width = image.width;
      canvas.width=image.width; canvas.height=image.height; canvas.getContext('2d').drawImage(image,0,0);
      const alpha = canvas.getContext('2d').getImageData(0,0,1,1).data[3]; image.close();
      const bytes = new Uint8Array(await blob.arrayBuffer()); const header = new DataView(bytes.buffer);
      header.setUint32(16,10000); header.setUint32(20,10000);
      let rejection=''; try { await window.composerFixture.prepareImageUpload(new File([bytes],'unsafe.png',{type:'image/png'})); } catch(error) { rejection=error.message; }
      const gif = new File([Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),c=>c.charCodeAt(0))],'animated.gif',{type:'image/gif'});
      const keptGIF = (await window.composerFixture.prepareImageUpload(gif)) === gif;
      const normal = new File([blob], 'normal.png', {type:'image/png'});
      const controller = new AbortController(); controller.abort(); let cancelled=false;
      try { await window.composerFixture.prepareImageUpload(normal,{signal:controller.signal}); } catch(error) { cancelled=error.name==='AbortError'; }
      canvas.width=canvas.height=0; return {width,alpha,rejection,keptGIF,cancelled};
    });
    assert.ok(guarded.width<=2560); assert.equal(guarded.alpha,0);
    assert.match(guarded.rejection,/分辨率过大/); assert.equal(guarded.keptGIF,true); assert.equal(guarded.cancelled,true);
    pass('long transparent images keep alpha, animation stays intact, and excessive header dimensions/cancelled preparation are rejected safely');
    await drop('切换前.png', 320, 200);
    await page.locator('#composer input[type=checkbox]').uncheck();
    await page.getByRole('button',{name:'预览 切换前.png',exact:true}).click();
    await page.getByRole('dialog',{name:'图片预览',exact:true}).waitFor();
    await page.evaluate(()=>{const {chat}=window.composerFixture;chat.active.value={...chat.active.value,name:'refreshed metadata'};chat.sendRevision.value++;});
    assert.equal(await page.getByRole('dialog',{name:'图片预览',exact:true}).isVisible(),true);
    await page.evaluate(()=>{const {chat}=window.composerFixture;chat.active.value={...chat.active.value,id:chat.active.value.id+1};});
    await page.getByRole('dialog',{name:'图片预览',exact:true}).waitFor({state:'hidden'});
    await page.waitForFunction(()=>window.imageURLs.size===0);
    pass('ordinary chat updates preserve the open preview, while switching chats closes it and releases local URLs');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, errors, uploads, sent }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, output }));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, uploads, sent }, null, 2)); throw error;
  } finally { await browser?.close(); await server?.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
