// Keep live media nodes across background synchronization and recent chat visits.
(function (root) {
  'use strict';
  const contexts = new WeakMap(), freshSources = new WeakMap(), errorBound = new WeakSet();
  function mediaIdentity(value) {
    try {
      const url = new URL(value, root.document?.baseURI || 'https://media.invalid/');
      const grant = ['media_expires', 'media_signature', 'media_session', 'media_kind'];
      if (grant.every(key => url.searchParams.has(key))) {
        // These two values rotate for the same file. Keep the session, kind,
        // origin, path and every content/version parameter in its identity.
        url.searchParams.delete('media_expires'); url.searchParams.delete('media_signature');
        url.searchParams.sort();
      }
      return url.href;
    } catch { return String(value || ''); }
  }
  function retryFreshSource(node) {
    const value = freshSources.get(node);
    if (!value || value === node.getAttribute('src')) return false;
    freshSources.delete(node); node.setAttribute('src', value); return true;
  }
  function retainSource(node, value) {
    if (!node.matches('img,video,audio,source')) return false;
    const previous = node.getAttribute('src');
    if (!previous || mediaIdentity(previous) !== mediaIdentity(value)) { freshSources.delete(node); return false; }
    // A failed load may use the newly issued grant immediately. Loaded and
    // still-loading images keep their existing request and decoded pixels.
    if (node.matches('img') && node.complete && !node.naturalWidth) { freshSources.delete(node); return false; }
    freshSources.set(node, value);
    if (!errorBound.has(node)) {
      errorBound.add(node);
      node.addEventListener('error', event => {
        if (node.isConnected && retryFreshSource(node)) event.stopImmediatePropagation();
      }, true);
    }
    return true;
  }
  function rowKey(node) {
    if (node.nodeType !== 1) return null;
    if (node.matches('.conversation[data-id]')) return 'conversation:' + node.dataset.id;
    if (node.matches('.bubble[data-message-id]')) return 'message:' + node.dataset.messageId;
    if (node.matches('[data-outbox-id]')) return 'outbox:' + node.dataset.outboxId;
    return null;
  }
  function keepOpenedMedia(node, desired) {
    if (node?.nodeType !== 1 || desired.nodeType !== 1) return false;
    const url = desired.getAttribute('data-media-load-url') || (desired.hasAttribute('data-gif-play') ? desired.getAttribute('data-gif-url') : '');
    if (!url || !node.matches('img.message-image,video.message-video,a.file-link,a.classic-image-media')) return false;
    const media = node.matches('img,video') ? node : node.querySelector('img');
    const previous = media?.getAttribute('src') || node.getAttribute('href');
    if (mediaIdentity(previous) !== mediaIdentity(url)) return false;
    if (media && media.getAttribute('src') !== url && !retainSource(media, url)) media.setAttribute('src', url);
    if (node.matches('a')) node.setAttribute('href', url);
    if (node.hasAttribute('data-download-url')) node.setAttribute('data-download-url', url);
    return true;
  }
  function render(container, html, context) {
    const template = container.ownerDocument.createElement('template'); template.innerHTML = html;
    if (contexts.get(container) !== context) {
      container.replaceChildren(template.content); contexts.set(container, context); return;
    }
    const rows = new Map([...container.querySelectorAll('.conversation[data-id],.bubble[data-message-id],[data-outbox-id]')].map(node => [rowKey(node), node]));
    const sync = (parent, desired) => {
      let cursor = parent.firstChild;
      for (const next of [...desired.childNodes]) {
        const key = rowKey(next);
        const opened = keepOpenedMedia(cursor, next);
        const compatible = cursor && cursor.nodeType === next.nodeType && cursor.nodeName === next.nodeName
          && !rowKey(cursor) && !key && (next.nodeType !== 1 || cursor.id === next.id);
        const current = (opened ? cursor : key ? rows.get(key) : compatible ? cursor : null) || next.cloneNode(false);
        if (!opened && !current.isEqualNode(next)) {
          if (next.nodeType === 1) {
            for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
            for (const attribute of next.attributes) {
              if (current.getAttribute(attribute.name) === attribute.value) continue;
              if (attribute.name === 'src' && retainSource(current, attribute.value)) continue;
              current.setAttribute(attribute.name, attribute.value);
            }
            sync(current, next);
          } else current.nodeValue = next.nodeValue;
        }
        if (current !== cursor) parent.insertBefore(current, cursor);
        cursor = current.nextSibling;
      }
      while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
    };
    sync(container, template.content);
  }
  function createCache({ maxViews = 8, maxMessages = 600 } = {}) {
    let account = '', owner = null; const views = new Map();
    const scope = key => { if (account !== key) { account = key; owner = null; views.clear(); } };
    return {
      clear() { account = ''; owner = null; views.clear(); },
      claim(key, id, container) { scope(key); owner = { id: Number(id), container }; },
      owns(key, id, container) { scope(key); return owner?.id === Number(id) && owner.container === container; },
      remember(key, id, container, metadata) {
        scope(key);
        if (owner?.id !== Number(id) || owner.container !== container) return false;
        const count = container.querySelectorAll('[data-message-id]').length;
        const fragment = container.ownerDocument.createDocumentFragment();
        while (container.firstChild) fragment.append(container.firstChild);
        views.delete(Number(id)); views.set(Number(id), { fragment, count, metadata }); owner = null;
        let total = [...views.values()].reduce((sum, view) => sum + view.count, 0);
        while (views.size > maxViews || total > maxMessages) {
          const first = views.keys().next().value; total -= views.get(first).count; views.delete(first);
        }
        return true;
      },
      take(key, id, container) {
        scope(key); const view = views.get(Number(id)); if (!view) return null;
        views.delete(Number(id)); container.replaceChildren(view.fragment); owner = { id: Number(id), container };
        return view.metadata;
      },
      forget(key, id) { scope(key); views.delete(Number(id)); if (owner?.id === Number(id)) owner = null; },
    };
  }
  const exported = { render, mediaIdentity, retryFreshSource, createCache };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.PulseMessageView = exported;
})(typeof window === 'object' ? window : globalThis);
