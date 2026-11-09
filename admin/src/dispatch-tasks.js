(function () {
  'use strict';
  const dispatchState = { filters: {}, rows: [], modal: null, sequence: 0, detailSequence: 0 };
  const dispatchStatuses = { pending: '待执行', running: '执行中', completed: '已完成', paused: '已暂停', failed: '执行失败' };
  function dispatchAllowed(manage = false) { return canPage('dispatch-tasks', manage ? 'manage' : 'view'); }
  function dispatchName(item) { return item?.name || item?.nickname || item?.username || `#${Number(item?.id)}`; }
  function dispatchStep(step = {}) { return { type: step.type || 'text', text: String(step.text || ''), image_url: String(step.image_url || ''), delay_seconds: step.delay_seconds ?? 0 }; }
  function dispatchDate(value) { return value ? String(value).replace('T', ' ').slice(0, 19) : '—'; }
  function dispatchFormDate(value) { return value ? String(value).replace(' ', 'T').slice(0, 19) : ''; }
  function dispatchLocalImage(value) {
    try { const base = new URL(API, location.href); const media = new URL(value, base); return media.origin === base.origin && (/(?:^|\/)storage\//.test(media.pathname) || /(?:^|\/)media$/.test(media.pathname) && /^(?:uploads|work-questions)\//.test(media.searchParams.get('path') || '')); }
    catch { return false; }
  }
  function dispatchIcon(name) {
    const paths = { person: '<circle cx="12" cy="7" r="3.2"/><path d="M5.5 20v-2.5a6.5 6.5 0 0 1 13 0V20"/>', eye: '<path d="M2 12s3.7-6.5 10-6.5S22 12 22 12s-3.7 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>', edit: '<path d="m14 5 5 5M4 20l4.5-1 12-12a2 2 0 0 0-4.5-4.5l-12 12L4 20ZM13 20h8"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/>', upload: '<path d="M12 16V3m-4 4 4-4 4 4M4 17v4h16v-4"/>', reset: '<path d="M3 10a9 9 0 1 1 1 7M3 3v7h7"/>' };
    return `<svg class="dispatch-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
  }
  function dispatchPayload(draft) {
    if (!Number.isSafeInteger(Number(draft.sender?.id)) || Number(draft.sender.id) < 1) throw new Error('请选择发送者。');
    if (!['user', 'group'].includes(draft.recipient_type)) throw new Error('请选择接收类型。');
    const recipient_ids = [...new Set(draft.recipients.map(item => Number(item.id)))];
    if (!recipient_ids.length || recipient_ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('请至少选择一位接收者。');
    if (recipient_ids.length > 100) throw new Error('最多选择100个接收者。');
    if (!['once', 'cron'].includes(draft.trigger_type)) throw new Error('请选择触发方式。');
    if (draft.trigger_type === 'once' && (!draft.execute_at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(draft.execute_at))) throw new Error('请选择执行时间。');
    if (draft.trigger_type === 'cron' && ![6, 7].includes(String(draft.cron_expression || '').trim().split(/\s+/).length)) throw new Error('计划任务须填写6或7字段 Cron 表达式。');
    if (!draft.steps.length) throw new Error('请至少添加一个发送步骤。');
    if (draft.steps.length > 100) throw new Error('最多添加100个发送步骤。');
    const steps = draft.steps.map((step, index) => {
      const text = String(step.text || ''); const delay = Number(step.delay_seconds);
      if (!['text', 'image', 'text_image'].includes(step.type)) throw new Error('发送类型无效。');
      if (step.type !== 'image' && (!text.trim() || text.length > 2000)) throw new Error(`第 ${index + 1} 步文字内容须为1至2000字。`);
      const image = String(step.image_url || '').trim();
      if (step.type === 'image' && !image) throw new Error(`第 ${index + 1} 步请填写图片地址或上传图片。`);
      if (step.type !== 'text' && image && step._uploadedSenderId && Number(step._uploadedSenderId) !== Number(draft.sender.id)) throw new Error(`第 ${index + 1} 步上传图片已绑定原发送者，请重新上传或填写其他图片地址。`);
      if (!['number', 'string'].includes(typeof step.delay_seconds) || String(step.delay_seconds).trim() === '' || !Number.isSafeInteger(delay) || delay < 0 || delay > 86400) throw new Error(`第 ${index + 1} 步延迟须填写0至86400的整数秒。`);
      return { type: step.type, ...(step.type === 'image' ? {} : { text }), ...(step.type !== 'text' && image ? { image_url: image } : {}), delay_seconds: delay };
    });
    return { ...(draft.id ? { id: Number(draft.id) } : {}), sender_id: Number(draft.sender.id), recipient_type: draft.recipient_type, recipient_ids, trigger_type: draft.trigger_type,
      execute_at: draft.trigger_type === 'once' ? draft.execute_at : '', cron_expression: draft.trigger_type === 'cron' ? String(draft.cron_expression).trim() : '', steps, enabled: draft.enabled !== false };
  }
  function dispatchMoveStep(draft, index, direction) {
    const destination = index + direction;
    if (destination < 0 || destination >= draft.steps.length) return;
    [draft.steps[index], draft.steps[destination]] = [draft.steps[destination], draft.steps[index]];
  }
  function dispatchRemoveStep(draft, index) {
    if (draft.steps.length <= 1) return;
    draft.steps.splice(index, 1);
  }
  function dispatchMoreMenu(button) {
    const menu = button.parentElement.querySelector('.dispatch-more-menu');
    document.querySelectorAll('.dispatch-more-menu').forEach(node => { if (node !== menu) node.hidden = true; });
    menu.hidden = !menu.hidden;
    if (!menu.hidden) { const rect = button.getBoundingClientRect(); menu.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`; menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 12)}px`; }
  }
  async function dispatchLoad() {
    if (!dispatchAllowed()) throw new Error('当前账号没有分发任务页面权限。');
    const query = new URLSearchParams({ page: page('dispatch-tasks'), size: 20, ...dispatchState.filters });
    const data = await api(`/admin/dispatch-tasks?${query}`);
    dispatchState.rows = data.items || [];
    const filters = dispatchState.filters;
    $('app').innerHTML = `<section class="dispatch-page"><div class="dispatch-hero"><div><h2>分发任务</h2><p>一个任务统一管理发送者、接收者、触发方式和发送步骤</p></div>${dispatchAllowed(true) ? '<button class="dispatch-button dispatch-primary" id="dispatch-task-new" type="button"><span aria-hidden="true">＋</span> 新增分发任务</button>' : ''}</div><form class="dispatch-filters" id="dispatch-task-filters"><label>任务ID<input id="dispatch-task-filter-id" inputmode="numeric" value="${esc(filters.task_id || '')}" placeholder="输入任务ID"></label><label>触发方式<select id="dispatch-task-filter-trigger"><option value="">全部</option><option value="once" ${filters.trigger_type === 'once' ? 'selected' : ''}>单次触发</option><option value="cron" ${filters.trigger_type === 'cron' ? 'selected' : ''}>计划任务</option></select></label><label>状态<select id="dispatch-task-filter-status"><option value="">全部</option>${Object.entries(dispatchStatuses).map(([value, title]) => `<option value="${value}" ${filters.status === value ? 'selected' : ''}>${title}</option>`).join('')}</select></label><button class="dispatch-button dispatch-primary" type="submit">${dispatchIcon('search')} 查询</button><button class="dispatch-button" id="dispatch-task-reset" type="button">${dispatchIcon('reset')} 重置</button></form><section class="dispatch-list-panel"><header><h3>任务列表</h3><span>共 ${Number(data.total || 0)} 个任务</span></header><div class="dispatch-table-scroll"><table class="dispatch-table"><thead><tr><th>任务ID</th><th>发送者</th><th>接收者</th><th>触发方式</th><th>调度配置</th><th>步骤</th><th>状态</th><th>最近执行</th><th>操作</th></tr></thead><tbody>${dispatchState.rows.map(dispatchTaskRow).join('') || '<tr><td class="dispatch-empty" colspan="9">暂无分发任务</td></tr>'}</tbody></table></div>${pager(data, 'dispatch-tasks')}</section></section>`;
    $('dispatch-task-new')?.addEventListener('click', () => dispatchOpen());
    $('dispatch-task-filters').onsubmit = event => { event.preventDefault(); const task_id = $('dispatch-task-filter-id').value.trim(); if (task_id && !/^\d+$/.test(task_id)) { notify('任务ID须为数字。', 'error'); return; } dispatchState.filters = { task_id, trigger_type: $('dispatch-task-filter-trigger').value, status: $('dispatch-task-filter-status').value }; return dispatchReload(true); };
    $('dispatch-task-reset').onclick = () => { dispatchState.filters = {}; return dispatchReload(true); };
    document.querySelectorAll('[data-dispatch-view]').forEach(button => { button.onclick = () => dispatchOpenTask(Number(button.dataset.dispatchView), true); });
    document.querySelectorAll('[data-dispatch-edit]').forEach(button => { button.onclick = () => dispatchOpenTask(Number(button.dataset.dispatchEdit), false); });
    document.querySelectorAll('[data-dispatch-more]').forEach(button => { button.onclick = event => { event.stopPropagation(); dispatchMoreMenu(button); }; });
    document.querySelectorAll('[data-dispatch-status]').forEach(button => { button.onclick = () => dispatchStatus(Number(button.dataset.dispatchStatus)); });
    document.querySelectorAll('[data-dispatch-delete]').forEach(button => { button.onclick = () => dispatchDelete(Number(button.dataset.dispatchDelete)); });
    bindPager('dispatch-tasks', () => loadDispatchTasks()); guardInteractions();
  }
  function dispatchTaskRow(task) {
    const sender = task.sender || { id: task.sender_id };
    const receivers = task.recipients || []; const count = receivers.length || task.recipient_ids?.length || 0;
    const recipient = count > 1 ? `批收${count}${task.recipient_type === 'group' ? '群' : '人'}` : receivers.length ? dispatchName(receivers[0]) : '—';
    const manage = dispatchAllowed(true);
    return `<tr><td>${Number(task.id)}</td><td><span class="dispatch-person-icon">${dispatchIcon('person')}</span>${esc(dispatchName(sender))}${sender.username ? `<small>${esc(sender.username)}</small>` : ''}</td><td title="${esc(receivers.map(dispatchName).join('、'))}"><span class="dispatch-person-icon">${dispatchIcon('person')}</span>${esc(recipient)}</td><td><span class="dispatch-trigger-tag ${task.trigger_type === 'cron' ? 'is-cron' : ''}">${task.trigger_type === 'cron' ? '计划任务' : '单次触发'}</span></td><td class="dispatch-schedule">${esc(task.trigger_type === 'cron' ? task.cron_expression : dispatchDate(task.execute_at))}</td><td><button class="dispatch-link" data-dispatch-view="${Number(task.id)}" type="button">${Number(task.step_count || task.steps?.length || 0)} 个步骤</button></td><td><span class="dispatch-status-tag is-${esc(task.status)}" title="${esc(task.last_error || '')}">${esc(dispatchStatuses[task.status] || task.status)}</span></td><td>${esc(dispatchDate(task.last_executed_at))}</td><td class="dispatch-actions"><button class="dispatch-link" data-dispatch-view="${Number(task.id)}" type="button">${dispatchIcon('eye')} 查看</button>${manage ? `<button class="dispatch-link" data-dispatch-edit="${Number(task.id)}" type="button">${dispatchIcon('edit')} 编辑</button><span class="dispatch-more"><button class="dispatch-link" data-dispatch-more="${Number(task.id)}" type="button" aria-label="更多任务操作">•••</button><span class="dispatch-more-menu" hidden><button type="button" data-dispatch-status="${Number(task.id)}" ${task.status === 'completed' && task.trigger_type === 'once' ? 'disabled' : ''}>${task.status === 'paused' || task.status === 'failed' ? '启用任务' : '暂停任务'}</button><button type="button" class="dispatch-danger" data-dispatch-delete="${Number(task.id)}">删除任务</button></span></span>` : ''}</td></tr>`;
  }
  async function dispatchReload(reset = false) { if (reset) state.pages['dispatch-tasks'] = 1; return loadDispatchTasks(); }
  async function dispatchOpenTask(id, readonly) {
    const sequence = ++dispatchState.detailSequence;
    try { const result = await api(`/admin/dispatch-tasks/detail?id=${id}`, { scope: false }); if (sequence !== dispatchState.detailSequence || state.view !== 'dispatch-tasks' || !dispatchAllowed()) return; dispatchOpen(result.task, readonly); }
    catch (error) { notify(error.message, 'error'); }
  }
  function dispatchClose() { dispatchState.detailSequence++; const modal = dispatchState.modal; if (!modal) return; modal.closed = true; Object.values(modal.searchTimers).forEach(clearTimeout); modal.element.remove(); dispatchState.modal = null; }
  function dispatchDetailTime(value) {
    const match = typeof value === 'string' ? value.match(/^\d{4}-\d{2}-\d{2} (\d{2}):(\d{2}):(\d{2})$/) : null;
    return match && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3]) < 60 ? `${match[1]}:${match[2]}:${match[3]}` : '—';
  }
  function dispatchDetailImageUrl(value) {
    const raw = String(value || '').trim();
    if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return '';
    try { const image = new URL(raw, new URL(API, location.href)); return ['https:', 'http:'].includes(image.protocol) && !image.username && !image.password ? image.href : ''; }
    catch { return ''; }
  }
  function dispatchDetailStepHtml(step, index, task) {
    const types = { text: '文字', image: '图片', text_image: '文字+图片' };
    const rawTime = Array.isArray(task.step_times) ? task.step_times[index] : null;
    const time = dispatchDetailTime(rawTime);
    const timeTitle = `计划时间（北京时间）；后续步骤以实际发送成功时间起算延迟${time === '—' ? '；时间尚未确定' : `\n${rawTime}`}`;
    const image = step.type !== 'text' ? dispatchDetailImageUrl(step.image_url) : '';
    const text = String(step.text || '').replace(/\s+/g, ' ').trim();
    const summary = step.type === 'image' ? image || String(step.image_url || '').trim() || '—' : text || '—';
    const preview = image ? `<a class="dispatch-detail-image-link ${step.type === 'image' ? 'is-image-summary' : ''}" href="${esc(image)}" target="_blank" rel="noopener noreferrer" title="${esc(image)}" data-dispatch-detail-image="${index}">${step.type === 'image' ? esc(summary) : '查看图片'}</a>` : '';
    return `<div class="dispatch-detail-step" data-dispatch-detail-step="${index}"><span class="dispatch-detail-number">${index + 1}</span><time class="dispatch-detail-time" data-dispatch-detail-time="${index}" title="${esc(timeTitle)}">${esc(time)}</time><span class="dispatch-detail-type">${esc(types[step.type] || '—')}</span>${Number(step.delay_seconds) > 0 ? `<span class="dispatch-detail-delay">延迟 ${Number(step.delay_seconds)} 秒</span>` : ''}<div class="dispatch-detail-content">${step.type === 'image' && preview ? preview : `<span class="dispatch-detail-summary" title="${esc(summary)}">${esc(summary)}</span>${preview}`}</div></div>`;
  }
  function dispatchDetailHtml(task) {
    const receivers = task.recipients || []; const count = receivers.length || task.recipient_ids?.length || 0;
    const recipient = count > 1 ? `批收${count}${task.recipient_type === 'group' ? '群' : '人'}` : receivers.length ? dispatchName(receivers[0]) : '—';
    const sender = task.sender || { id: task.sender_id };
    const schedule = task.trigger_type === 'cron' ? task.cron_expression || '—' : dispatchDate(task.execute_at);
    return `<section class="dispatch-detail" role="dialog" aria-modal="true" aria-labelledby="dispatch-detail-title"><header class="dispatch-detail-header"><h2 id="dispatch-detail-title">任务详情</h2><button class="dispatch-close" id="dispatch-detail-close" type="button" aria-label="关闭">×</button></header><table class="dispatch-detail-meta"><colgroup><col class="dispatch-detail-label-col"><col class="dispatch-detail-value-col"><col class="dispatch-detail-label-col"><col></colgroup><tbody><tr><th scope="row">任务ID</th><td>${Number(task.id)}</td><th scope="row">状态</th><td><span class="dispatch-status-tag is-${esc(task.status)}">${esc(dispatchStatuses[task.status] || task.status || '-')}</span></td></tr><tr><th scope="row">发送者</th><td title="${esc(sender.username || '')}">${esc(dispatchName(sender))}</td><th scope="row">接收者</th><td title="${esc(receivers.map(dispatchName).join('、'))}">${esc(recipient)}</td></tr><tr><th scope="row">触发方式</th><td>${task.trigger_type === 'cron' ? '计划任务' : '单次触发'}</td><th scope="row">调度配置</th><td title="${esc(schedule)}">${esc(schedule)}</td></tr><tr><th scope="row">最近执行</th><td>${esc(dispatchDate(task.last_executed_at))}</td><th scope="row">错误信息</th><td title="${esc(task.last_error || '')}">${esc(task.last_error || '-')}</td></tr></tbody></table><h3 class="dispatch-detail-steps-title">发送步骤</h3><div class="dispatch-detail-steps">${(task.steps || []).map((step, index) => dispatchDetailStepHtml(step, index, task)).join('') || '<p class="dispatch-detail-empty">暂无发送步骤</p>'}</div></section>`;
  }
  function dispatchOpenDetail(task) {
    if (!task || !dispatchAllowed()) { notify('当前账号没有分发任务页面权限。', 'error'); return; }
    dispatchClose();
    const element = document.createElement('div'); element.className = 'dispatch-backdrop dispatch-detail-backdrop user-modal-backdrop'; element.id = 'dispatch-task-detail-modal';
    dispatchState.modal = { element, readonly: true, closed: false, searchTimers: {}, saving: false, sequence: ++dispatchState.sequence };
    element.innerHTML = dispatchDetailHtml(task); document.body.appendChild(element);
    $('dispatch-detail-close').onclick = dispatchClose;
    $('dispatch-detail-close').focus?.();
    element.onclick = event => { if (event.target === element) dispatchClose(); };
    element.onkeydown = event => { if (event.key === 'Escape') dispatchClose(); };
  }
  function dispatchOpen(task = null, readonly = false) {
    if (readonly) { dispatchOpenDetail(task); return; }
    if (!dispatchAllowed() || (!readonly && !dispatchAllowed(true))) { notify('当前账号没有此操作权限。', 'error'); return; }
    dispatchClose();
    const draft = { id: task?.id, sender: task?.sender || null, recipient_type: task?.recipient_type || 'user', recipients: task?.recipients ? task.recipients.map(item => ({ ...item })) : [], trigger_type: task?.trigger_type || 'once', execute_at: dispatchFormDate(task?.execute_at), cron_expression: task?.cron_expression || '', steps: task?.steps?.length ? task.steps.map(dispatchStep) : [dispatchStep()], enabled: task?.status !== 'paused' };
    draft.steps.forEach(step => { if (step.image_url && dispatchLocalImage(step.image_url) && draft.sender) step._uploadedSenderId = Number(draft.sender.id); });
    const element = document.createElement('div'); element.className = 'dispatch-backdrop user-modal-backdrop'; element.id = 'dispatch-task-modal';
    const modal = { element, draft, readonly, closed: false, sequence: ++dispatchState.sequence, searches: {}, searchTimers: {}, saving: false, pendingUploads: 0 }; dispatchState.modal = modal;
    element.innerHTML = `<section class="dispatch-modal" role="dialog" aria-modal="true" aria-labelledby="dispatch-modal-title"><header class="dispatch-modal-header"><h2 id="dispatch-modal-title">${readonly ? '查看分发任务' : task ? '编辑分发任务' : '新增分发任务'}</h2><button class="dispatch-close" id="dispatch-modal-close" type="button" aria-label="关闭">×</button></header><form id="dispatch-task-form" novalidate><div class="dispatch-modal-body"><h3 class="dispatch-section-title">任务配置</h3><div class="dispatch-config-grid"><div class="dispatch-form-field"><label for="dispatch-sender-search"><i>*</i> 发送者</label><div class="dispatch-select-wrap"><input id="dispatch-sender-search" type="search" autocomplete="off" placeholder="搜索发送者" value="${esc(draft.sender ? dispatchName(draft.sender) : '')}" ${readonly ? 'disabled' : ''}><div class="dispatch-options" id="dispatch-sender-options" hidden></div></div></div><div class="dispatch-form-field"><span class="dispatch-form-label"><i>*</i> 接收类型</span><div class="dispatch-radio-group"><label><input type="radio" name="dispatch-recipient-type" value="user" ${draft.recipient_type === 'user' ? 'checked' : ''} ${readonly ? 'disabled' : ''}> 用户</label><label><input type="radio" name="dispatch-recipient-type" value="group" ${draft.recipient_type === 'group' ? 'checked' : ''} ${readonly ? 'disabled' : ''}> 群组</label></div></div><div class="dispatch-form-field dispatch-full"><label for="dispatch-recipient-search"><i>*</i> 接收者</label><div class="dispatch-select-wrap"><div class="dispatch-recipient-select"><div id="dispatch-selected-recipients"></div><input id="dispatch-recipient-search" type="search" autocomplete="off" placeholder="搜索接收用户，可多选" ${readonly ? 'disabled' : ''}></div><div class="dispatch-options" id="dispatch-recipient-options" hidden></div></div></div><div class="dispatch-form-field"><span class="dispatch-form-label"><i>*</i> 触发方式</span><div class="dispatch-radio-group"><label><input type="radio" name="dispatch-trigger-type" value="once" ${draft.trigger_type === 'once' ? 'checked' : ''} ${readonly ? 'disabled' : ''}> 单次触发</label><label><input type="radio" name="dispatch-trigger-type" value="cron" ${draft.trigger_type === 'cron' ? 'checked' : ''} ${readonly ? 'disabled' : ''}> 计划任务</label></div></div><div class="dispatch-form-field" id="dispatch-schedule-field"></div></div><div class="dispatch-step-divider"></div><div class="dispatch-step-section-title"><h3>发送步骤</h3><span>首步从任务触发时间开始计算延迟，后续步骤从上一整步发送成功后开始计算延迟</span></div><div id="dispatch-steps"></div>${readonly ? '' : '<button class="dispatch-button dispatch-add-step" id="dispatch-step-add" type="button"><span aria-hidden="true">＋</span> 添加步骤</button>'}<p id="dispatch-task-feedback" class="dispatch-feedback" role="alert"></p></div><footer class="dispatch-modal-footer"><button class="dispatch-button" id="dispatch-task-cancel" type="button">${readonly ? '关闭' : '取消'}</button>${readonly ? '' : '<button class="dispatch-button dispatch-primary" id="dispatch-task-save" type="submit">保存任务</button>'}</footer></form></section>`;
    document.body.appendChild(element); $('dispatch-modal-close').onclick = dispatchClose; $('dispatch-task-cancel').onclick = dispatchClose;
    element.onclick = event => { if (event.target === element && !modal.saving) dispatchClose(); };
    element.onkeydown = event => { if (event.key === 'Escape' && !modal.saving) dispatchClose(); };
    dispatchSchedule(modal); dispatchSteps(modal); dispatchRecipients(modal);
    if (!readonly) {
      dispatchBindSearch(modal, 'sender'); dispatchBindSearch(modal, 'recipient');
      element.querySelectorAll('[name="dispatch-recipient-type"]').forEach(input => { input.onchange = () => { draft.recipient_type = input.value; draft.recipients = []; dispatchRecipients(modal); $('dispatch-recipient-search').value = ''; $('dispatch-recipient-options').hidden = true; modal.searches.recipient = (modal.searches.recipient || 0) + 1; }; });
      element.querySelectorAll('[name="dispatch-trigger-type"]').forEach(input => { input.onchange = () => { draft.trigger_type = input.value; dispatchSchedule(modal); }; });
      $('dispatch-step-add').onclick = () => { if (draft.steps.length >= 100) { notify('最多添加100个发送步骤。', 'error'); return; } draft.steps.push(dispatchStep()); dispatchSteps(modal); };
      $('dispatch-task-form').onsubmit = event => dispatchSave(event, modal);
    } else $('dispatch-task-form').onsubmit = event => event.preventDefault();
  }
  function dispatchSchedule(modal) {
    const draft = modal.draft;
    $('dispatch-schedule-field').innerHTML = draft.trigger_type === 'cron' ? `<label for="dispatch-cron"><i>*</i> Cron表达式</label><div class="dispatch-cron-wrap"><input id="dispatch-cron" value="${esc(draft.cron_expression)}" placeholder="10 15 9 * * ?" title="北京时间（Asia/Shanghai）：秒 分 时 日 月 星期 [年]；例如每天09:15:10" ${modal.readonly ? 'disabled' : ''}><small>6或7字段 · 秒 分 时 日 月 星期 [年]（北京时间）</small></div>` : `<label for="dispatch-execute-at"><i>*</i> 执行时间</label><div class="dispatch-datetime-wrap ${draft.execute_at ? 'has-value' : ''}"><input id="dispatch-execute-at" type="datetime-local" step="1" value="${esc(draft.execute_at)}" title="北京时间（Asia/Shanghai）" ${modal.readonly ? 'disabled' : ''}><span class="dispatch-datetime-placeholder">${dispatchIcon('clock')}选择执行时间</span></div>`;
    if ($('dispatch-cron')) $('dispatch-cron').oninput = event => { draft.cron_expression = event.target.value; };
    if ($('dispatch-execute-at')) $('dispatch-execute-at').oninput = event => { draft.execute_at = event.target.value; event.target.closest('.dispatch-datetime-wrap')?.classList.toggle('has-value', !!event.target.value); };
  }
  function dispatchRecipients(modal) {
    $('dispatch-selected-recipients').innerHTML = modal.draft.recipients.map(item => `<span class="dispatch-recipient-tag">${esc(dispatchName(item))}${modal.readonly ? '' : `<button type="button" data-dispatch-recipient-remove="${Number(item.id)}" aria-label="移除${esc(dispatchName(item))}">×</button>`}</span>`).join('');
    $('dispatch-recipient-search').placeholder = modal.draft.recipient_type === 'group' ? '搜索接收群组，可多选' : '搜索接收用户，可多选';
    document.querySelectorAll('[data-dispatch-recipient-remove]').forEach(button => { button.onclick = () => { modal.draft.recipients = modal.draft.recipients.filter(item => Number(item.id) !== Number(button.dataset.dispatchRecipientRemove)); dispatchRecipients(modal); }; });
  }
  function dispatchStepHtml(step, index, modal) {
    const disabled = modal.readonly || Boolean(step._uploading);
    const textField = step.type === 'image' ? '' : `<label class="dispatch-text-field"><span><i>*</i> 文字内容</span><div><textarea rows="2" maxlength="2000" data-dispatch-step-text="${index}" placeholder="请输入发送内容" ${modal.readonly ? 'disabled' : ''}>${esc(step.text)}</textarea><small class="dispatch-step-counter">${step.text.length}/2000</small></div></label>`;
    const imageField = step.type === 'text' ? '' : `<label class="dispatch-image-field"><span>${step.type === 'image' ? '<i>*</i> ' : ''}图片地址</span><div class="dispatch-image-input-group"><input type="text" data-dispatch-step-image="${index}" value="${esc(step.image_url || '')}" placeholder="点击右侧上传，地址自动填写；单张最大50MB" ${disabled ? 'disabled' : ''}><button type="button" data-dispatch-step-upload="${index}" title="支持JPG、PNG、GIF、WebP，单张最大50MB；上传后可直接保存" ${disabled ? 'disabled' : ''}>${dispatchIcon('upload')} ${step._uploading ? '上传中…' : '上传'}</button><input type="file" data-dispatch-step-file="${index}" accept=".jpg,.jpeg,.png,.gif,.webp,image/jpeg,image/png,image/gif,image/webp" hidden ${disabled ? 'disabled' : ''}></div></label>`;
    return `<article class="dispatch-step-card is-${esc(step.type)}" data-dispatch-step="${index}"><header><span class="dispatch-step-number">${index + 1}</span><strong>步骤 ${index + 1}</strong>${modal.readonly ? '' : `<div class="dispatch-step-actions">${modal.draft.steps.length > 1 ? `<button type="button" data-dispatch-step-up="${index}" ${index === 0 ? 'disabled' : ''} aria-label="上移步骤${index + 1}">↑</button><button type="button" data-dispatch-step-down="${index}" ${index === modal.draft.steps.length - 1 ? 'disabled' : ''} aria-label="下移步骤${index + 1}">↓</button><button type="button" data-dispatch-step-remove="${index}">删除</button>` : ''}</div>`}</header><div class="dispatch-step-fields"><div class="dispatch-step-top"><label><span><i>*</i> 发送类型</span><select data-dispatch-step-type="${index}" ${modal.readonly ? 'disabled' : ''}>${[['text', '文字'], ['image', '图片'], ['text_image', '文字 + 图片']].map(([type, title]) => `<option value="${type}" ${step.type === type ? 'selected' : ''}>${title}</option>`).join('')}</select></label><label class="dispatch-delay-field"><span>步骤延迟</span><div><input type="number" min="0" max="86400" step="1" data-dispatch-step-delay="${index}" value="${esc(step.delay_seconds ?? 0)}" aria-describedby="dispatch-task-feedback" ${modal.readonly ? 'disabled' : ''}><small>秒</small></div></label></div>${textField}${imageField}</div></article>`;
  }
  function dispatchSteps(modal) {
    if (!dispatchActiveModal(modal)) return;
    $('dispatch-steps').innerHTML = modal.draft.steps.map((step, index) => dispatchStepHtml(step, index, modal)).join('');
    if (modal.readonly) return;
    document.querySelectorAll('[data-dispatch-step-text]').forEach(input => { input.oninput = () => { const step = modal.draft.steps[Number(input.dataset.dispatchStepText)]; step.text = input.value; input.parentElement.querySelector('.dispatch-step-counter').textContent = `${input.value.length}/2000`; }; });
    document.querySelectorAll('[data-dispatch-step-image]').forEach(input => { input.oninput = () => { const step = modal.draft.steps[Number(input.dataset.dispatchStepImage)]; if (step.image_url !== input.value) step._uploadedSenderId = null; step.image_url = input.value; dispatchWarnSender(modal); }; });
    document.querySelectorAll('[data-dispatch-step-type]').forEach(input => { input.onchange = () => { modal.draft.steps[Number(input.dataset.dispatchStepType)].type = input.value; dispatchSteps(modal); modal.element.querySelector(`[data-dispatch-step-type="${input.dataset.dispatchStepType}"]`)?.focus(); }; });
    document.querySelectorAll('[data-dispatch-step-delay]').forEach(input => { input.oninput = () => { modal.draft.steps[Number(input.dataset.dispatchStepDelay)].delay_seconds = input.value; }; });
    document.querySelectorAll('[data-dispatch-step-remove]').forEach(button => { button.onclick = () => { dispatchRemoveStep(modal.draft, Number(button.dataset.dispatchStepRemove)); dispatchSteps(modal); dispatchWarnSender(modal); }; });
    for (const [attribute, direction] of [['up', -1], ['down', 1]]) document.querySelectorAll(`[data-dispatch-step-${attribute}]`).forEach(button => { button.onclick = () => { dispatchMoveStep(modal.draft, Number(button.dataset[attribute === 'up' ? 'dispatchStepUp' : 'dispatchStepDown']), direction); dispatchSteps(modal); }; });
    document.querySelectorAll('[data-dispatch-step-upload]').forEach(button => { button.onclick = () => { if (!modal.draft.sender) { notify('请先选择发送者，再上传图片。', 'error'); return; } modal.element.querySelector(`[data-dispatch-step-file="${button.dataset.dispatchStepUpload}"]`)?.click(); }; });
    document.querySelectorAll('[data-dispatch-step-file]').forEach(input => { const step = modal.draft.steps[Number(input.dataset.dispatchStepFile)]; input.onchange = () => { const file = input.files?.[0]; input.value = ''; if (file) return dispatchUpload(modal, step, file); }; });
    dispatchSyncUploads(modal);
  }
  function dispatchActiveModal(modal) { return !modal.closed && dispatchState.modal === modal && modal.element.isConnected !== false; }
  function dispatchSyncUploads(modal) {
    if (!dispatchActiveModal(modal)) return;
    const save = $('dispatch-task-save'); if (save) save.disabled = modal.readonly || modal.saving || modal.pendingUploads > 0;
  }
  function dispatchWarnSender(modal) {
    if (!dispatchActiveModal(modal)) return;
    const senderId = Number(modal.draft.sender?.id);
    const different = senderId > 0 && modal.draft.steps.some(step => Number(step._uploadedSenderId || step._uploadingSenderId) > 0 && Number(step._uploadedSenderId || step._uploadingSenderId) !== senderId);
    const feedback = $('dispatch-task-feedback');
    if (different) feedback.textContent = '旧上传图片已绑定原发送者。更换发送者后，请重新上传图片；图片归属不会自动转移。';
    else if (modal.senderImageWarning) feedback.textContent = '';
    modal.senderImageWarning = different;
  }
  async function dispatchUpload(modal, step, file) {
    if (!dispatchActiveModal(modal) || modal.readonly || modal.saving || step._uploading || !modal.draft.steps.includes(step) || !dispatchAllowed(true)) return;
    if (!modal.draft.sender) { notify('请先选择发送者，再上传图片。', 'error'); return; }
    if (file.size <= 0 || file.size > 50 * 1024 * 1024) { notify('图片大小须大于0且不超过50MB。', 'error'); return; }
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type) && !(file.type === '' && /\.(?:jpe?g|png|gif|webp)$/i.test(file.name))) { notify('请选择JPG、PNG、GIF或WebP图片。', 'error'); return; }
    const senderId = Number(modal.draft.sender.id); const token = state.token;
    const form = new FormData(); form.append('file', file); form.append('sender_id', String(senderId));
    step._uploading = true; step._uploadingSenderId = senderId; modal.pendingUploads = (modal.pendingUploads || 0) + 1; dispatchSteps(modal);
    try {
      const data = await adminMultipart('/admin/dispatch-tasks/upload', form);
      if (!dispatchActiveModal(modal) || state.token !== token || !modal.draft.steps.includes(step)) return;
      if (!data?.url) throw new Error('上传响应缺少图片地址。');
      step.image_url = data.url; step._uploadedSenderId = senderId; dispatchWarnSender(modal);
    } catch (error) { if (dispatchActiveModal(modal) && state.token === token) notify(error.message, 'error'); }
    finally { step._uploading = false; delete step._uploadingSenderId; modal.pendingUploads = Math.max(0, (modal.pendingUploads || 0) - 1); if (dispatchActiveModal(modal) && state.token === token) { dispatchSteps(modal); dispatchSyncUploads(modal); } }
  }
  function dispatchBindSearch(modal, field) {
    const input = $(`dispatch-${field}-search`); const options = $(`dispatch-${field}-options`);
    const search = () => { clearTimeout(modal.searchTimers[field]); modal.searches[field] = (modal.searches[field] || 0) + 1; modal.searchTimers[field] = setTimeout(() => dispatchSearch(modal, field, input.value), 180); };
    input.oninput = () => { if (field === 'sender') modal.draft.sender = null; search(); };
    input.onfocus = () => { void dispatchSearch(modal, field, input.value); };
    input.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); options.hidden = true; } };
  }
  async function dispatchSearch(modal, field, keyword) {
    const revision = (modal.searches[field] || 0) + 1; modal.searches[field] = revision;
    const options = $(`dispatch-${field}-options`); const kind = field === 'sender' ? 'sender' : modal.draft.recipient_type;
    options.hidden = false; options.innerHTML = '<p>正在搜索…</p>';
    try {
      const query = new URLSearchParams({ kind, q: keyword.trim(), sender_id: modal.draft.sender?.id || '' });
      const data = await api(`/admin/dispatch-tasks/options?${query}`, { scope: false });
      if (modal.closed || dispatchState.modal !== modal || modal.searches[field] !== revision) return;
      options.innerHTML = (data.items || []).map(item => `<button type="button" data-dispatch-option="${Number(item.id)}"><span>${esc(dispatchName(item))}</span><small>${esc(item.username || `#${item.id}`)}</small>${field === 'recipient' && modal.draft.recipients.some(selected => Number(selected.id) === Number(item.id)) ? '<span class="dispatch-option-check">✓</span>' : ''}</button>`).join('') || '<p>没有匹配的用户或群组</p>';
      options.querySelectorAll('[data-dispatch-option]').forEach(button => { button.onclick = () => {
        const item = data.items.find(item => Number(item.id) === Number(button.dataset.dispatchOption));
        if (field === 'sender') { modal.draft.sender = { ...item }; $('dispatch-sender-search').value = dispatchName(item); options.hidden = true; dispatchWarnSender(modal); modal.searches.recipient = (modal.searches.recipient || 0) + 1; $('dispatch-recipient-options').hidden = true; }
        else { if (modal.draft.recipients.some(selected => Number(selected.id) === Number(item.id))) return; if (modal.draft.recipients.length >= 100) { notify('最多选择100个接收者。', 'error'); return; } modal.draft.recipients.push({ ...item }); dispatchRecipients(modal); button.disabled = true; button.insertAdjacentHTML('beforeend', '<span class="dispatch-option-check">✓</span>'); }
      }; });
    } catch (error) { if (!modal.closed && dispatchState.modal === modal && modal.searches[field] === revision) options.innerHTML = `<p role="alert">${esc(error.message)}</p>`; }
  }
  async function dispatchSave(event, modal) {
    event.preventDefault(); if (modal.saving || modal.closed || modal.readonly) return;
    if (modal.pendingUploads > 0) { $('dispatch-task-feedback').textContent = '图片正在上传，请上传完成后再保存任务。'; return; }
    if (!dispatchAllowed(true)) { notify('当前账号没有分发任务操作权限。', 'error'); return; }
    const feedback = $('dispatch-task-feedback'); let payload;
    try { payload = dispatchPayload(modal.draft); } catch (error) { feedback.textContent = error.message; return; }
    modal.saving = true; $('dispatch-task-save').disabled = true; feedback.textContent = '正在保存任务…';
    try { await api('/admin/dispatch-tasks', { method: 'POST', body: JSON.stringify(payload) }); if (dispatchState.modal === modal) dispatchClose(); notify('分发任务已保存'); await dispatchReload(); }
    catch (error) { if (!modal.closed && feedback.isConnected) { feedback.textContent = error.message; $('dispatch-task-save').disabled = false; } }
    finally { modal.saving = false; }
  }
  async function dispatchStatus(id) {
    if (!dispatchAllowed(true)) return;
    const task = dispatchState.rows.find(item => Number(item.id) === id); if (!task || (task.status === 'completed' && task.trigger_type === 'once')) return;
    const status = task.status === 'paused' || task.status === 'failed' ? 'pending' : 'paused';
    try { await api('/admin/dispatch-tasks/status', { method: 'POST', body: JSON.stringify({ id, status }) }); notify(status === 'paused' ? '任务已暂停' : '任务已启用'); await dispatchReload(); }
    catch (error) { notify(error.message, 'error'); }
  }
  async function dispatchDelete(id) {
    if (!dispatchAllowed(true)) return;
    if (!confirm(`确定删除分发任务 #${id} 吗？`)) return;
    try { await api('/admin/dispatch-tasks/delete', { method: 'POST', body: JSON.stringify({ id }) }); notify('分发任务已删除'); await dispatchReload(); }
    catch (error) { notify(error.message, 'error'); }
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('.dispatch-more')) document.querySelectorAll('.dispatch-more-menu').forEach(menu => { menu.hidden = true; });
    if (!event.target.closest('.dispatch-select-wrap')) document.querySelectorAll('.dispatch-options').forEach(options => { options.hidden = true; });
    const navigation = event.target.closest('[data-view]'); if (navigation && navigation.dataset.view !== 'dispatch-tasks') dispatchClose();
  });
  document.addEventListener('scroll', () => document.querySelectorAll('.dispatch-more-menu').forEach(menu => { menu.hidden = true; }), true);
  window.addEventListener('resize', () => document.querySelectorAll('.dispatch-more-menu').forEach(menu => { menu.hidden = true; }));
  window.AdminDispatchTasks = { load: dispatchLoad, close: dispatchClose };
})();
