const menu = document.getElementById('menu'), accounts = document.getElementById('accounts'), submenu = document.getElementById('submenu');
let model = { rows: [] }, expandedKey = null;
const act = (action, key) => window.pulseTray.act(action, key);
function collapse() {
  expandedKey = null; submenu.hidden = true; submenu.replaceChildren();
  accounts.querySelectorAll('.expanded').forEach(e => e.classList.remove('expanded'));
  accounts.querySelectorAll('.more').forEach(e => e.setAttribute('aria-expanded', 'false'));
}
function expand(row, owner, focus = false) {
  collapse(); expandedKey = row.key; owner.classList.add('expanded');
  owner.querySelector('.more').setAttribute('aria-expanded', 'true');
  submenu.setAttribute('aria-label', row.name); submenu.hidden = false;
  for (const [action, label] of [['logout', '退出登录'], ['close-window', '退出窗口'], ['remove-account', '删除此账号']]) {
    const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem';
    button.textContent = label; button.dataset.action = action; button.disabled = action === 'logout' && !row.signedIn;
    button.addEventListener('click', () => act(action, row.key)); submenu.append(button);
  }
  submenu.style.width = model.sideWidth + 'px';
  submenu.style.left = (model.side === 'left' ? model.rootX - model.sideWidth - 2 : model.rootX + model.rootWidth + 2) + 'px';
  submenu.style.top = Math.max(6, Math.min(innerHeight - submenu.offsetHeight - 6, owner.getBoundingClientRect().top)) + 'px';
  if (focus) submenu.querySelector('button:not(:disabled)')?.focus();
}
function render(value) {
  const selected = document.activeElement?.closest('[data-key]')?.dataset.key;
  const arrowFocused = document.activeElement?.classList.contains('more');
  const scroll = accounts.scrollTop, openKey = expandedKey;
  model = value; collapse(); accounts.replaceChildren();
  menu.style.left = value.rootX + 'px'; menu.style.width = value.rootWidth + 'px';
  if (!value.rows.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '没有打开的账号窗口'; accounts.append(empty); }
  for (const row of value.rows) {
    const wrapper = document.createElement('div'); wrapper.className = 'row'; wrapper.dataset.key = row.key;
    const name = document.createElement('button'); name.className = 'name'; name.type = 'button'; name.role = 'menuitem';
    name.title = `打开 ${row.name}${row.locked ? '（已锁定）' : ''}`;
    const check = document.createElement('span'); check.className = 'check'; check.textContent = row.active ? '✓' : '';
    const text = document.createElement('span'); text.className = 'name-text'; text.textContent = row.name;
    name.append(check, text);
    if (row.locked) { const status = document.createElement('span'); status.className = 'status'; status.textContent = '已锁定'; name.append(status); }
    name.addEventListener('click', () => act('open', row.key));
    const more = document.createElement('button'); more.className = 'more'; more.type = 'button'; more.role = 'menuitem';
    more.textContent = '›'; more.title = `${row.name}的操作`; more.setAttribute('aria-label', `${row.name}的操作`);
    more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
    more.addEventListener('mouseenter', () => expand(row, wrapper));
    more.addEventListener('click', () => expand(row, wrapper, true));
    name.addEventListener('mouseenter', () => { if (expandedKey && expandedKey !== row.key) collapse(); });
    wrapper.append(name, more); accounts.append(wrapper);
    if (row.key === selected) (arrowFocused ? more : name).focus();
  }
  accounts.scrollTop = scroll;
  if (openKey) {
    const row = value.rows.find(r => r.key === openKey), owner = [...accounts.children].find(e => e.dataset.key === openKey);
    if (row && owner) expand(row, owner);
  }
}
menu.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => act(button.dataset.action)));
document.addEventListener('pointerdown', event => { if (!menu.contains(event.target) && !submenu.contains(event.target)) act('dismiss'); });
accounts.addEventListener('scroll', collapse);
document.addEventListener('keydown', event => {
  const focused = document.activeElement;
  if (event.key === 'Escape') { event.preventDefault(); act('dismiss'); return; }
  if (event.key === 'ArrowLeft' && !submenu.hidden) {
    const owner = [...accounts.children].find(e => e.dataset.key === expandedKey);
    collapse(); owner?.querySelector('.more').focus(); event.preventDefault(); return;
  }
  if (event.key === 'ArrowRight' && focused?.closest('.row')) {
    const owner = focused.closest('.row'), row = model.rows.find(r => r.key === owner.dataset.key);
    if (row) expand(row, owner, true); event.preventDefault(); return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    const candidates = [...(!submenu.hidden && submenu.contains(focused) ? submenu : menu).querySelectorAll('button:not(:disabled)')];
    const index = candidates.indexOf(focused), delta = event.key === 'ArrowUp' ? -1 : 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? candidates.length - 1 : (index + delta + candidates.length) % candidates.length;
    candidates[next]?.focus(); event.preventDefault();
  }
});
window.pulseTray.onContent(render);
