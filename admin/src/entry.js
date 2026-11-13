'use strict';
let verifyingEntry = false;
async function verifyEntry() {
  if (verifyingEntry) return;
  const fragment = location.hash.slice(1);
  const token = fragment.startsWith('entry=') ? fragment.slice(6) : fragment;
  history.replaceState(null, '', '/entry/');
  const status = document.getElementById('entry-status');
  if (!/^[a-f0-9]{64}$/.test(token)) { status.textContent = '入口无效，请使用机器人提供的专属链接。'; return; }
  verifyingEntry = true;
  try {
    sessionStorage.setItem('pulse.go.admin.entry', token);
    location.replace('/');
  } catch { status.textContent = '入口无效或暂时无法连接，请从机器人重新打开专属链接。'; }
  finally { verifyingEntry = false; }
}
window.addEventListener('hashchange', verifyEntry);
verifyEntry();
