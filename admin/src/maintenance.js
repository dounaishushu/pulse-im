(() => {
  let current = null;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const status = { queued:'等待执行', running:'清理中', completed:'已完成', failed:'执行失败', cancelled:'已取消' };
  const reasons = { INACTIVE:'符合离线期限', RECENTLY_ACTIVE:'近期已上线', INTERNAL_STAFF:'内部人员保护', GROUP_MANAGER:'群管理者保护', UNSETTLED_FUNDS:'有未结算资金', NOT_ACTIVE:'账号状态已改变', POLICY_CHANGED:'计划已变更', PERMISSION_REVOKED:'管理员权限已撤销', CLEANUP_ERROR:'清理异常，请检查服务日志' };
  const bytes = n => n >= 1048576 ? (n/1048576).toFixed(2)+' MB' : n >= 1024 ? (n/1024).toFixed(1)+' KB' : n+' B';
  const requestId = () => 'maintenance-'+crypto.randomUUID();
  function close() { if (current) { current.closed=true; clearTimeout(current.timer); current.controller.abort(); current.modal?.remove(); current=null; } }
  async function mount({ root, api, canManage, notify }) {
    close();
    const view = current = { root, closed:false, controller:new AbortController(), timer:0, modal:null, selected:new Set(), preview:null, requests:new Map(), busy:false };
    const alive = () => current===view&&!view.closed&&root.isConnected;
    const get = id => root.querySelector('#'+id);
    const request = (path, options={}) => api('/admin/maintenance/'+path,{...options,signal:view.controller.signal});
    const [config, history] = await Promise.all([request('config'),request('runs')]);
    if (!alive()) return;
    view.config=config;
    root.innerHTML=`<div class="page-title"><div><div class="title-eyebrow">系统维护</div><h2>数据清理</h2><p>按最后活跃时间筛选账号，预览后选择清理，或设置自动执行计划。</p></div></div><div class="maintenance-page">
      <section class="panel maintenance-card"><div class="panel-head"><div><h3>未上线账号清理</h3><p>综合登录、心跳和使用记录判断。内部人员、群管理者及未结算资金账号自动保留。</p></div><span class="panel-tag">可恢复</span></div>
      <form id="maintenance-preview-form" class="maintenance-inline"><label>超过 <input id="maintenance-days" type="number" min="1" max="3650" required value="${config.inactive_days}" aria-label="未上线天数"> 天未上线</label><button class="primary" id="maintenance-preview" type="submit">预览账号</button><button class="maintenance-danger" id="maintenance-delete" type="button" disabled>清理选中账号</button><span id="maintenance-selected" role="status">尚未预览</span></form>
      <p class="maintenance-note">清理后账号不能登录，可在用户管理的“已删除”列表恢复。聊天记录、图片和作业工资记录保留。</p><div id="maintenance-candidates" aria-live="polite"><p class="no-data">先选择天数，点击“预览账号”。</p></div></section>
      <div class="maintenance-grid"><section class="panel maintenance-card"><div class="panel-head"><div><h3>缓存与过期数据</h3><p>仅清理过期缓存、过期登录凭据和旧运行日志。</p></div></div><form id="maintenance-cache-form" class="maintenance-inline"><label>凭据与日志保留 <input id="maintenance-cache-days" type="number" min="7" max="365" required value="${config.cache_days}" aria-label="缓存日志保留天数"> 天</label><button id="maintenance-cache-preview" class="table-action" type="submit">查看可清理数据</button></form><div id="maintenance-cache-summary" class="maintenance-cache-summary">尚未扫描</div><button class="primary" id="maintenance-cache-run" type="button" disabled>清理过期缓存</button><p class="maintenance-note">保留有效登录、设备绑定、聊天媒体及后台审计日志。清理可释放空间，访问速度也取决于数据库和网络。</p></section>
      <section class="panel maintenance-card"><div class="panel-head"><div><h3>定时清理</h3><p>关闭页面后也会按计划执行，时间按北京时间。</p></div><span id="maintenance-worker" class="status"></span></div><form id="maintenance-plan-form" class="maintenance-plan"><label class="maintenance-check"><input id="maintenance-enabled" type="checkbox" ${config.enabled?'checked':''}>启用定时清理</label><div class="maintenance-inline"><label>每 <input id="maintenance-interval" type="number" min="1" max="30" required value="${config.interval_days}" aria-label="执行间隔天数"> 天</label><label>执行时间 <input id="maintenance-time" type="time" required value="${esc(config.run_time)}"></label></div><label class="maintenance-check"><input id="maintenance-plan-accounts" type="checkbox" ${config.clean_accounts?'checked':''}>清理 <input id="maintenance-plan-days" type="number" min="1" max="3650" required value="${config.inactive_days}" aria-label="定时未上线天数"> 天未上线的符合条件账号</label><label class="maintenance-check"><input id="maintenance-plan-cache" type="checkbox" ${config.clean_cache?'checked':''}>清理过期缓存，凭据与日志保留 <input id="maintenance-plan-cache-days" type="number" min="7" max="365" required value="${config.cache_days}" aria-label="定时缓存保留天数"> 天</label><p id="maintenance-next" class="maintenance-note"></p><button id="maintenance-plan-save" class="primary" type="submit">保存清理计划</button></form></section></div>
      <section class="panel maintenance-card"><div class="panel-head"><div><h3>执行记录</h3><p>查看实际清理数量、跳过原因和任务状态。</p></div><button class="table-action" id="maintenance-history-refresh">刷新记录</button></div><div id="maintenance-history"></div></section><p id="maintenance-feedback" role="alert" class="maintenance-feedback" hidden></p></div>`;
    const feedback = (text, error=false) => { if (!alive()) return; const node=get('maintenance-feedback');node.textContent=text;node.hidden=!text;node.classList.toggle('is-error',error); };
    function updateWorker(value) { if(!alive())return;get('maintenance-worker').textContent=value.worker_online?'定时服务运行中':'定时服务未连接';get('maintenance-worker').classList.toggle('active',value.worker_online);get('maintenance-next').textContent=value.enabled?`下次执行：${value.next_run_at||'待安排'}（北京时间）`:'自动清理已关闭；手动清理仍可使用。'; }
    updateWorker(config);
    function selected() { get('maintenance-selected').textContent=view.preview?`符合条件 ${view.preview.total} 个 · 本页选中 ${view.selected.size} 个`:'尚未预览';get('maintenance-delete').disabled=!canManage||view.busy||!view.selected.size; }
    function candidates(data) {
      view.preview=data;view.selected.clear();
      get('maintenance-candidates').innerHTML=`<div class="table-wrap"><table class="maintenance-table"><thead><tr><th><input id="maintenance-select-all" type="checkbox" aria-label="全选本页账号" ${canManage?'':'disabled'}></th><th>账号 / 用户ID</th><th>昵称</th><th>最后活跃时间</th><th>未上线天数</th></tr></thead><tbody>${data.items.map(item=>`<tr><td><input type="checkbox" data-maintenance-user="${Number(item.id)}" aria-label="选择账号 ${esc(item.username||item.public_id)}" ${canManage?'':'disabled'}></td><td><b>${esc(item.username||'-')}</b><small>${esc(item.public_id)}</small></td><td>${esc(item.nickname)}</td><td>${esc(item.last_active_at)}</td><td>${Number(item.offline_days)} 天</td></tr>`).join('')||'<tr><td colspan="5" class="no-data">没有符合条件的账号</td></tr>'}</tbody></table></div><div class="maintenance-pagination"><span>第 ${data.page} 页 / 共 ${Math.max(1,Math.ceil(data.total/data.size))} 页，每页 ${data.size} 个</span><button class="table-action" data-maintenance-page="${data.page-1}" ${data.page<=1?'disabled':''}>上一页</button><button class="table-action" data-maintenance-page="${data.page+1}" ${data.page*data.size>=data.total?'disabled':''}>下一页</button></div>`;
      const sync=()=>{view.selected=new Set([...root.querySelectorAll('[data-maintenance-user]:checked')].map(n=>Number(n.dataset.maintenanceUser)));selected();};
      root.querySelectorAll('[data-maintenance-user]').forEach(n=>n.onchange=sync);
      get('maintenance-select-all').onchange=event=>{root.querySelectorAll('[data-maintenance-user]').forEach(n=>n.checked=event.target.checked);sync();};
      root.querySelectorAll('[data-maintenance-page]').forEach(n=>n.onclick=()=>preview(Number(n.dataset.maintenancePage),data.inactive_days));selected();
    }
    async function preview(page=1, days=Number(get('maintenance-days').value)) {
      get('maintenance-preview').disabled=true;feedback('');
      try { const data=await request(`preview?days=${encodeURIComponent(days)}&page=${page}`);if(alive())candidates(data); }
      catch(error){if(alive()&&error.name!=='AbortError')feedback(error.message,true);}
      finally{if(alive())get('maintenance-preview').disabled=false;}
    }
    function historyTable(data) {
      get('maintenance-history').innerHTML=`<div class="table-wrap"><table class="maintenance-table"><thead><tr><th>任务</th><th>执行方式</th><th>状态</th><th>清理账号</th><th>跳过账号</th><th>缓存结果</th><th>执行时间</th><th>操作</th></tr></thead><tbody>${data.items.map(item=>`<tr><td>#${Number(item.id)}</td><td>${item.trigger_type==='scheduled'?'定时':'手动'}</td><td>${esc(status[item.status]||item.status)}</td><td>${Number(item.deleted_count)}</td><td>${Number(item.skipped_count)}</td><td>${item.cache?`过期记录 ${Object.values(item.cache.database_rows||{}).reduce((a,b)=>a+Number(b),0)} 条；文件 ${Number(item.cache.files?.files||0)} 个`:'-'}</td><td>${esc(item.finished_at||item.started_at||item.created_at)}</td><td><button class="table-action" data-maintenance-run="${Number(item.id)}">详情</button></td></tr>`).join('')||'<tr><td colspan="8" class="no-data">暂无清理记录</td></tr>'}</tbody></table></div><div class="maintenance-pagination"><span>共 ${Number(data.total)} 条</span><button class="table-action" data-maintenance-history-page="${data.page-1}" ${data.page<=1?'disabled':''}>上一页</button><button class="table-action" data-maintenance-history-page="${data.page+1}" ${data.page*data.size>=data.total?'disabled':''}>下一页</button></div>`;
      root.querySelectorAll('[data-maintenance-run]').forEach(n=>n.onclick=()=>detail(Number(n.dataset.maintenanceRun)));
      root.querySelectorAll('[data-maintenance-history-page]').forEach(n=>n.onclick=()=>refreshHistory(Number(n.dataset.maintenanceHistoryPage)));
    }
    async function refreshHistory(page=1) { try{const data=await request('runs?page='+page);if(alive())historyTable(data);}catch(error){if(alive()&&error.name!=='AbortError')feedback(error.message,true);} }
    function dialog(title, html, confirmLabel, action) {
      if(!alive())return;view.modal?.remove();
      const modal=document.createElement('div');modal.className='user-modal-backdrop';modal.id='maintenance-modal';
      modal.innerHTML=`<section class="user-modal maintenance-modal" role="dialog" aria-modal="true" aria-labelledby="maintenance-modal-title"><button class="user-modal-close" type="button" data-maintenance-close aria-label="关闭">×</button><h2 id="maintenance-modal-title">${esc(title)}</h2><div class="maintenance-modal-body">${html}</div><p role="alert" data-maintenance-modal-error class="maintenance-feedback is-error"></p><div class="batch-modal-actions">${action?`<button type="button" class="maintenance-danger" id="maintenance-confirm">${esc(confirmLabel)}</button>`:''}<button type="button" class="modal-cancel" data-maintenance-close>${action?'取消':'关闭'}</button></div></section>`;
      const dispose=()=>{if(modal.dataset.busy)return;modal.remove();};modal.querySelectorAll('[data-maintenance-close]').forEach(n=>n.onclick=dispose);modal.onclick=e=>{if(e.target===modal)dispose();};
      modal.onkeydown=e=>{if(e.key==='Escape')dispose();};document.body.append(modal);view.modal=modal;
      if(action) modal.querySelector('#maintenance-confirm').onclick=async()=>{
        if(modal.dataset.busy||!alive())return;modal.dataset.busy='1';modal.querySelectorAll('button').forEach(n=>n.disabled=true);
        try{await action();if(alive())modal.remove();}
        catch(error){if(alive()){modal.querySelector('[data-maintenance-modal-error]').textContent=error.message;delete modal.dataset.busy;modal.querySelectorAll('button').forEach(n=>n.disabled=false);}}
      };
      modal.querySelector('[data-maintenance-close]').focus();
    }
    async function detail(id) {
      try{const item=await request('run?id='+id);if(!alive())return;
        dialog('清理记录 #'+id,`<p>状态：${esc(status[item.status]||item.status)}；清理 ${Number(item.deleted_count)} 个，跳过 ${Number(item.skipped_count)} 个。</p>${item.error_code?`<p>${esc(reasons[item.error_code]||item.error_code)}</p>`:''}${item.cache?`<p>释放文件空间：${bytes(item.cache.files?.bytes||0)}；未能清理 ${Number(item.cache.files?.failed||0)} 个文件。</p>${item.cache.database_limited||item.cache.files?.scan_limited?'<p>达到本次处理限额，可再次执行或等待下次计划。</p>':''}`:''}<div class="table-wrap"><table class="maintenance-table"><thead><tr><th>用户编号</th><th>结果</th><th>原因</th></tr></thead><tbody>${(item.users||[]).map(u=>`<tr><td>${Number(u.user_id)}</td><td>${u.outcome==='deleted'?'已清理':'已跳过'}</td><td>${esc(reasons[u.reason]||u.reason)}</td></tr>`).join('')||'<tr><td colspan="3">无账号明细</td></tr>'}</tbody></table></div><p class="maintenance-note">账号明细最多显示200条。</p>`,'',null);
      }catch(error){if(alive())feedback(error.message,true);}
    }
    async function start(options) {
      if(!canManage||!alive())return;
      const key=JSON.stringify(options);if(!view.requests.has(key))view.requests.set(key,requestId());
      view.busy=true;selected();
      try {
        const job=await request('run',{method:'POST',body:JSON.stringify({...options,confirmation:'CLEAN_SELECTED_DATA',request_id:view.requests.get(key)})});
        if(!alive())return;
        view.requests.delete(key);feedback(`任务 #${job.id} ${status[job.status]||job.status}：已清理 ${Number(job.deleted_count)} 个账号，跳过 ${Number(job.skipped_count)} 个。`);
        await refreshHistory();if(options.clean_accounts&&alive())await preview(1,options.inactive_days);
      } finally {view.busy=false;if(alive())selected();}
    }
    get('maintenance-preview-form').onsubmit=e=>{e.preventDefault();if(e.currentTarget.reportValidity())void preview();};
    get('maintenance-days').oninput=()=>{view.preview=null;view.selected.clear();get('maintenance-candidates').innerHTML='<p class="no-data">天数已改变，请重新预览。</p>';selected();};
    get('maintenance-delete').onclick=()=>{
      if(!canManage||!view.preview||!view.selected.size||view.busy)return;
      const ids=[...view.selected].sort((a,b)=>a-b),days=view.preview.inactive_days;
      dialog('确认清理选中账号',`<p>将清理选中的 <strong>${ids.length}</strong> 个、超过 <strong>${days}</strong> 天未上线的账号。</p><p>执行时会再次核对活跃时间和保护条件，不符合条件的账号将跳过。清理后可在用户管理恢复，聊天、图片和作业工资记录保留。</p>`,'确认清理',()=>start({clean_accounts:true,clean_cache:false,inactive_days:days,cache_days:7,user_ids:ids}));
    };
    get('maintenance-cache-form').onsubmit=async e=>{e.preventDefault();if(!e.currentTarget.reportValidity())return;
      const days=Number(get('maintenance-cache-days').value);get('maintenance-cache-preview').disabled=true;
      try{const result=await request('cache-preview?days='+days);if(!alive())return;view.cache=result;
        const counts=result.database_rows;get('maintenance-cache-summary').innerHTML=`<p>过期用户登录凭据：${Number(counts.auth_tokens)} 条</p><p>过期后台登录凭据：${Number(counts.admin_sessions)} 条</p><p>过期验证码与计数：${Number(counts.registration_captchas)+Number(counts.registration_captcha_rates)} 条</p><p>过期缓存与旧日志：${Number(result.files.files)} 个，约 ${bytes(result.files.bytes)}</p>${result.files.scan_limited?'<p>本次扫描已达限额。</p>':''}`;get('maintenance-cache-run').disabled=!canManage;
      }catch(error){if(alive())feedback(error.message,true);}finally{if(alive())get('maintenance-cache-preview').disabled=false;}
    };
    get('maintenance-cache-days').oninput=()=>{view.cache=null;get('maintenance-cache-run').disabled=true;get('maintenance-cache-summary').textContent='保留天数已改变，请重新扫描。';};
    get('maintenance-cache-run').onclick=()=>{if(!canManage||!view.cache)return;const days=view.cache.cache_days;dialog('确认清理过期缓存',`<p>清理已过期的缓存，以及过期超过 ${days} 天的登录凭据、验证码和超过 ${days} 天的运行日志。</p><p>有效登录、设备绑定、聊天图片和后台审计日志会保留。</p>`,'确认清理',()=>start({clean_accounts:false,clean_cache:true,inactive_days:90,cache_days:days,user_ids:[]}));};
    get('maintenance-plan-form').onsubmit=e=>{e.preventDefault();if(!canManage||!e.currentTarget.reportValidity())return;
      const data={enabled:get('maintenance-enabled').checked,clean_accounts:get('maintenance-plan-accounts').checked,clean_cache:get('maintenance-plan-cache').checked,inactive_days:Number(get('maintenance-plan-days').value),cache_days:Number(get('maintenance-plan-cache-days').value),interval_days:Number(get('maintenance-interval').value),run_time:get('maintenance-time').value,version:view.config.version};
      if(!data.clean_accounts&&!data.clean_cache){feedback('至少选择一种清理内容。',true);return;}
      const save=async()=>{const saved=await request('config',{method:'POST',body:JSON.stringify(data)});if(alive()){view.config=saved;updateWorker(saved);feedback('清理计划已保存。');notify?.('清理计划已保存');}};
      if(data.enabled)dialog('确认启用定时清理',`<p>每 ${data.interval_days} 天 ${esc(data.run_time)}（北京时间）执行。</p>${data.clean_accounts?`<p>自动清理超过 ${data.inactive_days} 天未上线、符合条件的普通账号，可在用户管理恢复。</p>`:''}${data.clean_cache?`<p>清理过期缓存，凭据与日志保留 ${data.cache_days} 天。</p>`:''}`,'保存并启用',save);
      else { get('maintenance-plan-save').disabled=true;save().catch(error=>feedback(error.message,true)).finally(()=>{if(alive())get('maintenance-plan-save').disabled=!canManage;}); }
    };
    get('maintenance-history-refresh').onclick=()=>refreshHistory();historyTable(history);
    if(!canManage) {get('maintenance-plan-form').querySelectorAll('input,button').forEach(n=>n.disabled=true);get('maintenance-delete').disabled=true;}
    const poll=async()=>{if(!alive())return;try{const config=await request('config');if(alive()){updateWorker(config);await refreshHistory();}}catch(error){if(alive()&&error.name!=='AbortError')feedback(error.message,true);}finally{if(alive())view.timer=setTimeout(poll,5000);}};
    view.timer=setTimeout(poll,5000);
  }
  globalThis.AdminMaintenance=Object.freeze({mount,close});
})();
