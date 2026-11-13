const { randomUUID } = require('node:crypto');
const path = require('node:path');
const cancelled = message => Object.assign(new Error(message || '下载已取消'), { name: 'AbortError', code: 'DOWNLOAD_CANCELLED' });

// Manual downloads belong to the signed-in profile, not the currently shown chat.
function createDownloadQueue({ download, onChange = () => {}, concurrency = 2, capacity = 32, queueTimeoutMs = 120000 }) {
  const tasks = new Map(), pending = []; let active = 0, disposed = false;
  const snapshots = owner => [...tasks.values()].filter(t => t.owner.profileId === owner.profileId && t.owner.accountId === owner.accountId)
    .map(t => ({ id: t.id, name: t.name, status: t.status, received: t.received, total: t.total }));
  const changed = task => { try { onChange(task.owner, snapshots(task.owner)); } catch {} };
  function settle(task, error, value) {
    if (task.done) return;
    task.done = true; clearTimeout(task.timer); tasks.delete(task.id);
    const i = pending.indexOf(task); if (i >= 0) pending.splice(i, 1);
    const complete = error ? task.reject : task.resolve;
    task.resolve = task.reject = null; complete(error || value); changed(task);
  }
  function pump() {
    while (!disposed && active < concurrency && pending.length) {
      const task = pending.shift(); if (task.done) continue;
      clearTimeout(task.timer); task.status = 'running'; active++; changed(task);
      Promise.resolve().then(() => {
        if (task.controller.signal.aborted) throw task.controller.signal.reason;
        return download(task.owner, task.payload, { signal: task.controller.signal, onProgress: value => {
          if (task.done || task.controller.signal.aborted) return;
          task.received = Number(value.received) || 0; task.total = Number(value.total) || 0;
          const now = Date.now(); if (now - task.lastProgress >= 150) { task.lastProgress = now; changed(task); }
        } });
      }).then(value => settle(task, null, value), error => settle(task, error)).finally(() => { active--; pump(); });
    }
  }
  function cancel(task, reason) {
    if (!task || task.done) return false;
    task.controller.abort(cancelled(reason));
    if (task.status === 'queued') { settle(task, task.controller.signal.reason); pump(); }
    else { task.status = 'cancelling'; changed(task); }
    return true;
  }
  return {
    start(owner, payload) {
      if (disposed) return Promise.reject(cancelled());
      if (!owner?.profileId || !Number.isSafeInteger(owner.accountId) || owner.accountId <= 0) return Promise.reject(Error('请先登录后下载文件'));
      let url; try { url = new URL(String(payload?.url || '')); } catch { return Promise.reject(Error('下载地址无效')); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !String(payload?.directory || '').trim()) return Promise.reject(Error('下载地址或目录无效'));
      const safe = { url: url.href, fileName: String(payload.fileName || '下载文件').slice(0, 255), directory: path.resolve(String(payload.directory)) };
      const key = JSON.stringify([owner.profileId, owner.accountId, safe.url, safe.fileName, safe.directory]);
      const previous = [...tasks.values()].find(t => t.key === key && !t.controller.signal.aborted);
      if (previous) return previous.promise;
      if (tasks.size >= capacity) return Promise.reject(Error('下载任务已满，请等待或取消部分任务后再试'));
      const task = { id: randomUUID(), key, owner: { ...owner }, payload: safe, name: safe.fileName, status: 'queued', received: 0, total: 0, lastProgress: 0, controller: new AbortController() };
      task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
      task.timer = setTimeout(() => cancel(task, '下载排队超时，请重试'), queueTimeoutMs);
      tasks.set(task.id, task); pending.push(task); changed(task); pump(); return task.promise;
    },
    list: snapshots,
    cancel(owner, id) { const task = tasks.get(String(id)); return Boolean(task && task.owner.profileId === owner.profileId && task.owner.accountId === owner.accountId && cancel(task)); },
    cancelProfile(profileId, accountId) { for (const task of [...tasks.values()]) if (task.owner.profileId === profileId && (accountId === undefined || task.owner.accountId === accountId)) cancel(task); },
    hasProfile(profileId) { return [...tasks.values()].some(task => task.owner.profileId === profileId); },
    dispose() { disposed = true; const work = [...tasks.values()]; for (const task of work) cancel(task); return Promise.allSettled(work.map(task => task.promise)); },
    stats: () => ({ active, queued: pending.length, total: tasks.size }),
  };
}
module.exports = { createDownloadQueue };
