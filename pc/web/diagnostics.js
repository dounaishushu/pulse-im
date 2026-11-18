// Load before other application scripts so a bootstrap error is recorded too.
(() => {
  let count = 0, start = Date.now();
  function report(kind, details) {
    const now = Date.now(); if (now - start >= 60000) { count = 0; start = now; }
    if (++count > 30) return;
    try { window.pulseDesktop?.reportDiagnostic?.({ kind, ...details }); } catch { /* Reporting cannot break the page. */ }
  }
  addEventListener('error', event => {
    if (event.target !== window) {
      if (['SCRIPT', 'LINK'].includes(event.target?.tagName)) report('resource-load-failed', { source: event.target.src || event.target.href });
      return;
    }
    report('renderer-error', { name: event.error?.name, message: event.message, stack: event.error?.stack, source: event.filename, line: event.lineno, column: event.colno });
  }, true);
  addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    report('unhandled-rejection', { name: reason?.name, message: typeof reason === 'string' ? reason : reason?.message || 'Promise rejected', stack: reason?.stack });
  });
  if (window.pulseDesktop?.reportDiagnostic && globalThis.PerformanceObserver?.supportedEntryTypes?.includes('long-animation-frame')) {
    let lastSlowFrame = -Infinity;
    try {
      new PerformanceObserver(list => {
        const now = performance.now();
        if (now - lastSlowFrame < 15000) return;
        const entry = list.getEntries().reduce((slowest, frame) => !slowest || frame.duration > slowest.duration ? frame : slowest, null);
        if (!entry || entry.duration < 200) return;
        lastSlowFrame = now;
        const scripts = Array.from(entry.scripts || []).sort((a, b) => b.duration - a.duration).slice(0, 3).map(script => {
          let file = '';
          try {
            const source = new URL(script.sourceURL);
            if (source.origin === location.origin || source.protocol === 'pulse-app:' && source.hostname === 'client') file = source.pathname.split('/').at(-1);
          } catch { /* Inline or unavailable source. */ }
          return { file, name: script.sourceFunctionName, ms: script.duration, forcedLayoutMs: script.forcedStyleAndLayoutDuration };
        });
        report('renderer-slow-frame', { durationMs: entry.duration, blockedMs: entry.blockingDuration,
          startedAtMs: performance.timeOrigin + entry.startTime, renderMs: entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0, visible: !document.hidden, scripts });
      }).observe({ type: 'long-animation-frame' });
    } catch { /* Older Chromium can still report renderer-unresponsive. */ }
  }
  addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      if (document.querySelector('.pc-auth-start') || document.body?.childElementCount === 0)
        report('renderer-startup-stalled', { message: 'Application content was not mounted after 30 seconds' });
    }, 30000);
  }, { once: true });
})();
