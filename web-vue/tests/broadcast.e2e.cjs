// Run with PULSE_PLAYWRIGHT_MODULE pointing to Playwright when it is not installed
// locally. Uses real Vue workspace/useChat/Go-v2 adapter against isolated HTTP data.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = path.resolve(process.env.PULSE_GROUP_TEST_OUTPUT || path.join(repo, '.local/broadcast-ui'));
const uuid = n => String(n).padStart(8, '0') + '-eeee-4eee-8eee-eeeeeeeeeeee';
const gid = uuid(9000), self = uuid(1), favorite = uuid(9900);
const model = { role: 'owner', staff: true, muted: false, allMuted: true, blocked: false, version: 1, preference: 1, pinned: false, description: '', announcement: '群公告保留在管理设置中', joinPolicy: 'invite', avatar: '', avatars: false, grantVersion: 0, issued: new Map(), activeGrants: 0, maxGrants: 0, metadata: new Map(), metadataVersion: new Map(), metadataActive: 0, metadataMax: 0, extraRoles: new Map(), reject: new Set(), deleted: new Set(), members: new Set([self, uuid(2), uuid(3)]), pins: [], requests: [], messages: [] };
model.memberInvites = false; model.memberMutes = new Map();
const person = n => ({ id: uuid(n), account: 'peer' + n, nickname: n === 4 || n === 5 ? '同名用户' : '用户' + n, remark: model.metadata.get(n)?.remark ?? (n === 4 ? '备注四' : ''), group_name: model.metadata.get(n)?.group_name || '', public_id: 'ID' + n, is_contact: [2, 3].includes(n), role: model.extraRoles.get(n) || (n === 1 ? model.role : n === 2 ? 'admin' : 'member'), internal_staff: n === 1 && model.staff, avatar_id: model.avatars ? uuid(30000 + n) : '' });
const message = (seq, sender, body) => ({ id: uuid(20000 + seq), conversation_id: gid, seq: String(seq), event_seq: String(seq), sender_id: uuid(sender), kind: 'text', body, version: '1', created_at: '2026-11-21T12:19:00Z', updated_at: '2026-11-21T12:19:00Z', sender: { name: person(sender).nickname } });
model.messages = [message(1, 2, '群聊功能测试，欢迎大家'), message(2, 1, '这是一条可编辑的测试消息')];
const summary = (id = gid, peer) => ({ id, kind: peer ? 'direct' : id === favorite ? 'saved' : 'group', title: model.title || '批改36群', avatar_id: !peer && id === gid ? model.avatar : '', peer_id: peer && uuid(peer), peer_name: peer && person(peer).nickname,
  my_role: model.role, can_send: !model.allMuted || model.role !== 'member' || id !== gid, mute_all: model.allMuted,
  can_invite: !peer && id === gid && (model.role !== 'member' || model.memberInvites), allow_member_invites: !peer && id === gid && model.memberInvites,
  archived: peer === 100, pinned: peer ? peer === 100 : model.pinned, muted_notifications: model.muted, preference_version: String(model.preference), membership_version: String(model.version),
  visible_from_seq: '1', message_seq: '2', event_seq: '2', unread_count: '0', member_count: model.members.size, updated_at: '2026-11-21T12:20:00Z',
  state: { clear_seq: '0', read_seq: '2', delivered_seq: '2', personal_seq: '0', version: '1' } });
const conversations = () => [summary(), summary(uuid(10000 + 100), 100), summary(uuid(10004), 4), summary(uuid(10005), 5), ...(model.includeRemarkConversation ? [summary(uuid(10003), 3)] : []), ...(model.createdGroups || [])];
const checks = [], errors = [];
let server, browser, page;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
async function waitFor(test) { for (let i = 0; i < 300; i++) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw Error('condition did not become true'); }

(async () => {
  fs.mkdirSync(output, { recursive: true });
  process.chdir(root);
  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false, fs: { allow: [repo] } },
    plugins: [{ name: 'group-chat-fixture', configureServer(vite) {
      vite.middlewares.use('/__group-chat-test', (_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/broadcast-fixture.ts"></script></html>'); });
    } }],
  });
  await server.listen();
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, ...(process.env.PULSE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PULSE_CHROMIUM_EXECUTABLE } : { channel: 'chrome' }) });
  page = await browser.newPage({ viewport: { width: 1180, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v2/**', async route => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname.replace('/api/v2', ''), method = req.method(), body = req.postDataJSON();
    model.requests.push({ path: p, query: u.search, method, body });
    let data = { items: [] }, status = 200;

    if (p === '/broadcast-targets') {
      if (!model.staff) { await route.fulfill({status:403,json:{error:{code:'forbidden'}}}); return; }
      const kind=u.searchParams.get('kind'), q=u.searchParams.get('q')||'', after=u.searchParams.get('after')||'';
      if (model.rejectTargets && after) { await route.fulfill({status:503,json:{error:{code:'unavailable'}}}); return; }
      const all=kind==='friend'?Array.from({length:model.targetCount||133},(_,i)=>({id:uuid(i+4),name:'好友'+(i+4),display_name:i===0?'重要客户':i===1?'张三':`好友${i+4}`,username:'account'+(i+4),avatar_id:uuid(30004+i),public_id:'ID'+(i+4)}))
        :[{id:gid,name:'批改36群',display_name:'批改36群',avatar_id:uuid(39999)},{id:uuid(9001),name:'测试群',display_name:'测试群',avatar_id:uuid(39998)}];
      const filtered=all.filter(row=>[row.name,row.display_name,row.username,row.public_id].join(' ').includes(q)&&row.id>after);
      const limit=Number(u.searchParams.get('limit')),items=filtered.slice(0,limit);
      model.targetPages=(model.targetPages||0)+1;
      if (q==='好友1') await new Promise(resolve=>setTimeout(resolve,300));
      await route.fulfill({json:{items,total:items.length,snapshot_max_id:u.searchParams.get('snapshot')||'2026-11-22T00:00:00Z',next_after_id:filtered.length>limit?items.at(-1).id:'',has_more:filtered.length>limit,max_recipients:model.targetLimit||900}}); return;
    }
    if (p === '/conversations/direct') {
      assert.equal(method,'POST'); assert.ok(body.peer_id);
      await route.fulfill({json:{id:uuid(10000+Number(body.peer_id.slice(0,8)))}}); return;
    }
    if (p === '/broadcasts') {
      assert.equal(method,'POST'); assert.ok(body.request_id.startsWith('broadcast-'));
      if (model.rejectBroadcast) { await route.fulfill({status:409,json:{error:{code:'conflict'}}}); return; }
      if (!model.staff) { await route.fulfill({status:403,json:{error:{code:'forbidden'}}}); return; }
      model.batch=uuid(60000); model.batchStatus='running';model.batchTotal=body.conversation_ids.length;model.sent=0;
      await route.fulfill({status:202,json:{id:model.batch}}); return;
    }
    if (p.startsWith('/send-batches/')) {
      if (method==='DELETE') model.batchStatus='cancelled';
      if (p.endsWith('/retry')) {assert.equal(method,'POST');model.batchStatus='running';}
      await route.fulfill({json:{id:model.batch,status:model.batchStatus,total:model.batchTotal,sent:model.sent}});return;
    }
    if (p === '/media/uploads' && ['image','video'].includes(body.kind)) {
      assert.equal(method,'POST');assert.ok(body.sha256);model.uploads=(model.uploads||0)+1;
      await route.fulfill({json:{id:uuid(41000+model.uploads),status:'ready',mime:body.kind==='image'?'image/png':'video/mp4',bytes:body.bytes,access:{content_path:'/api/v2/media-grants/'+'e'.repeat(64)+'/content',expires_in:120}}});return;
    }

    if (p === '/me' || p === '/me/profile') data = { ...person(1), avatar_id: '', user_id: self, version: '1' };
    else if (p === '/client/friend-page') {
      const people = model.createContacts || [2, 3], current = Number(u.searchParams.get('page') || 1), size = Number(u.searchParams.get('size') || 100);
      if (model.rejectContactPage === current) { status = 503; data = { error: { code: 'unavailable' } }; }
      else data = { items: people.slice((current - 1) * size, current * size).map(n => ({ ...person(n), ...(model.friendActivity ? { last_activity: model.friendActivity[n] || '' } : {}) })), total: people.length, page: current, size };
    }
    else if (p === '/client/config') data = { registration: {}, display: {}, releases: {} };
    else if (p === '/client/update') data = { required: false };
    else if (p.endsWith('/unread')) data = { count: '0', truncated: false };
    else if (/\/(read|delivered)$/.test(p)) data = { version: '1', reminder: false };
    else if (p === '/client/conversation-page' || p === '/conversations') data = { items: conversations(), total: conversations().length, page: 1, size: 100 };
    else if (p === '/client/conversation-updates') data = { items: conversations().filter(row => body.conversation_ids.includes(row.id)), removed_ids: [], incremental: true };
    else if (p === '/groups' && method === 'POST') {
      if (model.rejectCreate) { status = 403; data = { error: { code: 'forbidden' } }; }
      else {
        assert.ok(body.title.trim()); assert.ok(body.initial_members.length <= 499); assert.ok(body.avatar_id);
        const created = { ...summary(uuid(9100 + (model.createdGroups?.length || 0))), title: body.title, my_role: 'owner', can_send: true, can_invite: true,
          mute_all: false, allow_member_invites: false, owner_id: self, member_count: body.initial_members.length + 1, member_limit: 500, avatar_id: body.avatar_id,
          block_member_friend_requests: body.block_member_friend_requests, message_seq: '0', event_seq: '0', membership_version: '1',
          state: { clear_seq: '0', read_seq: '0', delivered_seq: '0', personal_seq: '0', version: '1' }, members: [self, ...body.initial_members] };
        model.createdGroups = [...(model.createdGroups || []), created]; data = { id: created.id, invite_code: 'created-group-fixture' };
      }
    } else if (model.createdGroups?.some(group => p === '/groups/' + group.id)) {
      data = { ...model.createdGroups.find(group => p === '/groups/' + group.id), description: '', announcement: '', join_policy: 'invite' };
    } else if (model.createdGroups?.some(group => p === '/groups/' + group.id + '/member-profiles')) {
      const group = model.createdGroups.find(group => p === '/groups/' + group.id + '/member-profiles');
      data = { items: group.members.map(id => ({ ...person(Number(id.slice(0, 8))), role: id === self ? 'owner' : 'member' })), next_after: '', query: '', search_scope: 'group', members_visibility: 'all' };
    } else if (p === '/groups/' + gid) {
      if (method === 'PATCH') {
        if (model.role === 'member' || model.rejectSettings) { status = 403; data = { error: { code: 'forbidden' } }; await route.fulfill({ status, json: data }); return; }
        for (const key of ['title', 'description', 'announcement']) if (key in body) model[key] = body[key];
        if ('join_policy' in body) model.joinPolicy = body.join_policy;
        if ('block_member_friend_requests' in body) model.blocked = body.block_member_friend_requests;
        if ('allow_member_invites' in body) model.memberInvites = body.allow_member_invites;
        model.version++;
      }
      data = { ...summary(), title: model.title || '批改36群', owner_id: self, member_limit: 1000, block_member_friend_requests: model.blocked, public_id: '12345678', description: model.description, announcement: model.announcement, join_policy: model.joinPolicy, avatar_id: model.avatar };
      data.restricted_member_count = [...model.memberMutes].filter(([n, minutes]) => minutes !== 0 && person(n).role === 'member').length;
      data.administrator_count = [...model.members].map(id => person(Number(id.slice(0, 8)))).filter(row => row.role === 'admin').length;
      if (model.legacyPermissionApi) { delete data.allow_member_invites; delete data.restricted_member_count; delete data.administrator_count; }
    } else if (p === '/groups/' + gid + '/mute-all') {
      if (model.role === 'member') { status = 403; data = { error: { code: 'forbidden' } }; }
      else { assert.equal(method, 'PUT'); model.allMuted = body.muted; model.version++; data = { status: 'ok' }; }
    } else if (p === '/groups/' + gid + '/invite-code/rotate') {
      data = { invite_code: 'new-invite-code-fixture' };
    } else if (p === '/media/uploads') {
      assert.equal(body.kind, 'avatar'); assert.ok(body.sha256); assert.ok(['group.png', 'group-avatar.png'].includes(body.filename));
      data = { id: uuid(40000), status: 'ready', mime: 'image/png', bytes: body.bytes, access: { content_path: '/api/v2/media-grants/' + 'e'.repeat(64) + '/content', expires_in: 120 } };
    } else if (p === '/groups/' + gid + '/avatar') {
      assert.equal(method, 'PUT'); model.avatar = body.media_id; model.version++; data = { status: 'ok' };
    } else if (p === '/media/grants') {
      data = { items: body.media_ids.map(id => ({ id, access: { content_path: '/api/v2/media-grants/' + 'f'.repeat(64) + '/content', expires_in: 120 } })) };
    } else if (/^\/media\/[^/]+\/grants$/.test(p)) {
      const id = p.split('/')[2];
      model.activeGrants++; model.maxGrants = Math.max(model.maxGrants, model.activeGrants);
      await new Promise(resolve => setTimeout(resolve, model.grantDelay || 0));
      model.activeGrants--;
      if (model.deniedGrant === id) { model.deniedAvatar = true; status = 403; data = { error: { code: 'forbidden' } }; }
      else if (model.failGrant === id && !model.failedGrant) { model.failedGrant = true; status = 503; data = { error: { code: 'unavailable' } }; }
      else { model.grantVersion++; model.issued.set(model.grantVersion.toString(16).padStart(64, '0'), id); data = { content_path: '/api/v2/media-grants/' + model.grantVersion.toString(16).padStart(64, '0') + '/content', expires_in: 120 }; }
    } else if (/^\/media-grants\/[a-f0-9]{64}\/content$/.test(p)) {
      if (model.failImage && !model.failedImage) { model.failedImage = true; model.failedImageId = model.issued.get(p.split('/')[2]); await route.fulfill({ status: 410, body: '' }); return; }
      if (model.createAvatarPortraits) {
        const n = Number((model.issued.get(p.split('/')[2]) || uuid(30002)).slice(0, 8)), colors = ['#a5d6cb', '#b6c7ef', '#e9bdce'];
        await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${colors[n % 3]}"/><ellipse cx="32" cy="68" rx="25" ry="30" fill="#354b66"/><ellipse cx="32" cy="27" rx="15" ry="20" fill="#43332e"/><ellipse cx="32" cy="28" rx="10" ry="14" fill="#f5d5be"/><path d="M18 21Q20 2 32 5Q49 5 47 24Q35 11 18 21" fill="#43332e"/></svg>` }); return;
      }
      await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSs4AAAAASUVORK5CYII=', 'base64') }); return;
    } else if (p === '/conversations/' + gid + '/preferences') {
      assert.equal(method, 'PATCH'); assert.equal(body.expected_version, String(model.preference));
      if ('muted_notifications' in body) model.muted = body.muted_notifications;
      if ('pinned' in body) model.pinned = body.pinned;
      model.preference++; data = summary();
    } else if (p === '/groups/' + gid + '/invite-candidates') {
      if (model.role === 'member' && !model.memberInvites) { await route.fulfill({ status: 403, json: { error: { code: 'forbidden' } } }); return; }
      const rows = Array.from({ length: 553 }, (_, i) => i + 4).filter(n => uuid(n) > (u.searchParams.get('after') || '') && !model.members.has(uuid(n)));
      const size = Number(u.searchParams.get('limit') || 100);
      const items = rows.slice(0, size).map(n => ({ ...person(n), last_activity: n === 556 ? '2026-11-21T15:00:00Z' : n === 5 ? '2026-11-21T00:00:02.000000090Z' : n === 4 ? '2026-11-21T00:00:02.000000010Z' : '' }));
      data = { items, next_after: rows.length > size ? items.at(-1).id : '' };
    } else if (p === '/groups/' + gid + '/members/batch') {
      assert.equal(method, 'POST'); assert.equal(typeof body.allow_history, 'boolean');
      if (model.role === 'member' && (!model.memberInvites || body.allow_history)) { await route.fulfill({ status: 403, json: { error: { code: 'forbidden' } } }); return; }
      const items = body.user_ids.map(id => { if (model.reject.has(id)) return { user_id: id, error: 'forbidden' }; model.members.add(id); return { user_id: id }; });
      model.version++; data = { items, added: items.filter(row => !row.error).length };
    } else if (p.startsWith('/groups/' + gid + '/members/') && /\/(role|muted)$/.test(p)) {
      const n = Number(p.split('/').at(-2).slice(0, 8));
      if (model.role === 'member' || p.endsWith('/role') && (model.role !== 'owner' || model.rejectRole)) { status = 403; data = { error: { code: 'forbidden' } }; }
      else if (p.endsWith('/role')) { assert.equal(method, 'PUT'); assert.ok(['admin', 'member'].includes(body.role)); model.extraRoles.set(n, body.role); model.version++; data = { status: 'ok' }; }
      else { assert.equal(method, 'PUT'); assert.ok(Number.isInteger(body.minutes)); model.memberMutes.set(n, body.minutes); model.version++; data = { status: 'ok' }; }
    } else if (p === '/groups/' + gid + '/member-profiles' || p === '/groups/' + gid + '/search-members' || p === '/groups/' + gid + '/members') {
      const query = u.searchParams.get('q') || '';
      const restricted = model.blocked && model.role === 'member';
      const rows = [...model.members].map(id => person(Number(id.slice(0, 8))))
        .map(row => ({ ...row, muted: Boolean(model.memberMutes.get(Number(row.id.slice(0, 8)))), muted_permanent: model.memberMutes.get(Number(row.id.slice(0, 8))) === -1 }))
        .filter(row => u.searchParams.get('restriction') !== 'muted' || row.role === 'member' && row.muted)
        .filter(row => (!restricted || (query ? row.is_contact && row.id !== self : ['owner', 'admin'].includes(row.role))) &&
          row.id > (u.searchParams.get('after') || '') && (!query || [row.nickname, row.account, row.remark, row.public_id].join(' ').includes(query)))
        .sort((a, b) => a.id.localeCompare(b.id));
      const limit = Number(u.searchParams.get('limit') || 100), items = rows.slice(0, limit);
      data = { items, next_after: rows.length > limit ? items.at(-1).id : '', query, members_visibility: restricted ? 'managers' : 'all', search_scope: restricted ? 'friends' : 'group' };
    } else if (/^\/profiles\/[^/]+$/.test(p)) {
      if (u.searchParams.get('conversation_id') === gid && model.blocked && model.role === 'member' && p !== '/profiles/' + self) {
        status = 403; data = { error: { code: 'forbidden' } };
      } else data = { ...person(Number(p.split('/').at(-1).slice(0, 8))), bio: '个人资料测试', version: '1', contact_version: String(model.metadataVersion.get(Number(p.split('/').at(-1).slice(0, 8))) || 1) };
    } else if (/^\/friends\/[^/]+\/metadata$/.test(p)) {
      assert.equal(method, 'PUT');
      const n = Number(p.split('/')[2].slice(0, 8));
      assert.ok([2, 3].includes(n)); assert.equal(body.expected_version, String(model.metadataVersion.get(n) || 1));
      model.metadataActive++; model.metadataMax = Math.max(model.metadataMax, model.metadataActive);
      await new Promise(resolve => setTimeout(resolve, model.metadataDelay || 0));
      model.metadataActive--;
      if (model.metadataError) { status = 409; data = { error: { code: 'conflict' } }; }
      else { model.metadata.set(n, { remark: body.remark, group_name: body.group_name }); model.metadataVersion.set(n, (model.metadataVersion.get(n) || 1) + 1); data = { version: String(model.metadataVersion.get(n)) }; }
    } else if (/^\/profiles\/[^/]+\/common-groups$/.test(p)) data = { items: [{ id: gid, title: model.title || '批改36群' }] };
    else if (p === '/conversations/saved') data = summary(favorite);
    else if (p === '/conversations/' + favorite) data = summary(favorite);
    else if (p === '/conversations/' + favorite + '/messages') data = { message: { ...model.messages[0], conversation_id: favorite }, duplicate: false };
    else if (p.endsWith('/personal-deletions')) { body.message_ids.forEach(id => model.deleted.add(id)); data = { status: 'ok' }; }
    else if (p.endsWith('/receipts')) data = { recipient_count: 3, delivered_count: 2, read_count: 1, items: [{ name: '用户2', status: 'read' }] };
    else if (/\/messages\/[^/]+$/.test(p) && method === 'DELETE') { model.messages[1].revoked = true; model.messages[1].version = '3'; data = model.messages[1]; }
    else if (/\/messages\/[^/]+$/.test(p) && method === 'PATCH') {
      assert.equal(body.expected_version, '1'); model.messages[1].body = body.body; model.messages[1].version = '2'; data = model.messages[1];
    } else if (p.endsWith('/pins') && method === 'GET') data = { items: model.messages.filter(row => model.pins.includes(row.id)) };
    else if (/\/pins\/[^/]+$/.test(p)) {
      const id = p.split('/').at(-1); model.pins = method === 'DELETE' ? model.pins.filter(row => row !== id) : [...model.pins, id]; data = { status: 'ok' };
    } else if (model.createdGroups?.some(group => p.startsWith('/conversations/' + group.id + '/')) && /\/(history|sync|personal-sync)$/.test(p)) data = { items: [], events: [], membership_version: '1', snapshot_max_seq: '0', next_after_seq: '0', next_before_seq: '0', visible_from_seq: '1', clear_seq: '0', has_more: false };
    else if (p.endsWith('/history')) data = { items: model.messages.filter(row => !model.deleted.has(row.id) && Number(row.seq) > Number(u.searchParams.get('after_seq') || 0)).slice(0, Number(u.searchParams.get('limit') || 100)), membership_version: String(model.version), snapshot_max_seq: '2', next_after_seq: '2', next_before_seq: '0', visible_from_seq: '1', clear_seq: '0', has_more: false };
    else if (p.endsWith('/personal-sync')) data = { events: [], snapshot_max_seq: '0', next_after_seq: '0', has_more: false };
    else if (p.endsWith('/sync')) data = { events: [], membership_version: String(model.version), snapshot_max_seq: '2', next_after_seq: '2', visible_from_seq: '1', has_more: false };
    else if (/^\/conversations\/[^/]+$/.test(p)) data = conversations().find(row => row.id === p.split('/').at(-1)) || (p.endsWith(uuid(10003)) ? summary(uuid(10003), 3) : summary());
    else if (method !== 'GET' && !['/client/network-observation'].includes(p) && !/\/(read|delivered)$/.test(p)) { status = 404; data = { error: { code: 'not_found', message: 'Unexpected fixture write: ' + p } }; }
    await route.fulfill({ status, json: data });
  });
  const sidebar = () => page.getByRole('complementary', { name: '群聊信息' });
  const menu = () => page.getByRole('menu', { name: '消息操作' });
  const openMenu = async (index = 1, position) => { await page.locator('.vue-message-row').nth(index).click({ button: 'right', ...(position ? { position } : {}) }); await menu().waitFor(); };
  const invite = async () => { await sidebar().getByRole('button', { name: '邀请入群', exact: true }).click(); await page.getByRole('dialog', { name: '邀请新成员' }).waitFor(); await page.getByText('正在加载可邀请用户…', { exact: true }).waitFor({ state: 'hidden' }); };
  const reset = async (role, staff) => { model.role = role; model.staff = staff; model.version++; await page.goto(origin + '/__group-chat-test'); await sidebar().locator('.group-sidebar-scroll ul').waitFor(); await page.locator('.vue-message-row').nth(1).waitFor(); };

  try {
    model.avatars=true;model.createAvatarPortraits=true;
    const nav=()=>page.getByRole('navigation',{name:'主导航',exact:true});
    const dialog=()=>page.getByRole('dialog',{name:'群发消息',exact:true});
    const box=()=>dialog().getByRole('textbox',{name:'群发消息内容'});
    const search=()=>dialog().getByRole('searchbox',{name:'搜索群发接收者'});
    const selected=()=>dialog().locator('.broadcast-section-heading > span');
    const send=()=>dialog().getByRole('button',{name:'发送',exact:true});
    const groupTab=()=>dialog().getByRole('tab',{name:/群组/});
    const friendTab=()=>dialog().getByRole('tab',{name:/好友/});
    const all=()=>dialog().locator('.broadcast-select-all input');
    const writes=path=>model.requests.filter(r=>r.path===path&&r.method==='POST');
    async function full(staff=true) {await reset('owner',staff);await page.evaluate(()=>window.groupFixture.full.value=true);await nav().waitFor();}
    async function open() {await nav().getByRole('button',{name:'群发消息',exact:true}).click();await dialog().waitFor();await dialog().locator('.broadcast-recipient').first().waitFor();}
    await full(false);
    assert.equal(await nav().getByRole('button',{name:'群发消息',exact:true}).count(),0);
    const count=model.requests.filter(r=>r.path==='/broadcast-targets').length;
    await page.evaluate(()=>window.groupFixture.chat.panel.value='broadcast');
    assert.equal(await dialog().count(),0);
    assert.equal(model.requests.filter(r=>r.path==='/broadcast-targets').length,count);
    pass('ordinary accounts have no broadcast rail entry; forcing the panel state does not mount it or read recipients');
    await full(true);await open();
    assert.deepEqual(await nav().locator('.workspace-rail-primary .rail-label').allTextContents(),['消息','联系人','群聊','通知','收藏','归档','群发']);
    assert.equal(await nav().getByRole('button',{name:'群发消息',exact:true}).getAttribute('aria-current'),'page');
    const geometry=await dialog().evaluate(el=>{const l=el.querySelector('.broadcast-targets').getBoundingClientRect(),r=el.querySelector('.broadcast-content').getBoundingClientRect();return {dialog:el.getBoundingClientRect().toJSON(),left:l.toJSON(),right:r.toJSON()};});
    assert.ok(geometry.dialog.width>=835&&geometry.left.x<geometry.right.x&&geometry.left.y===geometry.right.y);
    assert.equal(await dialog().getByRole('button',{name:'创建任务',exact:true}).count(),0);
    assert.equal(await send().isDisabled(),true);
    assert.equal(await box().getAttribute('maxlength'),'5000');
    assert.equal(await dialog().locator('.broadcast-recipient').count(),60);
    await waitFor(async()=>await dialog().locator('.broadcast-recipient .avatar img').count()>0);
    assert.ok(model.maxGrants<=4);
    await page.screenshot({path:path.join(output,'broadcast-desktop.png')});
    pass('internal staff have a real selected rail entry; the dialog has two columns, avatars, search, tabs, 5000-character editor and separate media buttons');
    await dialog().getByRole('button',{name:'取消',exact:true}).click();
    await nav().getByRole('button',{name:'我的收藏',exact:true}).click();
    await waitFor(async()=>await page.evaluate(()=>window.groupFixture.chat.active.value?.type==='favorites'));
    await open();assert.equal(await nav().locator('.rail-button[aria-current="page"]').count(),1);
    await dialog().getByRole('checkbox',{name:'选择 重要客户',exact:true}).check();
    await groupTab().click();await dialog().getByRole('checkbox',{name:'选择 批改36群',exact:true}).check();
    assert.equal(await selected().textContent(),'已选 2 个');
    await friendTab().click();await search().fill('account4');
    await waitFor(async()=>await dialog().locator('.broadcast-recipient').count()===11);
    await search().fill('重要客户');await waitFor(async()=>await dialog().locator('.broadcast-recipient').count()===1);
    assert.equal(await dialog().getByRole('checkbox',{name:'选择 重要客户',exact:true}).isChecked(),true);
    await search().fill('好友1');await new Promise(resolve=>setTimeout(resolve,240));await search().fill('张三');
    await dialog().getByRole('checkbox',{name:'选择 张三',exact:true}).waitFor();
    await new Promise(resolve=>setTimeout(resolve,400));assert.equal(await dialog().locator('.broadcast-recipient').count(),1);
    await search().fill('');await waitFor(async()=>await dialog().locator('.broadcast-recipient').count()===60);
    await all().check();await waitFor(async()=>await selected().textContent()==='已选 134 个');
    assert.equal(await dialog().locator('.broadcast-recipient').count(),133);assert.equal(await all().isChecked(),true);
    const pages=model.requests.filter(r=>r.path==='/broadcast-targets'&&r.query.includes('after='));
    assert.ok(pages.length>=2&&pages.every(r=>r.query.includes('snapshot=')));
    await all().uncheck();assert.equal(await selected().textContent(),'已选 1 个');
    pass('search uses server names/remarks/accounts and ignores stale replies; selections survive tab/search changes and full-result selection includes all 133 paginated friends while preserving selected groups');
    await search().fill('好友');await waitFor(async()=>await dialog().locator('.broadcast-recipient').count()===60);
    model.rejectTargets=true;await all().click();
    const reload=dialog().getByRole('button',{name:/重试$/});await reload.waitFor();
    assert.equal(await selected().textContent(),'已选 1 个');assert.equal(await all().isChecked(),false);
    model.rejectTargets=false;await reload.click();await waitFor(async()=>await dialog().locator('.broadcast-recipient').count()===120);
    await all().check();await waitFor(async()=>await selected().textContent()==='已选 134 个');await all().uncheck();
    assert.equal(await selected().textContent(),'已选 1 个');
    pass('a failed later recipient page preserves the selection and can retry from the same snapshot/cursor before selecting the complete search result');
    await search().fill('');await waitFor(async()=>await dialog().locator('.broadcast-recipient').count()===60);
    model.targetLimit=5;
    await search().fill('好友');await waitFor(async()=>await dialog().locator('.broadcast-recipient').count()===60);
    await all().click();await dialog().getByRole('alert').waitFor();
    assert.match(await dialog().getByRole('alert').textContent(),/最多可选 5/);assert.equal(await selected().textContent(),'已选 1 个');assert.equal(await all().isChecked(),false);
    model.targetLimit=900;await search().fill('重要客户');await waitFor(async()=>await dialog().locator('.broadcast-recipient').count()===1);
    await dialog().getByRole('checkbox',{name:'选择 重要客户',exact:true}).check();
    await box().fill('  群发文字验收  ');assert.equal(await dialog().locator('.broadcast-character-count').textContent(),'10/5000');
    model.rejectBroadcast=true;await send().click();await dialog().getByRole('alert').waitFor();
    assert.equal(await box().inputValue(),'  群发文字验收  ');assert.equal(await selected().textContent(),'已选 2 个');
    const first=writes('/broadcasts').at(-1).body;assert.deepEqual(new Set(first.conversation_ids),new Set([gid,uuid(10004)]));assert.equal(first.body,'群发文字验收');
    model.rejectBroadcast=false;await send().click();await waitFor(()=>model.batch);
    await waitFor(async()=>await dialog().locator('.broadcast-status').textContent().then(s=>s.includes('发送中')));
    assert.deepEqual(writes('/broadcasts').at(-1).body,first);assert.equal(writes('/conversations/direct').length,1);
    assert.equal(await box().inputValue(),'');assert.equal(await selected().textContent(),'已选 0 个');
    pass('recipient limits fail without losing selections; text submits real direct/group IDs and retry after a refused admission reuses the same idempotency key and prepared conversation');
    await dialog().getByRole('button',{name:'取消',exact:true}).click();await open();
    await waitFor(async()=>await dialog().locator('.broadcast-status').textContent().then(s=>s.includes('发送中')));
    model.batchStatus='partial';model.sent=1;
    await dialog().getByRole('button',{name:'刷新进度',exact:true}).click();
    await dialog().getByRole('button',{name:'重试未完成目标',exact:true}).click();
    await waitFor(()=>model.batchStatus==='running');
    await dialog().getByRole('button',{name:'取消剩余任务',exact:true}).click();await waitFor(()=>model.batchStatus==='cancelled');
    assert.ok(model.requests.some(r=>r.path.endsWith('/retry')&&r.method==='POST'));
    assert.ok(model.requests.some(r=>r.path.startsWith('/send-batches/')&&r.method==='DELETE'));
    pass('accepted task progress survives reopening and calls the real summary, retry and cancel routes');
    await waitFor(async()=>await dialog().locator('.broadcast-status').textContent().then(s=>s.includes('已取消')));
    await dialog().getByRole('checkbox',{name:'选择 重要客户',exact:true}).check();
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSs4AAAAASUVORK5CYII=','base64');
    const imageChooser=page.waitForEvent('filechooser');await dialog().getByRole('button',{name:'图片',exact:true}).click();
    await (await imageChooser).setFiles({name:'announcement.png',mimeType:'image/png',buffer:png});
    const videoChooser=page.waitForEvent('filechooser');await dialog().getByRole('button',{name:'视频',exact:true}).click();
    await (await videoChooser).setFiles({name:'announcement.mp4',mimeType:'video/mp4',buffer:Buffer.from('isolated-upload-fixture')});
    assert.equal(await dialog().locator('.broadcast-files .attachment-card').count(),2);
    await box().fill('图片及视频');await page.screenshot({path:path.join(output,'broadcast-attachments.png')});
    await send().click();await waitFor(()=>writes('/broadcasts').length===3);
    assert.deepEqual(writes('/broadcasts').at(-1).body.attachments,[{id:uuid(41001),kind:'image'},{id:uuid(41002),kind:'video'}]);
    assert.deepEqual(model.requests.filter(r=>r.path==='/media/uploads').map(r=>r.body.kind),['image','video']);
    pass('separate picture/video file choosers add actual files; both upload through media admission and their media IDs/kinds are sent with the broadcast');
    await waitFor(async()=>await dialog().locator('.broadcast-status').textContent().then(s=>s.includes('发送中')));
    await page.evaluate(()=>{const f=window.groupFixture;f.chat.me.value={...f.chat.me.value,internal_staff:false};});
    await dialog().waitFor({state:'hidden'});assert.equal(await nav().getByRole('button',{name:'群发消息',exact:true}).count(),0);
    const previous=model.requests.filter(r=>r.path.startsWith('/send-batches/')).length;
    await page.waitForTimeout(3700);assert.equal(model.requests.filter(r=>r.path.startsWith('/send-batches/')).length,previous);
    pass('revoking internal status immediately hides the entry, closes the dialog and stops task polling');
    await page.evaluate(()=>{const f=window.groupFixture;f.chat.me.value={...f.chat.me.value,internal_staff:true};});
    await page.setViewportSize({width:740,height:560});await page.getByRole('button',{name:'返回会话列表',exact:true}).click();await open();
    const compact=await dialog().boundingBox();assert.ok(compact.width<=716&&compact.height<=536);
    const footer=await send().boundingBox();assert.ok(footer.y>=0&&footer.y+footer.height<=560);
    await page.screenshot({path:path.join(output,'broadcast-small-window.png')});
    await dialog().getByRole('button',{name:'取消',exact:true}).click();
    const rail=await nav().locator('.rail-button').evaluateAll(rows=>rows.map(el=>el.getBoundingClientRect().toJSON()));
    assert.equal(rail.length,9);assert.ok(rail.every(r=>r.y===rail[0].y&&r.x>=0&&r.right<=740));
    await page.screenshot({path:path.join(output,'broadcast-sidebar.png')});
    await page.setViewportSize({width:390,height:844});await open();
    const mobile=await dialog().boundingBox();assert.ok(mobile.x>=0&&mobile.width<=366);
    assert.ok(await dialog().getByRole('button',{name:'图片',exact:true}).isVisible());
    await page.screenshot({path:path.join(output,'broadcast-mobile.png')});
    pass('the 740x560 PC window keeps two columns, reachable footer and all nine rail entries on one row; narrow screens stack the editor without horizontal overflow');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,geometry,compact,rail,requests:model.requests},null,2));
    console.log(JSON.stringify({passed:checks.length,output}));
  } catch (error) {
    await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
    fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error.stack,errors,requests:model.requests},null,2));throw error;
  } finally {await browser?.close();await server?.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
