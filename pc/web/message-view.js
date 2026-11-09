// Keep live media nodes across background synchronization and recent chat visits.
(function (root) {
  'use strict';
  const renders = new WeakMap(), freshSources = new WeakMap(), errorBound = new WeakSet();
  function mediaIdentity(value) {
    try {
      const url = new URL(root.PulseMediaSources?.original(root.PulseAvatarSources?.original(value) || value) || root.PulseAvatarSources?.original(value) || value, root.document?.baseURI || 'https://media.invalid/');
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
    if (root.PulseAvatarLoader?.retainSource(node, value)) return true;
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
    let record = renders.get(container);
    if (!record) {
      record = { context: null, html: null, dirty: true, observer: null };
      const Observer = container.ownerDocument.defaultView?.MutationObserver;
      if (Observer) {
        record.observer = new Observer(() => { record.dirty = true; });
        record.observer.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      renders.set(container, record);
    }
    if (record.observer?.takeRecords().length) record.dirty = true;
    // Receipts, media controls and retained views can mutate the DOM outside
    // this renderer. Skip parsing only when both the input and DOM are intact.
    if (record.observer && !record.dirty && record.context === context && record.html === html) return;
    const complete = () => {
      record.observer?.takeRecords(); record.context = context; record.html = html; record.dirty = false;
    };
    const template = container.ownerDocument.createElement('template'); template.innerHTML = html;
    if (record.context !== context) {
      container.replaceChildren(template.content); complete(); return;
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
    complete();
  }
  // Retain decoded header images when revisiting a recent chat. Grants stay
  // scoped to their account, origin, session and content version.
  function createAvatarCache({ maxAvatars = 24, maxPixels = 4 * 1024 * 1024 } = {}) {
    let account = null, active = null; const images = new Map();
    function prune() {
      let pixels = [...images.values()].reduce((n, img) => n + img.naturalWidth * img.naturalHeight, 0);
      for (const [key, img] of images) {
        if (images.size <= maxAvatars && pixels <= maxPixels) break;
        if (img === active) continue;
        pixels -= img.naturalWidth * img.naturalHeight; images.delete(key);
      }
    }
    return {
      clear() { account = null; active = null; images.clear(); },
      render(container, source, scope, fallback = '?') {
        if (account !== scope) { images.clear(); active = null; account = scope; }
        if (!source) {
          active = null;
          if (container.textContent !== fallback || container.childElementCount) container.textContent = fallback;
          prune(); return;
        }
        const key = mediaIdentity(source); let img = images.get(key);
        if (img && !retainSource(img, source) && img.getAttribute('src') !== source) img.setAttribute('src', source);
        // Retry a failed image when revisited, without starting a download loop
        // on every repeated refresh of the currently visible header.
        if (img && img !== active && img.complete && !img.naturalWidth) { images.delete(key); img = null; }
        if (!img) {
          img = container.ownerDocument.createElement('img'); img.alt = ''; img.decoding = 'async'; img.src = source;
          const image = img;
          img.addEventListener('load', () => { if (images.get(key) === image) prune(); });
        }
      images.delete(key); images.set(key, img); active = img;
      img.dataset.avatarFallback = fallback;
        if (container.firstChild !== img || container.childNodes.length !== 1) container.replaceChildren(img);
        prune();
      },
    };
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
  const exported = { render, mediaIdentity, retryFreshSource, createCache, createAvatarCache };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.PulseMessageView = exported;
})(typeof window === 'object' ? window : globalThis);
