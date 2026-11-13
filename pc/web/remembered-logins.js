(() => {
  function mount({ root, request, busy, feedback }) {
    if (typeof request !== 'function') return null;
    const input = root.querySelector('#phone'), password = root.querySelector('#password');
    const label = input.closest('label'); label.classList.add('remembered-account-anchor');
    const field = document.createElement('span'); field.className = 'remembered-account-field'; input.replaceWith(field);
    const arrow = document.createElement('button'); arrow.type = 'button'; arrow.className = 'remembered-account-toggle';
    arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    arrow.setAttribute('aria-label', '选择已保存账号'); arrow.setAttribute('aria-expanded', 'false'); field.append(input, arrow);
    const list = document.createElement('div'); list.className = 'remembered-account-list'; list.hidden = true; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '此窗口已保存账号，最多10个'); field.append(list);
    const row = document.createElement('div'); row.className = 'remembered-login-choice';
    row.innerHTML = '<label><input id="remember-password" type="checkbox" checked><span>记住密码</span></label><small>此窗口最多记住10个账号</small>';
    root.querySelector('#login-error').before(row);
    const checkbox = row.querySelector('input');
    let items = [], enabled = true, available = false, disposed = false, revision = 0, filled = null;
    const alive = () => !disposed && root.isConnected;
    const close = () => { list.hidden = true; arrow.setAttribute('aria-expanded', 'false'); };
    function render() {
      list.replaceChildren();
      const heading = document.createElement('small'); heading.className = 'remembered-account-heading'; heading.textContent = '已保存账号（最多10个）'; list.append(heading);
      const matches = items;
      for (const item of matches) {
        const entry = document.createElement('div'); entry.className = 'remembered-account-row';
        const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'remembered-account-pick'; choose.setAttribute('role', 'option');
        const avatar = document.createElement('span'); avatar.className = 'remembered-account-avatar'; avatar.textContent = Array.from(item.nickname || item.account)[0] || '人';
        try { const url = new URL(item.avatarUrl); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) { const image = document.createElement('img'); image.src = url.href; image.alt = ''; image.referrerPolicy = 'no-referrer'; image.onerror = () => image.remove(); avatar.append(image); } } catch {}
        const details = document.createElement('span'), name = document.createElement('strong'), account = document.createElement('small');
        name.textContent = item.nickname || item.account; account.textContent = item.account; details.append(name, account); choose.append(avatar, details);
        choose.onclick = () => select(item);
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remembered-account-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除已记住的账号 ${item.account}`);
        remove.onclick = event => { event.preventDefault(); event.stopPropagation(); forget(item, true); };
        entry.append(choose, remove); list.append(entry);
      }
      if (!matches.length) { const empty = document.createElement('p'); empty.textContent = items.length ? '没有匹配的已保存账号' : '登录成功后可在这里选择账号'; list.append(empty); }
    }
    function open() { if (!enabled || busy() || !alive()) return; render(); list.hidden = false; arrow.setAttribute('aria-expanded', 'true'); }
    async function select(item) {
      const wanted = ++revision; close();
      try {
        const result = await request('get', { id: item.id });
        if (!alive() || revision !== wanted || !enabled || busy()) return;
        input.value = result.account; password.value = result.password; filled = { id: item.id, account: result.account, password: result.password }; checkbox.checked = true;
        password.focus();
      } catch (error) { if (alive() && revision === wanted) feedback(error.message || '无法读取保存的密码，请手动输入'); }
    }
    async function forget(item, clearPassword) {
      const wanted = ++revision, account = item?.account || input.value.trim();
      try {
        await request('remove', { id: item?.id, account });
        if (!alive()) return;
        items = items.filter(value => value.id !== item?.id && value.account.toLowerCase() !== account.toLowerCase());
        if (filled && (item ? filled.id === item.id : filled.account.toLowerCase() === account.toLowerCase())) { if (clearPassword) password.value = ''; filled = null; }
        render();
      } catch (error) { if (alive() && revision === wanted) { checkbox.checked = true; feedback(error.message || '移除保存账号失败，请重试'); } }
    }
    arrow.onclick = () => list.hidden ? open() : close();
    const onFocus = () => open();
    const onInput = () => { ++revision; if (filled && input.value.trim().toLowerCase() !== filled.account.toLowerCase()) { if (password.value === filled.password) password.value = ''; filled = null; } if (!list.hidden) render(); };
    input.addEventListener('focus', onFocus); input.addEventListener('input', onInput);
    const passwordEdited = () => { ++revision; }; password.addEventListener('input', passwordEdited);
    const key = event => { if (event.key === 'Escape') close(); if (event.key === 'ArrowDown' && enabled) { event.preventDefault(); open(); list.querySelector('.remembered-account-pick')?.focus(); } };
    input.addEventListener('keydown', key);
    const outside = event => { if (!label.contains(event.target)) close(); }; document.addEventListener('pointerdown', outside);
    checkbox.onchange = () => { if (!checkbox.checked) forget(filled ? items.find(item => item.id === filled.id) : null, false); };
    const initial = revision;
    Promise.resolve().then(() => request('list')).then(result => {
      if (!alive()) return;
      items = Array.isArray(result?.items) ? result.items.slice(0, 10) : [];
      available = result?.available === true; checkbox.disabled = busy() || !available;
      if (!result?.available) { checkbox.checked = false; row.querySelector('small').textContent = '暂时无法安全记住密码'; }
      if (!list.hidden) render();
      if (enabled && revision === initial && !input.value && !password.value && items.length) select(items[0]);
    }).catch(error => { if (alive()) feedback(error.message || '无法读取已保存账号'); });
    return {
      checked: () => checkbox.checked && !checkbox.disabled,
      syncBusy() { checkbox.disabled = busy() || !available; arrow.disabled = busy(); if (busy()) close(); },
      setEnabled(value) { enabled = value; arrow.hidden = !value; close(); if (!value && filled) { if (password.value === filled.password) password.value = ''; filled = null; ++revision; } },
      dispose() { disposed = true; ++revision; filled = null; input.removeEventListener('focus', onFocus); input.removeEventListener('input', onInput); password.removeEventListener('input', passwordEdited); input.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); close(); },
    };
  }
  window.PulseRememberedLogins = Object.freeze({ mount });
})();
