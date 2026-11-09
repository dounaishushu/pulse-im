// Local diagnostics only. Never send logs, request bodies or credentials to a server.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const sensitiveKey = /password|passwd|authorization|cookie|token|secret|api[_-]?key|message[_-]?body|chat[_-]?content/i;

function sourceLabel(value) {
  const text = String(value || '').slice(0, 4096);
  try {
    const url = new URL(text);
    if (url.protocol === 'file:') return 'app/' + path.posix.basename(url.pathname);
    if (['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol)) {
      const name = path.posix.basename(url.pathname);
      return url.origin + (/^[\w.-]+\.(?:js|cjs|css|html|wasm)$/i.test(name) ? '/' + name : '/[path]');
    }
    return '[' + url.protocol.replace(':', '') + ']';
  } catch { return path.basename(text.replace(/\\/g, '/')).slice(0, 160); }
}
function redactText(value, limit = 4096) {
  return String(value || '').slice(0, 16000)
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, '[credential]')
    .replace(/(["']?(?:password|passwd|pwd|access_token|refresh_token|token|authorization|cookie|secret|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token]')
    .replace(/(?:https?|wss?|file):\/\/[^\s"'<>)]*/gi, sourceLabel)
    .replace(/(?:[A-Z]:\\Users\\|\/Users\/|\/home\/)[^\\/\s]+/gi, '[user]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, limit);
}
function safeData(value, depth = 0, seen = new Set()) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactText(value);
  if (depth > 4 || typeof value !== 'object' || seen.has(value)) return '[omitted]';
  seen.add(value);
  if (value instanceof Error) return safeData({ name: value.name, code: value.code, message: value.message, stack: value.stack }, depth + 1, seen);
  if (Array.isArray(value)) return value.slice(0, 32).map(item => safeData(item, depth + 1, seen));
  return Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, item]) => [key.slice(0, 80), sensitiveKey.test(key) ? '[redacted]' : safeData(item, depth + 1, seen)]));
}

function createLogWriter({ directory, version, maxBytes = 2 * 1024 * 1024, retainedFiles = 5, now = Date.now }) {
  const file = path.join(directory, 'desktop.log'), run = randomUUID();
  let available = false, errorCode = '', bytes = 0;
  function prepare() {
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw Object.assign(Error('Unsafe log file'), { code: 'LOG_FILE_INVALID' });
    bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    available = true;
  }
  function rotate() {
    for (let i = retainedFiles - 1; i >= 1; i--) {
      const from = i === 1 ? file : file + '.' + (i - 1), to = file + '.' + i;
      if (fs.existsSync(to)) fs.unlinkSync(to);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    bytes = 0;
  }
  function write(level, event, data = {}) {
    try {
      if (!available) prepare();
      const line = JSON.stringify({ time: new Date(now()).toISOString(), level, event: String(event).slice(0, 80), version, run, pid: process.pid, data: safeData(data) }) + '\n';
      const length = Buffer.byteLength(line);
      if (bytes + length > maxBytes) rotate();
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 }); bytes += length; errorCode = ''; return true;
    } catch (error) { available = false; errorCode = String(error?.code || 'LOG_WRITE_FAILED'); return false; }
  }
  return { write, run, file, directory, info: () => ({ directory, available, errorCode }) };
}

function pruneCrashDumps(directory, now = Date.now()) {
  const files = [];
  function visit(folder, depth = 0) {
    if (depth > 3 || !fs.existsSync(folder) || fs.lstatSync(folder).isSymbolicLink()) return;
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) visit(file, depth + 1);
      else if (item.isFile() && item.name.endsWith('.dmp')) { const stat = fs.statSync(file); files.push({ file, size: stat.size, time: stat.mtimeMs }); }
    }
  }
  try {
    visit(directory); files.sort((a, b) => b.time - a.time); let kept = 0, bytes = 0;
    for (const item of files) {
      if (item.time < now - 7 * 86400000 || kept >= 10 || bytes + item.size > 128 * 1024 * 1024) fs.unlinkSync(item.file);
      else { kept++; bytes += item.size; }
    }
  } catch { /* Cleanup never prevents startup or removes Crashpad's metadata. */ }
}

function installDiagnostics({ electron, version, processObject = process, directory = path.join(electron.app.getPath('userData'), 'logs') }) {
  const { app, crashReporter, shell } = electron;
  const writer = createLogWriter({ directory, version });
  const crashDirectory = path.join(directory, 'crashes'), marker = path.join(directory, 'last-session.json');
  const metadata = new WeakMap(), attached = new WeakSet(), limits = new WeakMap();
  let sessionStarted = false, quitting = false, clean = false, fatal = false, timer = null;
  const log = (event, data = {}, level = 'info') => { if (level === 'fatal') fatal = true; return writer.write(level, event, data); };
  function mark(ended = false) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(marker + '.tmp', JSON.stringify({ run: writer.run, pid: processObject.pid, version, time: new Date().toISOString(), ended, clean: ended && clean && !fatal }), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(marker + '.tmp', marker);
    } catch { /* Disk problems must not create a second application failure. */ }
  }
  function sample(reason) {
    try {
      const metrics = app.getAppMetrics().slice(0, 24).map(item => ({ pid: item.pid, type: item.type, cpuPercent: item.cpu?.percentCPUUsage,
        workingSetKB: item.memory?.workingSetSize, peakWorkingSetKB: item.memory?.peakWorkingSetSize }));
      log('process-metrics', { reason, freeMemoryMB: Math.round(os.freemem() / 1048576), totalMemoryMB: Math.round(os.totalmem() / 1048576), mainMemory: processObject.memoryUsage(), processes: metrics });
    } catch { /* Some metrics are unavailable during startup/shutdown. */ }
  }
  function context(contents) { return { webContentsId: contents.id, type: contents.getType(), ...metadata.get(contents) }; }
  function allowed(contents) {
    const now = Date.now(); let limit = limits.get(contents);
    if (!limit || now - limit.start >= 60000) { limit = { start: now, count: 0 }; limits.set(contents, limit); }
    limit.count++;
    if (limit.count === 61) log('renderer-log-rate-limited', context(contents), 'warning');
    return limit.count <= 60;
  }
  function rendererEvent(contents, value) {
    if (!value || !['renderer-error', 'unhandled-rejection', 'resource-load-failed', 'renderer-startup-stalled', 'avatar-load-failed', 'avatar-load-recovered'].includes(value.kind) || !allowed(contents)) return false;
    if (value.kind.startsWith('avatar-')) {
      if (!/^AVATAR_(?:HTTP_[1-5]\d{2}|NETWORK|TIMEOUT|OFFLINE|CONTENT_TYPE|TOO_LARGE|EMPTY|SOURCE_UNSUPPORTED|GRANT_EXPIRED|IMAGE_ERROR|DECODE|RECOVERED)$/.test(value.code)) return false;
      const bounded = (number, maximum) => Math.min(maximum, Math.max(0, Math.floor(Number(number) || 0)));
      log(value.kind, { ...context(contents), code: value.code, source: sourceLabel(value.source),
        area: /^[a-z-]{1,48}$/.test(value.area) ? value.area : 'avatar', status: bounded(value.status, 599),
        attempt: bounded(value.attempt, 2), elapsedMs: bounded(value.elapsedMs, 60000), online: value.online === true },
        value.kind === 'avatar-load-recovered' ? 'info' : 'warning');
      return true;
    }
    log(value.kind, { ...context(contents), name: String(value.name || '').slice(0, 80), message: String(value.message || '').slice(0, 2048),
      stack: String(value.stack || '').slice(0, 4096), source: sourceLabel(value.source), line: Number(value.line) || 0, column: Number(value.column) || 0 }, 'error');
    return true;
  }
  function attach(contents, details) {
    if (details) metadata.set(contents, { kind: String(details.kind || '').slice(0, 24), windowId: Number(details.windowId) || 0, profile: String(details.profileId || '').slice(0, 40) });
    if (attached.has(contents)) return;
    attached.add(contents); let started = 0;
    contents.on('did-start-loading', () => { started = Date.now(); log('page-load-start', context(contents)); });
    contents.on('did-finish-load', () => log('page-load-finished', { ...context(contents), source: sourceLabel(contents.getURL()), elapsedMs: started ? Date.now() - started : null }));
    contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
      if (mainFrame !== false) log('page-load-failed', { ...context(contents), code, description, source: sourceLabel(url) }, code === -3 ? 'info' : 'error');
    });
    contents.on('preload-error', (_event, file, error) => log('preload-error', { ...context(contents), source: sourceLabel(file), error }, 'error'));
    contents.on('console-message', (_event, level, message, line, source) => {
      // Normal console output can contain chat data. Keep only recognizable JS/runtime failures.
      if (level >= 3 && /^(?:Uncaught\b|(?:Type|Reference|Syntax|Range|URI|Eval)Error\b|Failed to load resource\b)/.test(message) && allowed(contents))
        log('renderer-console-error', { ...context(contents), message, line, source: sourceLabel(source) }, 'error');
    });
    contents.on('render-process-gone', (_event, details) => {
      log('renderer-process-gone', { ...context(contents), reason: details.reason, exitCode: details.exitCode }, details.reason === 'clean-exit' ? 'info' : 'error');
      if (details.reason !== 'clean-exit') sample('renderer-process-gone');
      const cleanup = setTimeout(() => pruneCrashDumps(crashDirectory), 5000); cleanup.unref();
    });
    contents.on('unresponsive', () => { log('renderer-unresponsive', context(contents), 'error'); sample('renderer-unresponsive'); });
    contents.on('responsive', () => log('renderer-responsive', context(contents)));
    contents.once('destroyed', () => log('page-destroyed', { webContentsId: contents.id, ...metadata.get(contents), quitting }));
  }
  log('process-start', { electron: processObject.versions.electron, chrome: processObject.versions.chrome, node: processObject.versions.node,
    platform: processObject.platform, arch: processObject.arch, osRelease: os.release(), packaged: app.isPackaged });
  processObject.on('uncaughtExceptionMonitor', (error, origin) => { fatal = true; log('main-uncaught-exception', { origin, error }, 'fatal'); if (sessionStarted) mark(); });
  processObject.on('unhandledRejection', error => log('main-unhandled-rejection', { error }, 'error'));
  processObject.on('warning', warning => log('main-warning', { warning }, 'warning'));
  processObject.once('exit', code => { log('process-exit', { code, clean: clean && !fatal && code === 0 }); if (sessionStarted) { if (code !== 0) clean = false; mark(true); } });
  app.on('web-contents-created', (_event, contents) => attach(contents));
  app.on('child-process-gone', (_event, details) => { log('child-process-gone', { type: details.type, reason: details.reason, exitCode: details.exitCode }, details.reason === 'clean-exit' ? 'info' : 'error'); if (details.reason !== 'clean-exit') sample('child-process-gone'); });
  app.once('before-quit', () => { quitting = true; log('app-before-quit'); });
  app.once('will-quit', () => { clean = true; clearInterval(timer); log('app-will-quit'); if (sessionStarted) mark(true); });
  try {
    fs.mkdirSync(crashDirectory, { recursive: true }); pruneCrashDumps(crashDirectory);
    app.setPath('crashDumps', crashDirectory);
    crashReporter.start({ productName: '小猿口算', uploadToServer: false, globalExtra: { desktop_version: String(version) } });
    log('local-crash-reporter-ready', { uploadToServer: false });
  } catch (error) { log('local-crash-reporter-unavailable', { error }, 'warning'); }
  app.whenReady().then(() => {
    if (quitting || clean) return;
    log('app-ready', { gpuFeatures: app.getGPUFeatureStatus() });
    if (sessionStarted) { sample('startup'); timer = setInterval(() => sample('periodic'), 60000); timer.unref(); }
  }).catch(error => log('diagnostics-ready-error', { error }, 'error'));
  return {
    log, attach, rendererEvent, info: writer.info,
    startSession() {
      if (sessionStarted) return;
      sessionStarted = true;
      try { const previous = JSON.parse(fs.readFileSync(marker, 'utf8')); if (!previous.clean) log('previous-session-incomplete', { previousRun: previous.run, previousVersion: previous.version, lastRecordedAt: previous.time }, 'warning'); } catch {}
      mark();
    },
    async openDirectory() {
      log('open-log-directory');
      if (!writer.info().available) throw Error('无法写入本地日志，请检查磁盘空间和目录权限。');
      const error = await shell.openPath(directory);
      if (error) { log('open-log-directory-failed', {}, 'warning'); throw Error('无法打开日志目录，请检查系统文件管理器。'); }
      return true;
    },
  };
}
module.exports = { createLogWriter, installDiagnostics, pruneCrashDumps, redactText, safeData, sourceLabel };
