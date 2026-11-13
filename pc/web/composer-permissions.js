/* Server-authoritative sending permission; drafts stay in their original input. */
(function (root) {
  'use strict';
  const fields = ['can_send', 'send_disabled_reason', 'my_muted_until', 'all_muted', 'my_role'];
  const yes = value => value === true || value === 1 || value === '1';
  function reason(chat, now = Date.now()) {
    if (!chat) return '';
    if (chat.frozen_at || ['frozen', 'deleted', 'dissolved', 'inactive'].includes(chat.status)) return 'inactive';
    if (chat.can_send === false || chat.can_send === 0) return chat.send_disabled_reason || 'member_muted';
    if (chat.can_send === true || chat.can_send === 1) return '';
    // Older servers still expose group-wide mute and the current member's role.
    const manager = ['owner', 'admin'].includes(chat.my_role);
    if (chat.type === 'channel' && !manager) return 'channel_readonly';
    if (chat.type === 'group' && yes(chat.all_muted) && !manager) return 'group_muted';
    if (chat.my_muted_until && Date.parse(String(chat.my_muted_until).replace(' ', 'T')) > now) return 'member_muted';
    return '';
  }
  const label = value => value === 'inactive' ? '当前会话无法发送消息' : value === 'channel_readonly' ? '仅管理员可发言' : value ? '已禁止发言' : '';
  function create({ context, load, changed = () => {}, blocked = () => {}, now = () => Date.now() }) {
    let owner = '', sequence = 0, snapshots = new Map(), visit = '', flight = null, lastCheck = 0, binding = null;
    function sync() {
      const c = context(), key = c.token && Number(c.userId) > 0 ? JSON.stringify([c.token, Number(c.userId)]) : '';
      if (key !== owner) { owner = key; snapshots.clear(); visit = ''; flight = null; lastCheck = 0; }
      return c;
    }
    const ticket = () => { sync(); return { owner, sequence: ++sequence }; };
    function merge(chat) {
      sync(); const saved = snapshots.get(Number(chat?.id));
      return saved ? { ...chat, ...saved.value } : chat;
    }
    function receive(path, data, stamp, token) {
      const c = sync();
      if (!owner || stamp.owner !== owner || token !== c.token || !/^\/conversations(?:\?|$|\/updates\?|\/info\?|\/groups\/profile(?:\?|$))/.test(path)) return;
      let activeChanged = false;
      for (const row of Array.isArray(data?.items) ? data.items : [data]) {
        if (!row || !(Number(row.id) > 0) || !fields.some(key => Object.hasOwn(row, key))) continue;
        const id = Number(row.id), previous = snapshots.get(id);
        if (previous && previous.sequence > stamp.sequence) { Object.assign(row, previous.value); continue; }
        const value = Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
        snapshots.set(id, { sequence: stamp.sequence, value });
        if (id === Number(c.conversation?.id)) activeChanged = true;
      }
      if (activeChanged) changed();
    }
    function denied(id) { return reason(merge({ ...context().conversation, id }), now()); }
    function check(force = false) {
      const c = sync(), id = Number(c.conversation?.id), next = owner + ':' + id;
      if (next !== visit) { visit = next; lastCheck = 0; flight = null; }
      if (!owner || !c.visible || !['group', 'channel'].includes(c.conversation?.type) || flight || (!force && now() - lastCheck < 5000)) return;
      const task = { owner, visit }, token = c.token; flight = task; lastCheck = now();
      Promise.resolve().then(() => load(id, token)).catch(() => {}).finally(() => { if (flight === task) flight = null; });
    }
    function update() {
      const c = sync(), composer = document.getElementById('composer'), input = document.getElementById('message-input');
      if (!composer || !input) { binding?.dispose(); binding = null; return; }
      if (binding?.input !== input) {
        binding?.dispose();
        const saved = new Map(), notice = document.createElement('div');
        notice.id = 'composer-send-restriction'; notice.className = 'composer-send-restriction'; notice.hidden = true;
        notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); composer.append(notice);
        let current = '', aria = input.getAttribute('aria-label');
        const position = () => {
          if (!current) return;
          notice.style.left = input.offsetLeft + 'px'; notice.style.top = input.offsetTop + 'px';
          notice.style.width = input.offsetWidth + 'px'; notice.style.height = input.offsetHeight + 'px';
        };
        const enforce = () => {
          if (!current) return;
          for (const node of composer.querySelectorAll('input,textarea,button,select')) {
            if (!saved.has(node)) saved.set(node, node.disabled);
            if (!node.disabled) node.disabled = true;
          }
          position();
        };
        const observer = new MutationObserver(enforce); observer.observe(composer, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
        const size = new ResizeObserver(position); size.observe(input); size.observe(composer);
        binding = { input, apply(value) {
          const entered = !current && value; current = value;
          composer.classList.toggle('composer-send-blocked', Boolean(value));
          notice.hidden = !value; if (notice.textContent !== label(value)) notice.textContent = label(value);
          if (value) { input.setAttribute('aria-label', label(value)); input.blur(); enforce(); if (entered) blocked(); }
          else { for (const [node, disabled] of saved) if (node.isConnected) node.disabled = disabled; saved.clear(); if (aria === null) input.removeAttribute('aria-label'); else input.setAttribute('aria-label', aria); }
        }, dispose() { observer.disconnect(); size.disconnect(); notice.remove(); } };
      }
      binding.apply(reason(merge(c.conversation), now())); check();
    }
    return { ticket, receive, merge, reason: chat => reason(merge(chat), now()), update, check,
      assert(chat) { const value = reason(merge(chat), now()); if (value) throw new Error(label(value)); } };
  }
  const api = { create, reason, label };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PulseComposerPermissions = api;
})(typeof window === 'object' ? window : globalThis);
