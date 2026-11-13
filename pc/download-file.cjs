const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function safeFileName(value) {
  const name = path.basename(String(value || '下载文件')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || '下载文件';
  const shortened = Array.from(name).slice(0, 100).join('');
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(shortened) ? '_' + shortened : shortened;
}

/** Download into an exclusively owned temp file, then publish with link(), whose
 * EEXIST behavior is atomic even across concurrent processes. Never overwrite or
 * remove a user's existing destination, including on timeout or partial transfer. */
function createDownloader({ net, timeoutMs = 120000 }) {
  return async function downloadFile(urlValue, fileNameValue, directoryValue, { signal, onProgress } = {}) {
    const url = new URL(String(urlValue || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持下载有效的网络文件。');
    const rawDirectory = String(directoryValue || '').trim();
    const directory = path.resolve(rawDirectory);
    if (!rawDirectory || directory === path.parse(directory).root) throw new Error('下载目录无效。');
    const name = safeFileName(fileNameValue); const extension = path.extname(name); const stem = name.slice(0, name.length - extension.length);
    const temporary = path.join(directory, '.pulse-download-' + randomBytes(18).toString('hex') + '.part');
    const controller = new AbortController(); let source; let received = 0, owned = false;
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const check = () => { if (controller.signal.aborted) throw controller.signal.reason || new Error('下载已取消'); };
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      check(); await fs.promises.mkdir(directory, { recursive: true }); check();
      const handle = await fs.promises.open(temporary, 'wx', 0o600); owned = true; await handle.close(); check();
      // Electron IncomingMessage is an EventEmitter, not a Node Readable.
      // Fetch exposes a real Web stream with backpressure and abort support.
      const response = await net.fetch(url.toString(), { signal: controller.signal });
      if (controller.signal.aborted) throw new Error('下载超时，请重试。');
      if (response.status < 200 || response.status >= 300) { await response.body?.cancel(); throw new Error(`下载失败（${response.status || '网络错误'}）。`); }
      source = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
      const output = fs.createWriteStream(temporary, { flags: 'r+' });
      const total = Number(response.headers.get('content-length')) || 0;
      const counter = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; try { onProgress?.({ received, total }); } catch {} callback(null, chunk); } });
      await pipeline(source, counter, output, { signal: controller.signal });
      const declared = response.headers.get('content-length');
      const encoding = response.headers.get('content-encoding');
      // Chromium decompresses encoded responses, whose header length describes
      // compressed bytes. Such streams are checked by Chromium's transport.
      if (declared !== null && (!encoding || encoding === 'identity') && (!/^\d+$/.test(declared) || Number(declared) !== received)) throw new Error('文件传输不完整，请重新下载。');
      const completed = await fs.promises.open(temporary, 'r+');
      try { await completed.sync(); } finally { await completed.close(); }
      if (controller.signal.aborted) throw new Error('下载超时，请重试。');
      for (let index = 0; index < 10000; index++) {
        const target = path.join(directory, index ? `${stem} (${index})${extension}` : name);
        try {
          await fs.promises.link(temporary, target);
          return target;
        } catch (error) {
          if (error.code !== 'EEXIST') throw new Error('无法安全保存到此目录，请选择支持原子文件操作的本地磁盘。');
        }
        if (controller.signal.aborted) throw new Error('下载超时，请重试。');
      }
      throw new Error('同名文件过多，请更换保存目录。');
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('下载已取消'), { code: 'DOWNLOAD_CANCELLED', name: 'AbortError' });
      if (controller.signal.aborted) throw new Error('下载超时，请重试。');
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); source?.destroy();
      if (owned) await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw new Error('下载临时文件清理失败，请检查目录权限。'); });
    }
  };
}
module.exports = { createDownloader, safeFileName };
