// Run after the production admin build. Every API response is isolated in this browser.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.PULSE_DISPATCH_CRON_TEST_OUTPUT || path.join(root, '../.local/dispatch-cron-browser'));
const uuid = n => `${String(n).padStart(8, '0')}-2222-4222-8222-222222222222`;
const report = { checks: [], errors: [], unexpectedRequests: [] };
const legacy = {
  id: uuid(20), name: '原有五字段任务', version: '1', enabled: true, cron: '0 9 * * *',
  next_run: '2027-01-01T01:00:00Z', payload: { sender_id: uuid(1), conversation_ids: [uuid(2)],
    steps: [{ kind: 'text', body: '已有通知' }], delays_seconds: [5] },
};
const model = { plans: [legacy], previews: [], writes: [] };
const pass = name => { report.checks.push(name); process.stdout.write('PASS ' + name + '\n'); };
let server, browser, page;
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const { preview } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')));
  server = await preview({ root, configFile: false, logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: 'America/Los_Angeles' });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.addInitScript(() => {
    sessionStorage.setItem('pulse.go.admin.entry', '1'.repeat(64));
    sessionStorage.setItem('pulse.go.admin.csrf', '2'.repeat(64));
  });
  await page.route('**/api/v2/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.replace('/api/v2', '');
    const body = req.postDataJSON();
    let data, status = 200;
    if (p === '/admin/me') data = { id: uuid(90), account: 'fixture', role: 'operator', active: true, permissions: ['dispatch.manage'] };
    else if (p === '/admin/dispatch-plans' && req.method() === 'GET') data = { items: model.plans, page: 1, size: 20, has_more: false };
    else if (p === '/admin/select-options') data = { items: [{ id: url.searchParams.get('kind') === 'group' ? uuid(2) : uuid(1), name: url.searchParams.get('kind') === 'group' ? '测试群组' : '测试发送者' }] };
    else if (p === '/admin/dispatch-plans/preview') {
      model.previews.push(body);
      if (body.cron === '60 0 9 * * *') { status = 400; data = { error: { code: 'dispatch_cron_invalid' } }; }
      else {
        const base = Date.parse(body.cron.split(/\s+/).length === 6 ? '2027-01-01T01:00:30Z' : '2027-01-01T01:00:00Z');
        let due = base;
        data = { base_at: new Date(base).toISOString(), timezone: 'Asia/Shanghai', steps: body.delays_seconds.map(delay => new Date(due += delay * 1000).toISOString()) };
      }
    } else if (p.startsWith('/admin/dispatch-plans/') && req.method() === 'GET') {
      data = model.plans.find(plan => plan.id === p.split('/').at(-1));
      assert.ok(data, 'fixture requested an unknown plan');
    } else if (p === '/admin/dispatch-plans' && req.method() === 'POST') {
      model.writes.push(body);
      const plan = { id: uuid(21), ...body, version: '1', payload: body, next_run: '2027-01-01T01:00:30Z' };
      model.plans.push(plan); data = { id: plan.id };
    } else if (p.startsWith('/admin/dispatch-plans/') && req.method() === 'PUT') {
      model.writes.push(body);
      const plan = model.plans.find(plan => plan.id === p.split('/').at(-1));
      assert.ok(plan, 'fixture updated an unknown plan');
      Object.assign(plan, body, { payload: body, version: String(Number(plan.version) + 1), next_run: '2027-01-01T01:00:30Z' });
      data = { id: plan.id };
    } else {
      report.unexpectedRequests.push({ path: p, method: req.method() });
      status = 404; data = { error: { code: 'unexpected_fixture_request' } };
    }
    await route.fulfill({ status, json: data });
  });
  const drawer = () => page.locator('.el-drawer:visible');
  const save = () => drawer().getByRole('button', { name: '保存任务', exact: true });
  async function readyToSave() {
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.el-drawer button')).some(button => button.textContent.trim() === '保存任务' && !button.disabled));
  }
  await page.goto(origin + '/#/dispatch-tasks');
  await page.getByRole('heading', { name: '分发任务', exact: true }).waitFor();
  await page.getByRole('button', { name: '新增分发任务', exact: true }).click();
  await drawer().getByLabel('任务名称', { exact: true }).fill('秒级分发测试');
  const entities = drawer().locator('.entity-select .el-select');
  await entities.nth(0).click(); await page.getByRole('option', { name: '测试发送者', exact: true }).click();
  await entities.nth(1).click(); await page.getByRole('option', { name: '测试群组', exact: true }).click();
  await drawer().getByText('接收对象', { exact: true }).click();
  await drawer().getByLabel('触发方式', { exact: true }).press('ArrowDown');
  await page.getByRole('option', { name: 'Cron 定时执行', exact: true }).click();
  const cron = () => drawer().getByLabel('Cron 表达式（北京时间）', { exact: true });
  assert.equal(await cron().getAttribute('placeholder'), '0 0 9 * * *');
  await drawer().getByText(/秒 分 时 日 月 周，例如/).waitFor();
  pass('the Cron field shows all six positions with a six-field example and legacy compatibility');
  await drawer().getByLabel('文字内容', { exact: true }).fill('计划通知');
  await cron().fill('30 0 9 * * *');
  await drawer().getByText('2027-01-01 09:00:30', { exact: true }).waitFor();
  await readyToSave();
  assert.equal(model.previews.at(-1).cron, '30 0 9 * * *');
  pass('six-field preview retains seconds and Beijing time in a browser configured for another timezone');
  await page.screenshot({ path: path.join(output, 'dispatch-six-field-preview.png') });
  for (const expression of ['0 9 * *', '0 0 9 * * * *']) {
    const previews = model.previews.length, writes = model.writes.length;
    await cron().fill(expression);
    await drawer().getByText('请填写 6 字段 Cron（秒 分 时 日 月 周），也兼容 5 字段', { exact: true }).waitFor();
    assert.equal(await save().isDisabled(), true);
    await page.waitForTimeout(300);
    assert.equal(model.previews.length, previews); assert.equal(model.writes.length, writes);
  }
  pass('missing and excess fields stop preview and save before any HTTP mutation');
  await cron().fill('60 0 9 * * *');
  await drawer().getByText(/Cron 表达式无效或没有下一次执行时间/).waitFor();
  assert.equal(await save().isDisabled(), true);
  pass('semantic server validation produces a six-field error and prevents saving invalid seconds');
  await cron().fill('30 0 9 * * *'); await readyToSave();
  await save().click(); await drawer().waitFor({ state: 'hidden' });
  assert.equal(model.writes.at(-1).cron, '30 0 9 * * *');
  assert.equal(model.writes.at(-1).run_at, null);
  pass('creating a six-field task forwards the full expression through the real admin transport');
  const oldRow = page.locator('.el-table__body-wrapper tbody tr').filter({ hasText: '原有五字段任务' });
  await oldRow.getByRole('button', { name: '编辑', exact: true }).click();
  assert.equal(await cron().inputValue(), '0 9 * * *');
  await drawer().getByText('2027-01-01 09:00:05', { exact: true }).waitFor();
  await readyToSave(); await save().click(); await drawer().waitFor({ state: 'hidden' });
  assert.equal(model.writes.at(-1).cron, '0 9 * * *');
  pass('an existing five-field task remains editable and keeps its original schedule');
  await oldRow.getByRole('button', { name: '编辑', exact: true }).click();
  await cron().fill('30 0 9 * * *');
  await drawer().getByText('2027-01-01 09:00:35', { exact: true }).waitFor();
  await readyToSave(); await save().click(); await drawer().waitFor({ state: 'hidden' });
  assert.equal(model.writes.at(-1).cron, '30 0 9 * * *');
  assert.equal(model.writes.at(-1).expected_version, '2');
  pass('editing a legacy task to six fields preserves optimistic concurrency and cumulative step delays');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []);
  report.phase = 'passed'; report.previewRequests = model.previews.length; report.savedExpressions = model.writes.map(write => write.cron);
}
main().catch(async error => {
  report.phase = 'failed'; report.error = error.stack; process.exitCode = 1;
  if (page) {
    report.visibleText = await page.locator('body').innerText();
    report.inputs = await page.getByRole('textbox').evaluateAll(nodes => nodes.map(node => ({ id: node.id, label: node.getAttribute('aria-label'), labels: Array.from(node.labels || []).map(label => label.textContent) })));
    await page.screenshot({ path: path.join(output, 'failure.png') });
  }
}).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n');
});
