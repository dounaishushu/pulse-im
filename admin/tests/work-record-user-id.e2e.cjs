const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = process.env.PULSE_ADMIN_RECORD_ID_TEST_OUTPUT || path.join(repo, '.local/admin-record-id-ui');
const uid = '7762e6a7-684e-401b-b979-5c42ae528303', publicID = '7762E6A7684E401BB9795C42AE528303';
const uuid = n => String(n).padStart(8, '0') + '-2222-4222-8222-222222222222';
const record = { id: uuid(11), user_id: uid, user_public_id: publicID, task_id: uuid(22), task_name: '线上批改工作八', nickname: '测试用户', task_date: '2026-11-24',
  status: 'reviewed', employee_type: 'intern', total: 20, correct_count: 19, wage: '7.750', unit_price: '0.402', version: '1',
  started_at: '2026-11-24T05:00:00+08:00', submitted_at: '2026-11-24T05:05:00+08:00', duration_seconds: 300, questions: [], answers: {}, results: {} };
const checks = [], errors = [], requests = [];
let server, browser, page;
const pass = text => { checks.push(text); console.log('PASS ' + text); };
async function waitFor(check) { for (let n=0;n<250;n++) { if (await check()) return; await new Promise(resolve=>setTimeout(resolve,20)); } throw Error('condition did not become true'); }
(async () => {
  fs.mkdirSync(output, {recursive:true});
  const {createServer} = await import(pathToFileURL(path.join(root,'node_modules/vite/dist/node/index.js')).href);
  const vue = (await import(pathToFileURL(path.join(root,'node_modules/@vitejs/plugin-vue/dist/index.mjs')).href)).default;
  const tailwind = (await import(pathToFileURL(path.join(root,'node_modules/@tailwindcss/vite/dist/index.mjs')).href)).default;
  server = await createServer({root,configFile:false,logLevel:'error',cacheDir:path.join(output,'vite-cache'),server:{host:'127.0.0.1',port:0,open:false},
    optimizeDeps:{entries:['tests/work-record-user-id-fixture.ts']}, plugins:[vue(),tailwind(),{name:'record-id-test',configureServer(vite){
      vite.middlewares.use('/__record-id-test',(_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="app"></div><script type="module" src="/tests/work-record-user-id-fixture.ts"></script></html>');});
    }}]});
  await server.listen();
  browser = await chromium.launch({headless:true,...(process.env.PULSE_CHROMIUM_EXECUTABLE?{executablePath:process.env.PULSE_CHROMIUM_EXECUTABLE}:{channel:'chrome'})});
  page = await browser.newPage({viewport:{width:1280,height:850},acceptDownloads:true});
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/v2/**',async route=>{
    const request=route.request(),url=new URL(request.url()),p=url.pathname.replace('/api/v2',''); requests.push({path:p,query:Object.fromEntries(url.searchParams),method:request.method()});
    const admin={id:uuid(90),account:'recordfixture',role:'superadmin',active:true,permissions:['records.manage']};
    let data;
    if(p==='/admin/auth/login')data={user:admin,csrf_token:'2'.repeat(64)};
    else if(p==='/admin/me')data=admin;
    else if(p==='/admin/task-codes')data={items:[{task_id:record.task_id,task_name:record.task_name}]};
    else if(p==='/admin/task-records'){
      const filter=(url.searchParams.get('user_id')||'').trim().replace(/-/g,'').toUpperCase();
      data={items:!filter||filter===publicID?[record]:[],page:1,size:10,has_more:false};
    }else if(p==='/admin/task-records/'+record.id)data=record;
    else if(p==='/admin/exports/wages'){
      await route.fulfill({headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename=wages.xlsx'},body:'isolated-download-fixture'});return;
    }else throw Error('unexpected fixture request '+p);
    await route.fulfill({json:data});
  });
  const input=page.getByPlaceholder('输入 32 位用户 ID');
  const rows=()=>page.locator('.el-table__body-wrapper tbody tr');
  const queryCount=()=>requests.filter(item=>item.path==='/admin/task-records').length;
  try{
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__record-id-test');
    await rows().first().waitFor();
    const cell=rows().first().locator('td').nth(1).locator('.cell');
    assert.equal((await cell.textContent()).trim(),publicID);
    assert.equal(await cell.evaluate(element=>element.scrollWidth<=element.clientWidth+1),true);
    assert.equal(await input.evaluate(element=>element.closest('.el-input').getBoundingClientRect().width>=300),true);
    pass('the records table displays the entire 32-character ID rather than the internal value 517');
    let count=queryCount();await input.fill(publicID);await page.getByRole('button',{name:'查询',exact:true}).click();await waitFor(()=>queryCount()>count);
    await rows().first().waitFor();
    assert.equal(requests.filter(item=>item.path==='/admin/task-records').at(-1).query.user_id,publicID);
    assert.equal((await cell.textContent()).trim(),publicID);
    pass('querying with a pasted long ID forwards the exact string and keeps the correct record');
    count=queryCount();await input.fill('F'.repeat(32));await page.getByRole('button',{name:'查询',exact:true}).click();await waitFor(()=>queryCount()>count);
    await page.getByText('暂无符合条件的数据',{exact:true}).waitFor();
    pass('an unknown long ID produces an empty result rather than showing unrelated records');
    count=queryCount();await page.getByRole('button',{name:'重置',exact:true}).click();await waitFor(()=>queryCount()>count);await rows().first().waitFor();
    assert.equal(await input.inputValue(),'');
    pass('reset clears the user ID filter and restores the list');
    await page.getByRole('button',{name:'查看详情',exact:true}).click();
    const drawer=page.getByRole('dialog',{name:'作业详情与批改',exact:true});await drawer.waitFor();
    await drawer.locator('.el-descriptions__body').getByText(publicID,{exact:true}).waitFor();
    await waitFor(async()=>{const box=await drawer.boundingBox();return box&&Math.abs(box.x+box.width-1280)<1;});
    assert.equal(requests.filter(item=>item.path.startsWith('/admin/task-records/')).at(-1).path,'/admin/task-records/'+record.id);
    pass('details show the same long user ID while opening by the original record UUID');
    await page.screenshot({path:path.join(output,'detail-long-user-id.png')});
    await drawer.getByRole('button',{name:'关闭',exact:true}).click();await drawer.waitFor({state:'hidden'});
    await input.fill(publicID);
    const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'导出记录',exact:true}).click();const download=await downloadEvent;
    assert.equal(download.suggestedFilename(),'作业记录.xlsx');
    assert.equal(requests.filter(item=>item.path==='/admin/exports/wages').at(-1).query.user_id,publicID);
    pass('export uses the same long ID filter without converting it to a JavaScript number');
    await page.locator('.el-table__body-wrapper .el-scrollbar__wrap').evaluate(element=>{element.scrollLeft=0;});
    await waitFor(async()=>{const box=await cell.boundingBox();return box&&box.x>=0&&box.x+box.width<1280;});
    await page.screenshot({path:path.join(output,'records-long-user-id.png')});
    await page.setViewportSize({width:390,height:850});
    assert.ok((await input.boundingBox()).width<=390);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    pass('the wider ID input fits a narrow viewport while the table scrolls internally');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:checks.length,checks,errors,requests,production_connected:false},null,2));
    console.log(JSON.stringify({passed:checks.length,output}));
  }catch(error){
    await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error.stack,checks,errors,requests},null,2));throw error;
  }finally{await browser?.close();await server?.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
