// A display-only URL. Downloads and media viewers continue using the original URL.
(function (root) {
  'use strict';
  const scheme = 'pulse-avatar:';
  function original(value) {
    try { const u = new URL(value); return u.protocol === scheme && u.hostname === 'cache' && u.pathname === '/v1'
      ? u.searchParams.get('source') || '' : String(value || ''); } catch { return String(value || ''); }
  }
  function source(value) {
    try {
      const u = new URL(original(value));
      if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.hash || u.href.length > 8192) return null;
      const grants = ['media_expires', 'media_signature', 'media_session', 'media_kind'];
      if (!grants.every(key => u.searchParams.getAll(key).length === 1 && u.searchParams.get(key))) return null;
      let path = decodeURIComponent(u.pathname);
      if (/(?:^|\/)media$/.test(path)) path = u.searchParams.get('path') || '';
      else if (path.includes('/storage/')) path = path.slice(path.indexOf('/storage/') + 9);
      else return null;
      if (!/^uploads\/\d{4}\/(?:0[1-9]|1[0-2])\/[a-f0-9]{32}\.(?:jpg|jpeg|png|gif|webp|avif|bmp)$/.test(path)) return null;
      return u;
    } catch { return null; }
  }
  function display(value, accountId, enabled) {
    if (!enabled || !Number.isSafeInteger(accountId) || accountId <= 0 || !source(value)) return String(value || '');
    const u = new URL('pulse-avatar://cache/v1'); u.searchParams.set('account', String(accountId)); u.searchParams.set('source', original(value)); return u.href;
  }
  function identity(value) {
    const u = source(value); if (!u) return original(value);
    u.searchParams.delete('media_expires'); u.searchParams.delete('media_signature'); u.searchParams.sort(); return u.href;
  }
  const api = { scheme, original, source, display, identity };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PulseAvatarSources = Object.freeze(api);
})(typeof window === 'object' ? window : null);
