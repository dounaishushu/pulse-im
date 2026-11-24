const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PULSE_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),repo=path.dirname(root);
const output=process.env.PULSE_ADMIN_AVATAR_OUTPUT||path.join(repo,'.local/admin-avatar-ui');
const baseline=process.env.PULSE_ADMIN_AVATAR_BASELINE==='1';
const uuid=n=>String(n).padStart(8,'0')+'-2222-4222-8222-222222222222';
const checks=[],errors=[],requests=[];let server,browser,page,releaseSlow;
const gate=new Promise(resolve=>releaseSlow=resolve);
const pass=name=>{checks.push(name);console.log('PASS '+name);};
const user=(n,name,avatar)=>({id:uuid(100+n),account:name,nickname:name,public_id:uuid(100+n).replaceAll('-','').toUpperCase(),avatar_id:avatar?uuid(avatar):'',created_at:'2026-11-24T00:00:00Z',active:true,can_send:true,can_add_friends:true,can_create_group:true});
async function waitFor(check){for(let i=0;i<300;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw Error('Condition did not become true');}
(async()=>{
 fs.mkdirSync(output,{recursive:true});
 const {createServer}=await import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')).href);
 const vue=(await import(pathToFileURL(path.join(root,'node_modules/@vitejs/plugin-vue/dist/index.mjs')).href)).default;
 const tailwind=(await import(pathToFileURL(path.join(root,'node_modules/@tailwindcss/vite/dist/index.mjs')).href)).default;
 const plugins=[];
 if(baseline)plugins.push({name:'avatar-baseline',enforce:'pre',load(id){if(id.replaceAll('\\','/').endsWith('/src/components/PreviewImage.vue'))return fs.readFileSync(process.env.PULSE_ADMIN_AVATAR_PREIMAGE,'utf8');}});
 plugins.push(vue(),tailwind(),{name:'avatar-fixture',configureServer(vite){vite.middlewares.use('/__avatar-test',(_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/user-avatar-fixture.ts"></script>');});}});
 server=await createServer({root,configFile:false,logLevel:'error',cacheDir:path.join(output,'vite-cache'),plugins,server:{host:'127.0.0.1',port:0,open:false},optimizeDeps:{entries:['tests/user-avatar-fixture.ts']}});
 await server.listen();const origin=server.resolvedUrls.local[0].replace(/\/$/,'');
 browser=await chromium.launch({headless:true,channel:'chrome'});page=await browser.newPage({viewport:{width:1280,height:850}});page.setDefaultTimeout(10000);
 page.on('pageerror',e=>errors.push(e.message));
 const png=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=32;const x=c.getContext('2d');x.fillStyle='#2878d7';x.fillRect(0,0,32,32);return c.toDataURL().split(',')[1];}),'base64');
 await page.route('**/api/v2/**',async route=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname.replace('/api/v2','');const headers=await req.allHeaders();
  const event={path:p,entry_header:headers['x-admin-entry']==='a'.repeat(64),session_cookie:(headers.cookie||'').includes('pulse_admin='),entrance_cookie:(headers.cookie||'').includes('admin_entry')};requests.push(event);
  const fulfill=(data,status=200,extra={})=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data),...extra});
  if(p==='/admin/auth/login')return fulfill({user:{id:uuid(90),account:'avatar_fixture',role:'superadmin',permissions:[],active:true},csrf_token:'b'.repeat(64)},200,{headers:{'Set-Cookie':'pulse_admin='+ 'c'.repeat(64)+'; Path=/api/v2/admin; HttpOnly; SameSite=Strict'}});
  if(p==='/admin/users'){
   const q=u.searchParams.get('q');return fulfill({items:q==='slow'?[user(4,'slow',4)]:q==='replacement'?[user(5,'replacement',5)]:[user(1,'legacy_a',1),user(2,'legacy_b',1),user(3,'denied',3),user(6,'no_avatar',0)],page:1,size:30,has_more:false});
  }
  if(p.startsWith('/admin/media/')){
   assert.equal(u.search,'','Media URLs must not contain entrance tokens');
   if(!event.entry_header||!event.session_cookie)return fulfill({error:{code:'unauthorized'}},401);
   if(p.includes(uuid(3)))return fulfill({error:{code:'forbidden'}},403);
   if(p.includes(uuid(4)))await gate;
   return route.fulfill({status:200,contentType:'image/png',body:png}).catch(()=>{});
  }
  return fulfill({items:[]});
 });
 try{
  await page.goto(origin+'/__avatar-test');
  const row=name=>page.locator('.el-table__body tr').filter({hasText:name});
  await row('legacy_a').waitFor();
  if(baseline){
   await waitFor(()=>requests.some(r=>r.path.includes(uuid(1))));
   await waitFor(()=>requests.filter(r=>r.path.includes(uuid(1))).length>=1);
   assert.equal(await row('legacy_a').locator('img').count(),0);
   assert.ok(requests.filter(r=>r.path.includes('/media/')).every(r=>!r.entry_header&&r.session_cookie&&!r.entrance_cookie));
   pass('original user table fails to load avatars with a retained session and entrance header only');
  }else{
   const image=row('legacy_a').locator('img');await waitFor(()=>image.evaluateAll(imgs=>imgs.length===1&&imgs[0].naturalWidth===32));
   await waitFor(()=>row('legacy_b').locator('img').evaluateAll(imgs=>imgs.length===1&&imgs[0].naturalWidth===32));
   assert.match(await image.getAttribute('src'),/^blob:/);
   assert.equal(requests.filter(r=>r.path.includes(uuid(1))).length,1);
   pass('user list displays decoded avatars without an entrance cookie and shares one authenticated download');
   await row('denied').getByText('图片无法加载').waitFor();
   assert.equal(await row('no_avatar').locator('.el-avatar').count(),1);
   pass('permission failures remain unavailable and users without an avatar retain their initials');
   await row('legacy_a').getByRole('button',{name:'查看legacy_a的头像'}).focus();await page.keyboard.press('Enter');
   const preview=page.locator('.el-image-viewer__img');await preview.waitFor();assert.equal(await preview.getAttribute('src'),await image.getAttribute('src'));
   await page.keyboard.press('Escape');await preview.waitFor({state:'hidden'});
   pass('keyboard enlargement uses the authenticated image rather than a second unauthenticated URL');
   assert.equal(requests.filter(r=>r.path.includes(uuid(99))).length,0);
   await page.locator('#fixture-offscreen').scrollIntoViewIfNeeded();
   await waitFor(()=>page.getByAltText('屏幕外测试图').evaluateAll(imgs=>imgs.length===1&&imgs[0].naturalWidth===32));
   assert.equal(requests.filter(r=>r.path.includes(uuid(99))).length,1);await page.locator('main').evaluate(el=>el.scrollTo(0,0));
   pass('offscreen images defer their authenticated download until scrolled into view');
   const input=page.locator('.filters input').first();await input.fill('slow');await page.getByRole('button',{name:'查询',exact:true}).click();
   await waitFor(()=>requests.some(r=>r.path.includes(uuid(4))));
   await input.fill('replacement');await page.getByRole('button',{name:'查询',exact:true}).click();
   const replacement=row('replacement').locator('img');await waitFor(()=>replacement.evaluateAll(imgs=>imgs.length===1&&imgs[0].naturalWidth===32));
   const current=await replacement.getAttribute('src');releaseSlow();await new Promise(r=>setTimeout(r,100));assert.equal(await replacement.getAttribute('src'),current);
   pass('late responses from an earlier user list cannot replace the current avatar');
   await page.screenshot({path:path.join(output,'loaded-user-avatar.png')});
   await page.locator('#fixture-logout').click();await waitFor(()=>page.locator('.user-avatar img').count().then(n=>n===0));
   const before=requests.filter(r=>r.path.includes('/media/')).length;await new Promise(r=>setTimeout(r,100));assert.equal(requests.filter(r=>r.path.includes('/media/')).length,before);
   pass('clearing the admin session revokes images and does not reload them under stale credentials');
   assert.deepEqual(errors,[]);
  }
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:checks.length,checks,errors,requests,production_connected:false,baseline},null,2));console.log(JSON.stringify({passed:checks.length,output,baseline}));
 }catch(e){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.html'),await page.content());fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:e.stack,checks,errors,requests},null,2));throw e;}
 finally{releaseSlow();await browser?.close();await server?.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
