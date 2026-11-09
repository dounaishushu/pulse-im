'use strict';
let verifyingEntry = false;
async function verifyEntry() {
  if (verifyingEntry) return;
  const token = location.hash.slice(1);
  history.replaceState(null, '', '/entry/');
  const status = document.getElementById('entry-status');
  if (!/^[a-f0-9]{64}$/.test(token)) { status.textContent = '入口无效，请使用机器人提供的专属链接。'; return; }
  verifyingEntry = true;
  try {
    const response = await fetch('/api/admin/auth/entry', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Pulse-Admin-Request': '1' },
      body: JSON.stringify({ token }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || (await response.json()).ok !== true) throw new Error('入口验证失败');
    location.replace('/');
  } catch { status.textContent = '入口无效或暂时无法连接，请从机器人重新打开专属链接。'; }
  finally { verifyingEntry = false; }
}
window.addEventListener('hashchange', verifyEntry);
verifyEntry();
