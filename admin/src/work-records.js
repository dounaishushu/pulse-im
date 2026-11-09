(function () {
  'use strict';

  const wrState = { listSequence: 0, detailSequence: 0, record: null, question: null, overflow: null };
  const view = 'task-records';
  const focusSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
  function wrAllowed(manage = false) { return canPage(view, manage ? 'manage' : 'view'); }
  function wrContext(token) { return state.token === token && state.view === view && wrAllowed(); }
  function wrMoney(value) { const number = Number(value); return (Number.isFinite(number) ? number : 0).toFixed(2); }
  function wrDuration(value) {
    const number = Number(value); const seconds = Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
    return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分${seconds % 60}秒`;
  }
  function wrIcon(name) {
    const paths = {
      eye: '<path d="M2 12s3.7-6.5 10-6.5S22 12 22 12s-3.7 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
      record: '<path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h3"/>',
      person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
      search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/>',
      reset: '<path d="M3 10a9 9 0 1 1 1 7M3 3v7h7"/>',
      export: '<path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      complete: '<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
      duration: '<circle cx="12" cy="14" r="7.5"/><path d="M9 2h6m-3 0v4m6 1 2-2M12 10v4l2 2"/>',
      calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18M7 14h2m3 0h2m3 0h1M7 17h2m3 0h2"/>',
      close: '<path d="m6 6 12 12M6 18 18 6"/>',
      prev: '<path d="m14 5-7 7 7 7"/>', next: '<path d="m10 5 7 7-7 7"/>',
    };
    return `<svg class="wr-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
  }
  function wrImageUrl(value) {
    if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f\\]/.test(value)) return '';
    const raw = value.trim();
    try {
      const base = new URL(typeof API === 'string' ? API : location.href, location.href);
      const absolute = /^https?:\/\//i.test(raw);
      if (!absolute && (!/^\/?(?:(?:api|index\.php)\/)?(?:storage|media)\//i.test(raw) || raw.startsWith('//'))) return '';
      const url = new URL(absolute ? raw : '/' + raw.replace(/^\//, ''), base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      if (!absolute && !/^\/(?:(?:api|index\.php)\/)?(?:storage|media)\//i.test(url.pathname)) return '';
      return url.href;
    } catch { return ''; }
  }
  function wrAnswer(value, standard = false) { return value === true ? '对' : value === false ? '错' : standard ? '未提供' : '未作答'; }
  function wrJudgement(question) {
    if (typeof question.reviewed_correct === 'boolean') return question.reviewed_correct;
    if (typeof question.answer !== 'boolean' || typeof question.correct_answer !== 'boolean') return null;
    return question.answer === question.correct_answer;
  }
  function wrCanReview(context) { return context.record.status === 'pending_review' && wrAllowed(true) && wrContext(context.token); }
  function wrShowReview(context) { return context.record.status !== 'reviewed' && wrAllowed(true); }
  function wrVerdict(value, full = false) {
    const kind = value === true ? 'correct' : value === false ? 'wrong' : 'unanswered';
    const text = value === true ? (full ? '本题回答正确' : '回答正确') : value === false ? (full ? '本题回答错误' : '回答错误') : '未作答';
    return `<span class="wr-verdict wr-verdict-${kind}">${text}</span>`;
  }
  function wrPages(index, total) {
    if (total <= 0) return [];
    const current = Math.max(1, Math.min(total, index + 1));
    if (total <= 8) return Array.from({ length: total }, (_, i) => i + 1);
    if (current <= 5) return [1, 2, 3, 4, 5, 6, '…', total];
    if (current >= total - 4) return [1, '…', ...Array.from({ length: 6 }, (_, i) => total - 5 + i)];
    return [1, '…', current - 1, current, current + 1, '…', total];
  }
  function wrStatus(status) { return `<span class="wr-status wr-status-${['in_progress', 'pending_review', 'reviewed'].includes(status) ? status : 'unknown'}">${esc(workStatusLabel(status))}</span>`; }
  function wrTableRow(record) {
    return `<tr><td>${esc(record.id)}</td><td>${esc(record.user_id)}</td><td class="wr-task-name" title="${esc(record.task_name || record.task_key || '')}">${esc(record.task_name || record.task_key || '—')}</td><td>${esc(record.task_date || '—')}</td><td>${esc(workDateTime(record.start_at))}</td><td>${esc(workDateTime(record.submitted_at || record.reviewed_at))}</td><td>${esc(record.total_questions)}</td><td class="wr-positive">${esc(record.correct_count)}</td><td class="wr-negative">${esc(record.wrong_count)}</td><td class="wr-wage">${wrMoney(record.wage)}</td><td>${wrStatus(record.status)}</td><td><button class="wr-detail-button" type="button" data-record-detail="${esc(record.id)}">${wrIcon('eye')}详情</button></td></tr>`;
  }
  function wrFilterQuery(filters, listing = true) {
    const query = { user_id: filters.userId || '', task_id: filters.taskId || '', status: filters.status || '', date_from: filters.dateFrom || '', date_to: filters.dateTo || '' };
    if (listing) Object.assign(query, { page: state.pages[view] || 1, size: 10 });
    return new URLSearchParams(query).toString();
  }
  function wrDateField(id, value, label) {
    return `<label class="wr-date-field ${value ? '' : 'wr-date-empty'}"><input id="${id}" aria-label="${label}" type="date" value="${esc(value || '')}"><span class="wr-date-placeholder" aria-hidden="true">${label}</span></label>`;
  }
  async function wrLoad() {
    if (!wrAllowed()) return;
    const sequence = ++wrState.listSequence; const token = state.token; const filters = { ...(state.recordFilters || {}) };
    const [data, tasks] = await Promise.all([api(`/admin/work-records?${wrFilterQuery(filters)}`), api('/admin/work-records/task-options')]);
    if (sequence !== wrState.listSequence || !wrContext(token)) return;
    $('app').innerHTML = `<div class="wr-page"><div class="wr-title"><h2>作业记录</h2></div><section class="wr-filter-panel" aria-label="筛选作业记录"><div class="wr-filter-fields"><input class="wr-filter-user" id="record-user-id" type="number" min="1" value="${esc(filters.userId || '')}" placeholder="用户ID" aria-label="用户ID"><select class="wr-filter-task" id="record-task-id" aria-label="任务"><option value="">任务</option>${(tasks.items || []).map(task => `<option value="${esc(task.id)}" ${String(filters.taskId || '') === String(task.id) ? 'selected' : ''}>${esc(task.name)}</option>`).join('')}</select><select class="wr-filter-status" id="record-status" aria-label="状态"><option value="">全部状态</option>${['in_progress', 'pending_review', 'reviewed'].map(status => `<option value="${status}" ${filters.status === status ? 'selected' : ''}>${esc(workStatusLabel(status))}</option>`).join('')}</select><div class="wr-date-range">${wrIcon('calendar')}${wrDateField('record-date-from', filters.dateFrom, '开始日期')}<span class="wr-date-separator">至</span>${wrDateField('record-date-to', filters.dateTo, '结束日期')}</div></div><div class="wr-filter-actions"><button class="wr-button wr-search-button" id="record-search" type="button">${wrIcon('search')}搜索</button><button class="wr-button wr-reset-button" id="record-reset" type="button">${wrIcon('reset')}重置</button><button class="wr-button wr-export-button" id="record-export" type="button">${wrIcon('export')}导出</button></div></section><section class="wr-table-panel"><div class="wr-table-wrap"><table class="wr-table"><thead><tr>${['记录ID', '用户ID', '任务', '日期', '开始时间', '完成时间', '总题数', '答对', '答错', '工资(元)', '状态', '操作'].map(title => `<th scope="col">${title}</th>`).join('')}</tr></thead><tbody>${(data.items || []).map(wrTableRow).join('') || '<tr><td colspan="12" class="wr-empty">暂无作业记录</td></tr>'}</tbody></table></div><div class="wr-list-pagination">${pager(data, view)}</div></section></div>`;
    const search = () => {
      state.pages[view] = 1;
      state.recordFilters = { userId: $('record-user-id').value.trim(), taskId: $('record-task-id').value, status: $('record-status').value, dateFrom: $('record-date-from').value, dateTo: $('record-date-to').value };
      return wrLoad();
    };
    $('record-search').onclick = search;
    ['record-date-from', 'record-date-to'].forEach(id => {
      const input = $(id);
      input.oninput = input.onchange = () => input.closest('.wr-date-field')?.classList.toggle('wr-date-empty', !input.value);
    });
    $('record-user-id').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void search(); } };
    $('record-reset').onclick = () => { state.pages[view] = 1; state.recordFilters = {}; return wrLoad(); };
    $('record-export').onclick = () => downloadWorkFile(`/admin/work-records/export?${wrFilterQuery(state.recordFilters || {}, false)}`, '作业记录.xlsx');
    document.querySelectorAll('[data-record-detail]').forEach(button => { button.onclick = () => wrOpen(Number(button.dataset.recordDetail)); });
    bindPager(view, wrLoad);
  }
  function wrLockScroll() {
    if (wrState.overflow === null) { wrState.overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
  }
  function wrRestoreScroll() {
    if (!wrState.record && !wrState.question && wrState.overflow !== null) { document.body.style.overflow = wrState.overflow; wrState.overflow = null; }
  }
  function wrFocus(node) { if (node?.isConnected && typeof node.focus === 'function') node.focus({ preventScroll: true }); }
  function wrCloseQuestion(restore = true) {
    const context = wrState.question; if (!context) return;
    wrState.question = null; context.element.remove();
    if (wrState.record) { wrState.record.dialog.inert = false; wrState.record.dialog.removeAttribute('aria-hidden'); }
    if (restore) wrFocus(context.trigger);
    wrRestoreScroll();
  }
  function wrClose(restore = true) {
    ++wrState.detailSequence;
    wrCloseQuestion(false); const context = wrState.record;
    wrState.record = null;
    if (context) { context.closed = true; context.element.remove(); if (restore) wrFocus(context.trigger); }
    wrRestoreScroll();
  }
  function wrCard(label, value, kind = 'info', extra = '', icon = 'clock') {
    const content = `<span class="wr-card-label">${label}</span><strong class="wr-card-value">${value}</strong>`;
    return `<div class="wr-${kind}-card ${extra}">${kind === 'time' ? wrIcon(icon) + `<div class="wr-time-copy">${content}</div>` : content}</div>`;
  }
  function wrAnswerCards(question) {
    return `<div class="wr-answer-grid"><div class="wr-answer-card wr-answer-user"><span class="wr-answer-label">用户答案</span><strong class="wr-answer-value">${wrAnswer(question.answer)}</strong></div><div class="wr-answer-card wr-answer-standard"><span class="wr-answer-label">正确答案</span><strong class="wr-answer-value">${wrAnswer(question.correct_answer, true)}</strong></div></div>`;
  }
  function wrRecordHtml(context) {
    const record = context.record; const avatar = wrImageUrl(record.avatar_url); const review = wrShowReview(context); const disabled = wrCanReview(context) ? '' : 'disabled';
    return `<section class="wr-dialog wr-record-dialog" role="dialog" aria-modal="true" aria-labelledby="wr-record-title" tabindex="-1"><header class="wr-dialog-header"><h2 class="wr-dialog-title" id="wr-record-title"><span class="wr-dialog-icon">${wrIcon('record')}</span>批改记录详情</h2><span class="wr-header-task" title="${esc(record.task_name || record.task_key)}">${esc(record.task_name || record.task_key)}</span><button class="wr-close" id="work-record-close" type="button" aria-label="关闭批改记录详情">${wrIcon('close')}</button></header><div class="wr-dialog-body"><section class="wr-user-card"><div class="wr-avatar">${avatar ? `<img src="${esc(avatar)}" alt="用户头像" referrerpolicy="no-referrer">` : ''}<span class="wr-avatar-placeholder" ${avatar ? 'hidden' : ''}>${wrIcon('person')}</span></div><div class="wr-user-copy"><strong>${esc(record.nickname || record.username || `用户${record.user_id}`)}</strong><span>用户ID：${esc(record.user_id)}</span></div><span class="wr-user-tag wr-status-${esc(record.status)}">${esc(workStatusLabel(record.status))}</span></section><section class="wr-info-grid">${wrCard('记录编号', '#' + esc(record.id))}${wrCard('任务日期', esc(record.task_date || '—'))}${wrCard('员工类型', esc(employeeLabel(record.employee_type)))}${wrCard('本次工资', '¥' + wrMoney(record.wage), 'info', 'wr-wage')}</section><section class="wr-time-grid">${wrCard('开始时间', esc(workDateTime(record.start_at)), 'time')}${wrCard('完成时间', esc(workDateTime(record.submitted_at || record.reviewed_at)), 'time', '', 'complete')}${wrCard('完成耗时', wrDuration(record.duration_seconds), 'time', '', 'duration')}</section><section class="wr-stat-grid">${wrCard('总题数', esc(record.total_questions), 'stat')}${wrCard('答对', esc(record.correct_count), 'stat', 'wr-positive wr-stat-correct')}${wrCard('答错', esc(record.wrong_count), 'stat', 'wr-negative wr-stat-wrong')}</section><section class="wr-answers-panel"><header class="wr-section-header"><div><h3>提交答案</h3><small>按题目逐条查看本次作答与判断结果</small></div><span class="wr-count-tag">共 ${context.questions.length} 题</span></header><div id="wr-current-question" class="wr-current-question"></div><nav class="wr-question-pagination" id="wr-question-pagination" aria-label="题目分页"></nav></section>${review ? `<section class="wr-review-section"><label class="wr-note-field"><span>批改备注</span><textarea id="work-review-note" maxlength="500" rows="3" placeholder="可以填写本次批改说明" ${disabled}>${esc(record.review_note || '')}</textarea></label><p class="wr-feedback" id="work-record-feedback" role="status"></p></section>` : ''}</div><footer class="wr-dialog-footer">${review ? `<div class="wr-footer-review-actions"><button class="wr-button wr-auto-review" id="work-record-auto-review" type="button" ${disabled}>按标准答案批改</button><button class="wr-button wr-save-review" id="work-record-submit" type="button" ${disabled}>保存批改</button></div>` : ''}<button class="wr-button wr-footer-close" id="work-record-cancel" type="button">关闭</button></footer></section>`;
  }
  function wrCurrentVerdict(context, question) {
    const draft = context.results[question.question_uuid];
    return wrCanReview(context) && typeof draft === 'boolean' ? draft : wrJudgement(question);
  }
  function wrQuestionHtml(context) {
    const question = context.questions[context.index];
    if (!question) return '<p class="wr-empty">暂无题目</p>';
    const review = wrShowReview(context); const editable = wrCanReview(context); const choice = context.results[question.question_uuid];
    return `<article class="wr-question-card" data-review-question="${esc(question.question_uuid)}"><div class="wr-question-header"><strong>第 ${context.index + 1} 题</strong>${wrVerdict(wrCurrentVerdict(context, question))}</div><div class="wr-question-uuid">题目编号：<code>${esc(question.question_uuid)}</code></div>${wrAnswerCards(question)}<div class="wr-question-actions"><button class="wr-question-detail" type="button" id="wr-view-question">${wrIcon('eye')}查看题目详情</button>${review ? `<div class="wr-review-controls"><button class="wr-review-choice wr-review-correct ${choice === true ? 'selected' : ''}" data-review-value="1" type="button" ${editable && !context.saving ? '' : 'disabled'}>批改正确</button><button class="wr-review-choice wr-review-wrong ${choice === false ? 'selected' : ''}" data-review-value="0" type="button" ${editable && !context.saving ? '' : 'disabled'}>批改错误</button></div>` : ''}</div></article>`;
  }
  function wrSetQuestion(context, index, focusPage = false) {
    if (context.closed || wrState.record !== context || !Number.isInteger(index) || index < 0 || index >= context.questions.length) return;
    wrCloseQuestion(false); context.index = index;
    context.element.querySelector('#wr-current-question').innerHTML = wrQuestionHtml(context);
    const pagination = context.element.querySelector('#wr-question-pagination');
    pagination.innerHTML = `<button class="wr-page-button wr-page-arrow" data-wr-question-page="${index - 1}" type="button" aria-label="上一题" ${index === 0 ? 'disabled' : ''}>${wrIcon('prev')}</button>${wrPages(index, context.questions.length).map(value => typeof value === 'number' ? `<button class="wr-page-button ${value === index + 1 ? 'wr-current' : ''}" type="button" data-wr-question-page="${value - 1}" ${value === index + 1 ? 'aria-current="page"' : ''}>${value}</button>` : '<span class="wr-page-ellipsis" aria-hidden="true">…</span>').join('')}<button class="wr-page-button wr-page-arrow" data-wr-question-page="${index + 1}" type="button" aria-label="下一题" ${index + 1 >= context.questions.length ? 'disabled' : ''}>${wrIcon('next')}</button>`;
    pagination.querySelectorAll('[data-wr-question-page]').forEach(button => { button.onclick = () => wrSetQuestion(context, Number(button.dataset.wrQuestionPage), true); });
    context.element.querySelector('#wr-view-question').onclick = event => wrOpenQuestion(context, event.currentTarget);
    context.element.querySelectorAll('[data-review-value]').forEach(button => { button.onclick = () => {
      if (!wrCanReview(context) || context.saving) return;
      context.results[context.questions[context.index].question_uuid] = button.dataset.reviewValue === '1';
      wrSetQuestion(context, context.index);
      wrFocus(context.element.querySelector(`[data-review-value="${button.dataset.reviewValue}"]`));
    }; });
    if (focusPage) wrFocus(pagination.querySelector('[aria-current="page"]'));
  }
  function wrBindImages(element) {
    element.querySelectorAll('.wr-avatar img, .wr-question-image').forEach(image => {
      const fail = () => { image.hidden = true; const fallback = image.parentElement.querySelector('.wr-avatar-placeholder, .wr-image-missing'); if (fallback) fallback.hidden = false; };
      image.addEventListener('error', fail, { once: true });
      if (image.complete && image.naturalWidth === 0) fail();
    });
  }
  async function wrOpen(recordId) {
    if (!wrAllowed() || !Number.isSafeInteger(recordId) || recordId < 1) return;
    wrClose(false); const sequence = ++wrState.detailSequence; const token = state.token; const trigger = document.activeElement;
    let data;
    try { data = await api(`/admin/work-records/detail?id=${recordId}`); }
    catch (error) { if (sequence === wrState.detailSequence && wrContext(token) && error?.name !== 'AbortError') alert(error.message); return; }
    if (sequence !== wrState.detailSequence || !wrContext(token)) return;
    if (!data?.record || !Array.isArray(data.questions)) { alert('作业详情数据不完整，请刷新后重试。'); return; }
    const context = { record: data.record, questions: data.questions, results: Object.create(null), index: 0, token, trigger, closed: false, saving: false, submission: null };
    context.questions.forEach(question => { context.results[question.question_uuid] = typeof question.reviewed_correct === 'boolean' ? question.reviewed_correct : null; });
    const element = document.createElement('div'); element.id = 'work-record-modal'; element.className = 'wr-overlay'; context.element = element; element.innerHTML = wrRecordHtml(context);
    context.dialog = element.querySelector('.wr-dialog'); wrState.record = context; wrLockScroll(); document.body.appendChild(element);
    element.querySelector('#work-record-close').onclick = () => wrClose(); element.querySelector('#work-record-cancel').onclick = () => wrClose();
    element.onclick = event => { if (event.target === element && !wrState.question) wrClose(); };
    if (context.questions.length) wrSetQuestion(context, 0);
    else element.querySelector('#wr-current-question').innerHTML = '<p class="wr-empty">暂无题目</p>';
    const automatic = element.querySelector('#work-record-auto-review');
    if (automatic) automatic.onclick = () => {
      if (!wrCanReview(context) || context.saving) return;
      context.questions.forEach(question => { context.results[question.question_uuid] = wrJudgement({ ...question, reviewed_correct: null }); });
      wrSetQuestion(context, context.index);
    };
    const submit = element.querySelector('#work-record-submit'); if (submit) submit.onclick = () => wrSave(context);
    wrBindImages(element); wrFocus(element.querySelector('#work-record-close'));
  }
  function wrOpenQuestion(context, trigger) {
    if (wrState.record !== context || context.closed || !wrContext(context.token)) return;
    wrCloseQuestion(false); const question = context.questions[context.index]; if (!question) return;
    const image = wrImageUrl(question.image_url); const element = document.createElement('div'); element.id = 'work-record-question-modal'; element.className = 'wr-overlay wr-question-overlay';
    element.innerHTML = `<section class="wr-dialog wr-question-dialog" role="dialog" aria-modal="true" aria-labelledby="wr-question-title" tabindex="-1"><header class="wr-dialog-header"><h2 class="wr-dialog-title" id="wr-question-title">题目详情</h2><button class="wr-close" id="wr-question-close" type="button" aria-label="关闭题目详情">${wrIcon('close')}</button></header><div class="wr-question-body"><div class="wr-question-uuid">题目编号：<code>${esc(question.question_uuid)}</code></div><div class="wr-question-image-frame">${image ? `<img class="wr-question-image" src="${esc(image)}" alt="题目图片" referrerpolicy="no-referrer">` : ''}<p class="wr-image-missing" role="status" ${image ? 'hidden' : ''}>${question.image_url ? '题目图片无法显示或地址无效' : '此题未提供图片'}</p></div>${wrAnswerCards(question)}<div class="wr-result-line">${wrVerdict(wrCurrentVerdict(context, question), true)}</div></div><footer class="wr-dialog-footer"><button class="wr-button wr-footer-close" id="wr-question-cancel" type="button">关闭</button></footer></section>`;
    wrState.question = { element, trigger, parent: context, dialog: element.querySelector('.wr-dialog') };
    context.dialog.inert = true; context.dialog.setAttribute('aria-hidden', 'true'); document.body.appendChild(element);
    element.querySelector('#wr-question-close').onclick = () => wrCloseQuestion(); element.querySelector('#wr-question-cancel').onclick = () => wrCloseQuestion();
    element.onclick = event => { if (event.target === element) wrCloseQuestion(); };
    wrBindImages(element); wrFocus(element.querySelector('#wr-question-close'));
  }
  async function wrSave(context) {
    if (!wrCanReview(context) || context.closed || context.saving || wrState.record !== context) return;
    const feedback = context.element.querySelector('#work-record-feedback');
    if (!context.questions.length || context.questions.some(question => typeof context.results[question.question_uuid] !== 'boolean')) { feedback.textContent = '请完成全部题目的批改后再保存。'; return; }
    const note = context.element.querySelector('#work-review-note').value; const values = Object.fromEntries(context.questions.map(question => [question.question_uuid, context.results[question.question_uuid]]));
    const fingerprint = JSON.stringify({ results: values, note });
    if (!context.submission || context.submission.fingerprint !== fingerprint) context.submission = { fingerprint, requestId: `review-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}` };
    context.saving = true; feedback.textContent = '正在保存批改…';
    context.element.querySelectorAll('#work-record-submit, #work-record-auto-review, #work-review-note, [data-review-value]').forEach(node => { node.disabled = true; });
    try {
      await api('/admin/work-records/review', { method: 'POST', body: JSON.stringify({ record_id: context.record.id, results: values, note, request_id: context.submission.requestId }) });
      if (wrState.record === context) wrClose();
      if (wrContext(context.token)) await wrLoad();
    } catch (error) {
      if (!context.closed && wrState.record === context) {
        feedback.textContent = error.message; context.saving = false;
        context.element.querySelectorAll('#work-record-submit, #work-record-auto-review, #work-review-note, [data-review-value]').forEach(node => { node.disabled = !wrCanReview(context); });
      }
    }
  }
  document.addEventListener('keydown', event => {
    const context = wrState.question || wrState.record; if (!context) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (wrState.question) wrCloseQuestion(); else wrClose(); return; }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(context.dialog.querySelectorAll(focusSelector)).filter(node => !node.hidden && node.getClientRects().length);
    if (!focusable.length) { event.preventDefault(); wrFocus(context.dialog); return; }
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (!context.dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) { event.preventDefault(); wrFocus(event.shiftKey ? last : first); }
  });
  document.addEventListener('focusin', event => {
    const context = wrState.question || wrState.record;
    if (context && !context.dialog.contains(event.target)) wrFocus(context.dialog.querySelector(focusSelector) || context.dialog);
  });
  window.addEventListener('hashchange', () => { if (state.view !== view || !wrAllowed()) wrClose(false); });
  window.AdminWorkRecords = { load: wrLoad, open: wrOpen, close: wrClose };
})();
