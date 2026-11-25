/* Message copies use original media bytes; the loaded viewer retains its
 * Chromium copy path. Both paths remain scoped to the current account. */
(() => {
  'use strict';
  function create({ context, write }) {
    let request = 0;
    function snapshot() { try { return context(); } catch { return null; } }
    function available() { const value = snapshot(); return typeof write === 'function' && value?.allowed === true; }
    function point(image) {
      if (!(image instanceof HTMLImageElement) || !image.isConnected || !image.complete || !image.naturalWidth || !image.naturalHeight) throw Error('请先加载图片后再复制');
      const rect = image.getBoundingClientRect();
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
      for (let node = image.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node), box = node.getBoundingClientRect();
        if (/^(hidden|clip|auto|scroll)$/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
        if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      }
      if (right - left < 2 || bottom - top < 2) throw Error('请将图片滚动到可见位置后再复制');
      const x = (left + right) / 2, y = (top + bottom) / 2;
      if (document.elementFromPoint(x, y) !== image) throw Error('图片被遮挡，请关闭遮挡窗口后再复制');
      return { x, y };
    }
    async function copy(image, valid = () => true) {
      request++;
      const value = snapshot();
      if (!available() || !valid()) throw Error('当前无法复制图片');
      const coordinates = point(image);
      if (!valid() || snapshot()?.key !== value.key) return false;
      const result = await write({ ...coordinates, accountId: value.accountId });
      if (!valid() || snapshot()?.key !== value.key || !snapshot()?.allowed) return false;
      if (result?.copied !== true) throw Error('复制图片失败，请重试');
      return true;
    }
    async function copySource(source, valid = () => true) {
      const value = snapshot(), sequence = ++request;
      const current = () => sequence === request && valid() && snapshot()?.key === value?.key && snapshot()?.allowed === true;
      if (!available() || !current()) throw Error('当前无法复制图片');
      let payload;
      try { payload = typeof source === 'function' ? await source() : source; }
      catch (error) { if (!current()) return false; throw error; }
      if (!current()) return false;
      let prepared;
      try { prepared = await write({ ...payload, accountId: value.accountId, phase: 'prepare' }); }
      catch (error) { if (!current()) return false; throw error; }
      if (!prepared?.ticket) {
        if (!current() || prepared?.cancelled) return false;
        throw Error('复制图片失败，请重试');
      }
      let committed = false;
      try {
        if (!current()) return false;
        const result = await write({ phase: 'commit', ticket: prepared.ticket, accountId: value.accountId });
        committed = result?.copied === true;
        if (!current() || result?.cancelled) return false;
        if (!committed) throw Error('复制图片失败，请重试');
        return true;
      } finally {
        if (!committed) await write({ phase: 'cancel', ticket: prepared.ticket, accountId: value.accountId });
      }
    }
    return Object.freeze({ available, copy, copySource });
  }
  window.PulseImageClipboard = Object.freeze({ create });
})();
