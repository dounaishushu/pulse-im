const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../admin/src/go-api.js'), 'utf8');

function fixture(fetch) {
  const storage = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  };
  const context = { location: { origin: 'https://admin.example.invalid' }, window: {},
    sessionStorage: storage(), localStorage: storage(), fetch, Response, FormData, URL, URLSearchParams, AbortController,
    crypto:require('node:crypto').webcrypto, Blob, File, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  return context;
}

const account = { id: '01010101-0101-4101-8101-010101010101', account: 'fixture-admin', role: 'superadmin', permissions: [] };

test('cookie login reaches Go without a tab-scoped entrance token', async () => {
  const requests = [];
  const context = fixture(async (url, options) => {
    requests.push({ url, options });
    return Response.json({ user: account, csrf_token: 'fixture-csrf' });
  });
  const result = await context.window.PulseGoAdmin.request('/admin/auth/login', { method: 'POST', body: JSON.stringify({ username: account.account, password: 'fixture-password' }) });
  assert.equal(result.session_mode, 'cookie');
  assert.equal(requests[0].url, 'https://admin.example.invalid/api/v2/admin/auth/login');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(requests[0].options.headers['X-Admin-Entry'], undefined);
  assert.equal(JSON.parse(requests[0].options.body).entry_token, '');
});

test('missing entrance returns a readable instruction', async () => {
  const context = fixture(async () => Response.json({ error: { code: 'admin_entry_required' } }, { status: 401 }));
  await assert.rejects(context.window.PulseGoAdmin.request('/admin/auth/login', { method: 'POST', body: '{}' }), error => error.code === 'admin_entry_required' && error.message.includes('专属入口'));
});

test('admin user lookup resolves a specific UUID instead of searching only the first page', async () => {
  let requested;
  const context = fixture(async url => {
    requested=url;
    return Response.json({id:account.id,account:'older-user',profile_version:'7'});
  });
  const local=context.window.PulseGoAdmin.local('user',account.id);
  const result=await context.window.PulseGoAdmin.request('/admin/users?user_id='+local);
  assert.equal(requested,'https://admin.example.invalid/api/v2/admin/users/'+account.id);
  assert.equal(result.items[0].username,'older-user');
});

test('an explicit entrance still accompanies the login password', async () => {
  let sent;
  const context = fixture(async (_, options) => { sent = options; return Response.json({ user: account, csrf_token: 'fixture-csrf' }); });
  const entry = 'a'.repeat(64);
  context.sessionStorage.setItem('pulse.go.admin.entry', entry);
  await context.window.PulseGoAdmin.request('/admin/auth/login', { method: 'POST', body: '{}' });
  assert.equal(sent.headers['X-Admin-Entry'], entry);
  assert.equal(JSON.parse(sent.body).entry_token, entry);
});

test('unconfigured location lookup keeps cached regions without submitting a refresh', async () => {
  const methods = [];
  const context = fixture(async (url, options) => {
    methods.push(options.method);
    if (url.includes('/ip-locations/pending')) return Response.json({ items: ['192.0.2.10'], lookup_available: false });
    if (url.includes('/admin/regions')) return Response.json({ items: [] });
    if (url.endsWith('/admin/stats')) return Response.json({ users: 3 });
    throw new Error('Unexpected location request');
  });
  const result = await context.window.PulseGoAdmin.request('/admin/stats/regions/resolve', { method: 'POST', body: '{}' });
  assert.equal(result.lookup_available, false);
  assert.equal(result.pending_ip_count, 1);
  assert.equal(result.next_ips.length, 0);
  assert.equal(result.total, 3);
  assert.equal(methods.includes('POST'), false);
});

test('unconfigured offsite lookup does not submit addresses or claim that they were processed', async () => {
  let calls = 0;
  const context = fixture(async (url, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    assert.ok(url.includes('/admin/offsite-logins?'));
    return Response.json({ items: [], next_ips: ['192.0.2.10'], pending_ip_count: 1, lookup_available: false });
  });
  const result = await context.window.PulseGoAdmin.request('/admin/stats/offsite-logins/resolve', { method: 'POST', body: '{}' });
  assert.equal(calls, 1);
  assert.equal(result.next_ips.length, 0);
  assert.equal(result.processed_ips, 0);
  assert.equal(result.pending_ip_count, 1);
});

test('dispatch list does not download step images before a task is opened', async () => {
  let calls = 0;
  const context = fixture(async (url, options) => {
    calls++;
    assert.ok(url.includes('/admin/dispatch-plans?'));
    assert.equal(options.method, 'GET');
    return Response.json({ page: 1, size: 20, items: [{ id: account.id, payload: {
      steps: Array.from({ length: 500 }, () => ({ kind: 'image', media_id: account.id })) }, enabled: true }] });
  });
  const result = await context.window.PulseGoAdmin.request('/admin/dispatch-tasks?page=1&size=20');
  assert.equal(calls, 1);
  assert.equal(result.items[0].step_count, 500);
  assert.equal(result.items[0].steps.length, 500);
});

test('a late admin response cannot repopulate data after logout or account replacement', async () => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  const context = fixture(async () => {
    started(); await pending;
    return Response.json({ page: 1, size: 20, items: [{ id: account.id, account: 'private-user' }] });
  });
  const api = context.window.PulseGoAdmin;
  const result = api.request('/admin/users');
  await waiting;
  api.reset();
  release();
  await assert.rejects(result, error => error.code === 'session_changed');
});

test('an admin write does not continue under new credentials after its preliminary read', async () => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  let writes = 0;
  const context = fixture(async (_, options) => {
    if (options.method !== 'GET') { writes++; return new Response(null, { status: 204 }); }
    started(); await pending;
    return Response.json({ version: '1', value: {} });
  });
  const api = context.window.PulseGoAdmin;
  const result = api.request('/admin/announcement', { method: 'POST', body: { enabled: true, title: 'old account', content: 'old draft' } });
  await waiting;
  context.sessionStorage.setItem(api.csrfKey, 'new-account-csrf');
  context.sessionStorage.setItem(api.entryKey, 'new-account-entry');
  api.reset();
  release();
  await assert.rejects(result, error => error.code === 'session_changed');
  assert.equal(writes, 0);
});

test('an editor keeps its original setting version and rejects an intervening change',async()=>{
  let version='1',writes=0;
  const context=fixture(async(url,options)=>{
    if(options.method==='PUT'){writes++;return Response.json({status:'saved'});}
    assert.ok(url.endsWith('/admin/config/announcement'));
    return Response.json({value:{enabled:false,title:'title',body:'body'},version});
  });
  const api=context.window.PulseGoAdmin;
  const draft=await api.request('/admin/announcement');version='2';
  await assert.rejects(api.request('/admin/announcement',{method:'POST',body:JSON.stringify(draft)}),error=>error.status===409);
  assert.equal(writes,0);
});

test('editing a word beyond the first page keeps the listed version',async()=>{
  const id='02020202-0202-4202-8202-020202020202';
  let reads=0,payload;
  const context=fixture(async(url,options)=>{
    if(options.method==='GET'){reads++;return Response.json({items:[{id,word:'later-word',replacement:'*',version:'7'}],page:2,size:100,has_more:false});}
    assert.ok(url.endsWith('/admin/sensitive-words/'+id));payload=JSON.parse(options.body);return Response.json({id});
  });
  const api=context.window.PulseGoAdmin;
  const list=await api.request('/admin/sensitive-words?page=2&size=100');
  await api.request('/admin/sensitive-words',{method:'POST',body:JSON.stringify({...list.items[0],replacement:'new'})});
  assert.equal(reads,1);assert.equal(payload.expected_version,'7');
});

test('task status writes contain only accepted server input fields',async()=>{
  const id='03030303-0303-4303-8303-030303030303';let payload;
  const context=fixture(async(url,options)=>{
    if(options.method==='GET')return Response.json({items:[{id,task_key:'task_later',name:'task',description:'',open_time:'09:00:00',estimated_minutes:10,question_count:2,intern_unit_price:'0.100',formal_unit_price:'0.200',enabled:true,sort_order:0,version:'4',intern_millis:100,created_at:'now'}],page:2,size:100});
    assert.ok(url.endsWith('/admin/tasks/'+id));payload=JSON.parse(options.body);return Response.json({id});
  });
  const api=context.window.PulseGoAdmin,list=await api.request('/admin/work-tasks?page=2&size=100');
  await api.request('/admin/work-tasks/status',{method:'POST',body:JSON.stringify({id:list.items[0].id,status:'disabled'})});
  assert.equal(payload.enabled,false);assert.equal(payload.expected_version,'4');
  assert.equal(payload.created_at,undefined);assert.equal(payload.intern_millis,undefined);assert.equal(payload.id,undefined);
});

test('client diagnostic filters reach the audit endpoint',async()=>{
  const context=fixture(async url=>{assert.equal(new URL(url).searchParams.get('action'),'client.diagnostics');return Response.json({items:[],page:1,size:50});});
  await context.window.PulseGoAdmin.request('/admin/audit-logs?action=client.diagnostics&page=1');
});

test('dispatch accepts explicit user recipients without an unrelated plan-list request',async()=>{
  const user='04040404-0404-4404-8404-040404040404',peer='05050505-0505-4505-8505-050505050505',plan='06060606-0606-4606-8606-060606060606';let payload;
  const context=fixture(async(url,options)=>{assert.ok(url.endsWith('/admin/dispatch-plans'));assert.equal(options.method,'POST');payload=JSON.parse(options.body);return Response.json({id:plan});});
  const api=context.window.PulseGoAdmin;
  const sender=api.local('user',user),recipient=api.local('user',peer);
  await api.request('/admin/dispatch-tasks',{method:'POST',body:JSON.stringify({name:'direct plan',sender_id:sender,recipient_type:'user',recipient_ids:[recipient],trigger_type:'cron',cron_expression:'0 9 * * *',steps:[{type:'text',text:'hello',delay_seconds:0}],enabled:true})});
  assert.equal(payload.sender_id,user);assert.deepEqual(JSON.parse(JSON.stringify(payload.recipient_user_ids)),[peer]);assert.equal(payload.conversation_ids,undefined);
});

test('deleting a task with records disables it and preserves the records',async()=>{
  const id='07070707-0707-4707-8707-070707070707';let disabled=false;
  const context=fixture(async(url,options)=>{
    if(options.method==='GET')return Response.json({items:[{id,task_key:'used',name:'used',open_time:'09:00:00',estimated_minutes:10,question_count:2,intern_unit_price:'0.100',formal_unit_price:'0.200',enabled:true,sort_order:0,version:'3'}],page:1,size:20});
    if(options.method==='DELETE')return Response.json({error:{code:'task_has_records'}},{status:409});
    assert.equal(options.method,'PUT');const body=JSON.parse(options.body);assert.equal(body.enabled,false);assert.equal(body.expected_version,'3');disabled=true;return Response.json({id});
  });
  const api=context.window.PulseGoAdmin,list=await api.request('/admin/work-tasks');
  await api.request('/admin/work-tasks/delete',{method:'POST',body:JSON.stringify({ids:[list.items[0].id]})});
  assert.equal(disabled,true);
});

test('message filters resolve migrated public IDs and prioritize legacy numeric IDs over local UI IDs',async()=>{
  const first='08080808-0808-4808-8808-080808080808',second='09090909-0909-4909-8909-090909090909';
  const context=fixture(async url=>{
    if(url.includes('/admin/users?'))return Response.json({items:[{id:first,account:'one',public_id:'new-one',legacy_numeric_id:900},{id:second,account:'two',public_id:'new-two',legacy_public_id:'AbCdEf1234567890',legacy_numeric_id:1}]});
    assert.equal(new URL(url).searchParams.get('sender_id'),second);return Response.json({items:[],page:1,size:30});
  });
  const api=context.window.PulseGoAdmin;api.local('user',first);
  await api.request('/admin/messages?sender=1');
  await api.request('/admin/messages?sender=AbCdEf1234567890');
});
