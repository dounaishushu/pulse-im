/* Drag-copy uses message text only; UI timestamps never enter the clipboard. */
(() => {
  'use strict';
  const installed = Symbol.for('pulse.messageCopy');
  if (document[installed]) return;
  document[installed] = true;
  const excluded = '#messages .classic-message-meta, #history-list .history-bubble > time, .message-menu-time';
  const elementOf = node => node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;

  function selectedText(range) {
    const root = range.commonAncestorContainer;
    if (elementOf(root)?.closest(excluded)) return '';
    const chunks = [];
    function visit(node) {
      if (!range.intersectsNode(node)) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.parentElement && getComputedStyle(node.parentElement).userSelect === 'none') return;
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : node.length;
        const text = node.data.slice(start, end);
        if (text) chunks.push({ text });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      const element = node.nodeType === Node.ELEMENT_NODE ? node : null;
      if (element?.matches(excluded) || element?.matches('script,style,template,noscript')) return;
      const style = element ? getComputedStyle(element) : null;
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return;
      if (element?.tagName === 'BR') { chunks.push({ text: '\n' }); return; }
      const block = element && node !== root && !['inline', 'inline-block', 'inline-flex', 'contents'].includes(style.display);
      const gap = element?.tagName === 'P' ? 2 : 1;
      if (block) chunks.push({ gap });
      for (const child of node.childNodes) visit(child);
      if (block) chunks.push({ gap });
    }
    visit(root);
    let text = '', pendingGap = 0;
    for (const chunk of chunks) {
      if (chunk.gap) { pendingGap = Math.max(pendingGap, chunk.gap); continue; }
      if (text && pendingGap) {
        const existing = /\n*$/.exec(text)[0].length;
        text += '\n'.repeat(Math.max(0, pendingGap - existing));
      }
      text += chunk.text; pendingGap = 0;
    }
    // Only structural outer breaks are omitted; original spaces/newlines stay intact.
    return text;
  }

  document.addEventListener('copy', event => {
    if (event.defaultPrevented || !event.clipboardData) return;
    const active = document.activeElement;
    if (active?.matches('input,textarea,select') || active?.isContentEditable) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const metadata = [...document.querySelectorAll(excluded)];
    const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
    if (!ranges.some(range => metadata.some(node => range.intersectsNode(node)))) return;
    const text = ranges.map(selectedText).filter(value => value !== '').join('\n');
    event.preventDefault();
    // A timestamp-only selection leaves the existing clipboard untouched.
    if (text !== '') { event.clipboardData.clearData(); event.clipboardData.setData('text/plain', text); }
  });
})();
