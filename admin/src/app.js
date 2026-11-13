const localDev = location.port === '8100' || (location.hostname === '127.0.0.1' && location.port === '');
const API = `${location.origin}/api/v2`;
localStorage.removeItem('pulse_admin_key');
localStorage.removeItem('pulse_admin_id');
sessionStorage.removeItem('pulse_admin_token');
localStorage.removeItem('pulse_admin_token');
const state = { token: '', csrf: '', admin: null, view: 'dashboard', pages: {} };
// token is only an in-memory UI generation marker, never a server credential.
function adminRequestHeaders() { return { 'X-Admin-Entry': sessionStorage.getItem(PulseGoAdmin.entryKey) || '', ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) }; }
const hashView = location.hash.slice(1);
if (['dashboard', 'devices', 'users', 'groups', 'messages', 'moderation', 'sensitive-words', 'login-logs', 'announcement', 'explore', 'client-config', 'routes', 'task-config', 'question-bank', 'task-records', 'admin-accounts', 'dispatch-tasks', 'maintenance'].includes(hashView)) state.view = hashView;
if (state.view === 'explore') state.view = 'client-config';
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (view) => state.pages[view] || 1;
const money = (fen) => `¥${(Number(fen || 0) / 100).toFixed(2)}`;
const titleMap = { devices: '设备管理', dashboard: '运营总览', users: '用户管理', groups: '群组管理', messages: '消息与会话', moderation: '内容审核', 'sensitive-words': '敏感词管理', 'login-logs': '系统日志', 'task-config': '任务配置', 'question-bank': '题库管理', 'task-records': '作业记录' };
titleMap.maintenance = '数据清理';
const typeMap = { text: '文字', image: '图片', file: '文件', voice: '语音', red_packet: '历史红包（已停用）', system: '系统' };
const statusMap = { active: '正常', frozen: '已冻结', deleted: '已删除', success: '成功', failed: '失败', sent: '已发送', recalled: '已撤回', completed: '已完成', expired: '已过期', refunded: '已退回' };
const deviceMap = { web: '网页端', android: '安卓端', ios: '苹果端', pc: '电脑端' };
const targetTypeMap = { user: '用户', message: '消息', conversation: '会话', group: '群组', wallet: '钱包', red_packet: '历史红包（已停用）' };
const remarkMap = { 'Claim internal red packet': '领取内部红包', 'Send internal red packet': '发放内部红包', 'audit test': '审计测试', 'local test': '本地测试' };
const actionMap = { 'user.status': '用户状态变更', 'user.permission': '用户权限变更', 'user.edit': '编辑用户资料', 'user.create': '新增用户', 'user.batch_create': '批量创建用户', 'user.clear_chat': '清理用户聊天', 'user.reset_token': '重置用户令牌', 'user.logout': '用户强制下线', 'user.delete': '删除用户', 'message.moderate_recall': '管理员撤回消息', 'wallet.top_up': '后台充值', 'wallet.debit': '后台扣款', 'group.create': '新增群组', 'group.update': '修改群组', 'group.delete': '删除群组', 'user.sensitive_word.create': '新增敏感词', 'user.sensitive_word.edit': '修改敏感词', 'user.sensitive_word.delete': '删除敏感词', 'user.sensitive_word.batch_delete': '批量删除敏感词' };
Object.assign(actionMap, { 'maintenance.settings': '修改清理计划', 'maintenance.start': '手动清理数据' });
Object.assign(actionMap, { 'admin.login_failed': '后台登录失败', 'admin.access_denied': '后台越权访问已拦截' });
const label = (map, value) => map[value] || (value ? '其他' : '-');
titleMap.announcement = '通知公告';
titleMap.explore = '探索配置';
titleMap['client-config'] = '客户端配置';
titleMap.routes = '线路管理';
titleMap['admin-accounts'] = '后台账号';
titleMap['dispatch-tasks'] = '分发任务';
targetTypeMap.announcement = '通知公告';
actionMap['announcement.update'] = '修改通知公告';
actionMap['client_navigation.update'] = '修改探索入口';
actionMap['client.diagnostics'] = '客户端上传日志';
actionMap['wallet.request_review'] = '审核钱包申请';
Object.assign(actionMap, { 'admin_account.create': '新增后台账号', 'admin_account.update': '编辑后台账号', 'admin_account.status': '变更后台账号状态', 'admin_account.password_reset': '重置后台账号密码', 'admin.account.create': '新增后台账号', 'admin.account.update': '编辑后台账号', 'admin.account.status': '变更后台账号状态', 'admin.password_reset': '重置后台账号密码', 'admin.login': '后台账号登录', 'admin.logout': '后台账号退出' });
Object.assign(targetTypeMap, { admin_account: '后台账号', admin: '后台账号' });
Object.assign(actionMap, { 'dispatch.task.create': '新增分发任务', 'dispatch.task.update': '编辑分发任务', 'dispatch.task.status': '变更分发任务状态', 'dispatch.task.delete': '删除分发任务' });
targetTypeMap.dispatch_task = '分发任务';
targetTypeMap.mobile_device = '手机设备';
Object.assign(actionMap, { 'mobile_device.unbind': '解绑手机设备', 'mobile_device.unbind_all': '解绑全部手机设备', 'mobile_device.policy': '修改手机设备锁' });
function auditDetail(item) {
  const detail = item.detail || {};
  if (item.action === 'wallet.request_review') return { 用户编号: detail.user_id, 金额: money(detail.amount_fen), 处理结果: detail.decision === 'approved' ? '已通过' : '已拒绝' };
  if (item.action !== 'client.diagnostics') return detail;
  const events = { 'page.home': '打开我的页面', 'page.profile': '打开编辑资料', 'page.accounts': '打开账号列表', 'page.wallet': '打开钱包', 'page.appearance': '打开外观设置', 'page.privacy': '打开隐私设置', 'page.notifications': '打开通知设置', 'page.language': '打开语言设置', 'profile.save': '保存资料', 'account.add': '添加账号', 'account.switch': '切换账号', 'cache.clear': '清除缓存', 'diagnostics.upload': '上传日志' };
  const codes = { ANDROID_JAVA_CRASH: '应用崩溃', ANDROID_MAIN_STALL: '界面线程卡顿', ANDROID_PROCESS_EXIT: '系统终止进程', ANDROID_MEMORY: '图片内存不足', ANDROID_SESSION_RESTORE: '恢复连接失败', ANDROID_SOCKET_LOST: '实时连接中断', ANDROID_SOCKET_TIMEOUT: '实时连接超时', ANDROID_SOCKET_PACKET: '实时消息处理异常' };
  return { 应用名称: detail.app_name, 应用版本: detail.app_version, 平台: detail.platform === 'ios' ? 'iOS' : '安卓', 设备型号: detail.model, 系统版本编号: detail.sdk,
    ...(detail.schema_version === 2 ? { 上传方式: detail.upload_mode === 'automatic' ? '自动上传' : '手动上传', 诊断编号: detail.diagnostic_id,
      异常记录: (detail.incidents || []).map(row => ({ 错误编号: row.code, 问题: codes[row.code] || row.code, 时间: new Date(Number(row.at)).toLocaleString('zh-CN'), 前台: row.foreground, 异常类型: row.exception_class, 卡顿毫秒: row.duration_ms || 0, 已用内存KB: row.heap_used_kb, 堆上限KB: row.heap_limit_kb, 系统退出原因: row.exit_reason, 调用栈: row.frames || [] })) } : {}),
    操作记录: (detail.events || []).map(event => ({ 操作: events[event.event] || '其他客户端操作', 结果: event.status === 'success' ? '成功' : '失败', 时间: new Date(Number(event.at)).toLocaleString('zh-CN') })) };
}
function auditActionLabel(item) { return item.action === 'admin.account.update' && item.detail?.password_reset ? '编辑后台账号／重置密码' : label(actionMap, item.action); }
const remark = (value) => remarkMap[value] || value || '-';

const adminPageCatalog = [
  ['dashboard', '运营总览', false], ['devices', '设备管理', true], ['users', '用户管理', true], ['groups', '群组管理', true], ['messages', '消息与会话', true],
  ['moderation', '内容审核', true], ['sensitive-words', '敏感词管理', true], ['login-logs', '系统日志', false], ['announcement', '通知公告', true],
  ['task-config', '任务配置', true], ['question-bank', '题库管理', true], ['task-records', '作业记录', true], ['client-config', '客户端配置', true], ['routes', '线路管理', true], ['dispatch-tasks', '分发任务', true], ['maintenance', '数据清理', true],
].map(([key, title, manage]) => ({ key, title, view: `${key}.view`, manage: manage ? `${key}.manage` : null }));
function isSuperAdmin(account = state.admin) { return Boolean(account && (account.is_super_admin === true || account.role === 'admin')); }
function accountCan(account, key, action = 'view') {
  if (!account) return false;
  if (key === 'explore') key = 'client-config';
  if (key === 'admin-accounts') return isSuperAdmin(account);
  const item = adminPageCatalog.find(page => page.key === key); if (!item) return false;
  if (isSuperAdmin(account)) return action === 'view' || Boolean(item.manage);
  const permissions = Array.isArray(account.permissions) ? account.permissions : account.role === 'auditor' ? adminPageCatalog.map(page => page.view) : [];
  if (!permissions.includes(item.view)) return false;
  return action === 'view' || Boolean(item.manage && permissions.includes(item.manage) && account.role !== 'auditor');
}
function canPage(key, action = 'view') { return accountCan(state.admin, key, action); }
function authorizedPage(preferred = state.view) {
  if (canPage(preferred)) return preferred === 'explore' ? 'client-config' : preferred;
  return adminPageCatalog.find(page => canPage(page.key))?.key || (canPage('admin-accounts') ? 'admin-accounts' : null);
}
function filterAuthorizedNavigation(root = document) {
  // 仅隐藏导航入口，保留后台账号页面、权限及机器人功能。
  root.querySelectorAll('[data-view]').forEach(node => { node.hidden = node.dataset.view === 'admin-accounts' || !canPage(node.dataset.view); });
  root.querySelectorAll('.nav-group').forEach(group => { group.hidden = ![...group.querySelectorAll('[data-view]')].some(node => !node.hidden); });
}
function apiAccessPages(path, method = 'GET') {
  const endpoint = path.split('?')[0]; const write = !['GET', 'HEAD'].includes(method.toUpperCase());
  if (endpoint.startsWith('/admin/auth/') || endpoint === '/health') return null;
  if (endpoint.startsWith('/admin/accounts')) return [['admin-accounts', 'view']];
  if (endpoint.startsWith('/admin/stats')) return [['dashboard', 'view']];
  if (endpoint === '/admin/users/avatar') return [['users', 'manage'], ['groups', 'manage']];
  if (endpoint.startsWith('/admin/messages')) return [['messages', write ? 'manage' : 'view'], ['moderation', write ? 'manage' : 'view']];
  if (endpoint.startsWith('/admin/work-records')) return [['task-records', write ? 'manage' : 'view']];
  if (endpoint.startsWith('/admin/work-tasks')) return [['task-config', write || endpoint.endsWith('/code') ? 'manage' : 'view']];
  if (endpoint.startsWith('/admin/dispatch-tasks')) return [['dispatch-tasks', write ? 'manage' : 'view']];
  if (endpoint.startsWith('/admin/maintenance/')) return [['maintenance', write ? 'manage' : 'view']];
  const pages = [['/admin/mobile-devices', 'devices'], ['/admin/users', 'users'], ['/admin/groups', 'groups'], ['/admin/sensitive-words', 'sensitive-words'], ['/admin/login-logs', 'login-logs'], ['/admin/audit-logs', 'login-logs'], ['/admin/announcement', 'announcement'], ['/admin/client-routes', 'routes'], ['/admin/client-config', 'client-config'], ['/admin/client-navigation', 'client-config'], ['/admin/work-questions', 'question-bank']];
  const page = pages.find(([prefix]) => endpoint === prefix || endpoint.startsWith(prefix + '/'));
  return page ? [[page[1], write ? 'manage' : 'view']] : [];
}
function assertAdminApiAccess(path, method = 'GET') {
  const candidates = apiAccessPages(path, method);
  if (candidates === null) return;
  if (!candidates.some(([key, action]) => canPage(key, action))) throw new Error('当前账号没有此页面或操作的权限');
}
function normalizedAccountPermissions(selected, catalog = adminPageCatalog, readOnly = false) {
  const values = new Set(selected); const result = [];
  for (const item of catalog) {
    if (values.has(item.view) || (!readOnly && item.manage && values.has(item.manage))) result.push(item.view);
    if (!readOnly && item.manage && values.has(item.manage)) result.push(item.manage);
  }
  return result;
}
let adminPermissionRefresh = null;
async function refreshAdminPermissions() {
  if (adminPermissionRefresh) return adminPermissionRefresh;
  adminPermissionRefresh = (async () => {
    const result = await api('/admin/auth/me', { scope: false });
    state.admin = result.admin || result;
    if (result.csrf_token) state.csrf = result.csrf_token;
    state.view = authorizedPage() || '';
    history.replaceState(null, '', state.view ? `#${state.view}` : '#');
    closeUserCreateModal(true); closeUserEditModal(); document.querySelectorAll('.user-modal-backdrop').forEach(node => node.remove());
    renderShell(); await renderView();
  })().catch(error => { if (state.token) notify(error.message, 'error'); }).finally(() => { adminPermissionRefresh = null; });
  return adminPermissionRefresh;
}
function renderNoAdminPages() {
  activePageLoad?.controller.abort();
  $('top-title').textContent = '暂无已授权页面';
  $('app').innerHTML = '<section class="panel admin-empty-permissions" role="status"><h2>当前账号尚未分配页面权限</h2><p>请联系超级管理员分配需要查看或操作的页面，然后重新登录。</p><button class="primary" id="empty-permissions-sign-out" type="button">退出登录</button></section>';
  $('empty-permissions-sign-out').onclick = () => $('sign-out').click();
}
function enforceReadOnlyControls(root = document) {
  if (canPage(state.view, 'manage') || (state.view === 'admin-accounts' && isSuperAdmin())) return;
  const mutations = '[data-device-unbind], #devices-unbind-all, #devices-policy, [data-user-action], [data-user-edit], .user-switch, [data-recall-id], [data-recall], [data-moderate-message], [data-shop-remove], [data-explore-remove], [data-permission], [data-user-status], [data-status], [data-group-edit], [data-group-delete], [data-word-edit], [data-word-delete], [data-work-edit], [data-work-delete], [data-work-status], [data-work-toggle], [data-work-code], [data-question-edit], [data-question-delete], [data-route-edit], [data-route-delete], [data-review-value], #user-create-button, #user-batch-button, #user-edit-submit, #batch-create-submit, #group-create-button, #group-delete-button, #group-edit-submit, #sensitive-word-create-button, #sensitive-word-batch-delete, #sensitive-word-submit, #announcement-save, #explore-save, #explore-add, #client-config-save, #client-shop-add, #work-task-create, #work-task-submit, #work-question-submit, #question-create-button, #question-import-button, #question-import-file, #work-record-submit, #work-record-auto-review, #work-review-note, #route-create-button, #route-batch-delete, #route-submit';
  root.querySelectorAll(mutations + ', #dispatch-task-new, #dispatch-task-save, #dispatch-step-add, [data-dispatch-edit], [data-dispatch-status], [data-dispatch-delete], [data-dispatch-step-remove]').forEach(node => { node.disabled = true; node.dataset.permissionDisabled = 'true'; node.title = '当前页面仅有查看权限'; });
  root.querySelectorAll('#user-create-form, #user-edit-form, #batch-create-form, #group-edit-form, #sensitive-word-form, #announcement-form, #explore-form, #client-config-form, #route-form, #work-task-form, #work-question-form').forEach(form => {
    form.querySelectorAll('input, select, textarea, button[type="submit"]').forEach(node => { node.disabled = true; node.dataset.permissionDisabled = 'true'; });
  });
}

let activePageLoad = null;
const actionLocks = new Set();
const getRequests = new Map();
const cancelled = error => error?.name === 'AbortError';
const requestId = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`}`;

function notify(message, kind = 'success') {
  let region = $('admin-notifications');
  if (!region) {
    region = document.createElement('div'); region.id = 'admin-notifications';
    region.className = 'admin-notifications'; region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  const item = document.createElement('div'); item.className = `admin-toast ${kind}`;
  const text = document.createElement('span'); text.textContent = message;
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭提示'); close.onclick = () => item.remove();
  item.append(text, close); region.appendChild(item);
  while (region.children.length > 3) region.firstElementChild.remove();
  setTimeout(() => item.remove(), kind === 'error' ? 10000 : 6000);
}

async function withAction(key, controls, action) {
  if (actionLocks.has(key)) return;
  actionLocks.add(key);
  const nodes = [...controls].filter(Boolean).map(node => ({ node, disabled: node.disabled }));
  nodes.forEach(({ node }) => { node.disabled = true; node.setAttribute('aria-busy', 'true'); });
  try { return await action(); }
  catch (error) { if (!cancelled(error)) notify(error.message, 'error'); }
  finally {
    actionLocks.delete(key);
    nodes.forEach(({ node, disabled }) => { node.disabled = disabled; node.removeAttribute('aria-busy'); });
  }
}

async function refreshAfterAction(view, load) {
  if (state.view !== view) return;
  // 修改完成时若已有刷新在途，等它结束再读取，避免展示修改前的快照。
  if (activePageLoad?.loading) await activePageLoad.promise;
  if (state.view === view) await load();
}

// 覆盖实际绑定的异步按钮与表单，锁定整张表单，阻止回车和连续点击再次提交。
function guardInteractions(root = document) {
  filterAuthorizedNavigation(root); enforceReadOnlyControls(root);
  root.querySelectorAll('#app button, #app form, .user-modal-backdrop button, .user-modal-backdrop form').forEach(node => {
    const property = node.tagName === 'FORM' ? 'onsubmit' : 'onclick';
    const handler = node[property];
    if (!handler || handler.adminGuarded) return;
    let pending = false;
    const guarded = function (event) {
      if (node.dataset.permissionDisabled === 'true') { event?.preventDefault(); notify('当前页面仅有查看权限', 'error'); return; }
      if (pending) { event?.preventDefault(); return; }
      pending = true;
      const controls = node.tagName === 'FORM' ? [...node.elements] : [node];
      const previous = controls.map(control => ({ control, disabled: control.disabled }));
      let result;
      try { result = handler.call(this, event); }
      catch (error) { pending = false; notify(error.message, 'error'); return; }
      if (!result?.then) { pending = false; return result; }
      node.setAttribute('aria-busy', 'true'); controls.forEach(control => control.disabled = true);
      return Promise.resolve(result).catch(error => { if (!cancelled(error)) notify(error.message, 'error'); }).finally(() => {
        pending = false; node.removeAttribute('aria-busy'); previous.forEach(({ control, disabled }) => control.disabled = disabled);
      });
    };
    guarded.adminGuarded = true; node[property] = guarded;
  });
}
new MutationObserver(() => guardInteractions()).observe(document.body, { childList: true, subtree: true });

async function readAdminResponse(response) {
  let data;
  try { data = await response.json(); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  const message = response.status === 404
    ? '后台入口或接口不可用（HTTP 404）。请从机器人重新打开当前账号的完整专属入口。'
    : response.status >= 500
      ? `后台服务异常（HTTP ${response.status}），请稍后重试。`
      : `后台返回的数据格式异常（HTTP ${response.status}），请刷新页面重试。`;
  return { ok: false, error: { code: 'ADMIN_RESPONSE_INVALID', message } };
}
function adminResponseError(response, data, fallback) {
  const requestId = String(data.error?.request_id || response.headers?.get('X-Pulse-Request-ID') || '');
  let message = data.error?.message || fallback;
  if (/^[a-f0-9]{24}$/.test(requestId) && !message.includes(requestId)) message += '（请求编号：' + requestId + '）';
  return Object.assign(new Error(message), { status: response.status, code: data.error?.code, requestId });
}

async function api(path, options = {}) {
  const { scope: scoped = true, timeout = 30000, ...fetchOptions } = options;
  assertAdminApiAccess(path, fetchOptions.method || 'GET');
  const read = !fetchOptions.method || fetchOptions.method.toUpperCase() === 'GET';
  const scope = read && scoped ? activePageLoad : null;
  const signal = fetchOptions.signal || scope?.controller.signal;
  const dedupeKey = read ? `${scope?.id || 0}:${path}` : null;
  if (dedupeKey && getRequests.has(dedupeKey)) return getRequests.get(dedupeKey);
  const headers = { 'Content-Type': 'application/json', ...adminRequestHeaders(), ...(options.headers || {}) };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  const pending = (async () => {
    try {
      const response = await PulseGoAdmin.fetch(path, { ...fetchOptions, headers, signal: controller.signal });
      const data = await readAdminResponse(response);
      if (scope && (scope !== activePageLoad || signal?.aborted)) throw new DOMException('已取消旧页面请求', 'AbortError');
      if (response.status === 401 && path !== '/admin/auth/login') { endAdminSession('登录已失效，请重新登录'); throw adminResponseError(response, {}, '登录已失效，请重新登录'); }
      if (response.status === 403 && ['ADMIN_CSRF_REQUIRED', 'ADMIN_ORIGIN_DENIED'].includes(data.error?.code)) throw new Error(data.error.message);
      if (response.status === 403 && path !== '/admin/auth/me') { void refreshAdminPermissions(); throw new Error(data.error?.message || '页面权限已改变，正在刷新授权'); }
      if (!response.ok || data.ok === false) throw adminResponseError(response, data, '请求失败，请稍后重试');
      return data.data;
    } catch (error) {
      if (timedOut) throw new Error('请求超时，请稍后重试');
      if (error instanceof TypeError) throw new Error('无法连接后台服务，请检查网络或服务是否启动');
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
    }
  })().finally(() => { if (dedupeKey && getRequests.get(dedupeKey) === pending) getRequests.delete(dedupeKey); });
  if (dedupeKey) getRequests.set(dedupeKey, pending);
  return pending;
}

function endAdminSession(message = '') {
  globalThis.AdminMaintenance?.close?.();
  closeUserCreateModal(true);
  closeUserEditModal();
  state.token = ''; state.csrf = ''; state.admin = null; sessionStorage.removeItem('pulse_admin_token');sessionStorage.removeItem(PulseGoAdmin.csrfKey);PulseGoAdmin.reset();
  activePageLoad?.controller.abort(); getRequests.clear(); showLogin(message);
}
async function refreshSystemHealth() {
  const status = $('system-health'); const dashboard = $('dashboard-health');
  try {
    const health = await PulseGoAdmin.request('/health', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const response = { ok: health.ok === true };
    const states = [health.database?.status, health.realtime?.status, health.websocket?.status];
    const pushStatus = health.push?.status;
    const dispatchStatus = health.dispatch?.status || 'unknown';
    const healthy = response.ok && health.ok === true && states.every(value => value === 'up' || value === 'fallback') && (!pushStatus || pushStatus === 'up') && dispatchStatus === 'up';
    const text = states.includes('down') || pushStatus === 'down' ? '服务异常' : dispatchStatus === 'down' ? '分发服务异常' : pushStatus === 'unconfigured' ? '移动推送未配置' : healthy ? '系统服务正常' : '服务状态待确认';
    if (status?.isConnected) { status.textContent = text; status.classList.toggle('health-error', !healthy); }
    if (dashboard?.isConnected) dashboard.textContent = text;
    if ($('database-latency')) $('database-latency').textContent = health.database?.status === 'up' ? `${Number(health.database.latency_ms || 0)} 毫秒` : '不可用';
    if ($('health-components')) $('health-components').textContent = `数据库：${health.database?.status || 'unknown'} / 实时：${health.realtime?.status || 'unknown'} / WebSocket：${health.websocket?.status || 'unknown'} / 分发：${dispatchStatus}（在线 ${Number(health.dispatch?.workers || 0)} / ${Number(health.dispatch?.expected_workers || 1)}，逾期 ${Number(health.dispatch?.overdue_tasks || 0) + Number(health.dispatch?.overdue_runs || 0)}） / 推送：${health.push?.status || 'unknown'}（待处理 ${Number(health.push?.pending_jobs || 0)}，24小时失败 ${Number(health.push?.failed_jobs_24h || 0)}）`;
  } catch {
    if (status?.isConnected) { status.textContent = '无法取得服务状态'; status.classList.add('health-error'); }
    if (dashboard?.isConnected) dashboard.textContent = '无法取得服务状态';
    if ($('health-components')) $('health-components').textContent = '检查失败，请重试';
  }
}

function showLogin(message = '') {
  globalThis.AdminMaintenance?.close?.();
  closeMessagePreview(false); state.messageItems = null; state.messageFilters = {};
  closeUserAvatarPreview(false);
  globalThis.AdminWorkRecords?.close?.();
  document.body.classList?.remove('dispatch-tasks-view');
  globalThis.AdminDispatchTasks?.close?.();
  document.body.innerHTML = `<main class="login-shell">
    <div class="login-glow login-glow-one"></div>
    <div class="login-glow login-glow-two"></div>
    <div class="login-grid-lines"></div>
    <section class="login-card" aria-labelledby="login-title">
      <div class="login-card-head">
        <div class="login-brand"><div class="login-mark"><span>脉</span><i></i></div><div><b>脉冲即时通讯</b><span>运营控制台</span></div></div>
        <span class="login-secure"><i></i>安全连接</span>
      </div>
      <div class="login-layout">
        <aside class="login-intro">
          <p class="eyebrow">管理控制台 · 安全访问</p>
          <h1>把每一次连接，<br><em>都看得更清楚。</em></h1>
          <p class="login-intro-copy">集中管理用户、会话、群组与系统运行状态，让运营工作始终保持清晰、有序。</p>
          <div class="login-insight"><div class="insight-pulse"><span></span><i></i><b></b></div><div><strong>独立管理员账户</strong><small>操作权限与审计记录随账户绑定</small></div></div>
          <div class="login-stats"><span><b>实时</b><small>状态同步</small></span><span><b>全天</b><small>安全守护</small></span><span><b>多端</b><small>统一管理</small></span></div>
        </aside>
        <div class="login-form-panel">
          <div class="login-form-heading"><span class="login-heading-icon">↗</span><div><p>欢迎回来</p><h2 id="login-title">登录管理后台</h2></div></div>
          <p class="muted">请输入管理员账号和密码，进入运营中心。</p>
          <form id="admin-login"><label class="login-field"><span>管理员账号</span><div class="login-input-wrap"><input id="admin-username" required autocomplete="username" maxlength="64" placeholder="请输入管理员账号"></div></label>
            <label class="login-field"><span>管理员密码</span><div class="login-input-wrap"><span class="input-icon">⌁</span><input id="admin-password" type="password" required autocomplete="current-password" placeholder="请输入管理员密码"><button id="toggle-admin-password" type="button" aria-label="显示管理员密码" aria-pressed="false">显示</button></div><small>安全登录 · 操作留痕</small></label>
            <button class="login-submit" id="login-submit" type="submit"><span id="login-submit-label">进入运营中心</span><span class="login-arrow">→</span><span class="login-spinner" aria-hidden="true"></span></button>
          </form>
          <p id="login-error" class="login-error" role="alert"></p>
          <div class="login-form-foot"><span>当前环境</span><b><i></i>${localDev ? '本地运营服务' : '正式运营服务'}</b><time id="login-time"></time></div>
        </div>
      </div>
      <footer class="login-footer"><span><i></i>脉冲即时通讯 · 管理员专用入口</span><span>安全运营中心</span></footer>
    </section>
  </main>`;
  const form = $('admin-login');
  const keyInput = $('admin-password');
  const submit = $('login-submit');
  const submitLabel = $('login-submit-label');
  const errorNode = $('login-error');
  errorNode.textContent = message;
  const panel = document.querySelector('.login-form-panel');
  const updateLoginTime = () => { const time = $('login-time'); if (time) time.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); };
  updateLoginTime();
  const clock = setInterval(updateLoginTime, 1000);
  $('toggle-admin-password').onclick = () => {
    const visible = keyInput.type === 'text';
    keyInput.type = visible ? 'password' : 'text';
    $('toggle-admin-password').textContent = visible ? '显示' : '隐藏';
    $('toggle-admin-password').setAttribute('aria-label', visible ? '显示管理员密码' : '隐藏管理员密码');
    $('toggle-admin-password').setAttribute('aria-pressed', String(!visible));
    keyInput.focus();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const username = $('admin-username').value.trim();
    const password = keyInput.value;
    submit.disabled = true;
    submit.classList.add('is-loading');
    submitLabel.textContent = '正在验证…';
    errorNode.textContent = '';
    errorNode.classList.remove('is-visible');
    panel.classList.remove('is-error');
    try {
      const result = await api('/admin/auth/login', { method: 'POST', body: JSON.stringify({ username, password, session_mode: 'cookie' }), scope: false });
      if (result?.session_mode !== 'cookie' || !result.csrf_token || !result.admin) throw new Error('管理员登录响应异常，请刷新后台后重试');
      state.token = requestId('admin-session'); state.csrf = result.csrf_token; state.admin = result.admin;
      keyInput.value = '';
      clearInterval(clock);
      renderShell();
      await renderView();
    } catch (error) {
      errorNode.textContent = error.message;
      errorNode.classList.add('is-visible');
      panel.classList.add('is-error');
      submit.disabled = false;
      submit.classList.remove('is-loading');
      submitLabel.textContent = '重新验证';
      keyInput.focus();
    }
  };
}

function renderShell() {
  globalThis.AdminMaintenance?.close?.();
  closeUserAvatarPreview(false);
  globalThis.AdminWorkRecords?.close?.();
  state.view = authorizedPage() || '';
  history.replaceState(null, '', state.view ? `#${state.view}` : '#');
  document.body.innerHTML = '<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">脉</span><div><strong>脉冲</strong></div></div><nav><a class="nav-item" data-view="dashboard" href="#dashboard"><span class="icon">⌂</span>运营总览</a><a class="nav-item" data-view="users" href="#users"><span class="icon">♙</span>用户管理</a><a class="nav-item" data-view="groups" href="#groups"><span class="icon">群</span>群组管理</a><a class="nav-item" data-view="messages" href="#messages"><span class="icon">▤</span>消息与会话</a><a class="nav-item" data-view="moderation" href="#moderation"><span class="icon">审</span>内容审核</a><a class="nav-item" data-view="sensitive-words" href="#sensitive-words"><span class="icon">词</span>敏感词管理</a><a class="nav-item" data-view="login-logs" href="#login-logs"><span class="icon">▣</span>系统日志</a></nav><p class="section-label shortcut-title">快捷操作</p><button id="refresh" class="shortcut"><span class="shortcut-icon green">↻</span>刷新数据</button><button id="sign-out" class="shortcut"><span class="shortcut-icon orange">×</span>退出登录</button><div class="account"><span class="avatar">管</span><span><b id="admin-account-name">管理员账户</b><small id="admin-account-role">已验证管理员</small></span><i></i></div></aside><main class="content"><header class="topbar"><div><p class="topbar-kicker">脉冲即时通讯 · 管理后台</p><h1 id="top-title">运营总览</h1></div><div class="top-actions"><span class="healthy" id="system-health"><i></i>正在检查服务状态</span><span class="admin-avatar">管</span></div></header><div id="app" class="page"></div></main></div>';
  document.querySelector('.sidebar nav').insertAdjacentHTML('beforeend', '<a class="nav-item" data-view="announcement" href="#announcement"><span class="icon">告</span>通知公告</a><div class="nav-group task-nav-group"><button class="nav-item nav-parent" id="task-nav-toggle" type="button" aria-expanded="true" aria-controls="task-nav-children"><span class="icon">任</span><span>任务批改管理</span><span class="nav-chevron" aria-hidden="true">⌄</span></button><div class="nav-children" id="task-nav-children" aria-hidden="false"><a class="nav-item nav-child" data-view="task-config" href="#task-config"><span class="icon">配</span>任务配置</a><a class="nav-item nav-child" data-view="question-bank" href="#question-bank"><span class="icon">题</span>题库管理</a><a class="nav-item nav-child" data-view="task-records" href="#task-records"><span class="icon">改</span>作业记录</a></div></div><a class="nav-item" data-view="explore" href="#explore"><span class="icon">探</span>探索配置</a><div class="nav-group third-party-nav-group"><button class="nav-item nav-parent" id="third-party-nav-toggle" type="button" aria-expanded="true" aria-controls="third-party-nav-children"><span class="icon">三</span><span>三方配置</span><span class="nav-chevron" aria-hidden="true">⌄</span></button><div class="nav-children" id="third-party-nav-children" aria-hidden="false"><a class="nav-item nav-child" data-view="client-config" href="#client-config"><span class="icon">配</span>客户端配置</a><a class="nav-item nav-child" data-view="routes" href="#routes"><span class="icon">线</span>线路管理</a></div></div>');
  document.querySelector('.sidebar nav [data-view="explore"]')?.remove();
  document.querySelector('.sidebar nav').insertAdjacentHTML('afterbegin', '<a class="nav-item" data-view="dispatch-tasks" href="#dispatch-tasks"><span class="icon">◷</span>分发任务</a>');
  // 暂时隐藏左侧“后台账号”菜单，保留功能代码；取消下一行注释即可恢复入口。
  // if (isSuperAdmin()) document.querySelector('.sidebar nav').insertAdjacentHTML('beforeend', '<a class="nav-item" data-view="admin-accounts" href="#admin-accounts"><span class="icon">管</span>后台账号</a>');
  document.querySelector('.sidebar nav [data-view="users"]').insertAdjacentHTML('afterend', '<a class="nav-item" data-view="devices" href="#devices"><span class="icon">机</span>设备管理</a>');
  document.querySelector('.sidebar nav').insertAdjacentHTML('beforeend', '<a class="nav-item" data-view="maintenance" href="#maintenance"><span class="icon">↻</span>数据清理</a>');
  filterAuthorizedNavigation();
  const navIcons = {
    dashboard: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7"></path><path d="M5 9v10h14V9"></path><path d="M9 19v-6h6v6"></path></svg>',
    users: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"></circle><path d="M3.5 20c.7-3.4 2.5-5 5.5-5s4.8 1.6 5.5 5"></path><path d="M16 5.5a3 3 0 0 1 0 5.8"></path><path d="M17 15c1.8.6 2.9 2.2 3.5 5"></path></svg>',
    groups: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="2.7"></circle><circle cx="16" cy="9" r="2.4"></circle><path d="M3.5 19c.6-3.1 2.1-4.7 4.5-4.7s3.9 1.6 4.5 4.7"></path><path d="M13.5 15c.7-.8 1.6-1.2 2.7-1.2 2.1 0 3.5 1.6 4.1 4.2"></path></svg>',
    messages: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v11H8l-4 3v-14z"></path><path d="M8 10h8M8 13h5"></path></svg>',
    moderation: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 19 6v5c0 4.7-2.8 8.2-7 10-4.2-1.8-7-5.3-7-10V6l7-3z"></path><path d="m8.5 12 2.3 2.3 4.8-5"></path></svg>',
    'sensitive-words': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M5 12h10M5 19h7"></path><path d="M18 16v5M15.5 18.5h5"></path></svg>',
    'login-logs': '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3.5" width="14" height="17" rx="2"></rect><path d="M8.5 8h7M8.5 12h7M8.5 16h4"></path></svg>',
    announcement: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11h4l9-5v12l-9-5H4z"></path><path d="M8 15.2 9.5 20h2L10 14.5"></path><path d="M20 9a4 4 0 0 1 0 6"></path></svg>',
    'dispatch-tasks': '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 7v5l4 2"></path></svg>',
    'task-config': '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3.5" width="16" height="17" rx="2"></rect><path d="M8 8h8M8 12h8M8 16h4"></path><path d="m16 15 1.5 1.5L20 14"></path></svg>',
    'question-bank': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5z"></path><path d="M8 8h8M8 12h6M8 16h4"></path></svg>',
    'task-records': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5z"></path><path d="M8 8h8M8 12h5M8 16h3"></path><circle cx="17" cy="16" r="3"></circle><path d="m17 14.5v1.7l1 0.6"></path></svg>',
    'task-group': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"></path><circle cx="8" cy="6" r="2"></circle><circle cx="15" cy="12" r="2"></circle><circle cx="10" cy="18" r="2"></circle></svg>',
    'client-config': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h14"></path><circle cx="9" cy="6" r="2"></circle><circle cx="15" cy="12" r="2"></circle><circle cx="11" cy="18" r="2"></circle></svg>',
    routes: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2"></circle><circle cx="18" cy="18" r="2"></circle><path d="M8 6h4a4 4 0 0 1 4 4v2a4 4 0 0 0 4 4h0"></path></svg>',
    'third-party': '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"></rect><rect x="14" y="4" width="6" height="6" rx="1"></rect><rect x="4" y="14" width="6" height="6" rx="1"></rect><rect x="14" y="14" width="6" height="6" rx="1"></rect></svg>'
  };
  document.querySelectorAll('.sidebar nav .icon').forEach((node) => {
    const item = node.closest('[data-view]');
    const key = item?.dataset.view || (node.closest('#third-party-nav-toggle') ? 'third-party' : node.closest('#task-nav-toggle') ? 'task-group' : '');
    if (navIcons[key]) { node.innerHTML = navIcons[key]; node.setAttribute('aria-hidden', 'true'); }
  });
  const thirdParty = document.querySelector('.third-party-nav-group');
  const thirdPartyToggle = $('third-party-nav-toggle');
  const thirdPartyChildren = $('third-party-nav-children');
  const thirdPartyViews = new Set(['client-config', 'routes']);
  const savedThirdPartyOpen = localStorage.getItem('pulse_admin_third_party_open');
  const setThirdPartyOpen = (open) => {
    thirdParty?.classList.toggle('is-collapsed', !open);
    thirdPartyToggle?.setAttribute('aria-expanded', String(open));
    thirdPartyChildren?.setAttribute('aria-hidden', String(!open));
    thirdPartyChildren?.querySelectorAll('a').forEach((link) => link.tabIndex = open ? 0 : -1);
    localStorage.setItem('pulse_admin_third_party_open', String(open));
  };
  const updateThirdPartyActive = () => thirdPartyToggle?.classList.toggle('active', thirdPartyViews.has(state.view));
  setThirdPartyOpen(savedThirdPartyOpen === null ? true : savedThirdPartyOpen === 'true' || state.view === 'client-config' || state.view === 'routes');
  updateThirdPartyActive();
  thirdPartyToggle.onclick = () => setThirdPartyOpen(thirdParty?.classList.contains('is-collapsed') === true);
  const taskGroup = document.querySelector('.task-nav-group');
  const taskToggle = $('task-nav-toggle');
  const taskChildren = $('task-nav-children');
  const taskViews = new Set(['task-config', 'question-bank', 'task-records']);
  const savedTaskOpen = localStorage.getItem('pulse_admin_task_open');
  const setTaskOpen = (open) => {
    taskGroup?.classList.toggle('is-collapsed', !open);
    taskToggle?.setAttribute('aria-expanded', String(open));
    taskChildren?.setAttribute('aria-hidden', String(!open));
    taskChildren?.querySelectorAll('a').forEach((link) => link.tabIndex = open ? 0 : -1);
    localStorage.setItem('pulse_admin_task_open', String(open));
  };
  const updateTaskActive = () => taskToggle?.classList.toggle('active', taskViews.has(state.view));
  setTaskOpen(savedTaskOpen === null ? true : savedTaskOpen === 'true' || taskViews.has(state.view));
  updateTaskActive();
  taskToggle.onclick = () => setTaskOpen(taskGroup?.classList.contains('is-collapsed') === true);
  document.querySelectorAll('[data-view]').forEach((node) => node.onclick = (event) => { event.preventDefault(); if (!canPage(node.dataset.view)) { notify('当前账号没有此页面权限', 'error'); return; } state.view = node.dataset.view; if (thirdPartyViews.has(state.view)) setThirdPartyOpen(true); if (taskViews.has(state.view)) setTaskOpen(true); updateThirdPartyActive(); updateTaskActive(); history.replaceState(null, '', `#${state.view}`); renderView(); });
  $('refresh').onclick = () => renderView();
  document.querySelector('.top-actions')?.insertAdjacentHTML('afterbegin', '<button id="top-refresh" class="top-refresh" type="button">刷新数据</button>');
  $('top-refresh').onclick = () => renderView();
  $('admin-account-name').textContent = state.admin?.username || '管理员';
  $('admin-account-role').textContent = { admin: '超级管理员', operator: '自定义权限账号', auditor: '只读账号' }[state.admin?.role] || '管理员';
  $('sign-out').onclick = async () => { try { await api('/admin/auth/logout', { method: 'POST', scope: false }); } finally { endAdminSession(); } };
  void refreshSystemHealth();
}

function pager(data, view) { const totalPages = Math.max(1, Math.ceil(Number(data.total || 0) / Number(data.size || 30))); if (totalPages <= 1) return ''; return `<div class="pager"><button class="table-action" data-page-action="prev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${data.page} / ${totalPages} 页，共 ${data.total} 条</span><button class="table-action" data-page-action="next" ${data.page >= totalPages ? 'disabled' : ''}>下一页</button><label class="pager-jump">跳转 <input data-page-input="${view}" type="number" min="1" max="${totalPages}" value="${data.page}"><button class="table-action" data-page-action="jump">确定</button></label></div>`; }
function bindPager(view, load) { document.querySelectorAll('[data-page-action]').forEach((button) => button.onclick = () => { const action = button.dataset.pageAction; const input = document.querySelector(`[data-page-input="${view}"]`); const next = action === 'jump' ? Number(input?.value || 1) : page(view) + (action === 'next' ? 1 : -1); if (Number.isInteger(next) && next > 0 && (!input || next <= Number(input.max))) { state.pages[view] = next; return load(); } }); }

async function loadDashboard() {
  const data = await api('/admin/stats'); const total = Number(data.users.total || 0); const online = Number(data.users.online || 0); const todayMessages = Number(data.today_messages || 0); const conversations = Number(data.conversations || 0); const dbLatency = Number(data.health?.database_latency_ms || 0);
  $('app').innerHTML = `<div class="page-title"><div><div class="title-eyebrow">运营数据中心</div><h2>运营总览</h2><p>数据更新时间：${esc(new Date(data.generated_at).toLocaleString('zh-CN'))}</p></div><button class="date" id="dashboard-refresh">刷新数据</button></div><section class="metrics"><article class="metric metric-green"><span>注册用户</span><strong>${total.toLocaleString('zh-CN')}</strong><em>${online.toLocaleString('zh-CN')} 人当前在线</em></article><article class="metric metric-blue"><span>会话总数</span><strong>${conversations.toLocaleString('zh-CN')}</strong><em>${data.today_logins || 0} 次今日登录</em></article><article class="metric metric-purple"><span>今日消息</span><strong>${todayMessages.toLocaleString('zh-CN')}</strong><em>已持久化消息</em></article><article class="metric metric-dark"><span>待处理事项</span><strong>${data.users.frozen || 0}</strong><em>${data.users.frozen || 0} 个冻结账户待审核</em></article></section><div class="middle-grid"><section class="panel chart-panel"><div class="panel-head"><div><h3>在线趋势</h3><p>尚未配置历史在线采集</p></div></div><p class="no-data">暂无可验证的趋势数据</p></section><section class="panel services"><div class="panel-head"><div><h3>服务状态</h3><p>当前运行情况</p></div><span class="health-text" id="dashboard-health">正在检查</span></div><div class="service"><span>在线会话</span><b>${online.toLocaleString('zh-CN')}</b><div><i class="blue" style="width:${Math.min(100, Math.max(5, online ? 85 : 5))}%"></i></div></div><div class="service"><span>数据库延迟</span><b><span id="database-latency">待检查</span></b><div><i style="width:${Math.min(100, Math.max(5, 100 - dbLatency))}%"></i></div></div><div class="service service-last"><span>接口检查</span><b><span id="health-components">正在检查</span></b></div></section></div><section class="panel quick"><div class="panel-head"><div><h3>快捷处理</h3><p>常用运营入口</p></div><span class="panel-tag">快速进入</span></div><div class="quick-grid"><a href="#users" data-view="users"><b>审</b><strong>用户审核</strong><small>${data.users.frozen || 0} 个冻结账户需要关注</small><em>查看用户列表　→</em></a><a href="#task-records" data-view="task-records"><b>任</b><strong>作业记录</strong><small>查看任务完成与工资记录</small><em>查看作业记录　→</em></a><a href="#groups" data-view="groups"><b>群</b><strong>群组管理</strong><small>当前共 ${conversations.toLocaleString('zh-CN')} 个会话</small><em>管理群组会话　→</em></a></div></section>`;
  document.querySelector('.metrics').insertAdjacentHTML('afterend', registrationRegionsPanel());
  bindRegistrationRegions();
  void loadRegistrationRegions(activePageLoad);
  $('registration-regions').insertAdjacentHTML('afterend', offsiteLoginPanel());
  $('offsite-login-refresh').onclick = () => loadOffsiteLogins(activePageLoad);
  $('offsite-login-retry').onclick = () => loadOffsiteLogins(activePageLoad);
  void loadOffsiteLogins(activePageLoad);
  void refreshSystemHealth();
  $('dashboard-refresh').onclick = loadDashboard; document.querySelectorAll('.quick-grid [data-view]').forEach((node) => node.onclick = (event) => { event.preventDefault(); if (!canPage(node.dataset.view)) { notify('当前账号没有此页面权限', 'error'); return; } state.view = node.dataset.view; history.replaceState(null, '', `#${state.view}`); renderView(); });
}

function registrationRegionsPanel() {
  return `<section id="registration-regions" class="panel registration-regions" aria-labelledby="registration-regions-title" aria-busy="true">
    <div class="registration-region-head"><div><h3 id="registration-regions-title">注册用户分布</h3><span>按省份热度分级展示</span></div><span id="registration-identified" class="registration-region-total">正在统计…</span></div>
    <div class="registration-region-plot"><span id="registration-map-help" class="registration-map-help">滚轮缩放 · 按住拖动</span><div class="registration-map-controls" role="group" aria-label="地图缩放"><button type="button" data-registration-map-action="out" aria-label="缩小地图" title="缩小地图" disabled>−</button><span id="registration-map-zoom" aria-label="地图缩放比例">100%</span><button type="button" data-registration-map-action="in" aria-label="放大地图" title="放大地图">+</button><button type="button" data-registration-map-action="reset" aria-label="重置地图" title="重置地图" disabled>重置</button></div><div class="registration-map-viewport"><svg class="registration-map" viewBox="0 0 680 510" data-zoom="1" data-zoomed="false" tabindex="0" role="group" aria-labelledby="registration-map-title registration-map-desc" aria-describedby="registration-map-help"><title id="registration-map-title">注册用户省份分布</title><desc id="registration-map-desc">根据注册IP的真实归属地区统计，选择省份可查看人数。无可识别地址的用户计入未识别。滚轮或加减键缩放，按住拖动地图，按0或Home键恢复全图。</desc><rect class="registration-inset" x="575" y="360" width="98" height="132" rx="2"/>${registrationProvinceMap.map(region => `<path data-registration-region="${region.code}" d="${region.path}" fill="#eaf3ff" fill-rule="evenodd" tabindex="0" role="img" aria-label="${esc(region.name)}：正在统计"><title>${esc(region.name)}：正在统计</title></path>`).join('')}<path class="registration-maritime" d="${registrationMaritimeBoundary}"/>${registrationProvinceLabelsHtml()}<text class="registration-inset-label" x="624" y="504" text-anchor="middle">南海诸岛</text></svg></div><div id="registration-region-tooltip" class="registration-region-tooltip" role="status" hidden></div></div>
    <div class="registration-region-feedback"><span id="registration-region-feedback" role="status" aria-live="polite">正在读取真实注册地区…</span><button id="registration-region-retry" class="table-action" hidden>重新查询</button></div>
    <div class="registration-region-foot"><div class="registration-region-legend"><span>热度</span><i aria-hidden="true"></i><span>低</span><span>高</span></div><span id="registration-unknown">未识别 — 人</span></div>
  </section>`;
}

function registrationHeatColor(count, maximum) {
  if (!count || !maximum) return '#eaf3ff';
  return ['#eaf3ff', '#bed5f3', '#8cb2e7', '#4f83ce', '#214b91'][Math.max(1, Math.min(4, Math.ceil(count / maximum * 4)))];
}

function bindRegistrationRegions() {
  const tooltip = $('registration-region-tooltip');
  const map = document.querySelector('#registration-regions .registration-map');
  bindRegistrationMapNavigation(map, tooltip);
  document.querySelectorAll('[data-registration-region]').forEach(node => {
    const show = () => { if (map?.dataset.dragging === 'true') return; tooltip.textContent = node.getAttribute('aria-label'); tooltip.hidden = false; };
    const hide = () => { tooltip.hidden = true; };
    node.onpointerenter = show; node.onpointerleave = hide;
    node.onfocus = show; node.onblur = hide; node.onclick = show;
    node.onkeydown = event => { if (event.key === 'Escape') hide(); };
  });
  $('registration-region-retry').onclick = () => loadRegistrationRegions(activePageLoad);
}

function registrationProvinceLabelsHtml() {
  const labels = typeof registrationProvinceLabels === 'undefined' ? [] : registrationProvinceLabels;
  // Keep the actual anchor in each province; short leaders separate the
  // coastal regions whose areas cannot hold two Chinese characters.
  const callouts = {
    '120000': { x: 484, y: 238, anchor: 'start' },
    '310000': { x: 523, y: 332, anchor: 'start' },
    '810000': { x: 451, y: 445, anchor: 'start' },
    '820000': { x: 411, y: 447, anchor: 'end' },
  };
  return `<g class="registration-map-labels" aria-hidden="true">${labels.map(region => {
    const placement = callouts[region.code];
    const x = placement?.x ?? region.x, y = placement?.y ?? region.y;
    const anchor = placement?.anchor || 'middle';
    const leader = placement ? `<path class="registration-map-label-line" data-registration-label-line="${esc(region.code)}" d="M${region.x},${region.y} L${x + (anchor === 'start' ? -4 : 4)},${y}"/><circle class="registration-map-label-dot" cx="${region.x}" cy="${region.y}" r="1.5"/>` : '';
    return `${leader}<text class="registration-map-label${region.radius < 9 ? ' is-compact' : ''}" data-registration-label="${esc(region.code)}" data-registration-label-callout="${Boolean(placement)}" data-anchor-x="${region.x}" data-anchor-y="${region.y}" x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="central">${esc(region.label)}</text>`;
  }).join('')}</g>`;
}

function bindRegistrationMapNavigation(map, tooltip) {
  if (!map || map.dataset.navigationBound === 'true') return;
  map.dataset.navigationBound = 'true';
  const panel = map.closest('.registration-regions');
  const base = { x: 0, y: 0, width: 680, height: 510 };
  let view = { ...base }, drag = null, suppressClickUntil = 0;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const hideTooltip = () => { if (tooltip) tooltip.hidden = true; };
  const update = next => {
    const zoom = clamp(base.width / next.width, 1, 4);
    const width = base.width / zoom, height = base.height / zoom;
    const viewportWidth = map.clientWidth || width, viewportHeight = map.clientHeight || height;
    const scale = Math.min(viewportWidth / width, viewportHeight / height);
    // Include the actual SVG letterbox in the pan area, with a small overlap
    // of the map extent at the outer limit instead of locking to its edges.
    const extraX = (viewportWidth / scale - width) / 2, extraY = (viewportHeight / scale - height) / 2;
    const keepX = Math.min(96, viewportWidth / 4, base.width * scale / 2) / scale;
    const keepY = Math.min(96, viewportHeight / 4, base.height * scale / 2) / scale;
    view = { x: clamp(next.x, keepX - width - extraX, base.width - keepX + extraX), y: clamp(next.y, keepY - height - extraY, base.height - keepY + extraY), width, height };
    map.setAttribute('viewBox', `${view.x} ${view.y} ${width} ${height}`);
    map.dataset.zoom = String(zoom);
    map.dataset.zoomed = String(zoom > 1);
    panel.querySelector('#registration-map-zoom').textContent = `${Math.round(zoom * 100)}%`;
    panel.querySelector('[data-registration-map-action="out"]').disabled = zoom <= 1;
    panel.querySelector('[data-registration-map-action="in"]').disabled = zoom >= 4;
    panel.querySelector('[data-registration-map-action="reset"]').disabled = Math.abs(zoom - 1) < 1e-9 && Math.abs(view.x) < 1e-6 && Math.abs(view.y) < 1e-6;
    hideTooltip();
  };
  const pointAt = (event, inverse = map.getScreenCTM()?.inverse()) => {
    if (!inverse) return null;
    const point = map.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    return point.matrixTransform(inverse);
  };
  const stopDrag = () => {
    if (!drag) return;
    const { id, moved } = drag;
    if (moved) suppressClickUntil = performance.now() + 250;
    drag = null; delete map.dataset.dragging;
    if (map.hasPointerCapture(id)) map.releasePointerCapture(id);
  };
  const reset = () => { stopDrag(); update(base); };
  const zoomAt = (factor, point = { x: view.x + view.width / 2, y: view.y + view.height / 2 }) => {
    stopDrag();
    const zoom = clamp(base.width / view.width * factor, 1, 4);
    const width = base.width / zoom, height = base.height / zoom;
    update({ x: point.x - (point.x - view.x) / view.width * width, y: point.y - (point.y - view.y) / view.height * height, width });
  };
  map.addEventListener('wheel', event => {
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    const point = pointAt(event); if (!point) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? map.clientHeight : 1;
    zoomAt(Math.exp(-clamp(event.deltaY * unit, -240, 240) / 350), point);
  }, { passive: false });
  map.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    const inverse = map.getScreenCTM()?.inverse();
    const point = pointAt(event, inverse); if (!point) return;
    drag = { id: event.pointerId, inverse, point, view: { ...view }, clientX: event.clientX, clientY: event.clientY, moved: false };
    map.setPointerCapture(event.pointerId);
  });
  map.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 3) return;
    drag.moved = true; map.dataset.dragging = 'true';
    const point = pointAt(event, drag.inverse); if (!point) return;
    event.preventDefault();
    update({ x: drag.view.x - (point.x - drag.point.x), y: drag.view.y - (point.y - drag.point.y), width: drag.view.width });
  });
  const finishDrag = event => {
    if (!drag || drag.id !== event.pointerId) return;
    stopDrag();
  };
  map.addEventListener('pointerup', finishDrag);
  map.addEventListener('pointercancel', finishDrag);
  map.addEventListener('lostpointercapture', finishDrag);
  map.addEventListener('click', event => {
    if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  map.addEventListener('pointerleave', hideTooltip);
  panel.querySelectorAll('[data-registration-map-action]').forEach(button => {
    button.onclick = () => {
      if (button.dataset.registrationMapAction === 'reset') reset();
      else zoomAt(button.dataset.registrationMapAction === 'in' ? 1.25 : 0.8);
    };
  });
  map.addEventListener('keydown', event => {
    if (['+', '=', '-', '0', 'Home'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0' || event.key === 'Home') reset();
      else zoomAt(event.key === '-' ? 0.8 : 1.25);
    }
  });
  reset();
  const resizeObserver = new ResizeObserver(() => {
    if (!map.isConnected) { resizeObserver.disconnect(); return; }
    if (map.clientWidth && map.clientHeight) { stopDrag(); update(view); }
  });
  resizeObserver.observe(map);
}

function renderRegistrationRegions(data) {
  const format = count => Number(count || 0).toLocaleString('zh-CN');
  const counts = new Map(data.provinces.map(region => [region.code, region]));
  const max = Math.max(0, ...data.provinces.map(region => Number(region.count)));
  document.querySelectorAll('[data-registration-region]').forEach(node => {
    const region = counts.get(node.dataset.registrationRegion);
    const count = Number(region?.count || 0);
    node.setAttribute('fill', registrationHeatColor(count, max));
    const text = `${region?.name || '地区'}：${format(count)} 人`;
    node.setAttribute('aria-label', text); node.querySelector('title').textContent = text;
  });
  $('registration-region-tooltip').hidden = true;
  $('registration-identified').textContent = `已识别 ${format(data.identified)} 人`;
  $('registration-unknown').textContent = `${data.overseas ? `境外 ${format(data.overseas)} 人　·　` : ''}未识别 ${format(data.unknown)} 人`;
  const reasons = data.unknown_reasons;
  $('registration-unknown').title = `无有效注册IP ${format(reasons.missing_or_invalid)} 人；本机或内网 ${format(reasons.private)} 人；待查询 ${format(reasons.pending)} 人；查询失败 ${format(reasons.unavailable)} 人；省份未匹配 ${format(reasons.unmapped)} 人`;
  const feedback = $('registration-region-feedback');
  feedback.textContent = data.domestic ? '按注册 IP 归属地统计，悬停省份查看人数' : data.total ? '暂无可定位到省份的注册 IP，未知地区如实计入未识别' : '暂无注册用户';
  feedback.title = '统计全部注册账户（含冻结、已删除账户），与注册用户总数口径一致。IP归属地为网络位置，境外单独计数。';
}

async function loadRegistrationRegions(context) {
  if (!context || context.regionLoading || context.controller.signal.aborted) return;
  context.regionLoading = true;
  const panel = $('registration-regions'), feedback = $('registration-region-feedback'), retry = $('registration-region-retry');
  const current = () => context === activePageLoad && !context.controller.signal.aborted && panel.isConnected;
  panel.setAttribute('aria-busy', 'true'); retry.hidden = true;
  feedback.textContent = '正在读取真实注册地区…';
  try {
    let data = await api('/admin/stats/regions', { signal: context.controller.signal });
    if (!current()) return;
    renderRegistrationRegions(data);
    // 每次最多补全128个不同IP，页面先显示缓存统计，查询不阻塞其他操作。
    for (let batch = 0; batch < 16 && data.next_ips.length; batch++) {
      feedback.textContent = `正在补全注册地区，剩余 ${data.pending_ip_count.toLocaleString('zh-CN')} 个 IP…`;
      data = await api('/admin/stats/regions/resolve', { method: 'POST', body: '{}', signal: context.controller.signal });
      if (!current()) return;
      renderRegistrationRegions(data);
      if (!data.processed_ips) break;
    }
    if (data.pending_ip_count) {
      feedback.textContent = data.next_ips.length ? `还有 ${data.pending_ip_count.toLocaleString('zh-CN')} 个 IP 待补全` : '地区正在其他请求中补全，请稍后刷新';
      retry.textContent = '继续查询'; retry.hidden = false;
    } else if (data.unknown_reasons.unavailable) {
      feedback.textContent = '部分注册地区暂未查到，已计入未识别；稍后可重试';
      retry.textContent = '重新查询'; retry.hidden = false;
    }
  } catch (error) {
    if (cancelled(error) || !current()) return;
    if ($('registration-identified').textContent === '正在统计…') $('registration-identified').textContent = '统计未完成';
    feedback.textContent = `地区统计加载失败：${error.message}`;
    retry.textContent = '重新查询'; retry.hidden = false;
  } finally {
    context.regionLoading = false;
    if (current()) panel.setAttribute('aria-busy', 'false');
  }
}

function offsiteLoginPanel() {
  return `<section id="offsite-logins" class="panel offsite-logins" aria-labelledby="offsite-login-title" aria-busy="true">
    <div class="offsite-login-head"><div><h3 id="offsite-login-title">异地登录核查</h3><span>注册地与登录地不一致的正常用户</span></div><button id="offsite-login-refresh" class="offsite-login-refresh" type="button" title="刷新异地登录核查" aria-label="刷新异地登录核查"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 6l5 4m2 3 3 5"/><circle cx="5" cy="5" r="2.1"/><circle cx="13" cy="11" r="2.1"/><circle cx="19" cy="20" r="2.1"/></svg></button></div>
    <div class="offsite-login-body"><div class="offsite-login-table-wrap" tabindex="0" role="region" aria-label="异地登录用户列表"><table class="offsite-login-table"><thead><tr><th scope="col">用户</th><th scope="col">注册归属地</th><th scope="col">登录归属地</th></tr></thead><tbody id="offsite-login-rows"><tr><td colspan="3" class="offsite-login-empty">正在核查真实登录地区…</td></tr></tbody></table></div>
    <div class="offsite-login-foot"><span id="offsite-login-feedback" role="status" aria-live="polite">正在读取最近一次成功登录记录…</span><div class="offsite-login-actions"><button id="offsite-login-retry" class="table-action" hidden>重新查询</button><div id="offsite-login-pager" hidden><button id="offsite-login-prev" class="table-action" aria-label="上一页异地登录用户">上一页</button><span id="offsite-login-page"></span><button id="offsite-login-next" class="table-action" aria-label="下一页异地登录用户">下一页</button></div></div></div></div>
  </section>`;
}

function offsiteLoginRow(user) {
  const difference = { country: '国家不同', province: '省级地区不同', city: '城市不同' }[user.difference_level] || '归属地区不同';
  return `<tr><td><div class="offsite-login-user">${user.avatar_url ? `<img src="${esc(user.avatar_url)}" alt="${esc(user.nickname)}的头像" loading="lazy" referrerpolicy="no-referrer">` : `<span class="offsite-login-avatar" aria-hidden="true">${esc(Array.from(user.nickname || user.account || '用')[0])}</span>`}<div><strong>${esc(user.nickname || user.account)}</strong><small>${esc(user.account)}</small></div></div></td><td><span class="offsite-login-location">${esc(user.register_location)} <span class="offsite-login-ip">[${esc(user.register_ip)}]</span></span></td><td title="${esc(`${difference}；最近成功登录：${user.login_at || '暂无时间'}；${label(deviceMap, user.login_device)}`)}"><span class="offsite-login-location">${esc(user.login_location)} <span class="offsite-login-ip">[${esc(user.login_ip)}]</span></span></td></tr>`;
}

function renderOffsiteLogins(data) {
  state.pages.offsiteLogins = data.page;
  $('offsite-login-rows').innerHTML = data.items.length ? data.items.map(offsiteLoginRow).join('') : '<tr><td colspan="3" class="offsite-login-empty">暂无已确认的异地登录用户</td></tr>';
  const format = count => Number(count || 0).toLocaleString('zh-CN');
  $('offsite-login-feedback').textContent = `已确认异地 ${format(data.total)} 人${data.unknown_users ? `　·　地区待识别 ${format(data.unknown_users)} 人` : ''}${data.no_login_users ? `　·　暂无成功登录 ${format(data.no_login_users)} 人` : ''}`;
  $('offsite-login-feedback').title = `仅核查正常账户的最近一次成功登录；已识别国家、省级地区或城市不同才列入。IP归属地反映网络位置。核查 ${format(data.checked_users)} 人，正常账户共 ${format(data.active_users)} 人。`;
  const pages = Math.max(1, Math.ceil(data.total / data.size));
  $('offsite-login-pager').hidden = pages === 1;
  $('offsite-login-pager').innerHTML = `<button id="offsite-login-prev" class="table-action" aria-label="上一页异地登录用户" ${data.page <= 1 ? 'disabled' : ''}>上一页</button><span id="offsite-login-page">${data.page} / ${pages}</span><button id="offsite-login-next" class="table-action" aria-label="下一页异地登录用户" ${data.page >= pages ? 'disabled' : ''}>下一页</button>`;
  const turn = delta => {
    if (activePageLoad?.offsiteLoading) return;
    state.pages.offsiteLogins = Math.min(pages, Math.max(1, data.page + delta));
    return loadOffsiteLogins(activePageLoad, false);
  };
  $('offsite-login-prev').onclick = () => turn(-1);
  $('offsite-login-next').onclick = () => turn(1);
}

async function loadOffsiteLogins(context, resolve = true) {
  if (!context || context.offsiteLoading || context.controller.signal.aborted) return;
  context.offsiteLoading = true;
  const panel = $('offsite-logins'), feedback = $('offsite-login-feedback'), retry = $('offsite-login-retry');
  const current = () => context === activePageLoad && !context.controller.signal.aborted && panel.isConnected;
  panel.setAttribute('aria-busy', 'true'); retry.hidden = true;
  feedback.textContent = '正在核查最近一次成功登录…';
  const query = () => `?page=${state.pages.offsiteLogins || 1}&size=30`;
  try {
    let data = await api('/admin/stats/offsite-logins' + query(), { signal: context.controller.signal });
    if (!current()) return;
    renderOffsiteLogins(data);
    context.offsiteLoaded = true;
    for (let batch = 0; resolve && batch < 16 && data.next_ips.length; batch++) {
      feedback.textContent = `正在补全核查地区，剩余 ${data.pending_ip_count.toLocaleString('zh-CN')} 个 IP…`;
      data = await api('/admin/stats/offsite-logins/resolve' + query(), { method: 'POST', body: '{}', signal: context.controller.signal });
      if (!current()) return;
      renderOffsiteLogins(data);
      if (!data.processed_ips) break;
    }
    if (data.pending_ip_count) {
      feedback.textContent += data.next_ips.length ? `　·　还有 ${data.pending_ip_count.toLocaleString('zh-CN')} 个 IP 待补全` : '　·　地区正在补全，请稍后刷新';
      retry.textContent = '继续核查'; retry.hidden = false;
    } else if (data.unknown_users) {
      retry.textContent = '重新核查'; retry.hidden = false;
    }
  } catch (error) {
    if (cancelled(error) || !current()) return;
    if (!context.offsiteLoaded) $('offsite-login-rows').innerHTML = '<tr><td colspan="3" class="offsite-login-empty">核查加载失败，请重试</td></tr>';
    feedback.textContent = `异地登录核查失败：${error.message}`;
    retry.textContent = '重新核查'; retry.hidden = false;
  } finally {
    context.offsiteLoading = false;
    if (current()) { panel.setAttribute('aria-busy', 'false'); guardInteractions(); }
  }
}

async function loadUsers() {
  const query = $('user-search')?.value.trim() ?? state.userFilters?.query ?? '';
  const status = $('user-status')?.value ?? state.userFilters?.status ?? '';
  state.userFilters = { query, status };
  const data = await api(`/admin/users?page=${page('users')}&size=30&q=${encodeURIComponent(query)}&status=${encodeURIComponent(status)}`);
  state.userItems = new Map(data.items.map(user => [Number(user.id), user]));
  $('app').innerHTML = `<div class="page-title"><div><div class="title-eyebrow">账户与权限</div><h2>用户管理</h2><p>共找到 ${data.total} 位用户，在线状态按心跳自动更新</p></div></div><section class="panel data-panel user-management"><div class="toolbar user-toolbar"><div class="user-filters"><input id="user-search" value="${esc(query)}" maxlength="128" placeholder="搜索IP、编号、用户ID、账号、手机号或昵称" aria-label="搜索用户，可输入注册IP或最近登录IP"><select id="user-status"><option value="">全部状态</option><option value="active" ${status === 'active' ? 'selected' : ''}>正常</option><option value="frozen" ${status === 'frozen' ? 'selected' : ''}>已冻结</option><option value="deleted" ${status === 'deleted' ? 'selected' : ''}>已删除</option></select><button class="primary small-button" type="button" id="user-search-button">搜索</button><button class="table-action" type="button" id="user-reset-button">重置</button></div><div class="user-toolbar-actions"><span class="user-toolbar-tip">IP可查注册及最近登录地址，支持IP片段</span><button class="primary small-button" id="user-create-button">新增用户</button><button class="table-action" id="user-batch-button">批量创建</button></div></div><div class="user-table-caption"><strong>用户明细</strong><span id="user-ip-feedback" role="status" aria-live="polite">左右滑动查看完整信息</span><button id="user-ip-retry" class="table-action" hidden>重试归属地查询</button></div><div class="table-wrap user-table-wrap"><table class="user-table"><thead><tr><th>会员ID</th><th>账号 / 用户ID</th><th>昵称</th><th>头像</th><th>注册IP</th><th>注册IP归属地</th><th>登录IP</th><th>登录IP归属地</th><th>登录时间</th><th>注册时间</th><th>在线状态</th><th>冻结用户</th><th>禁言</th><th>禁止加好友</th><th>禁止建群</th><th>内部人员</th><th>正式员工</th><th>查看设备</th><th>操作</th></tr></thead><tbody>${data.items.map(userRow).join('') || '<tr><td colspan="19" class="no-data">暂无用户数据</td></tr>'}</tbody></table></div>${pager(data, 'users')}</section>`;
  const search = () => { state.pages.users = 1; return loadUsers(); };
  $('user-search-button').onclick = search;
  $('user-reset-button').onclick = () => {
    $('user-search').value = ''; $('user-status').value = '';
    state.userFilters = { query: '', status: '' };
    state.pages.users = 1;
    return loadUsers();
  };
  $('user-search').onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); search(); } };
  $('user-status').onchange = search;
  $('user-create-button').onclick = createUser; $('user-batch-button').onclick = batchCreateUsers;
  document.querySelectorAll('[data-user-action]').forEach(button => button.onclick = () => updateUser(Number(button.dataset.id), button.dataset.userAction));
  document.querySelectorAll('[data-permission]').forEach(button => button.onclick = () => {
    const nextValue = button.dataset.value !== '1'; const field = button.dataset.permission;
    return updateUserPermission(Number(button.dataset.id), field, ['allow_add_friend', 'allow_create_group'].includes(field) ? !nextValue : nextValue);
  });
  document.querySelectorAll('[data-user-edit]').forEach(button => button.onclick = () => editUser(Number(button.dataset.userEdit)));
  document.querySelectorAll('[data-user-avatar]').forEach(button => button.onclick = () => openUserAvatarPreview(Number(button.dataset.userAvatar), button));
  document.querySelectorAll('[data-user-device]').forEach(button => button.onclick = () => showUserDevices(Number(button.dataset.userDevice)));
  bindPager('users', loadUsers);
  $('user-ip-retry').onclick = () => hydrateUserIpLocations(activePageLoad);
  void hydrateUserIpLocations(activePageLoad);
}

async function hydrateUserIpLocations(context) {
  if (!context || context.ipLoading || context.controller.signal.aborted) return;
  const nodes = [...document.querySelectorAll('[data-ip-location]')].filter(node => node.dataset.ipLocation && userIpLocationStatus(node.textContent, node.dataset.ipLocation, node.dataset.ipLocationStatus) !== 'ready');
  const ips = [...new Set(nodes.map(node => node.dataset.ipLocation).filter(Boolean))];
  if (!ips.length) return;
  context.ipLoading = true;
  const feedback = $('user-ip-feedback'), retry = $('user-ip-retry');
  feedback.textContent = `正在补全 ${ips.length} 个IP的归属地…`; retry.hidden = true;
  let failed = false;
  const failureMessages = new Set();
  try {
    for (let offset = 0; offset < ips.length; offset += 8) {
      const params = new URLSearchParams(); ips.slice(offset, offset + 8).forEach(ip => params.append('ips[]', ip));
      const data = await api(`/admin/users/ip-locations?${params}`, { timeout: 6000, signal: context.controller.signal });
      if (context !== activePageLoad || !feedback.isConnected) return;
      if (!Array.isArray(data.items)) throw new Error('归属地响应格式不正确');
      const locations = new Map(data.items.map(item => [item.ip, item]));
      nodes.forEach(node => {
        const item = locations.get(node.dataset.ipLocation);
        if (!item || !node.isConnected) return;
        node.textContent = item.status === 'pending' ? '查询失败，可重试' : item.location;
        node.dataset.ipLocationStatus = item.status;
        node.dataset.ipLocationError = item.error_code || '';
        if (item.status !== 'ready') { failed = true; failureMessages.add(node.textContent); }
      });
      for (const ip of ips.slice(offset, offset + 8)) if (!locations.has(ip)) failed = true;
      state.userItems?.forEach(user => {
        for (const field of ['register', 'login']) {
          const item = locations.get(user[`${field}_ip`]);
          if (!item) continue;
          user[`${field}_ip_location`] = item.location;
          user[`${field}_ip_location_status`] = item.status;
          user[`${field}_ip_location_error_code`] = item.error_code || null;
        }
      });
    }
    feedback.textContent = failed ? (failureMessages.size === 1 ? [...failureMessages][0] : '部分归属地暂未查到，可稍后重试') : '归属地已更新，左右滑动查看完整信息';
  } catch (error) {
    if (cancelled(error) || context !== activePageLoad || !feedback.isConnected) return;
    failed = true; feedback.textContent = '归属地查询暂不可用，用户列表可正常操作';
    nodes.filter(node => node.textContent === '查询中…').forEach(node => node.textContent = '查询失败，可重试');
  } finally {
    context.ipLoading = false;
    if (retry.isConnected && context === activePageLoad) retry.hidden = !failed;
  }
}
function userSwitch(user, field, text) { const inverted = field === 'allow_add_friend' || field === 'allow_create_group'; const defaultRaw = inverted ? 1 : 0; const rawValue = Number(user.permissions?.[field] ?? defaultRaw); const value = inverted ? !rawValue : Boolean(rawValue); const labels = { muted: '禁言', allow_add_friend: '禁止加好友', allow_create_group: '禁止建群', internal_staff: '内部人员', formal_employee: '正式员工', allow_view_devices: '查看设备' }; const label = text || labels[field] || '权限'; const actionLabel = value ? `关闭${label}` : `开启${label}`; return `<button class="user-switch ${value ? 'is-on' : 'is-off'}" data-permission="${field}" data-value="${value ? 1 : 0}" data-id="${user.id}" aria-label="${actionLabel}" title="${actionLabel}" aria-pressed="${value ? 'true' : 'false'}"><span class="user-switch-knob" aria-hidden="true"></span></button>`; }
function userStatusSwitch(user) { const value = user.status === 'frozen'; const next = user.status === 'active' ? 'frozen' : 'active'; const actionLabel = user.status === 'deleted' ? '恢复用户' : value ? '解除冻结' : '冻结用户'; return `<button class="user-switch ${value ? 'is-on' : 'is-off'}" data-user-action="${next}" data-id="${user.id}" data-value="${value ? 1 : 0}" aria-label="${actionLabel}" title="${actionLabel}" aria-pressed="${value ? 'true' : 'false'}"><span class="user-switch-knob" aria-hidden="true"></span></button>`; }
function userIpLocationStatus(location, ip, status) {
  if (!ip) return 'ready';
  if (['ready', 'pending', 'unavailable'].includes(status)) return status;
  if (!location || location === '查询中…') return 'pending';
  return ['查询失败，可重试', '暂未查到归属地'].includes(location) ? 'unavailable' : 'ready';
}
function userIpLocationCell(location, ip, status, errorCode) {
  const resolvedStatus = userIpLocationStatus(location, ip, status);
  return `<span class="user-ip-location" data-ip-location="${esc(ip || '')}" data-ip-location-status="${resolvedStatus}" data-ip-location-error="${esc(errorCode || '')}">${esc(location || (ip ? '查询中…' : '暂无记录'))}</span><small class="user-ip-address">${esc(ip || '暂无 IP')}</small>`;
}
async function updateUserPermission(id, field, value) {
  return withAction(`user:${id}`, userControls(id), async () => {
    await api('/admin/users/permission', { method: 'POST', body: JSON.stringify({ user_id: id, field, value, request_id: requestId('admin') }) });
    const user = state.userItems?.get(id);
    if (user) user.permissions[field] = value ? 1 : 0;
    if (state.view === 'users') {
      const button = document.querySelector(`[data-permission="${field}"][data-id="${id}"]`);
      if (button) {
        const on = ['allow_add_friend', 'allow_create_group'].includes(field) ? !value : value;
        const text = (button.title || '').replace(/^(开启|关闭)/, '');
        button.dataset.value = on ? '1' : '0'; button.classList.toggle('is-on', on); button.classList.toggle('is-off', !on);
        button.setAttribute('aria-pressed', String(on)); button.title = `${on ? '关闭' : '开启'}${text}`; button.setAttribute('aria-label', button.title);
      }
    }
    notify('用户权限已更新');
    if (state.view === 'users' && activePageLoad?.loading) await refreshAfterAction('users', loadUsers);
  });
}
function userControls(id) { return document.querySelector(`[data-user-edit="${id}"]`)?.closest('tr').querySelectorAll('button') || []; }
function createUser() {
  if (!canPage('users', 'manage')) { notify('当前账号没有新增用户权限', 'error'); return; }
  if ($('user-create-modal')) { $('create-username').focus(); return; }
  const modal = document.createElement('div');
  modal.id = 'user-create-modal'; modal.className = 'user-modal-backdrop batch-modal-backdrop';
  modal.innerHTML = `<section class="user-modal batch-user-modal create-user-modal" role="dialog" aria-modal="true" aria-labelledby="user-create-title"><button class="user-modal-close" id="user-create-close" type="button" aria-label="关闭">×</button><h2 id="user-create-title">新增用户</h2><form id="user-create-form" class="batch-modal-form" novalidate><div class="batch-field create-avatar-field"><span>头像</span><div><label class="avatar-upload-box" for="create-avatar-file"><img id="create-avatar-preview" alt="头像预览" hidden><span id="create-avatar-empty">点击上传头像</span><input id="create-avatar-file" type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" aria-label="上传头像"></label><p class="create-field-hint">可选，PNG/JPG，最大5MB<button id="create-avatar-remove" type="button" hidden>移除</button></p></div></div><label class="batch-field create-input-field"><span><i>*</i>用户名</span><div><input id="create-username" name="username" type="text" minlength="5" maxlength="10" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="请输入用户名" aria-describedby="create-username-hint"><p id="create-username-hint" class="create-field-hint">5到10位，以字母开头，包含字母和数字</p></div></label><label class="batch-field"><span><i>*</i>昵称</span><input id="create-nickname" name="nickname" type="text" minlength="2" maxlength="32" required placeholder="请输入昵称"></label><label class="batch-field create-input-field"><span><i>*</i>密码</span><div><div class="password-editor"><input id="create-password" name="password" type="password" minlength="8" maxlength="16" required autocomplete="new-password" placeholder="请输入登录密码" aria-describedby="create-password-hint"><button id="create-password-show" type="button" aria-controls="create-password" aria-pressed="false">显示</button></div><p id="create-password-hint" class="create-field-hint">8到16位，包含字母和数字，不含空格</p></div></label><p id="user-create-feedback" class="batch-modal-feedback" role="alert" aria-live="polite"></p><div class="batch-modal-actions"><button id="user-create-submit" class="primary" type="submit">确定</button><button id="user-create-cancel" class="modal-cancel" type="button">取消</button></div></form></section>`;
  document.body.appendChild(modal);
  modal._avatarFile = null; modal._avatarUrl = ''; modal._saving = false;
  const origin = { token: state.token, adminId: state.admin?.id };
  const current = () => modal.isConnected && state.view === 'users' && state.token === origin.token && state.admin?.id === origin.adminId && canPage('users', 'manage');
  const feedback = $('user-create-feedback');
  const clearAvatar = () => {
    if (modal._avatarUrl) URL.revokeObjectURL(modal._avatarUrl);
    modal._avatarFile = null; modal._avatarUrl = '';
    $('create-avatar-file').value = ''; $('create-avatar-preview').removeAttribute('src'); $('create-avatar-preview').hidden = true;
    $('create-avatar-empty').hidden = false; $('create-avatar-remove').hidden = true;
    modal.querySelector('.avatar-upload-box').classList.remove('has-avatar');
  };
  $('create-avatar-file').onchange = event => {
    const file = event.target.files?.[0]; if (!file || modal._saving) return;
    if (file.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg'].includes(file.type)) {
      feedback.textContent = '头像大小不能超过5MB，格式必须为PNG、JPG或JPEG。'; event.target.value = ''; return;
    }
    if (modal._avatarUrl) URL.revokeObjectURL(modal._avatarUrl);
    modal._avatarFile = file; modal._avatarUrl = URL.createObjectURL(file);
    $('create-avatar-preview').src = modal._avatarUrl; $('create-avatar-preview').hidden = false;
    $('create-avatar-empty').hidden = true; $('create-avatar-remove').hidden = false;
    modal.querySelector('.avatar-upload-box').classList.add('has-avatar'); feedback.textContent = '';
  };
  $('create-avatar-remove').onclick = clearAvatar;
  $('create-password-show').onclick = () => {
    const input = $('create-password'), show = $('create-password-show');
    const visible = input.type === 'password'; input.type = visible ? 'text' : 'password';
    show.textContent = visible ? '隐藏' : '显示'; show.setAttribute('aria-pressed', String(visible));
  };
  const close = () => closeUserCreateModal();
  $('user-create-close').onclick = close; $('user-create-cancel').onclick = close;
  modal.onclick = event => { if (event.target === modal) close(); };
  const keyboard = event => {
    if (!modal.isConnected) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const controls = [...modal.querySelectorAll('button,input')].filter(node => !node.disabled && !node.hidden && node.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', keyboard);
  const removed = new MutationObserver(() => { if (!modal.isConnected) modal._cleanup(); });
  removed.observe(document.body, { childList: true });
  modal._cleanup = () => {
    modal._controller?.abort(); removed.disconnect(); document.removeEventListener('keydown', keyboard);
    if (modal._avatarUrl) URL.revokeObjectURL(modal._avatarUrl);
    modal._avatarUrl = ''; modal._avatarFile = null; modal.querySelector('#create-password').value = '';
  };
  $('user-create-form').onsubmit = async event => {
    event.preventDefault(); if (modal._saving || !current()) return;
    const username = $('create-username').value.trim(), nickname = $('create-nickname').value.trim(), password = $('create-password').value;
    if (!/^[A-Za-z][A-Za-z0-9]{4,9}$/.test(username) || !/[0-9]/.test(username)) { feedback.textContent = '用户名需5到10位，以字母开头，包含字母和数字。'; $('create-username').focus(); return; }
    if (Array.from(nickname).length < 2 || Array.from(nickname).length > 32) { feedback.textContent = '昵称长度必须为2到32个字符。'; $('create-nickname').focus(); return; }
    const passwordBytes = new TextEncoder().encode(password).length;
    if (passwordBytes < 8 || passwordBytes > 16 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password) || /\s/.test(password)) { feedback.textContent = '密码需要8到16位，必须包含字母和数字，不能包含空格。'; $('create-password').focus(); return; }
    const controls = [...modal.querySelectorAll('input,button')];
    const payload = { username, nickname, password, request_id: requestId('admin-create') };
    modal._saving = true; modal._controller = new AbortController(); controls.forEach(control => { control.disabled = true; });
    $('user-create-form').setAttribute('aria-busy', 'true'); $('user-create-submit').textContent = '创建中…'; feedback.textContent = '';
    try {
      if (modal._avatarFile) payload.avatar_url = await uploadAdminAvatar(modal._avatarFile, { signal: modal._controller.signal });
      if (!current()) return;
      await api('/admin/users', { method: 'POST', signal: modal._controller.signal, body: JSON.stringify(payload) });
      if (!current()) return;
      closeUserCreateModal(true); notify('用户创建成功');
      try { await refreshAfterAction('users', loadUsers); }
      catch (error) { if (state.view === 'users') notify('用户已创建，列表刷新失败，请点击刷新数据。', 'error'); }
    } catch (error) {
      if (current() && error.name !== 'AbortError') feedback.textContent = error.message || '创建失败，请稍后重试。';
    } finally {
      modal._saving = false; modal._controller = null;
      if (modal.isConnected) { controls.forEach(control => { control.disabled = false; }); modal.querySelector('#user-create-form').removeAttribute('aria-busy'); modal.querySelector('#user-create-submit').textContent = '确定'; }
    }
  };
  $('create-username').focus();
}
function closeUserCreateModal(force = false) {
  const modal = $('user-create-modal'); if (!modal || (modal._saving && !force)) return;
  modal._cleanup?.(); modal.remove(); $('user-create-button')?.focus();
}
function openBatchCreateModal() {
  const old = $('batch-create-modal');
  if (old) old.remove();
  const modal = document.createElement('div');
  modal.id = 'batch-create-modal';
  modal.className = 'user-modal-backdrop batch-modal-backdrop';
  modal.innerHTML = `<section class="user-modal batch-user-modal" role="dialog" aria-modal="true" aria-labelledby="batch-create-title"><button class="user-modal-close" id="batch-create-close" type="button" aria-label="关闭">×</button><h2 id="batch-create-title">批量创建会员</h2><form id="batch-create-form" class="batch-modal-form"><label class="batch-field"><span><i>*</i>账号前缀</span><input id="batch-prefix" maxlength="24" required value="account" placeholder="例如：account"></label><label class="batch-field"><span>起始编号</span><div class="batch-number-control"><button type="button" data-batch-number="start" data-step="-1" aria-label="减少起始编号">−</button><input id="batch-start" type="number" min="1" max="999999999" value="1" required><button type="button" data-batch-number="start" data-step="1" aria-label="增加起始编号">＋</button></div></label><label class="batch-field"><span>创建数量</span><div class="batch-number-control"><button type="button" data-batch-number="count" data-step="-1" aria-label="减少创建数量">−</button><input id="batch-count" type="number" min="1" max="100" value="20" required><button type="button" data-batch-number="count" data-step="1" aria-label="增加创建数量">＋</button></div></label><label class="batch-field"><span><i>*</i>密码</span><input id="batch-password" type="password" minlength="8" maxlength="128" required placeholder="请输入统一登录密码"></label><p id="batch-create-feedback" class="batch-modal-feedback" role="alert"></p><div class="batch-modal-actions"><button class="primary" id="batch-create-submit" type="submit">确定</button><button class="modal-cancel" id="batch-create-cancel" type="button">取消</button></div></form></section>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  $('batch-create-close').onclick = close;
  $('batch-create-cancel').onclick = close;
  modal.onclick = (event) => { if (event.target === modal) close(); };
  document.querySelectorAll('[data-batch-number]').forEach((button) => {
    button.onclick = () => {
      const input = $(`batch-${button.dataset.batchNumber}`);
      const min = Number(input.min || 1);
      const max = Number(input.max || 100);
      const next = Math.min(max, Math.max(min, Number(input.value || min) + Number(button.dataset.step || 0)));
      input.value = next;
      input.dispatchEvent(new Event('input'));
    };
  });
  $('batch-create-form').onsubmit = async (event) => {
    event.preventDefault();
    const prefix = $('batch-prefix').value.trim();
    const start = Number($('batch-start').value);
    const count = Number($('batch-count').value);
    const password = $('batch-password').value;
    const feedback = $('batch-create-feedback');
    const submit = $('batch-create-submit');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(prefix)) { feedback.textContent = '账号前缀必须以字母开头，只能包含字母、数字或下划线。'; return; }
    if (!Number.isInteger(start) || start < 1) { feedback.textContent = '请输入不小于1的起始编号。'; return; }
    if (!Number.isInteger(count) || count < 1 || count > 100) { feedback.textContent = '创建数量必须在1到100之间。'; return; }
    if (password.length < 8 || password.length > 128) { feedback.textContent = '密码长度必须在8到128位之间。'; return; }
    if ((prefix + String(start + count - 1)).length > 32) { feedback.textContent = '生成的账号不能超过32位，请缩短前缀或调整编号。'; return; }
    submit.disabled = true;
    feedback.textContent = '正在创建，请稍候…';
    try {
      const result = await api('/admin/users/batch', { method: 'POST', body: JSON.stringify({ prefix, start, count, password, request_id: `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }) });
      close();
      alert(`成功创建${result.count}个会员。`);
      await refreshAfterAction('users', loadUsers);
    } catch (error) {
      feedback.textContent = error.message;
      submit.disabled = false;
    }
  };
}
function batchCreateUsers() { openBatchCreateModal(); }
async function editUser(id) {
  return withAction(`user:${id}`, userControls(id), async () => {
    const user = state.userItems?.get(id) || (await api(`/admin/users?user_id=${id}&size=1`)).items[0];
    if (user) openUserEditModal(user); else notify('该用户已不存在，请刷新列表', 'error');
  });
}
function openUserEditModal(user) {
  closeUserEditModal();
  const avatar = user.avatar_url || '';
  const modal = document.createElement('div');
  modal.id = 'user-edit-modal'; modal.className = 'user-modal-backdrop';
  modal.innerHTML = `<section class="user-modal" role="dialog" aria-modal="true" aria-labelledby="user-edit-title"><button class="user-modal-close" id="user-edit-close" type="button" aria-label="关闭">×</button><h2 id="user-edit-title">编辑会员</h2><form id="user-edit-form"><label class="edit-field"><span><i>*</i>账号</span><input id="edit-account" value="${esc(user.account || '')}" disabled></label><label class="edit-field"><span>用户ID</span><input id="edit-public-id" value="${esc(publicUserId(user) || '暂未分配')}" readonly></label><label class="edit-field"><span><i>*</i>昵称</span><input id="edit-nickname" value="${esc(user.nickname || '')}" maxlength="32" required></label><div class="edit-field edit-avatar-field"><span>头像</span><div><label class="avatar-upload-box ${avatar ? 'has-avatar' : ''}" for="edit-avatar-file"><img id="edit-avatar-preview" src="${esc(avatar)}" alt="头像预览" ${avatar ? '' : 'hidden'}><span id="edit-avatar-empty" ${avatar ? 'hidden' : ''}>点击上传</span><input id="edit-avatar-file" type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg"></label><p>请上传大小不超过 <b>5MB</b>，格式为 <b>png/jpg/jpeg</b> 的文件</p></div></div><div class="edit-field edit-password-field"><span>密码</span><div class="password-editor"><input id="edit-password" aria-label="当前密码" type="password" placeholder="••••••••" disabled autocomplete="new-password"><button id="edit-password-show" aria-controls="edit-password" aria-pressed="false" type="button">显示</button><button id="edit-password-enable" class="change-password" type="button">修改密码</button></div></div><p id="user-edit-feedback" class="user-edit-feedback" role="status" aria-live="polite"></p><div class="user-modal-actions"><button id="user-edit-submit" class="primary" type="submit">确定</button><button id="user-edit-cancel" class="modal-cancel" type="button">取消</button></div></form></section>`;
  document.body.appendChild(modal); modal._avatarFile = null;
  $('user-edit-close').onclick = closeUserEditModal;
  $('user-edit-cancel').onclick = closeUserEditModal;
  modal.onclick = (event) => { if (event.target === modal) closeUserEditModal(); };
  $('edit-avatar-file').onchange = () => previewUserAvatar(modal);
  bindUserPasswordEditor(modal, user.id);
  $('user-edit-form').onsubmit = (event) => saveUserEdit(event, user.id, modal);
}
function bindUserPasswordEditor(modal) {
  const input = modal.querySelector('#edit-password'), show = modal.querySelector('#edit-password-show');
  const change = modal.querySelector('#edit-password-enable'), feedback = modal.querySelector('#user-edit-feedback');
  const reset = (clear = false) => {
    if (clear || input.disabled) input.value = '';
    input.type = 'password';show.textContent = '显示';show.setAttribute('aria-pressed','false');show.disabled=input.disabled;
    show.title=input.disabled?'系统不保存可还原的原密码，请重置密码':'';
  };
  change.onclick = () => {
    if(modal._saving)return;
    reset(true);input.disabled=!input.disabled;input.placeholder=input.disabled?'原密码不可查看':'请输入新密码';
    input.setAttribute('aria-label',input.disabled?'原密码不可查看':'新密码');change.textContent=input.disabled?'重置密码':'取消重置';
    reset();feedback.textContent='';if(!input.disabled)input.focus();
  };
  show.onclick=()=>{if(modal._saving||input.disabled)return;const visible=input.type==='password';input.type=visible?'text':'password';show.textContent=visible?'隐藏':'显示';show.setAttribute('aria-pressed',String(visible));};
  const hide=()=>reset(),visibility=()=>{if(document.hidden)hide();};
  window.addEventListener('blur',hide);document.addEventListener('visibilitychange',visibility);
  const removed=new MutationObserver(()=>{if(!modal.isConnected)modal._passwordCleanup();});removed.observe(document.body,{childList:true});
  modal._passwordCleanup=()=>{reset(true);removed.disconnect();window.removeEventListener('blur',hide);document.removeEventListener('visibilitychange',visibility);};
  reset();
}
function closeUserEditModal() {
  const modal = $('user-edit-modal'); modal?._passwordCleanup?.(); modal?.remove();
}
function previewUserAvatar(modal) { const input = $('edit-avatar-file'); const file = input.files?.[0]; if (!file) return; if (file.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg'].includes(file.type)) { alert('头像大小不能超过5MB，格式必须为PNG、JPG或JPEG。'); input.value = ''; return; } modal._avatarFile = file; $('edit-avatar-preview').src = URL.createObjectURL(file); $('edit-avatar-preview').hidden = false; $('edit-avatar-empty').hidden = true; document.querySelector('.avatar-upload-box')?.classList.add('has-avatar'); }
async function adminResponseData(response, fallback, path) {
  const data = await readAdminResponse(response);
  if (response.status === 401) { endAdminSession('登录已失效，请重新登录'); throw adminResponseError(response, {}, '登录已失效，请重新登录'); }
  if (response.status === 403 && ['ADMIN_CSRF_REQUIRED', 'ADMIN_ORIGIN_DENIED'].includes(data.error?.code)) throw new Error(data.error.message);
  if (response.status === 403 && path !== '/admin/auth/me') { void refreshAdminPermissions(); throw new Error(data.error?.message || '页面权限已改变，正在刷新授权'); }
  if (!response.ok || data.ok === false) throw adminResponseError(response, data, fallback);
  return data.data;
}

async function uploadAdminAvatar(file, { signal } = {}) { assertAdminApiAccess('/admin/users/avatar', 'POST'); const form = new FormData(); form.append('file', file); return (await PulseGoAdmin.upload('/admin/users/avatar', form, signal)).url; }
async function saveUserEdit(event, id, modal) {
  event.preventDefault();
  if (modal._saving) return;
  const feedback = $('user-edit-feedback'), submit = $('user-edit-submit'), passwordInput = $('edit-password');
  const password = passwordInput.disabled ? '' : passwordInput.value;
  if (!passwordInput.disabled && !password) { feedback.textContent = '请输入新密码，或点击“取消修改”。'; return; }
  if (password && password.length < 8) { feedback.textContent = '新密码至少需要8位。'; return; }
  const payload = { user_id: id, nickname: $('edit-nickname').value.trim(), avatar_url: $('edit-avatar-preview').getAttribute('src') || '', password, request_id: requestId('admin') };
  modal._saving = true; submit.disabled = true; feedback.textContent = '正在保存…';
  try {
    if (modal._avatarFile) payload.avatar_url = await uploadAdminAvatar(modal._avatarFile);
    await api('/admin/users/edit', { method: 'POST', body: JSON.stringify(payload) });
    modal._passwordCleanup?.(); modal.remove(); notify('用户资料已保存'); await refreshAfterAction('users', loadUsers);
  } catch (error) { feedback.textContent = error.message; }
  finally { modal._saving = false; submit.disabled = false; }
}
async function showUserDevices(id) { try { const data = await api(`/admin/users/devices?user_id=${id}`); if (data.hidden) { alert('该用户已关闭查看设备权限。'); return; } const text = Object.entries(data.items || {}).map(([name, rows]) => `${name}\n${rows.length ? rows.map((row) => `设备：${label(deviceMap, row.device_type || row.platform)}，创建时间：${row.created_at || '-'}，最近使用：${row.last_used_at || '暂无记录'}`).join('\n') : '暂无记录'}`).join('\n\n'); alert(text || '暂无设备记录。'); } catch (error) { alert(error.message); } }

async function loadGroups() {
  const filters = state.groupFilters || {};
  const params = new URLSearchParams({ page: page('groups'), size: filters.size || 20, name: filters.name || '', group_id: filters.groupId || '', owner: filters.owner || '' });
  const data = await api(`/admin/groups?${params.toString()}`);
  $('app').innerHTML = `<div class="page-title"><div><div class="title-eyebrow">会话空间</div><h2>群组管理</h2><p>共找到 ${data.total} 个群组、频道和客服会话</p></div></div><section class="panel data-panel group-management"><div class="toolbar group-toolbar"><div class="group-filters"><input id="group-name" value="${esc(filters.name || '')}" placeholder="群组名称"><input id="group-id" value="${esc(filters.groupId || '')}" type="number" min="1" placeholder="群组 ID"><input id="group-owner" value="${esc(filters.owner || '')}" placeholder="群主账号或昵称"><select id="group-size" aria-label="每页数量"><option value="10" ${Number(filters.size || 20) === 10 ? 'selected' : ''}>每页 10 条</option><option value="20" ${Number(filters.size || 20) === 20 ? 'selected' : ''}>每页 20 条</option><option value="30" ${Number(filters.size || 20) === 30 ? 'selected' : ''}>每页 30 条</option><option value="50" ${Number(filters.size || 20) === 50 ? 'selected' : ''}>每页 50 条</option><option value="100" ${Number(filters.size || 20) === 100 ? 'selected' : ''}>每页 100 条</option></select><button class="primary small-button" id="group-search-button">搜索</button><button class="table-action" id="group-reset-button">重置</button></div><div class="group-actions"><button class="primary small-button" id="group-create-button">＋ 新增</button><button class="table-action" id="group-edit-button">修改</button><button class="table-action danger" id="group-delete-button">删除</button></div></div><div class="group-table-caption"><strong>群组列表</strong><span>勾选后可批量修改或删除，点击操作查看完整资料</span></div><div class="table-wrap group-table-wrap"><table class="group-table"><thead><tr><th class="check-col"><input id="group-select-all" type="checkbox" aria-label="全选"></th><th>ID</th><th>群组 ID</th><th>群组名称</th><th>群主</th><th>成员数</th><th>群类型</th><th>全员禁言</th><th>有效标志</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${data.items.map(groupRow).join('') || '<tr><td colspan="11" class="no-data">暂无群组数据</td></tr>'}</tbody></table></div>${pager(data, 'groups')}</section>`;
  $('group-search-button').onclick = () => { state.pages.groups = 1; state.groupFilters = { name: $('group-name').value.trim(), groupId: $('group-id').value.trim(), owner: $('group-owner').value.trim(), size: Number($('group-size').value) }; return loadGroups(); };
  $('group-size').onchange = () => { state.pages.groups = 1; state.groupFilters = { ...filters, size: Number($('group-size').value) }; loadGroups(); };
  $('group-reset-button').onclick = () => { state.pages.groups = 1; state.groupFilters = {}; return loadGroups(); };
  $('group-create-button').onclick = () => openGroupEditModal();
  $('group-edit-button').onclick = editSelectedGroup;
  $('group-delete-button').onclick = deleteSelectedGroups;
  $('group-select-all').onchange = (event) => document.querySelectorAll('[data-group-checkbox]').forEach((box) => { box.checked = event.target.checked; });
  document.querySelectorAll('[data-group-view]').forEach((button) => button.onclick = () => openGroupDetailModal(Number(button.dataset.groupView)));
  document.querySelectorAll('[data-group-edit]').forEach((button) => button.onclick = () => openGroupEditModal(Number(button.dataset.groupEdit)));
  document.querySelectorAll('[data-group-delete]').forEach((button) => button.onclick = () => deleteGroups([Number(button.dataset.groupDelete)]));
  bindPager('groups', loadGroups);
}
const groupTypeMap = { group: '群组', channel: '频道', customer_service: '客服' };
const groupJoinMap = { free: '自由加入', approval: '需要审核', invite: '仅邀请加入' };
const groupStatusMap = { active: '有效', disabled: '已停用' };
function groupRow(item) { return `<tr><td class="check-col"><input data-group-checkbox value="${item.id}" type="checkbox" aria-label="选择群组"></td><td>${item.id}</td><td>${item.group_id || item.id}</td><td><b>${esc(item.name || '未命名')}</b></td><td>${esc(item.owner_nickname || item.owner_username || item.owner_id || '-')}</td><td><b>${Number(item.display_member_count ?? item.member_count)} 人</b><br><small>实际 ${item.member_count} / 上限 ${item.max_members}</small></td><td><span class="type-tag">${label(groupTypeMap, item.type)}</span></td><td><span class="status ${Number(item.all_muted) ? 'frozen' : 'active'}">${Number(item.all_muted) ? '已开启' : '未开启'}</span></td><td><span class="status ${item.status === 'active' ? 'active' : 'frozen'}">${label(groupStatusMap, item.status)}</span></td><td>${esc(item.created_at || '-')}</td><td class="group-actions-cell"><button class="table-action" data-group-view="${item.id}">查看</button><button class="table-action" data-group-edit="${item.id}">修改</button><button class="table-action danger" data-group-delete="${item.id}">删除</button></td></tr>`; }
function selectedGroupIds() { return [...document.querySelectorAll('[data-group-checkbox]:checked')].map((box) => Number(box.value)).filter((id) => id > 0); }
function editSelectedGroup() { const ids = selectedGroupIds(); if (ids.length !== 1) { alert('请选择一个群组进行修改。'); return; } return openGroupEditModal(ids[0]); }
function deleteSelectedGroups() { const ids = selectedGroupIds(); if (!ids.length) { alert('请选择要删除的群组。'); return; } return deleteGroups(ids); }
async function deleteGroups(ids) { if (!window.confirm(`确定删除选中的 ${ids.length} 个群组吗？该群组将停用，成员将移出；历史消息和账务记录会保留。`)) return; try { await api('/admin/groups/delete', { method: 'POST', body: JSON.stringify({ ids, request_id: `admin-group-${Date.now()}` }) }); await loadGroups(); } catch (error) { alert(error.message); } }
function groupDetailRows(group) { return `<div class="group-detail-grid"><div><span>ID</span><b>${group.id}</b></div><div><span>群组 ID</span><b>${group.group_id}</b></div><div><span>群组名称</span><b>${esc(group.name || '-')}</b></div><div><span>群主</span><b>${esc(group.owner_nickname || group.owner_username || group.owner_id || '-')}（${group.owner_id || '-'}）</b></div><div><span>群组类型</span><b>${label(groupTypeMap, group.type)}</b></div><div><span>真实成员数量</span><b>${group.member_count}</b></div><div><span>显示成员数量</span><b>${Number(group.display_member_count ?? group.member_count)}</b></div><div><span>最大成员数</span><b>${group.max_members}</b></div><div><span>全员禁言</span><b>${Number(group.all_muted) ? '已开启' : '未开启'}</b></div><div><span>加群方式</span><b>${label(groupJoinMap, group.join_method)}</b></div><div><span>有效标志</span><b>${label(groupStatusMap, group.status)}</b></div><div class="wide"><span>群介绍</span><p>${esc(group.description || '暂无')}</p></div><div class="wide"><span>群公告</span><p>${esc(group.announcement || '暂无')}</p></div><div><span>创建时间</span><b>${esc(group.created_at || '-')}</b></div><div><span>更新时间</span><b>${esc(group.updated_at || '-')}</b></div></div>`; }
async function openGroupDetailModal(id) { try { const group = await api(`/admin/groups/detail?id=${id}`); const old = $('group-detail-modal'); if (old) old.remove(); const modal = document.createElement('div'); modal.id = 'group-detail-modal'; modal.className = 'user-modal-backdrop'; modal.innerHTML = `<section class="user-modal group-detail-modal" role="dialog" aria-modal="true"><button class="user-modal-close" id="group-detail-close" type="button" aria-label="关闭">×</button><h2>查看群组</h2>${groupDetailRows(group)}<div class="user-modal-actions"><button class="primary" id="group-detail-edit">修改群组</button><button class="modal-cancel" id="group-detail-cancel">关闭</button></div></section>`; document.body.appendChild(modal); const close = () => modal.remove(); $('group-detail-close').onclick = close; $('group-detail-cancel').onclick = close; modal.onclick = (event) => { if (event.target === modal) close(); }; $('group-detail-edit').onclick = () => { close(); openGroupEditModal(group.id); }; } catch (error) { alert(error.message); } }
async function openGroupEditModal(id = 0) { try { const group = id ? await api(`/admin/groups/detail?id=${id}`) : { id: 0, group_id: 0, type: 'group', name: '', owner_id: '', description: '', announcement: '', member_count: 0, max_members: 500, all_muted: 0, join_method: 'free', status: 'active', allow_member_add_friend: 1 }; const old = $('group-edit-modal'); if (old) old.remove(); const modal = document.createElement('div'); modal.id = 'group-edit-modal'; modal.className = 'user-modal-backdrop'; modal.innerHTML = `<section class="user-modal group-edit-modal" role="dialog" aria-modal="true"><button class="user-modal-close" id="group-edit-close" type="button" aria-label="关闭">×</button><h2>${id ? '修改群组' : '新增群组'}</h2><form id="group-edit-form" class="group-edit-form"><label class="edit-field"><span>${id ? '群组 ID' : '群组 ID'}</span><input value="${id ? group.group_id : '保存后生成'}" disabled></label><label class="edit-field"><span><i>*</i>群组名称</span><input id="group-edit-name" value="${esc(group.name || '')}" maxlength="128" required></label><label class="edit-field"><span><i>*</i>群主</span><input id="group-edit-owner" type="number" min="1" value="${group.owner_id || ''}" required></label><label class="edit-field"><span>群介绍</span><textarea id="group-edit-description" maxlength="500">${esc(group.description || '')}</textarea></label><label class="edit-field"><span>群公告</span><textarea id="group-edit-announcement" maxlength="10000">${esc(group.announcement || '')}</textarea></label><label class="edit-field"><span>真实成员数量</span><input value="${group.member_count}" disabled></label><label class="edit-field" id="group-edit-count-field"><span>虚拟显示人数</span><div><div class="group-number-control"><button type="button" data-group-count-step="-1" aria-label="减少显示人数">−</button><input id="group-edit-display-count" type="number" min="0" max="10000000" step="1" value="${Number(group.member_count_offset || 0) !== 0 ? Number(group.display_member_count ?? group.member_count) : ''}" placeholder="留空使用真实人数"><button type="button" data-group-count-step="1" aria-label="增加显示人数">＋</button></div><small class="field-help">当前显示 ${Number(group.display_member_count ?? group.member_count)} 人；设为100后，新成员入群显示101、102。清空恢复真实人数。</small></div></label><label class="edit-field"><span><i>*</i>最大成员数</span><div class="group-number-control"><button type="button" data-group-number="-1">−</button><input id="group-edit-max" type="number" min="${Math.max(1, group.member_count)}" max="10000000" value="${group.max_members || 500}" required><button type="button" data-group-number="1">＋</button></div></label><label class="edit-field"><span>群组类型</span><select id="group-edit-type" ${id ? '' : ''}>${Object.entries(groupTypeMap).map(([key, value]) => `<option value="${key}" ${group.type === key ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="edit-field"><span>全员禁言</span><select id="group-edit-muted"><option value="0" ${!Number(group.all_muted) ? 'selected' : ''}>未开启</option><option value="1" ${Number(group.all_muted) ? 'selected' : ''}>已开启</option></select></label><label class="edit-field"><span>加群方式</span><select id="group-edit-join">${Object.entries(groupJoinMap).map(([key, value]) => `<option value="${key}" ${group.join_method === key ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label class="edit-field"><span>有效标志</span><select id="group-edit-status"><option value="active" ${group.status === 'active' ? 'selected' : ''}>有效</option><option value="disabled" ${group.status === 'disabled' ? 'selected' : ''}>已停用</option></select></label><label class="edit-field"><span>群友加好友</span><select id="group-edit-friend"><option value="1" ${Number(group.allow_member_add_friend) ? 'selected' : ''}>允许</option><option value="0" ${!Number(group.allow_member_add_friend) ? 'selected' : ''}>禁止</option></select></label><p id="group-edit-feedback" class="user-edit-feedback"></p><div class="user-modal-actions"><button class="primary" id="group-edit-submit" type="submit">确定</button><button class="modal-cancel" id="group-edit-cancel" type="button">取消</button></div></form></section>`; document.body.appendChild(modal); const close = () => modal.remove(); $('group-edit-close').onclick = close; $('group-edit-cancel').onclick = close; modal.onclick = (event) => { if (event.target === modal) close(); }; document.querySelectorAll('[data-group-number]').forEach((button) => button.onclick = () => { const input = $('group-edit-max'); input.value = Math.min(Number(input.max), Math.max(Number(input.min || 1), Number(input.value || 500) + Number(button.dataset.groupNumber))); }); let displayCountEdited = false; const displayInput = $('group-edit-display-count'); displayInput.oninput = () => { displayCountEdited = true; }; const syncDisplayField = () => { const enabled = $('group-edit-type').value === 'group'; $('group-edit-count-field').hidden = !enabled; $('group-edit-count-field').style.display = enabled ? '' : 'none'; displayInput.disabled = !enabled; modal.querySelectorAll('[data-group-count-step]').forEach(button => { button.disabled = !enabled; }); }; $('group-edit-type').onchange = syncDisplayField; syncDisplayField(); modal.querySelectorAll('[data-group-count-step]').forEach(button => { button.onclick = () => { displayInput.value = Math.min(10000000, Math.max(0, Number(displayInput.value || group.display_member_count || group.member_count || 0) + Number(button.dataset.groupCountStep))); displayCountEdited = true; }; }); $('group-edit-form').onsubmit = async (event) => { event.preventDefault(); const submit = $('group-edit-submit'); const feedback = $('group-edit-feedback'); submit.disabled = true; feedback.textContent = '正在保存...'; const payload = { name: $('group-edit-name').value.trim(), owner_id: Number($('group-edit-owner').value), description: $('group-edit-description').value, announcement: $('group-edit-announcement').value, max_members: Number($('group-edit-max').value), type: $('group-edit-type').value, all_muted: $('group-edit-muted').value === '1', join_method: $('group-edit-join').value, status: $('group-edit-status').value, allow_member_add_friend: $('group-edit-friend').value === '1', request_id: `admin-group-${Date.now()}` }; if (displayCountEdited && !displayInput.disabled) payload.display_member_count = displayInput.value.trim() === '' ? null : Number(displayInput.value); try { await api(id ? '/admin/groups/update' : '/admin/groups/create', { method: 'POST', body: JSON.stringify(id ? { ...payload, group_id: id } : payload) }); close(); await loadGroups(); } catch (error) { feedback.textContent = error.message; submit.disabled = false; } }; } catch (error) { alert(error.message); } }

const messageTypeLabels = { text: '文字', image: '图片', video: '视频', file: '文件', voice: '语音', contact_card: '名片', shake: '抖动', system: '系统' };
const messageConversationLabels = { direct: '个人', group: '群聊', channel: '频道', customer_service: '客服' };
const emptyMessageFilters = () => ({ sender: '', receiver: '', conversation_type: '', type: '', q: '' });
function messagePerson(person) {
  if (!person) return '<span class="muted-action">未知用户</span>';
  return `<strong>${esc(person.account || person.nickname || `用户 #${person.id}`)}</strong><small>${esc(person.nickname || '')}</small><small>ID ${esc(person.id)}${person.public_id ? ` · ${esc(person.public_id)}` : ''}</small>`;
}
function messageSender(item) { return { id: item.sender_id, account: item.sender_account, nickname: item.sender_nickname, public_id: item.sender_public_id }; }
function messageReceiver(item) {
  return item.conversation_type === 'direct'
    ? (item.recipients || []).map(messagePerson).join('') || '<span class="muted-action">接收者信息不可用</span>'
    : `<strong>${esc(item.conversation_name || `会话 #${item.conversation_id}`)}</strong><small>${esc(messageConversationLabels[item.conversation_type] || '会话')} · #${esc(item.conversation_id)}</small>`;
}
function messageMediaUrl(value) {
  value = PulseGoAdmin.mediaURL(value);
  if (typeof value === 'string' && value.startsWith('blob:') && value.startsWith('blob:' + location.origin + '/')) return value;
  // The API signs stored attachments for the current admin session. Never render
  // arbitrary text links, data URLs or an unsigned attachment as an image.
  if (typeof value !== 'string' || value.length > 4096) return '';
  try {
    const url = new URL(value, API.startsWith('http') ? API : location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    const path = decodeURIComponent(url.pathname);
    const stored = /\/storage\/uploads\/\d{4}\/(?:0[1-9]|1[0-2])\/[a-f0-9]{32}\.[a-z0-9]{1,8}$/.test(path);
    const proxy = path.endsWith('/media') && /^uploads\/\d{4}\/(?:0[1-9]|1[0-2])\/[a-f0-9]{32}\.[a-z0-9]{1,8}$/.test(url.searchParams.get('path') || '');
    if (!(stored || proxy) || url.searchParams.get('media_kind') !== 'admin'
      || !/^[a-f0-9]{64}$/.test(url.searchParams.get('media_signature') || '')
      || !/^[a-f0-9]{64}$/.test(url.searchParams.get('media_session') || '')
      || !/^\d{10}$/.test(url.searchParams.get('media_expires') || '')) return '';
    return url.href;
  } catch { return ''; }
}
function messageBodyMarkup(item, detail = false) {
  const body = item.body || {}, text = typeof body.text === 'string' ? body.text : '';
  if (item.type === 'image') {
    const original = messageMediaUrl(body.url || body.image_url);
    const thumb = messageMediaUrl(body.thumbnail_url) || original;
    if (item.recalled_at) return '<span class="muted-action">图片（已撤回）</span>';
    if (!original) return '<span class="muted-action">图片地址不可用</span>';
    return detail
      ? `<div class="message-media-stage" aria-busy="true"><p class="message-media-feedback" role="status">正在加载图片…</p><img class="message-full-image" src="${esc(original)}" alt="消息图片" referrerpolicy="no-referrer"></div>${text ? `<div class="message-content-text">${esc(text)}</div>` : ''}`
      : `<button type="button" class="message-image-button" data-message-preview="${item.id}" aria-label="查看消息 ${item.id} 的图片"><img src="${esc(thumb)}" loading="lazy" alt="消息图片，点击查看" referrerpolicy="no-referrer"><span>查看图片</span></button>${text ? `<div class="message-content-text">${esc(text)}</div>` : ''}`;
  }
  if (['video','voice','file'].includes(item.type) && !item.recalled_at && body._go_media_id) {
    const label = item.type==='video'?'视频':item.type==='voice'?'语音':'文件';
    return detail ? `<div class="message-private-media" data-media-id="${esc(body._go_media_id)}"><button type="button" class="table-action" data-load-private-media>加载${label}</button><span role="status"></span></div>` : `<div class="message-content-text">${esc(body.name || label)}，点击查看</div>`;
  }
  const readable = text || (item.type === 'contact_card' ? `个人名片：${body.nickname || body.username || body.user_id || ''}` : body.file_name || body.name || body.original_name || '');
  return `<div class="message-content-text">${esc(readable || JSON.stringify(body, null, detail ? 2 : 0))}</div>`;
}
async function loadMessages(view = 'messages') {
  closeMessagePreview(false);
  state.messageFilters ||= {};
  const filters = state.messageFilters[view] ||= emptyMessageFilters();
  const params = new URLSearchParams({ page: String(page(view)), size: '30', ...filters });
  const data = await api(`/admin/messages?${params}`);
  const moderation = view === 'moderation';
  state.messageItems = { view, token: state.token, items: new Map(data.items.map(item => [Number(item.id), item])) };
  const resolved = data.filters || {};
  const scope = [resolved.sender && `发送者：${resolved.sender.account || resolved.sender.nickname}（ID ${resolved.sender.id}）`, resolved.receiver && `接收者：${resolved.receiver.account || resolved.receiver.nickname}（ID ${resolved.receiver.id}）`].filter(Boolean).join(' → ');
  $('app').innerHTML = `<div class="page-title"><div><div class="title-eyebrow">内容与沟通</div><h2>${moderation ? '内容审核' : '消息与会话'}</h2><p>共找到 ${Number(data.total)} 条消息${moderation ? ' · 审核并处理违规消息' : ''}</p></div></div>
    <section class="panel data-panel message-history-panel">
      <form id="message-filters" class="toolbar message-filters" autocomplete="off">
        <label>发送者<input id="message-sender" name="sender" maxlength="128" value="${esc(filters.sender)}" placeholder="完整账号 / 用户 ID"></label>
        <label>接收者<input id="message-receiver" name="receiver" maxlength="128" value="${esc(filters.receiver)}" placeholder="完整账号 / 用户 ID（个人会话）"></label>
        <label>会话类型<select id="message-conversation-type" name="conversation_type"><option value="">全部会话</option>${Object.entries(messageConversationLabels).map(([key, value]) => `<option value="${key}" ${filters.conversation_type === key ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
        <label>消息类型<select id="message-type" name="type"><option value="">全部类型</option>${Object.entries(messageTypeLabels).map(([key, value]) => `<option value="${key}" ${filters.type === key ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
        <label>消息内容<input id="message-search-admin" name="q" maxlength="500" value="${esc(filters.q)}" placeholder="搜索消息内容"></label>
        <button type="submit" class="primary small-button" id="message-search-button">搜索</button><button type="button" class="table-action" id="message-reset">重置</button>
      </form>
      <div class="message-query-note">只填发送者可查看他发出的消息；同时填写两项，只查询发送者发给接收者的个人消息。支持完整账号、公开用户 ID 或数字用户 ID。<br>客户端删除消息、清空聊天或删除会话，不影响此处保留的记录。</div>
      ${scope ? `<div class="message-query-scope">${esc(scope)}</div>` : ''}
      <div class="table-wrap"><table class="message-history-table"><thead><tr><th>编号</th><th>会话</th><th>发送者</th><th>接收者</th><th>类型</th><th>内容</th><th>发送时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${data.items.map(item => `<tr><td>${item.id}</td><td><strong>${esc(messageConversationLabels[item.conversation_type] || '会话')}</strong><small>#${item.conversation_id}${item.conversation_type !== 'direct' && item.conversation_name ? ` · ${esc(item.conversation_name)}` : ''}</small></td><td class="message-person">${messagePerson(messageSender(item))}</td><td class="message-person">${messageReceiver(item)}</td><td><span class="type-tag">${esc(messageTypeLabels[item.type] || item.type)}</span></td><td class="message-content-cell">${messageBodyMarkup(item)}</td><td>${esc(item.created_at)}</td><td><span class="status ${item.recalled_at ? 'frozen' : 'active'}">${item.recalled_at ? '已撤回' : '已发送'}</span></td><td><button type="button" class="table-action" data-message-preview="${item.id}">查看</button>${moderation ? (item.recalled_at ? '<span class="muted-action">已处理</span>' : `<button type="button" class="table-action danger" data-moderate-message="${item.id}">撤回消息</button>`) : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="no-data">没有符合筛选条件的消息</td></tr>'}</tbody></table></div>${pager(data, view)}
    </section>`;
  $('message-filters').onsubmit = event => {
    event.preventDefault(); state.messageFilters[view] = Object.fromEntries(new FormData(event.currentTarget));
    state.pages[view] = 1; return loadMessages(view);
  };
  $('message-reset').onclick = () => { state.messageFilters[view] = emptyMessageFilters(); state.pages[view] = 1; return loadMessages(view); };
  document.querySelectorAll('[data-message-preview]').forEach(button => button.onclick = () => openMessagePreview(Number(button.dataset.messagePreview), button));
  document.querySelectorAll('[data-moderate-message]').forEach(button => button.onclick = () => moderateMessage(Number(button.dataset.moderateMessage), view));
  document.querySelectorAll('.message-image-button img').forEach(image => image.onerror = () => { image.hidden = true; image.closest('button').classList.add('message-image-failed'); image.nextElementSibling.textContent = '图片未加载，点击重试'; });
  bindPager(view, () => loadMessages(view));
}
function closeMessagePreview(restoreFocus = true) {
  const modal = $('message-history-preview');
  if (!modal) return;
  const trigger = modal.messageTrigger;
  if (modal.open) modal.close();
  modal.remove();
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}
function openMessagePreview(id, trigger) {
  const listing = state.messageItems;
  if (!listing || listing.view !== state.view || listing.token !== state.token || !canPage(listing.view)) return;
  const item = listing.items.get(id);
  if (!item) return;
  closeMessagePreview(false);
  const modal = document.createElement('dialog');
  modal.id = 'message-history-preview'; modal.className = 'message-history-preview'; modal.messageTrigger = trigger;
  modal.setAttribute('aria-labelledby', 'message-preview-title');
  modal.innerHTML = `<header><div><h2 id="message-preview-title">消息详情 · #${item.id}</h2><p>${esc(item.created_at)} · ${esc(messageTypeLabels[item.type] || item.type)}${item.recalled_at ? ' · 已撤回' : ''}</p></div><button type="button" class="message-preview-close" aria-label="关闭消息详情" autofocus>×</button></header><div class="message-preview-people"><div>发送者${messagePerson(messageSender(item))}</div><div>接收者${messageReceiver(item)}</div></div><div class="message-preview-body">${messageBodyMarkup(item, true)}<details><summary>消息数据</summary><pre>${esc(JSON.stringify(item.body || {}, null, 2))}</pre></details></div><footer><button type="button" class="modal-cancel message-preview-close">关闭</button></footer>`;
  document.body.appendChild(modal);
  const mediaButton = modal.querySelector('[data-load-private-media]');
  if (mediaButton) mediaButton.onclick = async () => {
    mediaButton.disabled = true;
    const stage = mediaButton.parentElement, feedback = stage.querySelector('[role="status"]');
    feedback.textContent = '正在加载…';
    try {
      const source = await PulseGoAdmin.mediaBlob(item.body._go_media_id);
      if (!modal.isConnected || state.messageItems !== listing) return;
      if (item.type === 'file') {
        const link = document.createElement('a');link.href=source;link.download=item.body.name||'附件';link.textContent='下载附件';stage.replaceChildren(link);
      } else {
        const player = document.createElement(item.type==='video'?'video':'audio');player.controls=true;player.preload='metadata';player.src=source;player.style.maxWidth='100%';stage.replaceChildren(player);
      }
    } catch (error) {if(modal.isConnected){feedback.textContent=error.message;mediaButton.disabled=false;}}
  };
  const close = () => closeMessagePreview();
  modal.querySelectorAll('.message-preview-close').forEach(button => button.onclick = close);
  modal.oncancel = event => { event.preventDefault(); close(); };
  modal.onkeydown = event => { if (event.key === 'Escape') event.stopPropagation(); };
  modal.onclick = event => {
    const rect = modal.getBoundingClientRect();
    if (event.target === modal && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) close();
  };
  const image = modal.querySelector('.message-full-image');
  if (image) {
    const complete = failed => {
      if (!modal.isConnected) return;
      const stage = image.closest('.message-media-stage'), feedback = stage.querySelector('.message-media-feedback');
      stage.setAttribute('aria-busy', 'false'); image.hidden = failed; feedback.hidden = !failed;
      feedback.textContent = failed ? '图片加载失败，请关闭并刷新列表后重试。' : '';
    };
    image.onload = () => complete(false); image.onerror = () => complete(true);
    if (image.complete) complete(image.naturalWidth === 0);
  }
  modal.showModal();
}

async function moderateMessage(messageId, view) { if (!window.confirm(`确定撤回消息 #${messageId} 吗？`)) return; try { await api('/admin/messages/recall', { method: 'POST', body: JSON.stringify({ message_id: messageId, request_id: `moderate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }) }); await loadMessages(view); } catch (error) { alert(error.message); } }

async function loadSensitiveWords() { const query = $('sensitive-word-search')?.value.trim() || ''; const data = await api(`/admin/sensitive-words?page=${page('sensitive-words')}&size=20&q=${encodeURIComponent(query)}`); $('app').innerHTML = `<div class="page-title"><div><div class="title-eyebrow">内容安全</div><h2>敏感词管理</h2><p>消息发送和展示时会按照这里的规则自动替换</p></div></div><section class="panel data-panel sensitive-panel"><div class="toolbar sensitive-toolbar"><div class="sensitive-search"><b>匹配文字</b><input id="sensitive-word-search" value="${esc(query)}" placeholder="请输入匹配文字"><button class="primary small-button" id="sensitive-word-search-button">搜索</button><button class="table-action" id="sensitive-word-reset-button">重置</button></div><div class="sensitive-actions"><button class="primary small-button" id="sensitive-word-create-button">＋ 新增</button><button class="table-action" id="sensitive-word-batch-delete">删除选中</button></div></div><div class="sensitive-table-wrap"><table class="sensitive-table"><thead><tr><th class="check-col"><input id="sensitive-word-select-all" type="checkbox" aria-label="全选"></th><th>ID</th><th>匹配文字</th><th>替换文字</th><th>创建时间</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${data.items.map(sensitiveWordRow).join('') || '<tr><td colspan="7" class="no-data">暂无敏感词</td></tr>'}</tbody></table></div>${pager(data, 'sensitive-words')}</section>`; $('sensitive-word-search-button').onclick = () => { state.pages['sensitive-words'] = 1; return loadSensitiveWords(); }; $('sensitive-word-reset-button').onclick = () => { $('sensitive-word-search').value = ''; state.pages['sensitive-words'] = 1; return loadSensitiveWords(); }; $('sensitive-word-create-button').onclick = () => openSensitiveWordModal(); $('sensitive-word-batch-delete').onclick = batchDeleteSensitiveWords; $('sensitive-word-select-all').onchange = (event) => document.querySelectorAll('[data-word-checkbox]').forEach((box) => { box.checked = event.target.checked; }); document.querySelectorAll('[data-word-edit]').forEach((button) => { button._word = data.items.find((item) => Number(item.id) === Number(button.dataset.wordEdit)); button.onclick = () => openSensitiveWordModal(button._word); }); document.querySelectorAll('[data-word-delete]').forEach((button) => button.onclick = () => deleteSensitiveWord(Number(button.dataset.wordDelete))); bindPager('sensitive-words', loadSensitiveWords); }
function sensitiveWordRow(item) { return `<tr><td class="check-col"><input data-word-checkbox value="${item.id}" type="checkbox" aria-label="选择敏感词"></td><td>${item.id}</td><td><b>${esc(item.word)}</b></td><td>${item.replacement === '' ? '<span class="muted-action">删除文字</span>' : esc(item.replacement)}</td><td>${esc(item.created_at)}</td><td>${esc(item.updated_at)}</td><td><button class="table-action" data-word-edit="${item.id}">修改</button><button class="table-action danger" data-word-delete="${item.id}">删除</button></td></tr>`; }
function openSensitiveWordModal(word = null) { const old = $('sensitive-word-modal'); if (old) old.remove(); const modal = document.createElement('div'); modal.id = 'sensitive-word-modal'; modal.className = 'user-modal-backdrop'; modal.innerHTML = `<section class="user-modal word-modal" role="dialog" aria-modal="true"><button class="user-modal-close" id="sensitive-word-close" type="button" aria-label="关闭">×</button><h2>${word ? '修改敏感词' : '新增敏感词'}</h2><form id="sensitive-word-form" class="word-modal-form"><label><span><i>*</i>匹配文字</span><input id="sensitive-word-value" value="${esc(word?.word || '')}" maxlength="128" required placeholder="请输入需要替换的文字"></label><label><span>替换文字</span><input id="sensitive-replacement-value" value="${esc(word?.replacement ?? '*')}" maxlength="128" placeholder="例如：*"></label><p id="sensitive-word-feedback" class="user-edit-feedback"></p><div class="user-modal-actions"><button class="primary" id="sensitive-word-submit" type="submit">确定</button><button class="modal-cancel" id="sensitive-word-cancel" type="button">取消</button></div></form></section>`; document.body.appendChild(modal); $('sensitive-word-close').onclick = () => modal.remove(); $('sensitive-word-cancel').onclick = () => modal.remove(); modal.onclick = (event) => { if (event.target === modal) modal.remove(); }; $('sensitive-word-form').onsubmit = async (event) => { event.preventDefault(); const feedback = $('sensitive-word-feedback'); const submit = $('sensitive-word-submit'); submit.disabled = true; try { await api(word ? '/admin/sensitive-words/edit' : '/admin/sensitive-words', { method: 'POST', body: JSON.stringify({ id: word?.id, word: $('sensitive-word-value').value.trim(), replacement: $('sensitive-replacement-value').value, request_id: `admin-${Date.now()}` }) }); modal.remove(); await loadSensitiveWords(); } catch (error) { feedback.textContent = error.message; submit.disabled = false; } }; }
async function deleteSensitiveWord(id) { if (!window.confirm(`确定删除敏感词 #${id} 吗？`)) return; try { await api('/admin/sensitive-words/delete', { method: 'POST', body: JSON.stringify({ id, request_id: `admin-${Date.now()}` }) }); await loadSensitiveWords(); } catch (error) { alert(error.message); } }
async function batchDeleteSensitiveWords() { const ids = [...document.querySelectorAll('[data-word-checkbox]:checked')].map((box) => Number(box.value)); if (!ids.length) { alert('请选择要删除的敏感词。'); return; } if (!window.confirm(`确定删除选中的${ids.length}个敏感词吗？`)) return; try { await api('/admin/sensitive-words/batch-delete', { method: 'POST', body: JSON.stringify({ ids, request_id: `admin-${Date.now()}` }) }); await loadSensitiveWords(); } catch (error) { alert(error.message); } }

async function loadLogs(kind) { const endpoint = kind === 'login-logs' ? `/admin/login-logs?page=${page(kind)}&size=50` : `/admin/audit-logs?${kind === 'client-logs' ? 'action=client.diagnostics&' : ''}page=${page(kind)}&size=50`; const data = await api(endpoint); const items = data.items || []; const login = kind === 'login-logs'; $('app').innerHTML = `<div class="page-title"><div><div class="title-eyebrow">安全与追踪</div><h2>${login ? '登录日志' : kind === 'client-logs' ? '客户端日志' : '审计日志'}</h2><p>共 ${data.total || items.length} 条记录</p></div><div class="form-row" aria-label="日志类型">${[['login-logs', '登录日志'], ['client-logs', '客户端日志'], ['audit-logs', '操作审计']].map(([key, title]) => `<button type="button" class="${key === kind ? '' : 'secondary'}" data-log-kind="${key}" aria-pressed="${key === kind}">${title}</button>`).join('')}</div></div><section class="panel data-panel"><div class="table-wrap"><table><thead><tr>${login ? '<th>用户编号</th><th>手机号</th><th>登录端</th><th>地址</th><th>结果</th><th>时间</th>' : '<th>操作</th><th>目标</th><th>管理员</th><th>地址</th><th>详情</th><th>时间</th>'}</tr></thead><tbody>${items.map((item) => login ? `<tr><td>${esc(item.user_id || '-')}</td><td>${esc(item.phone)}</td><td>${label(deviceMap, item.device_type)}</td><td>${esc(item.ip)}</td><td><span class="status ${Number(item.success) ? 'active' : 'frozen'}">${Number(item.success) ? '成功' : '失败'}</span></td><td>${esc(item.created_at)}</td></tr>` : `<tr><td>${auditActionLabel(item)}</td><td>${label(targetTypeMap, item.target_type)} #${esc(item.target_id)}</td><td>${esc(item.admin_id)}</td><td>${esc(item.ip)}</td><td class="body-cell">${esc(JSON.stringify(auditDetail(item)))}</td><td>${esc(item.created_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="no-data">暂无日志记录</td></tr>'}</tbody></table></div>${pager(data, kind)}</section>`; document.querySelectorAll('[data-log-kind]').forEach(button => { button.onclick = () => loadLogs(button.dataset.logKind).catch(error => notify(error.message, 'error')); }); bindPager(kind, () => loadLogs(kind)); }

async function loadAnnouncement() {
  const data = await api('/admin/announcement');
  if (state.view !== 'announcement') return;
  $('app').innerHTML = `<div class="announcement-layout"><section class="panel announcement-editor"><div class="panel-head"><div><h3>启动通知公告</h3><p>保存后，用户下次打开应用时读取最新内容</p></div><span id="announcement-state" class="panel-tag">${data.enabled ? '已启用' : '已停用'}</span></div><form id="announcement-form"><label class="announcement-toggle"><span><b>启用公告</b><small>关闭后不弹窗，也不显示首页公告栏</small></span><input id="announcement-enabled" type="checkbox" role="switch" ${data.enabled ? 'checked' : ''}></label><label class="announcement-field"><span>公告标题</span><input id="announcement-title" maxlength="32" value="${esc(data.title)}" placeholder="例如：官方提示" required></label><label class="announcement-field"><span>公告正文</span><textarea id="announcement-content" maxlength="4000" rows="8" placeholder="填写要通知用户的内容，支持换行" required>${esc(data.content)}</textarea></label><p class="announcement-help">正文填写 {app_name} 可自动显示应用名称；公告按纯文字展示。</p><div class="announcement-meta"><span id="announcement-updated">更新时间：${esc(data.updated_at)}</span><span id="announcement-count"></span></div><p id="announcement-feedback" role="status" aria-live="polite"></p><div class="announcement-actions"><button id="announcement-save" class="primary" type="submit">保存公告</button><button id="announcement-reload" class="table-action" type="button">重新加载</button></div></form></section><section class="panel announcement-preview-panel"><div class="panel-head"><div><h3>手机弹窗预览</h3><p>预览随填写内容更新，保存后生效</p></div></div><div class="announcement-phone"><div class="announcement-preview-card"><svg class="announcement-shield" viewBox="0 0 160 160" aria-hidden="true"><defs><linearGradient id="notice-shield" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#7cbbff"/><stop offset="1" stop-color="#3c77fa"/></linearGradient></defs><ellipse cx="80" cy="137" rx="41" ry="8" fill="#6295ff" opacity=".12"/><path d="M80 13L139 39v45c0 33-24 53-59 65C45 137 21 117 21 84V39z" fill="url(#notice-shield)"/><path d="M80 26l46 21v35c0 27-19 44-46 54-27-10-46-27-46-54V47z" fill="white"/><rect x="74" y="51" width="12" height="41" rx="6" fill="#5488fa"/><circle cx="80" cy="108" r="7" fill="#5488fa"/></svg><h4 id="announcement-preview-title"></h4><div id="announcement-preview-content"></div><button class="announcement-preview-ok" type="button" disabled>我知道了</button></div></div><p class="announcement-help">应用打开或从后台返回时读取公告，确认后本次使用不重复弹出；点击首页公告栏可再次查看。</p></section></div>`;
  let revision = data.revision;
  const updatePreview = () => {
    const resolve = text => text.replaceAll('{app_name}', '脉冲即时通讯').replaceAll('来顺', '脉冲即时通讯');
    $('announcement-preview-title').textContent = resolve($('announcement-title').value || '官方提示');
    $('announcement-preview-content').textContent = resolve($('announcement-content').value);
    $('announcement-count').textContent = `${$('announcement-content').value.length} / 4000 字`;
  };
  $('announcement-title').oninput = updatePreview;
  $('announcement-content').oninput = updatePreview;
  $('announcement-reload').onclick = loadAnnouncement;
  updatePreview();
  $('announcement-form').onsubmit = async event => {
    event.preventDefault();
    const save = $('announcement-save'), feedback = $('announcement-feedback');
    const fieldIds = ['announcement-enabled', 'announcement-title', 'announcement-content', 'announcement-reload'];
    const fields = fieldIds.map(id => $(id));
    const payload = { title: $('announcement-title').value, content: $('announcement-content').value, enabled: $('announcement-enabled').checked, revision, request_id: `announcement-${Date.now()}` };
    save.disabled = true; fields.forEach(field => field.disabled = true); feedback.textContent = '正在保存…'; feedback.className = '';
    try {
      const result = await api('/admin/announcement', { method: 'POST', body: JSON.stringify(payload) });
      revision = result.revision;
      feedback.textContent = result.enabled ? '保存成功，用户下次打开应用时显示最新公告。' : '保存成功，公告已停用。';
      feedback.className = 'announcement-success';
      // Keep the result attached to this form if the administrator navigates away during the request.
      if (feedback.isConnected) {
        $('announcement-state').textContent = result.enabled ? '已启用' : '已停用';
        $('announcement-updated').textContent = `更新时间：${result.updated_at}`;
      }
    } catch (error) { feedback.textContent = error.message; feedback.className = 'error'; }
    finally { save.disabled = false; fields.forEach(field => field.disabled = false); }
  };
}

async function loadExplore() {
  const data = await api('/admin/client-navigation');
  const links = Array.isArray(data.explore_links) ? data.explore_links : [];
  const row = (item = {}) => `<div class="explore-link-row" data-explore-row><input data-explore-name maxlength="32" value="${esc(item.name || '')}" placeholder="例如：商城1"><input data-explore-url maxlength="2048" value="${esc(item.url || '')}" placeholder="https://example.com"><button class="table-action danger" type="button" data-explore-remove>移除</button></div>`;
  $('app').innerHTML = `<section class="panel data-panel explore-config"><div class="panel-head"><div><h3>探索入口配置</h3><p>安卓端和 iOS 端的“探索”会显示这里配置的入口，点击后在应用内打开外部网页。</p></div><span class="panel-tag">最多10个</span></div><div class="explore-help">每个入口填写显示名称和完整的 http 或 https 链接。页面内容由外部站点提供，后台只负责配置入口地址。</div><form id="explore-form"><div class="explore-link-head"><span>入口名称</span><span>外部链接</span><span></span></div><div id="explore-links">${links.map(row).join('')}</div><button class="table-action" id="explore-add" type="button">＋ 添加探索入口</button><p id="explore-feedback" class="user-edit-feedback" role="status"></p><div class="announcement-actions"><button class="primary" id="explore-save" type="submit">保存配置</button><button class="table-action" id="explore-reload" type="button">重新加载</button></div></form></section>`;
  const container = $('explore-links');
  const addRow = () => { if (container.querySelectorAll('[data-explore-row]').length >= 10) return; container.insertAdjacentHTML('beforeend', row()); bindRows(); };
  const bindRows = () => container.querySelectorAll('[data-explore-remove]').forEach((button) => { button.onclick = () => button.closest('[data-explore-row]')?.remove(); });
  $('explore-add').onclick = addRow;
  $('explore-reload').onclick = loadExplore;
  bindRows();
  $('explore-form').onsubmit = async (event) => {
    event.preventDefault();
    const feedback = $('explore-feedback'); const save = $('explore-save'); save.disabled = true; feedback.textContent = '正在保存...';
    const explore_links = [...container.querySelectorAll('[data-explore-row]')].map((node, index) => ({ id: index + 1, name: node.querySelector('[data-explore-name]').value.trim(), url: node.querySelector('[data-explore-url]').value.trim() }));
    try { const result = await api('/admin/client-navigation', { method: 'POST', body: JSON.stringify({ explore_links, request_id: `navigation-${Date.now()}` }) }); feedback.className = 'user-edit-feedback success'; feedback.textContent = `已保存 ${result.explore_links.length} 个探索入口。`; } catch (error) { feedback.className = 'user-edit-feedback error'; feedback.textContent = error.message; } finally { save.disabled = false; }
  };
}

async function loadClientConfig() {
  const data = await api('/admin/client-config');
  const configuredLinks = (Array.isArray(data.explore_links) && data.explore_links.length ? data.explore_links : (Array.isArray(data.mall_links) ? data.mall_links : [])).filter((item) => item && (item.name || item.url));
  const shops = configuredLinks.concat([{}, {}, {}]).slice(0, 10);
  const shopRow = (item = {}, index = 0) => `<div class="client-shop-row" data-shop-row><span class="client-shop-index">值得买 ${index + 1}</span><input data-shop-name maxlength="32" value="${esc(item.name || '')}" placeholder="入口名称"><input data-shop-url maxlength="2048" value="${esc(item.url || '')}" placeholder="https://example.com"><button class="table-action danger" data-shop-remove type="button">移除</button></div>`;
  $('app').innerHTML = `<section class="panel data-panel client-config-panel"><div class="panel-head"><div><h3>客户端配置</h3><p>统一管理客户端版本、注册策略和商城入口，保存后各端会读取最新配置。</p></div><span class="panel-tag">三方配置</span></div><form id="client-config-form" class="client-config-form"><div class="config-section"><div class="config-section-title"><b>客户端更新</b><span>用于客户端检查新版本</span></div><label class="config-toggle"><span><b>显示群成员人数</b><small>关闭后客户端群组资料不显示成员人数</small></span><input id="config-show-member-count" type="checkbox" role="switch" ${data.show_group_member_count ? 'checked' : ''}></label><div class="config-grid"><label><span>PC 最新版本号</span><input id="config-version" maxlength="32" value="${esc(data.latest_version)}" placeholder="例如：1.0.0"></label><label><span>Android APK下载地址</span><input id="config-android-url" maxlength="2048" value="${esc(data.android_download_url)}" placeholder="https://example.com/app.apk"></label><label><span>iOS下载地址</span><input id="config-ios-url" maxlength="2048" value="${esc(data.ios_download_url)}" placeholder="https://example.com/app.ipa"></label><label class="client-field wide"><span>电脑端下载地址</span><input id="config-pc-download-url" type="url" maxlength="2048" value="${esc(data.pc_download_url || '')}" placeholder="https://实际域名/新版安装包.exe"></label><label class="config-wide"><span>更新说明</span><textarea id="config-update-description" maxlength="10000" rows="4" placeholder="填写本次更新内容">${esc(data.update_description)}</textarea></label></div><label class="config-toggle"><span><b>PC 强制更新</b><small>仅限制低于 PC 最低兼容版本的电脑端，其他平台单独设置</small></span><input id="config-force-update" type="checkbox" role="switch" ${data.force_update ? 'checked' : ''}></label></div><div class="config-section"><div class="config-section-title"><b>注册限制</b><span>注册接口会实时执行以下规则</span></div><label class="config-toggle"><span><b>注册必须上传头像</b><small>开启后未提交头像地址的注册请求会被拒绝</small></span><input id="config-require-avatar" type="checkbox" role="switch" ${data.register_require_avatar ? 'checked' : ''}></label><div class="config-grid"><label><span>单个IP最大注册账号数</span><input id="config-ip-limit" type="number" min="0" max="100000" value="${Number(data.max_register_accounts_per_ip || 0)}"><small class="field-help">填写0表示不限制</small></label></div></div><div class="config-section"><div class="config-section-title"><b>值得买入口</b><span>客户端商城页面显示的外部链接</span></div><div id="client-shops" class="client-shops">${shops.map(shopRow).join('')}</div><button class="table-action" id="client-shop-add" type="button">＋ 添加商城入口</button></div><p id="client-config-feedback" class="user-edit-feedback" role="status"></p><div class="announcement-actions"><button class="primary" id="client-config-save" type="submit">保存配置</button><button class="table-action" id="client-config-reload" type="button">重新加载</button></div></form></section>`;
  const container = $('client-shops');
  const bindShopRows = () => container.querySelectorAll('[data-shop-remove]').forEach((button) => { button.onclick = () => button.closest('[data-shop-row]')?.remove(); });
  $('client-shop-add').onclick = () => { const index = container.querySelectorAll('[data-shop-row]').length; if (index >= 10) return; container.insertAdjacentHTML('beforeend', shopRow({}, index)); bindShopRows(); };
  const platformLabels = { pc: 'PC', android: 'Android', ios: 'iOS', web: '网页版' };
  const defaultVersions = { pc: data.latest_version || '1.0.0', android: '0.2.58', ios: '1.0', web: '2.4.103' };
  const rules = Object.fromEntries(Object.keys(platformLabels).map(platform => [platform, data.platform_updates?.[platform] || { latest_version: defaultVersions[platform], minimum_version: platform === 'pc' && data.force_update ? data.latest_version : '', force_update: platform === 'pc' && data.force_update }]));
  const ruleFields = Object.keys(platformLabels).map(platform => '<div class="config-section"><div class="config-section-title"><b>' + platformLabels[platform] + ' 更新策略</b><span>最新版本用于提示，低于最低兼容版本时才强制更新</span></div><div class="config-grid">' + (platform === 'pc' ? '' : '<label><span>最新版本号</span><input id="config-' + platform + '-version" maxlength="32" value="' + esc(rules[platform].latest_version) + '"></label>') + '<label><span>最低兼容版本</span><input id="config-' + platform + '-minimum" maxlength="32" value="' + esc(rules[platform].minimum_version || '') + '" placeholder="不强制更新可留空"></label></div>' + (platform === 'pc' ? '' : '<label class="config-toggle"><span><b>' + platformLabels[platform] + ' 强制更新</b><small>只作用于本平台</small></span><input id="config-' + platform + '-force" type="checkbox" role="switch" ' + (rules[platform].force_update ? 'checked' : '') + '></label>') + '</div>').join('');
  document.querySelector('#client-config-form .config-section').insertAdjacentHTML('afterend', ruleFields);
  $('client-config-reload').onclick = loadClientConfig;
  bindShopRows();
  $('client-config-form').onsubmit = async (event) => {
    event.preventDefault();
    const save = $('client-config-save'); const feedback = $('client-config-feedback'); save.disabled = true; feedback.className = 'user-edit-feedback'; feedback.textContent = '正在保存...';
    const mall_links = [...container.querySelectorAll('[data-shop-row]')].map((row) => ({ name: row.querySelector('[data-shop-name]').value.trim(), url: row.querySelector('[data-shop-url]').value.trim() })).filter((item) => item.name || item.url);
    const payload = { show_group_member_count: $('config-show-member-count').checked, latest_version: $('config-version').value.trim(), android_download_url: $('config-android-url').value.trim(), ios_download_url: $('config-ios-url').value.trim(), pc_download_url: $('config-pc-download-url').value.trim(), update_description: $('config-update-description').value, force_update: $('config-force-update').checked, register_require_avatar: $('config-require-avatar').checked, max_register_accounts_per_ip: Number($('config-ip-limit').value || 0), mall_links, request_id: `client-config-${Date.now()}` };
    payload.platform_updates = Object.fromEntries(Object.keys(platformLabels).map(platform => [platform, { latest_version: platform === 'pc' ? payload.latest_version : $('config-' + platform + '-version').value.trim(), minimum_version: $('config-' + platform + '-minimum').value.trim(), force_update: platform === 'pc' ? payload.force_update : $('config-' + platform + '-force').checked }]));
    try { await api('/admin/client-config', { method: 'POST', body: JSON.stringify(payload) }); feedback.className = 'user-edit-feedback success'; feedback.textContent = '配置已保存，客户端下次读取时生效。'; } catch (error) { feedback.className = 'user-edit-feedback error'; feedback.textContent = error.message; } finally { save.disabled = false; }
  };
}

function openRouteModal(route = null) {
  const old = $('client-route-modal'); if (old) old.remove();
  const modal = document.createElement('div'); modal.id = 'client-route-modal'; modal.className = 'user-modal-backdrop';
  modal.innerHTML = `<section class="user-modal route-modal" role="dialog" aria-modal="true" aria-labelledby="route-modal-title"><button class="user-modal-close" id="route-modal-close" type="button" aria-label="关闭">×</button><h2 id="route-modal-title">${route ? '编辑线路' : '新增线路'}</h2><form id="route-form" class="route-form"><label><span><i>*</i>线路名称</span><input id="route-name" maxlength="64" value="${esc(route?.name || '')}" required placeholder="例如：主线路"></label><label><span><i>*</i>线路地址</span><input id="route-url" type="url" maxlength="2048" value="${esc(route?.url || '')}" required placeholder="https://线路域名/api"></label><label><span>聊天地址</span><input id="route-ws-url" type="url" maxlength="2048" value="${esc(route?.ws_url || '')}" placeholder="留空按 API 域名生成 /ws"></label><label><span>附件地址</span><input id="route-media-url" type="url" maxlength="2048" value="${esc(route?.media_url || '')}" placeholder="留空按 API 域名生成 /storage"></label><label><span>排序</span><div class="batch-number-control"><button type="button" id="route-sort-minus">−</button><input id="route-sort" type="number" min="-999999" max="999999" value="${Number(route?.sort || 0)}"><button type="button" id="route-sort-plus">＋</button></div></label><label><span>状态</span><select id="route-status"><option value="enabled" ${route?.status !== 'disabled' ? 'selected' : ''}>启用</option><option value="disabled" ${route?.status === 'disabled' ? 'selected' : ''}>停用</option></select></label><p id="route-feedback" class="user-edit-feedback"></p><div class="user-modal-actions"><button class="primary" id="route-submit" type="submit">确定</button><button class="modal-cancel" id="route-cancel" type="button">取消</button></div></form></section>`;
  document.body.appendChild(modal);
  const close = () => modal.remove(); $('route-modal-close').onclick = close; $('route-cancel').onclick = close; modal.onclick = (event) => { if (event.target === modal) close(); };
  $('route-sort-minus').onclick = () => { $('route-sort').value = Number($('route-sort').value || 0) - 1; }; $('route-sort-plus').onclick = () => { $('route-sort').value = Number($('route-sort').value || 0) + 1; };
  $('route-form').onsubmit = async (event) => { event.preventDefault(); const submit = $('route-submit'); const feedback = $('route-feedback'); submit.disabled = true; feedback.textContent = '正在保存...'; try { await api('/admin/client-routes', { method: 'POST', body: JSON.stringify({ id: route?.id || 0, name: $('route-name').value.trim(), url: $('route-url').value.trim(), ws_url: $('route-ws-url').value.trim(), media_url: $('route-media-url').value.trim(), sort: Number($('route-sort').value || 0), status: $('route-status').value, request_id: `client-route-${Date.now()}` }) }); close(); await loadRoutes(); } catch (error) { feedback.textContent = error.message; submit.disabled = false; } };
}

async function loadRoutes() {
  const filters = state.routeFilters || {}; const params = new URLSearchParams({ page: page('routes'), size: 20, name: filters.name || '', status: filters.status || '' });
  const data = await api(`/admin/client-routes?${params.toString()}`);
  $('app').innerHTML = `<div class="page-title"><div><div class="title-eyebrow">三方配置</div><h2>线路管理</h2><p>接口、聊天和附件随线路一起切换。只启用已部署并验收的入口；排序值越小越靠前。</p></div></div><section class="panel data-panel route-management"><div class="toolbar route-toolbar"><div class="route-filters"><input id="route-search" value="${esc(filters.name || '')}" placeholder="搜索线路名称"><select id="route-status-filter"><option value="">全部状态</option><option value="enabled" ${filters.status === 'enabled' ? 'selected' : ''}>启用</option><option value="disabled" ${filters.status === 'disabled' ? 'selected' : ''}>停用</option></select><button class="primary small-button" id="route-search-button">搜索</button><button class="table-action" id="route-reset-button">重置</button></div><div class="route-actions"><button class="primary small-button" id="route-create-button">＋ 新增</button><button class="table-action danger" id="route-batch-delete">批量删除</button></div></div><div class="table-wrap route-table-wrap"><table class="route-table"><thead><tr><th class="check-col"><input id="route-select-all" type="checkbox" aria-label="全选"></th><th>ID</th><th>线路名称</th><th>接口 / 聊天 / 附件</th><th>排序</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${data.items.map((item) => `<tr><td><input class="route-check" type="checkbox" value="${item.id}"></td><td>${item.id}</td><td><b>${esc(item.name)}</b></td><td class="route-url-cell" title="${esc(item.url)}">${esc(item.url)}<small class="route-endpoint-detail">${esc(item.ws_url || '按 API 域名生成聊天地址')}</small><small class="route-endpoint-detail">${esc(item.media_url || '按 API 域名生成附件地址')}</small>${item.valid_for_failover === false ? '<small class="route-invalid">请编辑为有效的 HTTPS 线路</small>' : ''}</td><td>${item.sort}</td><td><span class="status ${item.status === 'enabled' ? 'active' : ''}">${item.status === 'enabled' ? '启用' : '停用'}</span></td><td>${esc(item.updated_at || '-')}</td><td><button class="table-action" data-route-edit="${item.id}">编辑</button><button class="table-action danger" data-route-delete="${item.id}">删除</button></td></tr>`).join('') || '<tr><td colspan="8" class="no-data">暂无线路数据</td></tr>'}</tbody></table></div>${pager(data, 'routes')}</section>`;
  $('route-search-button').onclick = () => { state.pages.routes = 1; state.routeFilters = { name: $('route-search').value.trim(), status: $('route-status-filter').value }; return loadRoutes(); };
  $('route-reset-button').onclick = () => { state.pages.routes = 1; state.routeFilters = {}; return loadRoutes(); };
  $('route-create-button').onclick = () => openRouteModal();
  $('route-select-all').onclick = (event) => document.querySelectorAll('.route-check').forEach((check) => { check.checked = event.target.checked; });
  document.querySelectorAll('[data-route-edit]').forEach((button) => button.onclick = () => openRouteModal(data.items.find((item) => item.id === Number(button.dataset.routeEdit))));
  document.querySelectorAll('[data-route-delete]').forEach((button) => button.onclick = async () => { if (!confirm('确定删除这条线路吗？')) return; button.disabled = true; try { await api('/admin/client-routes/delete', { method: 'POST', body: JSON.stringify({ ids: [Number(button.dataset.routeDelete)], request_id: `client-route-delete-${Date.now()}` }) }); await loadRoutes(); } catch (error) { alert(error.message); button.disabled = false; } });
  $('route-batch-delete').onclick = async () => { const ids = [...document.querySelectorAll('.route-check:checked')].map((item) => Number(item.value)); if (!ids.length) { alert('请先选择线路。'); return; } if (!confirm(`确定删除选中的 ${ids.length} 条线路吗？`)) return; try { await api('/admin/client-routes/delete', { method: 'POST', body: JSON.stringify({ ids, request_id: `client-route-delete-${Date.now()}` }) }); await loadRoutes(); } catch (error) { alert(error.message); } };
  bindPager('routes', loadRoutes);
}

function workStatusLabel(status) { return ({ in_progress: '进行中', pending_review: '待批改', reviewed: '已完成', available: '可开始', not_started: '未开始' }[status] || '未知'); }
function workStatusClass(status) { return status === 'reviewed' ? 'active' : status === 'pending_review' ? 'pending' : status === 'in_progress' ? 'working' : ''; }
function employeeLabel(type) { return type === 'formal' ? '正式员工' : '实习员工'; }
function formatWorkDuration(seconds) { const value = Math.max(0, Number(seconds || 0)); const hours = Math.floor(value / 3600); const minutes = Math.floor((value % 3600) / 60); const secs = value % 60; return hours ? `${hours}小时${minutes}分${secs}秒` : `${minutes}分${secs}秒`; }
function workDateTime(value) { return value ? String(value).replace('T', ' ') : '-'; }
function workOpenStatusClass(status) { return status === 'open' ? 'active' : status === 'disabled' ? 'frozen' : 'pending'; }
function workActionIcon(name) {
  const paths = {
    edit: '<path d="M4 17.25V20h2.75L18.81 7.94a1.8 1.8 0 0 0 0-2.54l-.21-.21a1.8 1.8 0 0 0-2.54 0L4 17.25Z"></path><path d="m14.5 6.5 3 3"></path>',
    toggle: '<circle cx="12" cy="12" r="8.25"></circle><path d="M8.5 12h7"></path>',
    code: '<rect x="4" y="4" width="6" height="6" rx=".7"></rect><rect x="14" y="4" width="6" height="6" rx=".7"></rect><rect x="4" y="14" width="6" height="6" rx=".7"></rect><path d="M14 14h2v2h-2zM18 14h2v6h-6v-2h4z"></path>',
    delete: '<path d="M5 7h14"></path><path d="M10 11v5M14 11v5"></path><path d="m9 7 .7-2h4.6l.7 2M7 7l.7 13h8.6L17 7"></path>'
  };
  return `<svg class="work-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || ''}</svg>`;
}
function beijingDateParts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
function localDateValue() { const { year, month, day } = beijingDateParts(); return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
function millisecondsUntilBeijingMidnight() { const { year, month, day } = beijingDateParts(); const nextMidnightUtc = Date.UTC(year, month - 1, day + 1) - (8 * 60 * 60 * 1000); return Math.max(1000, nextMidnightUtc - Date.now() + 250); }

async function loadTaskConfig() {
  const filters = state.taskFilters || {};
  const query = new URLSearchParams({ page: page('task-config'), size: 20, key: filters.key || '', name: filters.name || '', status: filters.status || '' });
  const data = await api(`/admin/work-tasks?${query.toString()}`);
  $('app').innerHTML = `<div class="page-title"><div><div class="title-eyebrow">任务批改管理</div><h2>任务配置</h2><p>配置移动端任务开放时间、题目数量和员工单价</p></div></div><section class="panel data-panel work-admin-panel"><div class="toolbar work-toolbar"><div class="work-filters"><input id="work-task-key" value="${esc(filters.key || '')}" placeholder="任务键"><input id="work-task-name" value="${esc(filters.name || '')}" placeholder="任务名称"><select id="work-task-status"><option value="">全部状态</option><option value="enabled" ${filters.status === 'enabled' ? 'selected' : ''}>启用</option><option value="disabled" ${filters.status === 'disabled' ? 'selected' : ''}>禁用</option></select><button class="primary small-button" id="work-task-search">⌕ 搜索</button><button class="table-action reset-action" id="work-task-reset">↻ 重置</button></div><div class="work-actions"><button class="primary small-button" id="work-task-create">＋ 新增</button></div></div><div class="work-table-caption"><strong>任务列表</strong><span>每天首次开始任务时按北京时间生成一套题目，当天共用。当天已有题目时，新题数从次日生效；历史作业保留原题目和单价。</span></div><div class="table-wrap work-table-wrap"><table class="work-table task-config-table"><thead><tr><th>任务ID</th><th>任务键</th><th>任务名称</th><th>开放时间</th><th>预计用时(分钟)</th><th>实习单价</th><th>正式单价</th><th>题目数量</th><th>状态</th><th>开放状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${data.items.map((item) => `<tr><td>${item.id}</td><td><code>${esc(item.task_key)}</code></td><td class="task-name-cell"><b>${esc(item.name)}</b><small class="table-subtext">${esc(item.description || '暂无任务描述')}</small></td><td>${esc(item.open_time)}</td><td>${item.estimated_minutes}</td><td>${Number(item.intern_unit_price).toFixed(3)}</td><td>${Number(item.formal_unit_price).toFixed(3)}</td><td>${item.question_count}（${item.question_count % 2 === 0 ? `${item.question_count / 2} 对 / ${item.question_count / 2} 错` : '必须为偶数'}）${item.today_question_count && Number(item.today_question_count) !== Number(item.question_count) ? `<small class="table-subtext">今日 ${Number(item.today_question_count)} 题；新题数 ${esc(item.question_count_effective_from || '次日')} 生效</small>` : ''}</td><td><span class="status ${item.status === 'enabled' ? 'active' : 'frozen'}">${item.status === 'enabled' ? '启用' : '禁用'}</span></td><td><span class="status ${workOpenStatusClass(item.open_status)}">${esc(item.open_status_label || '未开放')}</span></td><td>${esc(item.created_at || '-')}</td><td class="work-actions-cell"><button class="table-action edit-action" data-work-edit="${item.id}">${workActionIcon('edit')}<span>修改</span></button><button class="table-action toggle-action ${item.status === 'enabled' ? 'disable-action' : 'enable-action'}" data-work-toggle="${item.id}" data-work-status="${item.status}">${workActionIcon('toggle')}<span>${item.status === 'enabled' ? '禁用' : '启用'}</span></button><button class="table-action code-action" data-work-code="${item.id}">${workActionIcon('code')}<span>验证码</span></button><button class="table-action danger" data-work-delete="${item.id}">${workActionIcon('delete')}<span>删除</span></button></td></tr>`).join('') || '<tr><td colspan="12" class="no-data">暂无任务配置</td></tr>'}</tbody></table></div>${pager(data, 'task-config')}</section>`;
  $('work-task-search').onclick = () => { state.pages['task-config'] = 1; state.taskFilters = { key: $('work-task-key').value.trim(), name: $('work-task-name').value.trim(), status: $('work-task-status').value }; return loadTaskConfig(); };
  $('work-task-reset').onclick = () => { state.pages['task-config'] = 1; state.taskFilters = {}; return loadTaskConfig(); };
  $('work-task-create').onclick = () => openWorkTaskModal();
  document.querySelectorAll('[data-work-edit]').forEach((button) => button.onclick = () => openWorkTaskModal(data.items.find((item) => item.id === Number(button.dataset.workEdit))));
  document.querySelectorAll('[data-work-code]').forEach((button) => button.onclick = () => showWorkTaskCode(Number(button.dataset.workCode)));
  document.querySelectorAll('[data-work-toggle]').forEach((button) => button.onclick = async () => { const id = Number(button.dataset.workToggle); const next = button.dataset.workStatus === 'enabled' ? 'disabled' : 'enabled'; const label = next === 'enabled' ? '启用' : '禁用'; if (!confirm(`确定要${label}这项任务吗？`)) return; button.disabled = true; try { await api('/admin/work-tasks/status', { method: 'POST', body: JSON.stringify({ id, status: next, request_id: `work-status-${Date.now()}` }) }); await loadTaskConfig(); } catch (error) { button.disabled = false; alert(error.message); } });
  document.querySelectorAll('[data-work-delete]').forEach((button) => button.onclick = async () => { if (!confirm('确定删除这项任务吗？已有作业记录的任务只能停用。')) return; try { await api('/admin/work-tasks/delete', { method: 'POST', body: JSON.stringify({ ids: [Number(button.dataset.workDelete)], request_id: `work-delete-${Date.now()}` }) }); await loadTaskConfig(); } catch (error) { alert(error.message); } });
  bindPager('task-config', loadTaskConfig);
}

function openWorkTaskModal(task = null) {
  document.getElementById('work-task-modal')?.remove();
  const modal = document.createElement('div'); modal.id = 'work-task-modal'; modal.className = 'user-modal-backdrop';
  modal.innerHTML = `<section class="user-modal work-modal" role="dialog" aria-modal="true"><button class="user-modal-close" id="work-task-close" type="button">×</button><div class="modal-kicker">任务批改管理</div><h2>${task ? '编辑任务' : '新增任务'}</h2><form id="work-task-form" class="work-form"><div class="work-form-grid"><label><span><i>*</i>任务键</span><input id="work-task-key-value" maxlength="64" value="${esc(task?.task_key || '')}" ${task ? 'readonly' : ''} required placeholder="例如：work_demo"></label><label><span><i>*</i>任务名称</span><input id="work-task-name-value" maxlength="120" value="${esc(task?.name || '')}" required placeholder="例如：线上批改题"></label><label><span><i>*</i>开放时间</span><input id="work-task-open-time" type="time" value="${esc((task?.open_time || '09:00:00').slice(0, 5))}" required></label><label><span><i>*</i>预计用时（分钟）</span><input id="work-task-estimated" type="number" min="1" max="1440" value="${Number(task?.estimated_minutes || 20)}" required></label><label><span>实习员工单价</span><input id="work-task-intern-price" type="number" min="0" max="100000" step="0.001" value="${Number(task?.intern_unit_price || 0).toFixed(3)}" required></label><label><span>正式员工单价</span><input id="work-task-formal-price" type="number" min="0" max="100000" step="0.001" value="${Number(task?.formal_unit_price || 0).toFixed(3)}" required></label><label><span><i>*</i>题目数量</span><input id="work-task-question-count" type="number" min="2" max="1000" step="2" value="${Number(task?.question_count || 20)}" required><small class="table-subtext">必须填写偶数，正确题和错误题各一半。当天已有题目批次时，新题数次日生效；已开始的作业保持原题数。</small></label><label><span>排序值</span><input id="work-task-sort" type="number" value="${Number(task?.sort_order || 0)}"></label><label><span>状态</span><select id="work-task-status-value"><option value="enabled" ${task?.status !== 'disabled' ? 'selected' : ''}>启用</option><option value="disabled" ${task?.status === 'disabled' ? 'selected' : ''}>停用</option></select></label></div><label class="work-form-full"><span>任务描述</span><textarea id="work-task-description" maxlength="5000" rows="5" placeholder="填写手机端显示的任务说明">${esc(task?.description || '')}</textarea></label><p id="work-task-feedback" class="user-edit-feedback"></p><div class="user-modal-actions"><button class="primary" id="work-task-submit" type="submit">保存任务</button><button class="modal-cancel" id="work-task-cancel" type="button">取消</button></div></form></section>`;
  document.body.appendChild(modal);
  const close = () => modal.remove(); $('work-task-close').onclick = close; $('work-task-cancel').onclick = close; modal.onclick = (event) => { if (event.target === modal) close(); };
  $('work-task-form').onsubmit = async (event) => { event.preventDefault(); const button = $('work-task-submit'); const feedback = $('work-task-feedback'); button.disabled = true; feedback.textContent = '正在保存…'; try { await api('/admin/work-tasks', { method: 'POST', body: JSON.stringify({ id: task?.id || 0, task_key: $('work-task-key-value').value.trim(), name: $('work-task-name-value').value.trim(), open_time: $('work-task-open-time').value, estimated_minutes: Number($('work-task-estimated').value), description: $('work-task-description').value, intern_unit_price: $('work-task-intern-price').value, formal_unit_price: $('work-task-formal-price').value, question_count: Number($('work-task-question-count').value), sort_order: Number($('work-task-sort').value || 0), status: $('work-task-status-value').value, request_id: `work-save-${Date.now()}` }) }); close(); await loadTaskConfig(); } catch (error) { feedback.textContent = error.message; button.disabled = false; } };
}

async function showWorkTaskCode(taskId) {
  document.getElementById('work-task-code-modal')?.remove();
  const modal = document.createElement('div'); modal.id = 'work-task-code-modal'; modal.className = 'user-modal-backdrop';
  modal.innerHTML = `<section class="user-modal work-code-modal" role="dialog" aria-modal="true"><button class="user-modal-close" id="work-code-close" type="button">×</button><h2>每日任务验证码</h2><div class="work-code-task"><span>任务名称</span><b id="work-code-task-name">正在读取…</b></div><label class="work-code-date"><span>日期</span><input id="work-code-date" type="date" value="${localDateValue()}"></label><div class="work-code-line"><span>验证码</span><strong id="work-code-value">未生成</strong></div><p id="work-code-feedback" class="work-code-feedback">验证码将在 2 秒后显示</p><div class="work-code-actions"><button class="modal-cancel" id="work-code-cancel" type="button">关闭</button><button class="primary" id="work-code-refresh" type="button">重新生成</button></div></section>`;
  document.body.appendChild(modal);
  let closed = false; let loading = false; let delayedLoadTimer = null; let rolloverTimer = null; let manualDate = false;
  const close = () => { closed = true; clearTimeout(delayedLoadTimer); clearTimeout(rolloverTimer); modal.remove(); };
  $('work-code-close').onclick = close; $('work-code-cancel').onclick = close; modal.onclick = event => { if (event.target === modal) close(); };
  const load = async (forceRegenerate = false) => {
    if (closed || loading) return; loading = true;
    const date = $('work-code-date').value || localDateValue(); $('work-code-value').textContent = '生成中…';
    try { const data = await api(`/admin/work-tasks/code?task_id=${taskId}&date=${encodeURIComponent(date)}${forceRegenerate ? '&regenerate=1' : ''}`); if (!closed) { $('work-code-task-name').textContent = data.task_name; $('work-code-value').textContent = data.code; $('work-code-feedback').textContent = data.regenerated ? `已生成 ${data.date} 的新验证码` : `已同步 ${data.date} 的每日验证码`; } }
    catch (error) { if (!closed) { $('work-code-value').textContent = '获取失败'; $('work-code-feedback').textContent = error.message; } }
    finally { loading = false; }
  };
  const loadNow = (forceRegenerate = false) => { clearTimeout(delayedLoadTimer); delayedLoadTimer = null; load(forceRegenerate); };
  const scheduleBeijingRollover = () => {
    clearTimeout(rolloverTimer);
    rolloverTimer = setTimeout(() => {
      if (closed) return;
      const today = localDateValue();
      const dateInput = $('work-code-date');
      if (!manualDate && dateInput && dateInput.value !== today) { dateInput.value = today; load(); }
      scheduleBeijingRollover();
    }, millisecondsUntilBeijingMidnight());
  };
  const loadAfterOpening = () => {
    $('work-code-feedback').textContent = '验证码将在 2 秒后显示';
    delayedLoadTimer = setTimeout(() => { delayedLoadTimer = null; load(); }, 2000);
  };
  $('work-code-date').onchange = () => { manualDate = $('work-code-date').value !== localDateValue(); loadNow(); };
  $('work-code-refresh').onclick = () => loadNow(true);
  loadAfterOpening();
  scheduleBeijingRollover();
}

async function loadQuestionBank() {
  const filters = state.questionFilters || {}; const query = new URLSearchParams({ page: page('question-bank'), size: 20, uuid: filters.uuid || '', answer: filters.answer || '' });
  const data = await api(`/admin/work-questions?${query.toString()}`);
  $('app').innerHTML = `<div class="page-title"><div><div class="title-eyebrow">任务批改管理</div><h2>题库管理</h2><p>支持单题维护，也可以直接导入 Excel 或 CSV 题库</p></div></div><section class="panel data-panel work-admin-panel"><div class="toolbar work-toolbar"><div class="work-filters"><input id="question-search" value="${esc(filters.uuid || '')}" placeholder="搜索题目 UUID"><select id="question-answer"><option value="">全部答案</option><option value="1" ${filters.answer === '1' ? 'selected' : ''}>对</option><option value="0" ${filters.answer === '0' ? 'selected' : ''}>错</option></select><button class="primary small-button" id="question-search-button">搜索</button><button class="table-action" id="question-reset-button">重置</button></div><div class="work-actions"><button class="primary small-button" id="question-create-button">＋ 新增题目</button><button class="table-action" id="question-import-button">导入 Excel/CSV</button><button class="table-action" id="question-export-button">导出题库</button><button class="table-action" id="question-template-button">下载模板</button><button class="table-action" id="question-refresh-button">刷新题库</button><input id="question-import-file" type="file" accept=".xlsx,.xls,.csv" hidden></div></div><div class="work-table-caption"><strong>题库列表</strong><span>Excel 列名支持：题目UUID、图片地址、正确答案</span></div><div class="table-wrap work-table-wrap"><table class="work-table question-table"><thead><tr><th>ID</th><th>题目 UUID</th><th>题目图片</th><th>正确答案</th><th>创建时间</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${data.items.map((item) => `<tr><td>${item.id}</td><td><code>${esc(item.question_uuid)}</code></td><td>${item.image_url ? `<img class="question-thumb" src="${esc(PulseGoAdmin.mediaURL(item.image_url))}" alt="题目图片">` : '<span class="muted-action">无图片</span>'}</td><td><span class="answer-pill ${item.correct_answer ? 'answer-yes' : 'answer-no'}">${item.correct_answer ? '对' : '错'}</span></td><td>${esc(item.created_at || '-')}</td><td>${esc(item.updated_at || '-')}</td><td><button class="table-action" data-question-edit="${item.id}">修改</button><button class="table-action danger" data-question-delete="${item.id}">删除</button></td></tr>`).join('') || '<tr><td colspan="7" class="no-data">暂无题目，请先导入题库</td></tr>'}</tbody></table></div>${pager(data, 'question-bank')}</section>`;
  $('question-search-button').onclick = () => { state.pages['question-bank'] = 1; state.questionFilters = { uuid: $('question-search').value.trim(), answer: $('question-answer').value }; return loadQuestionBank(); };
  $('question-reset-button').onclick = () => { state.pages['question-bank'] = 1; state.questionFilters = {}; return loadQuestionBank(); };
  $('question-create-button').onclick = () => openWorkQuestionModal();
  $('question-import-button').onclick = () => $('question-import-file').click();
  $('question-import-file').onchange = async () => { const file = $('question-import-file').files[0]; if (!file) return; const form = new FormData(); form.append('file', file); try { const result = await adminMultipart('/admin/work-questions/import', form); alert(`导入完成：新增 ${result.created} 条，更新 ${result.updated} 条${result.errors?.length ? `，失败 ${result.errors.length} 条\n${result.errors.slice(0, 20).map(item => `第${item.row}行：${item.message}`).join('\n')}` : ''}`); await loadQuestionBank(); } catch (error) { alert(error.message); } finally { if ($('question-import-file')) $('question-import-file').value = ''; } };
  $('question-export-button').onclick = () => downloadWorkFile(`/admin/work-questions/export?${query.toString()}`, '题库.xlsx');
  $('question-template-button').onclick = () => downloadWorkFile('/admin/work-questions/template', '题库导入模板.xlsx');
  $('question-refresh-button').onclick = () => loadQuestionBank();
  document.querySelectorAll('[data-question-edit]').forEach((button) => button.onclick = () => openWorkQuestionModal(data.items.find((item) => item.id === Number(button.dataset.questionEdit))));
  document.querySelectorAll('[data-question-delete]').forEach((button) => button.onclick = async () => { if (!confirm('确定删除这道题吗？')) return; try { await api('/admin/work-questions/delete', { method: 'POST', body: JSON.stringify({ ids: [Number(button.dataset.questionDelete)], request_id: `question-delete-${Date.now()}` }) }); await loadQuestionBank(); } catch (error) { alert(error.message); } });
  bindPager('question-bank', loadQuestionBank);
}

async function adminMultipart(path, body) { assertAdminApiAccess(path, 'POST'); return PulseGoAdmin.upload(path, body); }
async function downloadWorkFile(path, filename) {
  try {
    assertAdminApiAccess(path, 'GET');
    const response = await PulseGoAdmin.download(path);
    if (!response.ok) { await adminResponseData(response, '下载失败', path); }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { alert(error.message); }
}
function downloadWorkCsv(filename, rows) { const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n'); const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }

function openWorkQuestionModal(question = null) {
  document.getElementById('work-question-modal')?.remove(); const modal = document.createElement('div'); modal.id = 'work-question-modal'; modal.className = 'user-modal-backdrop';
  modal.innerHTML = `<section class="user-modal work-modal" role="dialog" aria-modal="true"><button class="user-modal-close" id="work-question-close" type="button">×</button><div class="modal-kicker">题库管理</div><h2>${question ? '修改题目' : '新增题目'}</h2><form id="work-question-form" class="work-form"><label><span>题目 UUID</span><input id="question-uuid-value" maxlength="36" value="${esc(question?.question_uuid || '')}" ${question ? 'readonly' : ''} placeholder="留空自动生成"></label><label><span>图片地址</span><input id="question-image-value" maxlength="2048" value="${esc(question?.image_url || '')}" placeholder="输入图片 URL 或选择本地图片"></label><label class="question-file-field"><span>上传图片</span><input id="question-image-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp"><small>支持 JPG、PNG、GIF、WEBP，最大 10MB</small></label><label><span><i>*</i>正确答案</span><select id="question-answer-value" required><option value="1" ${question?.correct_answer ? 'selected' : ''}>对</option><option value="0" ${question && !question.correct_answer ? 'selected' : ''}>错</option></select></label><div id="question-image-preview" class="question-modal-preview">${question?.image_url ? `<img src="${esc(PulseGoAdmin.mediaURL(question.image_url))}" alt="题目预览">` : '<span>暂无图片预览</span>'}</div><p id="work-question-feedback" class="user-edit-feedback"></p><div class="user-modal-actions"><button class="primary" id="work-question-submit" type="submit">保存题目</button><button class="modal-cancel" id="work-question-cancel" type="button">取消</button></div></form></section>`;
  document.body.appendChild(modal); const close = () => modal.remove(); $('work-question-close').onclick = close; $('work-question-cancel').onclick = close; modal.onclick = (event) => { if (event.target === modal) close(); };
  $('question-image-file').onchange = () => { const file = $('question-image-file').files[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { $('question-image-preview').innerHTML = `<img src="${reader.result}" alt="题目预览">`; }; reader.readAsDataURL(file); };
  $('work-question-form').onsubmit = async (event) => { event.preventDefault(); const submit = $('work-question-submit'); const feedback = $('work-question-feedback'); submit.disabled = true; feedback.textContent = '正在保存…'; try { let imageUrl = $('question-image-value').value.trim(); const file = $('question-image-file').files[0]; if (file) { const form = new FormData(); form.append('file', file); const uploaded = await adminMultipart('/admin/work-questions/upload', form); imageUrl = uploaded.url; } await api('/admin/work-questions', { method: 'POST', body: JSON.stringify({ id: question?.id || 0, question_uuid: $('question-uuid-value').value.trim(), image_url: imageUrl, correct_answer: $('question-answer-value').value, request_id: `question-save-${Date.now()}` }) }); close(); await loadQuestionBank(); } catch (error) { feedback.textContent = error.message; submit.disabled = false; } };
}

async function loadTaskRecords() { return window.AdminWorkRecords.load(); }

async function openWorkRecordDetail(recordId) { return window.AdminWorkRecords.open(recordId); }

function adminAccountRole(role) { return { admin: '超级管理员', operator: '自定义权限账号', auditor: '只读账号' }[role] || role; }
function accountPermissionSummary(account) {
  if (isSuperAdmin(account)) return '全部页面 · 全部操作';
  const readable = adminPageCatalog.filter(page => accountCan(account, page.key));
  if (!readable.length) return '尚未分配页面';
  return readable.map(page => `${page.title}${accountCan(account, page.key, 'manage') ? '（操作）' : '（只读）'}`).join('、');
}
async function loadAdminAccounts() {
  const filters = state.adminAccountFilters || {};
  const params = new URLSearchParams({ page: page('admin-accounts'), size: 20, q: filters.q || '', status: filters.status || '' });
  const [data, catalog] = await Promise.all([api(`/admin/accounts?${params}`), api('/admin/accounts/permissions')]);
  state.adminAccountCatalog = catalog.items; state.adminAccountItems = data.items;
  $('app').innerHTML = `<section class="panel data-panel admin-account-panel"><form class="toolbar admin-account-filters" id="admin-account-filter-form"><input id="admin-account-search" maxlength="64" value="${esc(filters.q || '')}" placeholder="搜索管理员账号" aria-label="搜索管理员账号"><select id="admin-account-status-filter" aria-label="账号状态"><option value="">全部状态</option><option value="active" ${filters.status === 'active' ? 'selected' : ''}>已启用</option><option value="disabled" ${filters.status === 'disabled' ? 'selected' : ''}>已停用</option></select><button class="table-action" type="submit">搜索</button><button class="table-action" id="admin-account-filter-reset" type="button">重置</button><button class="primary small-button admin-account-create" id="admin-account-new" type="button">＋ 新增账号</button></form><p class="admin-account-login-note">只有已添加并启用的后台账号可以登录后台，普通用户账号不能用于后台登录。</p><div class="table-wrap"><table class="admin-account-table"><thead><tr><th>编号</th><th>账号</th><th>角色</th><th>页面权限</th><th>状态</th><th>创建时间</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${data.items.map(account => {
    const own = Number(account.id) === Number(state.admin.id);
    return `<tr><td>${Number(account.id)}</td><td><strong>${esc(account.username)}</strong>${own ? '<small class="admin-own-label">当前账号</small>' : ''}</td><td>${esc(adminAccountRole(account.role))}</td><td class="admin-permission-summary">${esc(accountPermissionSummary(account))}</td><td><span class="status ${account.status === 'active' ? 'active' : 'frozen'}">${account.status === 'active' ? '已启用' : '已停用'}</span></td><td>${esc(account.created_at || '-')}</td><td>${esc(account.updated_at || '-')}</td><td><button class="table-action" type="button" data-admin-account-edit="${Number(account.id)}">编辑／重置密码</button><button class="table-action ${account.status === 'active' ? 'danger' : ''}" type="button" data-admin-account-status="${Number(account.id)}" ${own ? 'disabled title="不能停用当前登录账号"' : ''}>${account.status === 'active' ? '停用' : '启用'}</button></td></tr>`;
  }).join('') || '<tr><td colspan="8" class="no-data">没有找到后台账号</td></tr>'}</tbody></table></div>${pager(data, 'admin-accounts')}</section>`;
  $('admin-account-new').onclick = () => openAdminAccountModal();
  $('admin-account-filter-form').onsubmit = event => { event.preventDefault(); state.adminAccountFilters = { q: $('admin-account-search').value.trim(), status: $('admin-account-status-filter').value }; state.pages['admin-accounts'] = 1; return loadAdminAccounts(); };
  $('admin-account-filter-reset').onclick = () => { state.adminAccountFilters = {}; state.pages['admin-accounts'] = 1; return loadAdminAccounts(); };
  document.querySelectorAll('[data-admin-account-edit]').forEach(button => { button.onclick = () => openAdminAccountModal(data.items.find(account => Number(account.id) === Number(button.dataset.adminAccountEdit))); });
  document.querySelectorAll('[data-admin-account-status]').forEach(button => { button.onclick = () => setAdminAccountStatus(data.items.find(account => Number(account.id) === Number(button.dataset.adminAccountStatus))); });
  bindPager('admin-accounts', loadAdminAccounts);
}
function setPermissionSelection(root, catalog, mode, role) {
  root.querySelectorAll('[data-admin-permission]').forEach(input => { input.checked = mode === 'all' || (mode === 'read-only' && input.dataset.adminPermission.endsWith('.view')); });
  syncAdminAccountPermissionGrid(root, catalog, role);
}
function syncAdminAccountPermissionGrid(root, catalog, role) {
  const superAdmin = role === 'admin'; const readOnly = role === 'auditor';
  for (const item of catalog) {
    const view = root.querySelector(`[data-admin-permission="${item.view}"]`);
    const manage = item.manage && root.querySelector(`[data-admin-permission="${item.manage}"]`);
    if (view) { view.disabled = superAdmin; if (superAdmin) view.checked = true; }
    if (manage) { manage.disabled = superAdmin || readOnly; if (superAdmin) manage.checked = true; else if (readOnly) manage.checked = false; if (manage.checked && view) view.checked = true; }
  }
  root.querySelectorAll('[data-permission-selection]').forEach(button => { button.disabled = superAdmin; });
  const note = root.querySelector('#admin-account-permission-note');
  if (note) note.textContent = superAdmin ? '超级管理员拥有全部页面和操作权限，并可管理后台账号。' : readOnly ? '审计员仅能查看勾选的页面，不能执行修改操作。' : '勾选“操作”时会自动勾选同一页面的“查看”；后台账号管理仅对超级管理员开放。';
}
function buildAdminAccountPayload(values, account, selected, catalog = adminPageCatalog) {
  const username = String(values.username || '').trim(); const password = String(values.password || '');
  const role = values.role; const status = values.status;
  if (!/^[A-Za-z][A-Za-z0-9_.-]{2,63}$/.test(username)) throw new Error('管理员账号须为3至64位，以字母开头，可包含数字、点、横线或下划线。');
  if ((!account && !password) || (password && (password.length < 14 || password.length > 128))) throw new Error('新建账号必须设置14至128位密码；编辑时留空保持原密码。');
  if (!['admin', 'operator', 'auditor'].includes(role) || !['active', 'disabled'].includes(status)) throw new Error('角色或状态无效');
  if (account && Number(account.id) === Number(state.admin?.id) && (role !== account.role || status !== 'active')) throw new Error('不能降级或停用当前登录账号');
  return { ...(account ? { id: Number(account.id) } : {}), username, password, role, status, permissions: role === 'admin' ? [] : normalizedAccountPermissions(selected, catalog, role === 'auditor') };
}
function openAdminAccountModal(account = null) {
  if (!isSuperAdmin()) { notify('只有超级管理员能管理后台账号', 'error'); return; }
  $('admin-account-modal')?.remove();
  const catalog = state.adminAccountCatalog || adminPageCatalog; const chosen = new Set(account?.permissions || []);
  const own = account && Number(account.id) === Number(state.admin.id);
  const role = account?.role || 'operator'; const modal = document.createElement('div'); modal.id = 'admin-account-modal'; modal.className = 'user-modal-backdrop admin-account-backdrop';
  modal.innerHTML = `<section class="user-modal admin-account-modal" role="dialog" aria-modal="true" aria-labelledby="admin-account-title"><button class="user-modal-close" id="admin-account-close" type="button" aria-label="关闭">×</button><div class="modal-kicker">后台账号</div><h2 id="admin-account-title">${account ? '编辑后台账号' : '新增后台账号'}</h2><form id="admin-account-form"><div class="admin-account-fields"><label><span>管理员账号</span><input id="admin-account-username" autocomplete="off" minlength="3" maxlength="64" required value="${esc(account?.username || '')}"></label><label><span>${account ? '新密码（留空保持）' : '登录密码'}</span><input id="admin-account-password" type="password" autocomplete="new-password" minlength="14" maxlength="128" ${account ? '' : 'required'} placeholder="${account ? '留空保持原密码；填写即重置' : '至少14位'}"></label><label><span>角色</span><select id="admin-account-role-value" ${own ? 'disabled' : ''}><option value="operator" ${role === 'operator' ? 'selected' : ''}>自定义权限账号</option><option value="admin" ${role === 'admin' ? 'selected' : ''}>超级管理员（全权）</option><option value="auditor" ${role === 'auditor' ? 'selected' : ''}>只读账号</option></select></label><label><span>状态</span><select id="admin-account-status-value" ${own ? 'disabled' : ''}><option value="active" ${account?.status !== 'disabled' ? 'selected' : ''}>启用</option><option value="disabled" ${account?.status === 'disabled' ? 'selected' : ''}>停用</option></select></label></div>${own ? '<p class="admin-account-self-note">正在编辑当前登录账号，角色和启用状态不能更改。重置密码后须重新登录。</p>' : ''}<section class="admin-page-permissions"><div class="admin-permission-heading"><h3>页面权限</h3><div><button class="table-action" type="button" data-permission-selection="all">全选</button><button class="table-action" type="button" data-permission-selection="read-only">全部只读</button><button class="table-action" type="button" data-permission-selection="none">清空</button></div></div><p id="admin-account-permission-note"></p><div class="admin-permission-grid" id="admin-account-permissions"><div class="permission-grid-head"><span>后台页面</span><span>查看</span><span>操作</span></div>${catalog.map(item => `<div class="admin-permission-row"><strong>${esc(item.title)}</strong><label><input type="checkbox" data-admin-permission="${esc(item.view)}" ${chosen.has(item.view) ? 'checked' : ''} aria-label="${esc(item.title)}查看"></label>${item.manage ? `<label><input type="checkbox" data-admin-permission="${esc(item.manage)}" ${chosen.has(item.manage) ? 'checked' : ''} aria-label="${esc(item.title)}操作"></label>` : '<span class="permission-not-applicable">—</span>'}</div>`).join('')}</div></section><p class="user-edit-feedback" id="admin-account-feedback" role="alert"></p><div class="user-modal-actions"><button class="primary" type="submit" id="admin-account-save">保存账号</button><button class="modal-cancel" type="button" id="admin-account-cancel">取消</button></div></form></section>`;
  document.body.appendChild(modal);
  const close = () => modal.remove(); $('admin-account-close').onclick = close; $('admin-account-cancel').onclick = close; modal.onclick = event => { if (event.target === modal) close(); };
  const roleInput = $('admin-account-role-value');
  modal.querySelectorAll('[data-admin-permission]').forEach(input => { input.onchange = () => {
    const item = catalog.find(item => item.view === input.dataset.adminPermission || item.manage === input.dataset.adminPermission);
    if (input.dataset.adminPermission === item?.view && !input.checked && item.manage) modal.querySelector(`[data-admin-permission="${item.manage}"]`).checked = false;
    syncAdminAccountPermissionGrid(modal, catalog, roleInput.value);
  }; });
  modal.querySelectorAll('[data-permission-selection]').forEach(button => { button.onclick = () => setPermissionSelection(modal, catalog, button.dataset.permissionSelection, roleInput.value); });
  roleInput.onchange = () => syncAdminAccountPermissionGrid(modal, catalog, roleInput.value);
  syncAdminAccountPermissionGrid(modal, catalog, role);
  $('admin-account-form').onsubmit = async event => {
    event.preventDefault(); const feedback = $('admin-account-feedback'); const button = $('admin-account-save'); if (button.disabled) return;
    let payload;
    try { payload = buildAdminAccountPayload({ username: $('admin-account-username').value, password: $('admin-account-password').value, role: roleInput.value, status: $('admin-account-status-value').value }, account, [...modal.querySelectorAll('[data-admin-permission]:checked')].map(input => input.dataset.adminPermission), catalog); }
    catch (error) { feedback.textContent = error.message; return; }
    button.disabled = true; feedback.textContent = '正在保存账号…';
    try {
      const saved = await api(account ? '/admin/accounts/update' : '/admin/accounts', { method: 'POST', body: JSON.stringify(payload) });
      $('admin-account-password').value = ''; close(); notify(account ? '后台账号已更新，旧登录会话已撤销' : '后台账号已创建');
      if(saved.entry_token){const entryURL=new URL('/entry/#'+saved.entry_token,location.origin);await navigator.clipboard?.writeText(entryURL.href).catch(()=>{});alert('专属后台入口已生成并尝试复制，请现在保存：\n'+entryURL.href);}
      if (own) { endAdminSession(); return; }
      await loadAdminAccounts();
    } catch (error) { if (feedback.isConnected) { feedback.textContent = error.message; button.disabled = false; } }
  };
}
async function setAdminAccountStatus(account) {
  if (!account || Number(account.id) === Number(state.admin?.id)) { notify('不能停用当前登录账号', 'error'); return; }
  const status = account.status === 'active' ? 'disabled' : 'active';
  if (!confirm(`确定${status === 'disabled' ? '停用' : '启用'}后台账号“${account.username}”吗？${status === 'disabled' ? '既有登录会话会立即失效。' : ''}`)) return;
  await api('/admin/accounts/status', { method: 'POST', body: JSON.stringify({ id: Number(account.id), status }) });
  notify('后台账号状态已更新'); await loadAdminAccounts();
}


// Keep an operation ID after a lost response; retrying must not clear a new binding.
function deviceOperationId(key) {
  const storage = `pulse_device_action_${state.admin.id}_${key}`;
  let id = sessionStorage.getItem(storage);
  if (!id) { id = requestId('device'); sessionStorage.setItem(storage, id); }
  return { id, done: () => sessionStorage.removeItem(storage) };
}
async function loadMobileDevices() {
  const keyword = $('devices-search')?.value ?? state.deviceKeyword ?? '';
  state.deviceKeyword = keyword;
  const data = await api(`/admin/mobile-devices?q=${encodeURIComponent(keyword)}&page=${page('devices')}&size=30`);
  const manage = canPage('devices', 'manage');
  $('app').innerHTML = `<section class="panel data-panel"><div class="panel-head"><div><h3>手机设备锁 <span class="status ${data.enabled ? 'active' : ''}">${data.enabled ? '已启用' : '未启用'}</span></h3><p>${data.enabled ? '普通用户首次登录绑定手机，换手机需后台解绑。' : '当前兼容旧版手机端。安卓和 iOS 新版就绪后再启用设备锁。'} 解绑不影响当前登录；设备锁开启时，以下次成功登录的手机重新绑定。电脑端、网页端可正常使用；内部员工不受手机设备锁限制。</p></div></div><div class="toolbar user-toolbar filter-bar"><form class="user-filters" id="devices-filter"><input id="devices-search" placeholder="用户名、昵称或用户 ID" aria-label="搜索设备账号" maxlength="128" value="${esc(keyword)}"><button class="primary" type="submit">搜索</button></form><div class="user-toolbar-actions"><span class="user-toolbar-tip">当前筛选 ${Number(data.total)} 条 · 全部绑定 ${Number(data.locked_total)} 个</span>${manage ? `<button class="table-action" id="devices-policy">${data.enabled ? '停用设备锁' : '启用设备锁'}</button><button class="table-action danger" id="devices-unbind-all" ${data.locked_total ? '' : 'disabled'}>一键解绑全部</button>` : ''}</div></div><div class="table-wrap"><table><thead><tr><th>绑定 ID</th><th>用户 ID</th><th>用户名</th><th>昵称</th><th>设备标识</th><th>设备型号</th><th>客户端</th><th>绑定时间</th><th>最近登录</th><th>操作</th></tr></thead><tbody>${data.items.map(item => `<tr><td>${Number(item.id)}</td><td>${esc(item.public_id)}</td><td>${esc(item.username || '-')}</td><td>${esc(item.nickname)}</td><td>${esc(item.device_id)}</td><td>${esc(item.device_name || '-')}</td><td>${esc(label(deviceMap, item.platform))}</td><td>${esc(item.bound_at)}</td><td>${esc(item.last_login_at)}</td><td>${manage ? `<button class="table-action danger" data-device-unbind="${Number(item.id)}">解绑</button>` : '仅查看'}</td></tr>`).join('') || '<tr><td colspan="10">暂无绑定的手机设备</td></tr>'}</tbody></table></div>${pager(data, 'devices')}</section>`;
  $('devices-filter').onsubmit = event => { event.preventDefault(); state.pages.devices = 1; return loadMobileDevices(); };
  bindPager('devices', loadMobileDevices);
  const mutate = (key, controls, path, body, success) => withAction('mobile-devices', controls, async () => {
    const operation = deviceOperationId(key);
    const result = await api('/admin/mobile-devices/' + path, { method: 'POST', body: JSON.stringify({ ...body, request_id: operation.id }), timeout: 60000 });
    operation.done(); notify(success(result)); await refreshAfterAction('devices', loadMobileDevices);
  });
  const controls = () => document.querySelectorAll('[data-device-unbind], #devices-policy, #devices-unbind-all');
  document.querySelectorAll('[data-device-unbind]').forEach(button => button.onclick = () => {
    const item = data.items.find(row => Number(row.id) === Number(button.dataset.deviceUnbind));
    if (!canPage('devices', 'manage') || !item || !confirm(`确定解绑 ${item.username || item.nickname} 的手机设备吗？仅清除设备绑定，不会退出当前登录。设备锁开启时，以下次成功登录的手机重新绑定。`)) return;
    return mutate(`unbind_${item.id}`, controls(), 'unbind', { user_id: Number(item.user_id), binding_id: Number(item.id) }, () => '设备已解绑，当前登录保持不变；以下次成功登录的手机重新绑定');
  });
  if ($('devices-unbind-all')) $('devices-unbind-all').onclick = () => {
    if (!canPage('devices', 'manage') || !confirm(`确定解绑全部 ${Number(data.locked_total)} 个手机设备吗？此操作覆盖所有账号，不受当前搜索条件影响。仅清除设备绑定，不会退出当前登录；设备锁开启时，以下次成功登录的手机重新绑定，设备锁开关保持不变。`)) return;
    return mutate('unbind_all', controls(), 'unbind-all', { confirmation: 'UNBIND_ALL' }, result => `已解绑 ${Number(result.unbound_count)} 个手机设备，当前登录保持不变`);
  };
  if ($('devices-policy')) $('devices-policy').onclick = () => {
    const enabled = !data.enabled;
    if (!canPage('devices', 'manage') || !confirm(enabled ? '请确认安卓和 iOS 用户均已更新支持设备标识的新版。启用后，普通用户现有手机登录会失效，重新登录时绑定第一台手机；旧版将无法登录。确定启用？' : '确定停用手机设备锁？停用期间允许普通用户在其他手机登录，已有设备绑定将保留。')) return;
    return mutate(`policy_${enabled}`, controls(), 'policy', { enabled, confirmation: 'CHANGE_DEVICE_POLICY' }, () => enabled ? '设备锁已启用，普通用户需重新登录' : '设备锁已停用');
  };
}

async function renderView() {
  closeUserCreateModal(true);
  closeUserEditModal();
  closeMessagePreview(false); state.messageItems = null;
  const next = authorizedPage();
  if (next !== 'maintenance') globalThis.AdminMaintenance?.close?.();
  if (next !== 'users') closeUserAvatarPreview(false);
  document.body.classList.toggle('dispatch-tasks-view', next === 'dispatch-tasks');
  if (next !== 'dispatch-tasks') globalThis.AdminDispatchTasks?.close?.();
  if (next !== 'task-records') globalThis.AdminWorkRecords?.close?.();
  if (!next) { renderNoAdminPages(); return; }
  state.view = next; history.replaceState(null, '', `#${next}`); filterAuthorizedNavigation();
  document.querySelectorAll('[data-view]').forEach(node => node.classList.toggle('active', node.dataset.view === state.view));
  $('top-title').textContent = titleMap[state.view] || '运营总览';
  const loaders = { maintenance: loadMaintenance, devices: loadMobileDevices, dashboard: loadDashboard, users: loadUsers, groups: loadGroups, messages: loadMessages, moderation: () => loadMessages('moderation'), 'sensitive-words': loadSensitiveWords, announcement: loadAnnouncement, explore: loadExplore, 'client-config': loadClientConfig, routes: loadRoutes, 'task-config': loadTaskConfig, 'question-bank': loadQuestionBank, 'task-records': loadTaskRecords, 'admin-accounts': loadAdminAccounts, 'dispatch-tasks': loadDispatchTasks };
  return (loaders[state.view] || (() => loadLogs(state.view)))();
}

let pageSequence = 0;
function pageLoader(view, loader) {
  return function (...args) {
    const target = typeof view === 'function' ? view(...args) : view;
    // 操作完成后的刷新仅刷新所属页面，不能把用户已切换到的页面覆盖掉。
    if (state.view !== target || !canPage(target)) return Promise.resolve();
    if (activePageLoad?.view === target && activePageLoad.loading) return activePageLoad.promise;
    const app = $('app'); if (!app) return Promise.resolve();
    const sameView = app.dataset.view === target;
    activePageLoad?.controller.abort();
    const context = { id: ++pageSequence, view: target, controller: new AbortController(), loading: true };
    activePageLoad = context;
    app.querySelectorAll('.page-load-error, .page-loading-overlay').forEach(node => node.remove());
    // 先读取现有筛选条件，再显示加载提示；刷新不会丢失搜索词。
    const pending = loader(...args);
    if (!sameView) {
      app.innerHTML = `<section class="panel page-loading" role="status"><span class="admin-spinner" aria-hidden="true"></span><strong>正在加载${esc(titleMap[target] || '页面')}…</strong><p>请稍候，正在获取最新数据</p><div class="loading-skeleton"><i></i><i></i><i></i></div></section>`;
      app.dataset.view = target;
    } else app.insertAdjacentHTML('beforeend', '<div class="page-loading-overlay" role="status"><span class="admin-spinner" aria-hidden="true"></span>正在更新数据…</div>');
    app.setAttribute('aria-busy', 'true'); app.inert = true;
    [$('refresh'), $('top-refresh')].forEach(node => { if (node) { node.disabled = true; node.setAttribute('aria-busy', 'true'); } });
    context.promise = (async () => {
      try { await pending; }
      catch (error) {
        if (cancelled(error) || activePageLoad !== context) return;
        const panel = `<section class="panel data-panel page-load-error" role="alert"><strong>${sameView ? '刷新失败，保留上次数据' : '数据获取失败'}</strong><p>${esc(error.message)}</p><button class="primary" id="page-load-retry">重新加载</button></section>`;
        if (sameView && !app.querySelector('.page-loading')) app.insertAdjacentHTML('afterbegin', panel); else app.innerHTML = panel;
        $('page-load-retry').onclick = renderView;
      } finally {
        context.loading = false;
        if (activePageLoad === context) {
          app.querySelector('.page-loading-overlay')?.remove(); app.setAttribute('aria-busy', 'false'); app.inert = false;
          [$('refresh'), $('top-refresh')].forEach(node => { if (node) { node.disabled = false; node.removeAttribute('aria-busy'); } });
          guardInteractions();
        }
      }
    })();
    return context.promise;
  };
}
function closeUserAvatarPreview(restoreFocus = true) {
  const modal = $('user-avatar-preview');
  if (!modal) return;
  const trigger = modal.avatarTrigger;
  if (modal.open) modal.close();
  modal.remove();
  if (restoreFocus && trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
}

function openUserAvatarPreview(id, trigger) {
  const user = state.userItems?.get(id);
  if (!user?.avatar_url || state.view !== 'users' || !canPage('users')) return;
  closeUserAvatarPreview(false);
  // Native modal focus containment also prevents interacting with the table behind it.
  const modal = document.createElement('dialog');
  modal.id = 'user-avatar-preview'; modal.className = 'user-avatar-preview';
  modal.avatarTrigger = trigger;
  modal.setAttribute('aria-labelledby', 'user-avatar-preview-title');
  modal.innerHTML = `<header class="avatar-preview-header"><div><h2 id="user-avatar-preview-title">头像预览</h2><p id="user-avatar-preview-owner"></p></div><button type="button" class="avatar-preview-close" aria-label="关闭头像预览" autofocus>×</button></header><div class="avatar-preview-stage" aria-busy="true"><img class="avatar-preview-image" alt="" hidden><p class="avatar-preview-feedback" role="status" aria-live="polite">正在加载头像…</p></div><footer class="avatar-preview-footer"><button type="button" class="table-action" id="user-avatar-preview-retry" hidden>重新加载</button><button type="button" class="modal-cancel" id="user-avatar-preview-close">关闭</button></footer>`;
  document.body.appendChild(modal);
  const owner = user.nickname || user.account || `用户 #${user.member_id || id}`;
  modal.querySelector('#user-avatar-preview-owner').textContent = `${owner} · 会员ID ${user.member_id || id}`;
  const image = modal.querySelector('img'), stage = modal.querySelector('.avatar-preview-stage');
  const feedback = modal.querySelector('.avatar-preview-feedback'), retry = modal.querySelector('#user-avatar-preview-retry');
  image.alt = `${owner}的头像`;
  const close = () => closeUserAvatarPreview();
  modal.querySelector('.avatar-preview-close').onclick = close;
  modal.querySelector('#user-avatar-preview-close').onclick = close;
  modal.oncancel = event => { event.preventDefault(); close(); };
  modal.onkeydown = event => {
    if (event.key === 'Escape') { event.stopPropagation(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...modal.querySelectorAll('button:not(:disabled)')].filter(node => !node.hidden && node.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last) || !modal.contains(document.activeElement)) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus();
    }
  };
  modal.onclick = event => {
    const rect = modal.getBoundingClientRect();
    if (event.target === modal && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) close();
  };
  image.onload = () => {
    if (!modal.isConnected) return;
    image.hidden = false; feedback.hidden = true; retry.hidden = true; stage.setAttribute('aria-busy', 'false');
  };
  image.onerror = () => {
    if (!modal.isConnected) return;
    image.hidden = true; feedback.hidden = false; retry.hidden = false; stage.setAttribute('aria-busy', 'false');
    feedback.textContent = '头像加载失败，请重新加载';
  };
  const load = () => {
    image.hidden = true; feedback.hidden = false; feedback.textContent = '正在加载头像…'; retry.hidden = true;
    stage.setAttribute('aria-busy', 'true'); image.removeAttribute('src'); image.src = user.avatar_url;
  };
  retry.onclick = load;
  modal.showModal(); load();
}

// 已删除账号仍保留在后台列表中，但操作按钮必须明确显示为“恢复用户”。
// 统一渲染19列用户信息，保留已删除用户的恢复操作。
function publicUserId(user) {
  const value = user?.public_id;
  return typeof value === 'string' && value.length === 16 && /^[A-Za-z0-9]{16}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value) ? value : '';
}

function userRow(user) {
  const statusText = user.status === 'deleted' ? '恢复用户' : user.status === 'active' ? '正常' : '已冻结';
  return `<tr><td><b>${user.member_id}</b></td><td>${esc(user.account || '-')}<small class="user-public-id" data-user-public-id>${esc(publicUserId(user) || '暂未分配用户ID')}</small></td><td><b>${esc(user.nickname)}</b></td><td>${user.avatar_url ? `<button type="button" class="user-avatar-button" data-user-avatar="${user.id}" aria-label="${esc(`查看${user.nickname || user.account || "用户"}的头像大图`)}" title="点击放大头像"><img class="user-avatar" src="${esc(user.avatar_url)}" alt="头像"></button>` : '<span class="avatar-placeholder" role="img" aria-label="未设置头像" title="未设置头像"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5.5 20v-1.5a6.5 6.5 0 0 1 13 0V20"/></svg></span>'}</td><td>${esc(user.register_ip || '-')}</td><td>${userIpLocationCell(user.register_ip_location, user.register_ip, user.register_ip_location_status, user.register_ip_location_error_code)}</td><td>${esc(user.login_ip || '-')}</td><td>${userIpLocationCell(user.login_ip_location, user.login_ip, user.login_ip_location_status, user.login_ip_location_error_code)}</td><td>${user.login_at ? esc(user.login_at) : '<span title="登录记录尚未生成，用户重新登录后显示">暂无登录记录</span>'}</td><td>${esc(user.registered_at || '-')}</td><td><span class="status ${user.online ? 'active' : ''}">${user.online ? '在线' : '离线'}</span></td><td>${userStatusSwitch(user)}</td><td>${userSwitch(user, 'muted')}</td><td>${userSwitch(user, 'allow_add_friend')}</td><td>${userSwitch(user, 'allow_create_group')}</td><td>${userSwitch(user, 'internal_staff')}</td><td>${userSwitch(user, 'formal_employee')}</td><td>${userSwitch(user, 'allow_view_devices')}</td><td class="user-actions"><button class="table-action" data-user-edit="${user.id}">编辑</button><button class="table-action" data-user-device="${user.id}">设备</button><button class="table-action" data-user-action="clear-chat" data-id="${user.id}">清理聊天</button><button class="table-action" data-user-action="reset-token" data-id="${user.id}">重置令牌</button><button class="table-action danger" data-user-action="logout" data-id="${user.id}">踢下线</button>${user.status === 'deleted' ? '' : `<button class="table-action danger" data-user-action="delete" data-id="${user.id}">删除</button>`}</td></tr>`;
}

async function updateUser(id, action) {
  const actionText = action === 'logout' ? '踢下线' : action === 'clear-chat' ? '清理聊天记录' : action === 'reset-token' ? '重置登录令牌' : action === 'delete' ? '删除用户' : action === 'active' ? '恢复用户' : '冻结';
  return withAction(`user:${id}`, userControls(id), async () => {
    if (!window.confirm(`确定要${actionText}用户 #${id} 吗？`)) return;
    const paths = { logout: '/admin/users/logout', 'clear-chat': '/admin/users/clear-chat', 'reset-token': '/admin/users/reset-token', delete: '/admin/users/delete' };
    const path = paths[action] || '/admin/users/status';
    const body = ['logout', 'clear-chat', 'reset-token', 'delete'].includes(action) ? { user_id: id, request_id: `admin-${Date.now()}` } : { user_id: id, status: action, request_id: `admin-${Date.now()}` };
    const result = await api(path, { method: 'POST', body: JSON.stringify(body) });
    notify(action === 'clear-chat' ? `已清理 ${result.cleared_conversations || 0} 个会话，共隐藏 ${result.hidden_messages || 0} 条聊天记录` : action === 'reset-token' || action === 'logout' ? `操作成功，共撤销 ${result.revoked_tokens || 0} 个登录令牌` : '用户状态已更新');
    await refreshAfterAction('users', loadUsers);
  });
}

loadDashboard = pageLoader('dashboard', loadDashboard);
loadUsers = pageLoader('users', loadUsers);
loadMobileDevices = pageLoader('devices', loadMobileDevices);
loadGroups = pageLoader('groups', loadGroups);
loadMessages = pageLoader((view = 'messages') => view, loadMessages);
loadSensitiveWords = pageLoader('sensitive-words', loadSensitiveWords);
loadAnnouncement = pageLoader('announcement', loadAnnouncement);
loadExplore = pageLoader('explore', loadExplore);
loadClientConfig = pageLoader('client-config', loadClientConfig);
loadRoutes = pageLoader('routes', loadRoutes);
loadTaskConfig = pageLoader('task-config', loadTaskConfig);
loadQuestionBank = pageLoader('question-bank', loadQuestionBank);
loadTaskRecords = pageLoader('task-records', loadTaskRecords);
loadAdminAccounts = pageLoader('admin-accounts', loadAdminAccounts);
const loadDispatchTasks = pageLoader('dispatch-tasks', () => window.AdminDispatchTasks.load());
const loadMaintenance = pageLoader('maintenance', () => window.AdminMaintenance.mount({ root: $('app'), api, canManage: canPage('maintenance', 'manage'), notify }));
loadLogs = pageLoader(kind => kind, loadLogs);

async function restoreAdminSession() {
  try { const result = await api('/admin/auth/me', { scope: false }); if (!result.csrf_token) throw new Error('请重新登录'); state.token = requestId('admin-session'); state.csrf = result.csrf_token; state.admin = result.admin || result; renderShell(); await renderView(); }
  catch (error) { endAdminSession(error.status === 401 ? '' : error.message); }
}
window.addEventListener('hashchange', () => {
  const target = location.hash.slice(1) || authorizedPage();
  if (!target || !canPage(target)) { notify('当前账号没有此页面权限', 'error'); history.replaceState(null, '', state.view ? `#${state.view}` : '#'); return; }
  state.view = target; void renderView();
});
restoreAdminSession();
