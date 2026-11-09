const bridge = window.pulseScreenshot;
const selectionBox = document.getElementById('selection'), actions = document.getElementById('capture-actions');
let start = null, selection = null, sending = false;
const point = event => ({ x: Math.max(0, Math.min(innerWidth, event.clientX)), y: Math.max(0, Math.min(innerHeight, event.clientY)) });
function draw(end) {
  selection = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
  selectionBox.hidden = false;
  Object.assign(selectionBox.style, { left: selection.x + 'px', top: selection.y + 'px', width: selection.width + 'px', height: selection.height + 'px' });
}
document.addEventListener('pointerdown', event => {
  if (sending || event.button !== 0 || event.target.closest('#capture-actions')) return;
  start = point(event); actions.hidden = true; document.getElementById('capture-error').textContent = ''; draw(start);
});
document.addEventListener('pointermove', event => { if (start) draw(point(event)); });
document.addEventListener('pointerup', event => {
  if (!start) return;
  draw(point(event)); start = null;
  if (selection.width < 6 || selection.height < 6) { selection = null; selectionBox.hidden = true; return; }
  actions.hidden = false;
  document.getElementById('capture-size').textContent = `${Math.round(selection.width)} × ${Math.round(selection.height)}`;
  actions.style.left = Math.max(8, Math.min(innerWidth - actions.offsetWidth - 8, selection.x + selection.width - actions.offsetWidth)) + 'px';
  actions.style.top = Math.max(8, Math.min(innerHeight - actions.offsetHeight - 8, selection.y + selection.height + 8)) + 'px';
});
async function complete() {
  if (sending || !selection) return;
  sending = true; document.getElementById('capture-done').disabled = true;
  try {
    const result = await bridge.complete({ x: selection.x / innerWidth, y: selection.y / innerHeight, width: selection.width / innerWidth, height: selection.height / innerHeight });
    if (result?.error) document.getElementById('capture-error').textContent = result.error;
  } catch { document.getElementById('capture-error').textContent = '截图失败，请重新选择范围。'; }
  finally { sending = false; document.getElementById('capture-done').disabled = false; }
}
document.getElementById('capture-done').onclick = complete;
document.getElementById('capture-cancel').onclick = () => bridge.cancel();
document.addEventListener('contextmenu', event => { event.preventDefault(); if (!sending) bridge.cancel(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !sending) bridge.cancel(); if (event.key === 'Enter') complete(); });
bridge.image().then(result => { document.getElementById('screen-image').src = result.dataUrl; }).catch(() => { document.getElementById('capture-error').textContent = '截图会话已关闭，请按Esc返回。'; });
