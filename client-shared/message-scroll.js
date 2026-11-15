/* Keep live messages visible through asynchronous rendering and media resizing. */
(() => {
  let binding;
  window.PulseMessageScroll = Object.freeze({
    followLatest() { binding?.followLatest(); },
    bind({ container, context }) {
      binding?.dispose();
      if (!container) return;
      const abort = new AbortController(), rows = new Set();
      let following = null, frame = 0;
      const same = (a, b) => a.token === b.token && a.userId === b.userId && a.id === b.id && a.navigation === b.navigation;
      const valid = c => container.isConnected && c.allowed && c.id > 0 && !c.located;
      function refresh() {
        const current = context();
        if (following && (!valid(current) || !same(following, current))) following = null;
        if (following) container.scrollTop = container.scrollHeight;
      }
      function schedule() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; refresh(); }); }
      function pause() { following = null; }
      function followLatest() {
        const current = context();
        if (!valid(current)) return;
        following = { ...current };
        refresh(); schedule();
      }
      const resize = new ResizeObserver(schedule);
      resize.observe(container);
      function watchRows() {
        for (const row of rows) if (row.parentElement !== container) { resize.unobserve(row); rows.delete(row); }
        for (const row of container.children) if (!rows.has(row)) { rows.add(row); resize.observe(row); }
        schedule();
      }
      const changes = new MutationObserver(watchRows);
      changes.observe(container, { childList: true, subtree: true }); watchRows();
      // A render may temporarily shrink the list and clamp scrollTop. Only a
      // reader gesture cancels following; that clamp must not look like a scroll up.
      const options = { signal: abort.signal, passive: true };
      container.addEventListener('scroll', schedule, options);
      container.addEventListener('wheel', event => { if (event.deltaY < 0) pause(); }, options);
      container.addEventListener('touchmove', pause, options);
      container.addEventListener('pointerdown', event => {
        if (event.clientX >= container.getBoundingClientRect().right - (container.offsetWidth - container.clientWidth || 14)) pause();
      }, options);
      document.addEventListener('keydown', event => {
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && !event.target.closest('input,textarea,[contenteditable="true"]')) pause();
      }, { signal: abort.signal });
      container.addEventListener('load', schedule, { signal: abort.signal, capture: true });
      container.addEventListener('loadedmetadata', schedule, { signal: abort.signal, capture: true });
      window.addEventListener('resize', schedule, options);
      window.visualViewport?.addEventListener('resize', schedule, options);
      const dispose = () => {
        abort.abort(); changes.disconnect(); resize.disconnect();
        if (frame) cancelAnimationFrame(frame);
        if (binding?.dispose === dispose) binding = null;
      };
      binding = { followLatest, dispose };
    }
  });
})();
