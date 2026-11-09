/* Copy the loaded image through Chromium, preserving authenticated media and
 * its original pixels without a canvas/CORS or external-browser round trip. */
(() => {
  'use strict';
  function create({ context, write }) {
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
      const value = snapshot();
      if (!available() || !valid()) throw Error('当前无法复制图片');
      const coordinates = point(image);
      if (!valid() || snapshot()?.key !== value.key) return false;
      const result = await write({ ...coordinates, accountId: value.accountId });
      if (!valid() || snapshot()?.key !== value.key || !snapshot()?.allowed) return false;
      if (result?.copied !== true) throw Error('复制图片失败，请重试');
      return true;
    }
    return Object.freeze({ available, copy });
  }
  window.PulseImageClipboard = Object.freeze({ create });
})();
