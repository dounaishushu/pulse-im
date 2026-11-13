// Per-account in-memory composer drafts, shared by the composer and sidebar.
(function (root) {
  'use strict';
  function create({ limit = 100 } = {}) {
    const drafts = new Map(); let owner = '', binding = null;
    const key = account => JSON.stringify([account?.token || '', Number(account?.userId) || 0]);
    const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
    function save(id, input, changed) {
      if (!validId(id)) return;
      id = Number(id);
      const previous = drafts.get(id)?.text || '', text = input.value;
      const affected = new Set(); drafts.delete(id);
      if (text) drafts.set(id, { text, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection || 'none' });
      if (previous !== text) affected.add(id);
      while (drafts.size > limit) { const evicted = drafts.keys().next().value; drafts.delete(evicted); affected.add(evicted); }
      if (affected.size) changed([...affected]);
    }
    function restore(id, input) {
      const draft = drafts.get(Number(id));
      input.value = draft?.text || '';
      input.setSelectionRange(draft?.start || 0, draft?.end || 0, draft?.direction || 'none');
    }
    return {
      text(account, id) { return owner === key(account) ? drafts.get(Number(id))?.text || '' : ''; },
      refresh() { binding?.refresh(); },
      clear() { binding?.dispose(false); binding = null; drafts.clear(); owner = ''; },
      bind({ state, input, changed = () => {} }) {
        binding?.dispose(); binding = null;
        const account = { token: state.token, userId: Number(state.user?.id) }, scope = key(account);
        if (owner !== scope) { drafts.clear(); owner = scope; }
        const sameAccount = () => state.token === account.token && Number(state.user?.id) === account.userId;
        let conversation = Number(state.active?.id) || 0;
        restore(conversation, input);
        const remember = () => { if (sameAccount()) save(conversation, input, changed); };
        const refresh = () => {
          if (!sameAccount() || !input.isConnected) return;
          const next = Number(state.active?.id) || 0;
          if (conversation === next) return;
          const previous = conversation;
          remember(); conversation = next; restore(next, input);
          changed([previous, next].filter(validId));
        };
        input.addEventListener('input', remember);
        const dispose = (keep = true) => { if (keep) remember(); input.removeEventListener('input', remember); };
        binding = { refresh, dispose };
      },
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = { create };
  else root.PulseConversationDrafts = { create };
})(typeof window === 'object' ? window : globalThis);
