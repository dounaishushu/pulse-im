(function(root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.PulseMediaSources = factory(); })(globalThis, function() {
  const scheme = 'pulse-media:';
  const imageExtensions = /\.(?:jpg|jpeg|png|gif|webp|avif|bmp)$/i;
  function filePath(u) {
    const pathname = decodeURIComponent(u.pathname);
    if (pathname.endsWith('/media')) return u.searchParams.getAll('path').length === 1 ? u.searchParams.get('path') : null;
    const at = pathname.indexOf('/storage/uploads/');
    return at >= 0 ? pathname.slice(at + 9) : null;
  }
  function rawSource(value) {
    try {
      const u = new URL(String(value)); if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.hash || u.href.length > 8192) return null;
      if(/^\/api\/v2\/media-grants\/[a-f0-9]{64}\/(content|preview)$/.test(u.pathname)&&!u.search)return u;
      for (const name of ['media_expires', 'media_signature', 'media_session', 'media_kind']) if (u.searchParams.getAll(name).length !== 1 || !u.searchParams.get(name)) return null;
      if (!/^uploads\/\d{4}\/(?:0[1-9]|1[0-2])\/[a-f0-9]{32}\.(?:jpg|jpeg|png|gif|webp|avif|bmp|mp4|mov|webm|m4v|mkv|avi|3gp|mpeg|mpg|ogv|wmv|mp3|m4a|aac|amr|wav|ogg|opus|flac|caf)$/i.test(filePath(u) || '')) return null;
      return u;
    } catch { return null; }
  }
  function parseDisplay(value) {
    try {
      const u = new URL(String(value));
      if (u.protocol !== scheme || u.hostname !== 'cache' || u.port || u.pathname !== '/v1' || u.username || u.password || u.hash || u.href.length > 32768) return null;
      const names = ['account', 'conversation', 'message', 'source'];
      if ([...u.searchParams.keys()].some(key => ![...names, 'kind'].includes(key)) || names.some(key => u.searchParams.getAll(key).length !== 1)) return null;
      const kinds = u.searchParams.getAll('kind');
      if (kinds.length > 1 || kinds.length && !['image', 'video', 'audio', 'file'].includes(kinds[0])) return null;
      const result = {};
      for (const key of names.slice(0, 3)) {
        const raw = u.searchParams.get(key), number = Number(raw);
        if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(number)) return null;
        result[key] = number;
      }
      const original = rawSource(u.searchParams.get('source')); if (!original) return null;
      return { ...result, source: original.href, ...(kinds.length ? { kind: kinds[0] } : {}) };
    } catch { return null; }
  }
  function original(value) { return parseDisplay(value)?.source || String(value || ''); }
  function source(value) { return rawSource(original(value)); }
  function isImage(value) { const parsed = parseDisplay(value); if (parsed?.kind) return parsed.kind === 'image'; const u = source(value); return Boolean(u && (/^\/api\/v2\/media-grants\//.test(u.pathname)||imageExtensions.test(filePath(u)))); }
  function identity(value) { const u = source(value); if (!u) return null; u.searchParams.delete('media_expires'); u.searchParams.delete('media_signature'); u.searchParams.sort(); return u.href; }
  function display(value, account, conversation, message, enabled, kind = '') {
    if (!enabled || ![account, conversation, message].every(n => Number.isSafeInteger(Number(n)) && Number(n) > 0) || !source(value)) return original(value);
    const hint = kind === 'voice' ? 'audio' : kind;
    return `pulse-media://cache/v1?account=${account}&conversation=${conversation}&message=${message}&source=${encodeURIComponent(original(value))}${['image','video','audio','file'].includes(hint) ? '&kind='+hint : ''}`;
  }
  return { scheme, original, source, identity, display, parseDisplay, isImage };
});
