const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LIMIT = 10;
const MAGIC = Buffer.from('PULSE-REMEMBERED-LOGINS-1\n');
function serverKey(raw) {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw Error('服务器地址无效');
  return url.href.replace(/\/+$/, '');
}
function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value)) throw Error('账号资料无效');
  return value;
}
function validate(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > LIMIT) throw Error('账号资料无法读取');
  const ids = new Set(), owners = new Set();
  for (const entry of value.entries) {
    text(entry.id, 80, true); text(entry.account, 128, true); text(entry.password, 1024, true); text(entry.nickname, 128); text(entry.avatarUrl, 4096);
    if (!Number.isSafeInteger(entry.userId) || entry.userId <= 0 || serverKey(entry.server) !== entry.server || ids.has(entry.id) || owners.has(entry.server + '\n' + entry.userId)) throw Error('账号资料无法读取');
    ids.add(entry.id); owners.add(entry.server + '\n' + entry.userId);
  }
  return value.entries;
}
function createRememberedLogins({ filename, safeStorage, platform = process.platform }) {
  function available() {
    return safeStorage.isEncryptionAvailable() && !(platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text');
  }
  function read() {
    if (!fs.existsSync(filename)) return [];
    if (!available()) throw Error('无法安全读取账号密码，请稍后重试');
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) throw Error('保存的账号资料无法读取');
    try {
      const bytes = fs.readFileSync(filename);
      if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw Error();
      return validate(JSON.parse(safeStorage.decryptString(bytes.subarray(MAGIC.length))));
    } catch { throw Error('保存的账号资料无法解密，请使用账号密码登录'); }
  }
  function write(entries) {
    if (!available()) throw Error('系统安全存储暂不可用，无法记住密码');
    validate({ version: 1, entries });
    let sealed;
    try { sealed = Buffer.concat([MAGIC, safeStorage.encryptString(JSON.stringify({ version: 1, entries }))]); }
    catch { throw Error('账号密码安全保存失败，请稍后重试'); }
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temp = filename + '.' + crypto.randomUUID() + '.tmp';
    try {
      const descriptor = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, sealed); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temp, filename);
    } catch { throw Error('账号密码保存失败，请检查本机存储后重试'); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  function list(server) {
    const key = serverKey(server);
    return read().filter(entry => entry.server === key).map(({ password, server: _server, ...metadata }) => metadata);
  }
  function get(server, id) {
    const key = serverKey(server), entry = read().find(item => item.server === key && item.id === id);
    if (!entry) throw Error('该保存账号已移除，请重新选择');
    return { account: entry.account, password: entry.password };
  }
  function save(server, value) {
    const key = serverKey(server), entries = read();
    const account = text(value?.account, 128, true).trim(), userId = value?.userId;
    const password = text(value?.password, 1024, true);
    if (!account || !Number.isSafeInteger(userId) || userId <= 0) throw Error('账号资料无效');
    const previous = entries.find(item => item.server === key && (item.userId === userId || item.account.toLowerCase() === account.toLowerCase()));
    const entry = { id: previous?.id || crypto.randomUUID(), server: key, userId, account, password,
      nickname: text(value.nickname || '', 128), avatarUrl: text(value.avatarUrl || '', 4096) };
    const remaining = entries.filter(item => !(item.server === key && (item.userId === userId || item.account.toLowerCase() === account.toLowerCase())));
    write([entry, ...remaining].slice(0, LIMIT));
    return { saved: true };
  }
  function remove(server, value) {
    const key = serverKey(server), entries = read();
    const remaining = entries.filter(item => !(item.server === key && (item.id === value?.id || item.account.toLowerCase() === String(value?.account || '').trim().toLowerCase())));
    if (remaining.length !== entries.length) write(remaining);
    return { removed: entries.length - remaining.length };
  }
  return Object.freeze({ available, list, get, save, remove });
}
function createWindowRememberedLogins({ directory, safeStorage, platform = process.platform }) {
  const vaults = new Map();
  return Object.freeze({
    // A saved vault is retained even if decryption is temporarily unavailable.
    hasSavedGroup(id) { return fs.existsSync(id === 'default' ? path.join(directory, 'remembered-logins-v1.bin') : path.join(directory, 'window-groups', id, 'remembered-logins-v1.bin')); },
    releaseGroup(id) { vaults.delete(id); },
    forGroup(id) {
      if (id !== 'default' && (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))) throw Error('账号窗口不存在。');
      if (!vaults.has(id)) {
        // Preserve the original vault in place. New windows never copy from it.
        const filename = id === 'default' ? path.join(directory, 'remembered-logins-v1.bin') : path.join(directory, 'window-groups', id, 'remembered-logins-v1.bin');
        vaults.set(id, createRememberedLogins({ filename, safeStorage, platform }));
      }
      return vaults.get(id);
    },
  });
}
module.exports = { LIMIT, createRememberedLogins, createWindowRememberedLogins, serverKey };
