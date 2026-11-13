(function () {
  'use strict';
  const bridge = window.pulseDesktop || window.pulseHistoryWindow || window.pulseImageWindow;
  if (!bridge?.mediaConsumers || !window.PulseMediaSources) return;
  const paused = new WeakMap();
  let nodes = new Set(), last = '', visible = true, unlocked = true, queued = false, stopped = false;
  const isCached = value => window.PulseMediaSources.parseDisplay(value) && window.PulseMediaSources.isImage(value);
  function publish(urls) {
    const next = JSON.stringify([...urls].sort());
    if (last === next) return;
    last = next;
    try { Promise.resolve(bridge.mediaConsumers([...urls])).catch(() => { last = ''; }); } catch { last = ''; }
  }
  function pause(node) {
    const url = node.getAttribute('src');
    // A completed decoded image has no pending transfer and can stay in the
    // existing conversation DOM cache. Only interrupted images need a restart.
    if (url && isCached(url) && !(node.complete && node.naturalWidth > 0)) {
      paused.set(node, url); node.setAttribute('data-pulse-media-paused', '');
      node.removeAttribute('src');
    }
  }
  function sync() {
    queued = false;
    if (stopped) return;
    const nextNodes = new Set(document.querySelectorAll('img[src^="pulse-media:"],img[data-pulse-media-paused]'));
    for (const node of nodes) if (!nextNodes.has(node)) pause(node);
    const urls = new Set();
    for (const node of nextNodes) {
      // The viewer hides its own <img> until decoding finishes; only an ancestor
      // being hidden means the user has left this content.
      if (!visible || !unlocked || document.hidden || node.parentElement?.closest('[hidden]')) { pause(node); continue; }
      const saved = paused.get(node);
      if (saved) {
        if (!node.hasAttribute('src')) node.setAttribute('src', saved);
        paused.delete(node); node.removeAttribute('data-pulse-media-paused');
      }
      const url = node.getAttribute('src');
      if (isCached(url) && urls.size < 2048) urls.add(url);
    }
    nodes = nextNodes;
    publish(urls);
  }
  function schedule() { if (!queued && !stopped) { queued = true; queueMicrotask(sync); } }
  const observer = new MutationObserver(schedule);
  function start() {
    if (stopped) return;
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'hidden'] });
    sync();
  }
  // Hidden account views retain their DOM, but should not keep image transfers
  // ahead of the account the user is reading. Other windows publish separately.
  const unsubscribe = bridge.onAccountVisibilityChanged?.(value => { visible = value.active !== false; schedule(); });
  const unsubscribeSession = bridge.onSessionChanged?.(value => { if (typeof value.locked === 'boolean') { unlocked = !value.locked; schedule(); } });
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('pagehide', () => { stopped = true; observer.disconnect(); unsubscribe?.(); unsubscribeSession?.(); document.removeEventListener('visibilitychange', schedule); publish(new Set()); nodes.clear(); }, { once: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
