// Run with PULSE_PLAYWRIGHT_MODULE pointing to Playwright when it is not installed
// locally. Uses real Vue workspace/useChat/Go-v2 adapter against isolated HTTP data.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const output = path.resolve(process.env.PULSE_GROUP_TEST_OUTPUT || path.join(repo, '.local/contact-card-ui'));
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
  pinned: peer ? peer === 100 : model.pinned, muted_notifications: model.muted, preference_version: String(model.preference), membership_version: String(model.version),
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
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
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

    if ((p==='/me'||p==='/me/profile')&&model.receiver) {
      await route.fulfill({json:{...person(2),nickname:'收件人',avatar_id:'',user_id:uuid(2),internal_staff:false,version:'1'}});return;
    }
    if (p==='/client/friend-page') {
      const people=model.createContacts||[2,3],current=Number(u.searchParams.get('page')||1),size=Number(u.searchParams.get('size')||100);
      if(model.contactsDelay) await new Promise(resolve=>setTimeout(resolve,model.contactsDelay));
      if(model.rejectCardPage2&&current===2) {await route.fulfill({status:503,json:{error:{code:'unavailable'}}});return;}
      await route.fulfill({json:{items:people.slice((current-1)*size,current*size).map(n=>({...person(n),public_id:String(n).padStart(32,'A'),avatar_id:n===5?'':uuid(30000+n)})),total:people.length,page:current,size}});return;
    }
    if (p.startsWith('/users/by-account/')) {
      const account=decodeURIComponent(p.split('/').at(-1)).toLowerCase();
      if(model.lookupDelay) await new Promise(resolve=>setTimeout(resolve,model.lookupDelay));
      if(account!=='outsider001') {await route.fulfill({status:404,json:{error:{code:'not_found'}}});return;}
      await route.fulfill({json:{id:uuid(7000),account:'outsider001',nickname:'外部联系人',public_id:'C'.repeat(32),avatar_id:uuid(37000)}});return;
    }
    if(p==='/public-users/'+'C'.repeat(32)) {await route.fulfill({json:{id:uuid(7000),account:'outsider001',nickname:'外部联系人',public_id:'C'.repeat(32),avatar_id:uuid(37000)}});return;}
    if(p==='/conversations/'+gid+'/messages'&&method==='POST') {
      assert.equal(body.kind,'contact');assert.ok(body.card_user_id);assert.ok(body.request_id.startsWith('card-'));
      assert.equal(body.avatar_id,undefined);assert.equal(body.content,undefined);
      if(model.sendDelay)await new Promise(resolve=>setTimeout(resolve,model.sendDelay));
      if(model.rejectCardSend) {await route.fulfill({status:409,json:{error:{code:'conflict'}}});return;}
      const prior=model.deliveries.get(body.request_id);let delivered=prior;
      if(!delivered){const n=Number(body.card_user_id.slice(0,8)),row=person(n),seq=Math.max(...model.messages.map(m=>Number(m.seq)))+1;
        delivered={...message(seq,1,''),kind:'contact',request_id:body.request_id,content:{contact:{id:row.id,public_id:n===7000?'C'.repeat(32):String(n).padStart(32,'A'),account:n===7000?'outsider001':row.account,nickname:n===7000?'外部联系人':row.nickname,avatar_id:n===5?'':uuid(30000+n)}}};
        model.deliveries.set(body.request_id,delivered);model.messages.push(delivered);model.lastCard=delivered;
      }
      await route.fulfill({status:201,json:{message:delivered,duplicate:!!prior}});return;
    }
    if(p==='/conversations/'+gid+'/history') {
      const high=Math.max(...model.messages.map(m=>Number(m.seq))),items=model.messages.filter(m=>!model.deleted.has(m.id)&&Number(m.seq)>Number(u.searchParams.get('after_seq')||0));
      await route.fulfill({json:{items,membership_version:String(model.version),snapshot_max_seq:String(high),next_after_seq:String(high),next_before_seq:'0',visible_from_seq:'1',clear_seq:'0',has_more:false}});return;
    }
    if(/^\/conversations\/[^/]+\/messages\/[^/]+\/contact$/.test(p)) {
      const raw=model.messages.find(m=>m.id===p.split('/').at(-2)),card=raw?.content?.contact;
      if(model.denyCard||!card||raw.revoked||model.deleted.has(raw.id)){await route.fulfill({status:403,json:{error:{code:'forbidden'}}});return;}
      const n=Number(card.id.slice(0,8));
      await route.fulfill({json:{user:{...card,bio:'来自名片的个人资料',version:'1',is_contact:n!==7000,can_add_friend:n===7000},is_contact:n!==7000,can_add_friend:n===7000,source_conversation_id:gid,source_message_id:raw.seq}});return;
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
    model.avatars=true;model.createAvatarPortraits=true;model.createContacts=Array.from({length:236},(_,i)=>i+4);model.deliveries=new Map();
    model.messages.push({...message(3,2,''),kind:'contact',content:{contact:{id:uuid(5),account:'peer5',nickname:'无头像用户',public_id:'B'.repeat(32),avatar_id:''}}});
    const picker=()=>page.getByRole('dialog',{name:'发送站内名片',exact:true});
    const search=()=>picker().getByRole('searchbox',{name:'搜索名片联系人',exact:true});
    const rows=()=>picker().locator('.contact-card-row');
    const cardPosts=()=>model.requests.filter(r=>r.path==='/conversations/'+gid+'/messages'&&r.method==='POST');
    const lastCard=()=>page.locator(`.vue-message-row[data-message-id="${model.lastCard.seq}"] .message-contact-card`);
    const cardProfile=()=>page.getByRole('dialog',{name:'个人资料',exact:true});
    async function open(){await page.getByRole('button',{name:'名片',exact:true}).click();await picker().waitFor();}
    async function ready(){await waitFor(async()=>await rows().count()===236);await picker().getByText('正在加载联系人…',{exact:true}).waitFor({state:'hidden'});}
    async function close(){await picker().getByRole('button',{name:'关闭',exact:true}).click();}
    await reset('owner',false);await page.evaluate(()=>window.groupFixture.full.value=true);
    model.contactsDelay=300;model.grantDelay=750;await open();
    await picker().getByText('正在加载联系人…',{exact:true}).waitFor();await rows().first().waitFor();
    assert.equal(await rows().first().getByText('备注四',{exact:true}).count(),1);
    await ready();model.contactsDelay=0;model.grantDelay=0;
    await rows().first().locator('.avatar img').waitFor();
    const bounds=await rows().evaluateAll(items=>items.slice(0,8).map(el=>el.getBoundingClientRect().toJSON()));
    assert.ok(bounds.every((r,i)=>r.width===bounds[0].width&&(!i||r.y>=bounds[i-1].bottom)));
    assert.ok(model.maxGrants<=4);assert.ok(model.requests.filter(r=>/\/media\/[^/]+\/grants$/.test(r.path)).length<40);
    assert.match(await picker().locator('.contact-card-count').textContent(),/236/);
    await page.screenshot({path:path.join(output,'card-picker.png')});
    pass('the picker opens before paginated names/avatars finish, shows all 236 friends one per row, and only loads visible avatars with at most four simultaneous grants');
    await search().fill('备注四 peer4');assert.equal(await rows().count(),1);assert.equal(await rows().first().getByText('昵称：同名用户',{exact:true}).count(),1);
    await search().fill('@peer238');assert.equal(await rows().count(),1);assert.match(await rows().first().textContent(),/peer238/);
    await search().fill(String(239).padStart(32,'A'));assert.equal(await rows().count(),1);
    await search().fill('');await ready();await rows().last().scrollIntoViewIfNeeded();await rows().last().locator('.avatar img').waitFor();
    pass('remark, nickname, account and public ID filtering includes later friend pages; space-separated terms match together and @account works');
    await search().fill('peer4');model.rejectCardSend=true;
    const send=picker().getByRole('button',{name:'发送 备注四 的名片',exact:true});await send.click();
    await picker().getByRole('alert').waitFor();assert.equal(await search().inputValue(),'peer4');
    const attempted=cardPosts().at(-1).body;assert.equal(attempted.card_user_id,uuid(4));
    model.rejectCardSend=false;model.sendDelay=250;
    await send.click();await send.dispatchEvent('click');await picker().waitFor({state:'hidden'});model.sendDelay=0;
    assert.equal(cardPosts().length,2);assert.deepEqual(cardPosts().at(-1).body,attempted);assert.equal(model.deliveries.size,1);
    await lastCard().locator('.avatar img').waitFor();
    assert.match(await lastCard().textContent(),/同名用户/);assert.match(await lastCard().textContent(),/@peer4/);
    assert.match(await lastCard().textContent(),/ID：/);assert.equal(await lastCard().getAttribute('data-own'),'true');
    await page.screenshot({path:path.join(output,'outgoing-card.png')});
    pass('sending calls the real contact-card wire contract; a refused send preserves the search and retries the same request ID, while double clicks create just one message');
    await lastCard().click();await cardProfile().locator('.contact-profile-head .avatar img').waitFor();
    assert.equal(await cardProfile().getByRole('heading',{name:'同名用户',exact:true}).count(),1);
    assert.equal(await cardProfile().getByText('来自名片的个人资料',{exact:true}).count(),1);
    await cardProfile().getByRole('button',{name:'关闭',exact:true}).click();
    await open();await ready();await search().fill('outsider001');assert.equal(await rows().count(),0);
    await search().press('Enter');await picker().getByRole('button',{name:'发送 外部联系人 的名片',exact:true}).waitFor();
    await rows().first().locator('.avatar img').waitFor();
    await page.screenshot({path:path.join(output,'card-account-search.png')});
    await picker().getByRole('button',{name:'发送 外部联系人 的名片',exact:true}).click();await picker().waitFor({state:'hidden'});
    assert.equal(cardPosts().at(-1).body.card_user_id,uuid(7000));assert.equal(model.deliveries.size,2);
    await lastCard().locator('.avatar img').waitFor();
    pass('an exact account outside the local friend list can be found explicitly with its avatar and sent as an actual card; ordinary friend cards open their message-scoped profiles');
    model.receiver=true;await reset('owner',false);await page.evaluate(()=>window.groupFixture.full.value=true);
    await lastCard().locator('.avatar img').waitFor();assert.equal(await lastCard().getAttribute('data-own'),'false');
    await page.evaluate(seq=>{const chat=window.groupFixture.chat;chat.messages.value=chat.messages.value.map(row=>row.id===seq?{...row,body:{...row.body,user_id:undefined}}:row);chat.contactContext.value=999999;},Number(model.lastCard.seq));
    await lastCard().click();await cardProfile().locator('.contact-profile-head .avatar img').waitFor();
    assert.equal(await cardProfile().getByRole('heading',{name:'外部联系人',exact:true}).count(),1);
    assert.equal(await page.evaluate(()=>window.groupFixture.chat.contactContext.value),undefined);
    assert.equal(await cardProfile().getByRole('alert').count(),0);
    await page.screenshot({path:path.join(output,'received-card-profile.png')});
    await cardProfile().getByRole('button',{name:'关闭',exact:true}).click();
    await page.screenshot({path:path.join(output,'received-card.png')});
    pass('received/reloaded cards keep their avatar and open the server-authorized profile, even if a legacy UI snapshot has no local user ID; old unrelated group context is cleared');
    const publicBefore=model.requests.filter(r=>r.path.startsWith('/public-users/')).length;
    model.denyCard=true;await lastCard().click();await cardProfile().getByRole('alert').waitFor();
    assert.equal(await cardProfile().locator('.contact-profile').count(),0);
    assert.equal(model.requests.filter(r=>r.path.startsWith('/public-users/')).length,publicBefore);
    await cardProfile().getByRole('button',{name:'关闭',exact:true}).click();model.denyCard=false;
    const noAvatar=page.locator('.vue-message-row[data-message-id="3"] .message-contact-card');
    assert.equal(await noAvatar.locator('.avatar img').count(),0);assert.match(await noAvatar.textContent(),/无头像用户/);
    pass('a denied card profile remains denied without public fallback; contacts without a picture retain a readable name/letter card');
    model.receiver=false;await reset('owner',false);await page.evaluate(()=>window.groupFixture.full.value=true);
    model.rejectCardPage2=true;await open();await picker().getByRole('button',{name:'重试加载',exact:true}).waitFor();
    assert.equal(await rows().count(),100);model.rejectCardPage2=false;
    await picker().getByRole('button',{name:'重试加载',exact:true}).click();await ready();
    await search().fill('outsider001');model.lookupDelay=600;
    await picker().getByRole('button',{name:'查找账号',exact:true}).click();
    await page.evaluate(()=>{const chat=window.groupFixture.chat;chat.active.value={...chat.active.value,can_send:false};});
    await picker().waitFor({state:'hidden'});await page.waitForTimeout(700);model.lookupDelay=0;
    assert.equal(await picker().count(),0);assert.equal(model.deliveries.size,2);
    await page.evaluate(()=>{const chat=window.groupFixture.chat;chat.active.value={...chat.active.value,can_send:true};});
    pass('a later friend-page failure exposes retry without discarding loaded users, and revoking send permission closes the picker and ignores a late account lookup');
    await open();await ready();await page.setViewportSize({width:740,height:560});
    const dialogBounds=await picker().boundingBox();assert.ok(dialogBounds.width<=716&&dialogBounds.height<=536);
    await page.screenshot({path:path.join(output,'card-picker-small-window.png')});await close();
    await page.setViewportSize({width:390,height:844});
    const contactBounds=await lastCard().boundingBox();assert.ok(contactBounds.width<=280&&contactBounds.x>=0&&contactBounds.x+contactBounds.width<=390);
    await page.screenshot({path:path.join(output,'contact-card-mobile.png')});
    pass('the searchable single-row picker fits a 740x560 PC window and the sent/received card remains within a narrow chat viewport');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,bounds,dialogBounds,contactBounds,requests:model.requests},null,2));
    console.log(JSON.stringify({passed:checks.length,output}));
  } catch(error) {
    await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
    fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:error.stack,errors,requests:model.requests},null,2));throw error;
  } finally {await browser?.close();await server?.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
