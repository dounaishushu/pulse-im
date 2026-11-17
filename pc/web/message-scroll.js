/* Keep live messages visible through asynchronous rendering and media resizing. */
(() => {
  let binding;
  window.PulseMessageScroll = Object.freeze({
    followLatest(options) { return binding?.followLatest(options); },
    shouldFollowIncoming() { return binding?.shouldFollowIncoming() ?? false; },
    positionRevision() { return binding?.positionRevision() ?? 0; },
    bind({ container, context }) {
      binding?.dispose();
      if (!container) return;
      const abort = new AbortController(), rows = new Set();
      let following = null, frame = 0, scope = null, readerPaused = false, revision = 0;
      let readerPointer = null, resumeAtBottom = null;
      const same = (a, b) => a.token === b.token && a.userId === b.userId && a.id === b.id && a.navigation === b.navigation;
      const valid = c => container.isConnected && c.allowed && c.id > 0 && !c.located;
      const gap = () => container.scrollHeight - container.scrollTop - container.clientHeight;
      function currentContext() {
        const current = context();
        if (!scope || !same(scope, current)) {
          scope = { ...current }; following = null; readerPaused = false;
          readerPointer = null; resumeAtBottom = null; revision++;
        }
        return current;
      }
      function shouldFollowIncoming() {
        const current = currentContext();
        return valid(current) && !readerPaused && (Boolean(following && same(following, current)) || gap() < 40);
      }
      function positionRevision() { currentContext(); return revision; }
      function refresh() {
        const current = currentContext();
        if (following && (!valid(current) || !same(following, current))) following = null;
        // Only a deliberate downward scroll, scrollbar release, or explicit
        // send can resume following. A layout clamp is not a reader gesture.
        if (readerPaused && resumeAtBottom && readerPointer === null && valid(current) && gap() <= 2
            && resumeAtBottom.height === container.scrollHeight && resumeAtBottom.viewport === container.clientHeight) {
          readerPaused = false; resumeAtBottom = null; following = { ...current }; revision++;
        }
        if (following && !readerPaused) container.scrollTop = container.scrollHeight;
      }
      function schedule() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; refresh(); }); }
      function pause() { currentContext(); following = null; readerPaused = true; resumeAtBottom = null; revision++; }
      function requestResume() {
        currentContext(); resumeAtBottom = { height: container.scrollHeight, viewport: container.clientHeight }; schedule();
      }
      function followLatest({ force = false } = {}) {
        const current = currentContext();
        if (force) { readerPaused = false; readerPointer = null; resumeAtBottom = null; revision++; }
        if (!valid(current) || readerPaused) return false;
        following = { ...current };
        refresh(); schedule();
        return true;
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
      container.addEventListener('wheel', event => {
        if (event.deltaY < 0) pause();
        else if (event.deltaY > 0) requestResume();
      }, options);
      container.addEventListener('touchmove', pause, options);
      container.addEventListener('pointerdown', event => {
        if (event.pointerType === 'touch' || event.clientX >= container.getBoundingClientRect().right - (container.offsetWidth - container.clientWidth || 14)) {
          pause(); readerPointer = event.pointerId;
        }
      }, options);
      const finishPointer = event => {
        if (readerPointer !== event.pointerId) return;
        readerPointer = null; revision++; requestResume();
      };
      document.addEventListener('pointerup', finishPointer, options);
      document.addEventListener('pointercancel', finishPointer, options);
      document.addEventListener('keydown', event => {
        if (event.target?.closest?.('input,textarea,[contenteditable="true"]')) return;
        if (!valid(currentContext())) return;
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pause();
        else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) requestResume();
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
      binding = { followLatest, shouldFollowIncoming, positionRevision, dispose };
    }
  });
})();
