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
  addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      if (document.querySelector('.pc-auth-start') || document.body?.childElementCount === 0)
        report('renderer-startup-stalled', { message: 'Application content was not mounted after 30 seconds' });
    }, 30000);
  }, { once: true });
})();
